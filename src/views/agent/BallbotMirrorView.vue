<!--
═══════════════════════════════════════════════════════════════════
  BallbotMirrorView.vue — Réplica espejo Ballbot (2026-05-22)

  Muestra las 18+ estrategias de Ballbot replicadas en HELIX,
  con backtest retrospectivo HONESTO sobre 5 años + comparación
  contra el consensus de HELIX v2.

  Sin maquillaje: edge_pp y Wilson CI explícitos.

  Ruta: /agent/ballbot-mirror
═══════════════════════════════════════════════════════════════════
-->
<template>
  <div class="bm-view">
    <header class="bm-header">
      <div class="bm-title">
        <span class="bm-icon">🪞</span>
        <div>
          <h1 class="bm-h1">Ballbot Mirror · Réplica Espejo</h1>
          <p class="bm-sub">
            18+ estrategias Ballbot replicadas en HELIX · Backtest retrospectivo honesto · Comparación lado a lado
          </p>
        </div>
      </div>
      <div class="bm-controls">
        <select v-model="form.game_type" class="bm-sel">
          <option value="pick3">pick3</option>
          <option value="pick4">pick4</option>
        </select>
        <select v-model="form.draw_type" class="bm-sel">
          <option value="midday">midday</option>
          <option value="evening">evening</option>
        </select>
        <select v-model="form.half" class="bm-sel">
          <option value="du">du</option>
          <option value="ab">ab</option>
          <option value="cd">cd</option>
        </select>
        <input v-model="form.top_n" type="number" min="5" max="50" class="bm-input" placeholder="top N" />
        <button class="bm-btn" @click="runMirror" :disabled="loading">
          {{ loading ? '⟳ Ejecutando...' : '▶ Ejecutar mirror' }}
        </button>
      </div>
    </header>

    <!-- Disclaimer honesto -->
    <section class="bm-disclaimer">
      <span class="bm-disclaimer-icon">⚠️</span>
      <div>
        <strong>Transparencia matemática:</strong>
        Las estrategias replicadas usan EXACTAMENTE la misma lógica de Ballbot sobre los mismos datos.
        Los <code>edge_pp</code> y Wilson 95% CI mostrados son <strong>backtest empírico</strong> sobre algo_rank_history.
        Si Wilson 95% CI lower &gt; 15% (top-15) → edge real demostrado.
        Si CI incluye 15% → indistinguible del azar.
      </div>
    </section>

    <!-- HELIX consensus comparison -->
    <section v-if="result?.helix_consensus" class="bm-helix-card">
      <h2 class="bm-section-title">🧬 HELIX Consensus · Walk-forward retrospectivo</h2>
      <div class="bm-helix-grid">
        <div class="bm-helix-stat">
          <div class="bm-stat-val" :class="result.helix_consensus.edge_x >= 1.10 ? 'good' : result.helix_consensus.edge_x >= 1.00 ? 'neutral' : 'bad'">
            {{ formatX(result.helix_consensus.edge_x) }}
          </div>
          <div class="bm-stat-lbl">Edge multiplier vs azar</div>
        </div>
        <div class="bm-helix-disclosure">{{ result.helix_consensus.disclosure }}</div>
      </div>
    </section>

    <!-- POINT 3: Comparativa lado-a-lado (pega output Ballbot) -->
    <section class="bm-diff-card">
      <h2 class="bm-section-title">🔬 Comparativa Bot Ballbot ↔ HELIX Mirror</h2>
      <p class="bm-diff-help">
        Pega aquí los candidatos del bot Ballbot (números 2-dígitos separados por coma, espacio, o salto de línea) y selecciona la estrategia. Se calculará overlap y position-match.
      </p>
      <div class="bm-diff-grid">
        <div class="bm-diff-col">
          <label class="bm-diff-lbl">Estrategia a comparar</label>
          <select v-model="diff.ballbot_id" class="bm-sel">
            <option v-for="m in BALLBOT_LIST" :key="m.id" :value="m.id">{{ m.emoji }} {{ m.title }}</option>
          </select>
          <label class="bm-diff-lbl" style="margin-top: 0.5rem;">Candidatos Ballbot (pegar)</label>
          <textarea
            v-model="diff.ballbot_input"
            class="bm-textarea"
            placeholder="17, 54, 03, 86, 75, 10, 16, 71, 93, 69, 42, 23, 64, 88, 04"
            rows="3"></textarea>
          <button class="bm-btn" @click="runDiff" :disabled="diffLoading || !diff.ballbot_input">
            {{ diffLoading ? '⟳ Comparando...' : '▶ Calcular diff' }}
          </button>
        </div>
        <div v-if="diff.result" class="bm-diff-result">
          <div class="bm-diff-metrics">
            <div class="bm-diff-metric">
              <div class="bm-diff-val" :class="diff.result.set_overlap_pct >= 80 ? 'good' : diff.result.set_overlap_pct >= 50 ? 'neutral' : 'bad'">
                {{ diff.result.set_overlap_pct }}%
              </div>
              <div class="bm-diff-lbl-sm">Set overlap</div>
            </div>
            <div class="bm-diff-metric">
              <div class="bm-diff-val" :class="diff.result.jaccard >= 80 ? 'good' : diff.result.jaccard >= 50 ? 'neutral' : 'bad'">
                {{ diff.result.jaccard }}%
              </div>
              <div class="bm-diff-lbl-sm">Jaccard</div>
            </div>
            <div class="bm-diff-metric">
              <div class="bm-diff-val" :class="diff.result.position_exact_pct >= 80 ? 'good' : 'neutral'">
                {{ diff.result.position_exact_pct }}%
              </div>
              <div class="bm-diff-lbl-sm">Position exact</div>
            </div>
          </div>
          <table class="bm-diff-table">
            <thead><tr><th>#</th><th>Ballbot</th><th>HELIX</th><th>Match</th></tr></thead>
            <tbody>
              <tr v-for="r in diff.result.position_map" :key="r.pos">
                <td>{{ r.pos }}</td>
                <td class="bm-mono">{{ r.ballbot }}</td>
                <td class="bm-mono">{{ r.helix }}</td>
                <td>{{ r.match ? '✅' : '✗' }}</td>
              </tr>
            </tbody>
          </table>
          <div v-if="diff.result.only_ballbot.length || diff.result.only_helix.length" class="bm-diff-sets">
            <div v-if="diff.result.only_ballbot.length">
              <strong>Solo Ballbot:</strong> <code>{{ diff.result.only_ballbot.join(', ') }}</code>
            </div>
            <div v-if="diff.result.only_helix.length">
              <strong>Solo HELIX:</strong> <code>{{ diff.result.only_helix.join(', ') }}</code>
            </div>
          </div>
        </div>
      </div>
    </section>

    <!-- POINT 4: Timeseries evolución mensual por algo -->
    <section v-if="result?.strategies?.length" class="bm-ts-card">
      <h2 class="bm-section-title">📈 Evolución mensual del algoritmo</h2>
      <p class="bm-diff-help">
        Selecciona un algoritmo para ver su hit-rate mes a mes (con Wilson 95% CI). Permite identificar regímenes favorables/desfavorables en el tiempo.
      </p>
      <div class="bm-ts-controls">
        <select v-model="ts.algo" class="bm-sel" @change="loadTimeseries">
          <option v-for="s in result.strategies.filter(x => x.helix_id)" :key="s.ballbot_id" :value="s.helix_id">
            {{ s.emoji }} {{ s.bot_title }}
          </option>
        </select>
        <select v-model="ts.bucket" class="bm-sel" @change="loadTimeseries">
          <option value="month">Mensual</option>
          <option value="week">Semanal</option>
          <option value="quarter">Trimestral</option>
        </select>
      </div>
      <div v-if="ts.series.length" class="bm-ts-chart">
        <div class="bm-ts-baseline">Baseline azar 15% ▬▬</div>
        <div class="bm-ts-bars">
          <div v-for="(pt, i) in ts.series" :key="i" class="bm-ts-bar-wrap" :title="`${pt.bucket}: ${(pt.hit_rate_15*100).toFixed(1)}% (n=${pt.n}, edge=${pt.edge_pp>=0?'+':''}${pt.edge_pp}pp)`">
            <div class="bm-ts-bar"
                 :class="pt.edge_pp >= 1 ? 'good' : pt.edge_pp >= 0 ? 'neutral' : 'bad'"
                 :style="{ height: Math.max(2, Math.min(100, pt.hit_rate_15 * 250)) + 'px' }">
            </div>
            <div class="bm-ts-label">{{ pt.bucket.slice(5) }}</div>
          </div>
        </div>
      </div>
      <div v-else-if="ts.loading" class="bm-loading">⟳ Cargando timeseries...</div>
    </section>

    <!-- Tabla comparativa -->
    <section v-if="result?.strategies?.length" class="bm-section">
      <h2 class="bm-section-title">📊 Comparativa estrategias Ballbot ({{ result.strategies.length }})</h2>
      <div class="bm-table-wrap">
        <table class="bm-table">
          <thead>
            <tr>
              <th class="bm-th-strategy">Estrategia</th>
              <th>Status</th>
              <th class="ta-r">Candidatos top-N</th>
              <th class="ta-r">Hit@15</th>
              <th class="ta-r">Hit@25</th>
              <th class="ta-r">Wilson CI @15</th>
              <th class="ta-r">Edge @15</th>
              <th class="ta-r">Rank avg</th>
              <th class="ta-r">N</th>
              <th>Veredicto</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sortedStrategies" :key="s.ballbot_id" :class="rowClass(s)">
              <td>
                <div class="bm-strat-cell">
                  <span class="bm-strat-emoji">{{ s.emoji }}</span>
                  <div>
                    <div class="bm-strat-title">{{ s.bot_title }}</div>
                    <code class="bm-strat-id">{{ s.ballbot_id }}</code>
                  </div>
                </div>
              </td>
              <td>
                <span class="bm-status" :class="s.status === 'canonical' ? 'bm-status-canon' : 'bm-status-mirror'">
                  {{ s.status === 'canonical' ? '✓ HELIX' : '🪞 mirror' }}
                </span>
              </td>
              <td class="ta-r">
                <div class="bm-candidates">
                  <span v-for="(c, i) in s.candidates.slice(0, 8)" :key="i" class="bm-pair-chip">{{ c }}</span>
                  <span v-if="s.candidates.length > 8" class="bm-more">+{{ s.candidates.length - 8 }}</span>
                </div>
              </td>
              <td class="ta-r bm-hr" v-if="s.retrospective">
                <strong>{{ formatPct(s.retrospective.hit_rate_15) }}</strong>
              </td>
              <td class="ta-r" v-else>—</td>
              <td class="ta-r bm-hr" v-if="s.retrospective">
                {{ formatPct(s.retrospective.hit_rate_25) }}
              </td>
              <td class="ta-r" v-else>—</td>
              <td class="ta-r bm-ci" v-if="s.retrospective">
                [{{ formatPct(s.retrospective.wilson_lo_15) }}, {{ formatPct(s.retrospective.wilson_hi_15) }}]
              </td>
              <td class="ta-r" v-else>—</td>
              <td class="ta-r" :class="edgeClass(s.retrospective?.edge_15_pp)" v-if="s.retrospective">
                {{ formatEdgePp(s.retrospective.edge_15_pp) }}
              </td>
              <td class="ta-r" v-else>—</td>
              <td class="ta-r" v-if="s.retrospective">{{ s.retrospective.n_total > 0 ? s.retrospective.n_total : '—' }}</td>
              <td class="ta-r" v-else>—</td>
              <td>{{ verdict(s) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Estado inicial -->
    <div v-if="!result && !loading" class="bm-empty">
      <p>Selecciona parámetros y haz click en <strong>Ejecutar mirror</strong>.</p>
      <p>Verás las 18+ estrategias Ballbot ejecutadas EN HELIX con backtest retrospectivo honesto sobre 5 años.</p>
    </div>

    <div v-if="loading" class="bm-loading">⟳ Ejecutando 18+ estrategias en paralelo + cargando backtest retrospectivo...</div>
  </div>
</template>

<script setup>
import { ref, computed, watch } from 'vue';
import { apiPost, apiGet } from '../../utils/apiClient.js';

const form = ref({
  game_type: 'pick3',
  draw_type: 'evening',
  half:      'du',
  top_n:     15,
});

const loading = ref(false);
const result  = ref(null);

// POINT 3: Diff state
const BALLBOT_LIST = [
  { id: 'trend_momentum', emoji: '📈', title: 'Fuerza de Tendencia Pro' },
  { id: 'freq_analysis', emoji: '🎯', title: 'Radar de Frecuencias' },
  { id: 'gap_due', emoji: '⏳', title: 'Números Debidos' },
  { id: 'bayesian_score', emoji: '🧠', title: 'Score Bayesiano' },
  { id: 'markov_order2', emoji: '🔮', title: 'Markov-2' },
  { id: 'streak_analysis', emoji: '🔥', title: 'Detector de Rachas' },
  { id: 'positional_analysis', emoji: '🎯', title: 'Radiografía Posicional' },
  { id: 'transition_follow', emoji: '🔗', title: 'Rastreador de Secuencias' },
  { id: 'calendar_pattern', emoji: '📅', title: 'Reloj de Probabilidades' },
  { id: 'decade_family', emoji: '🏷', title: 'Bloques Ganadores' },
  { id: 'terminal_analysis', emoji: '🎚', title: 'Cierres Perfectos' },
  { id: 'max_per_week_day', emoji: '📊', title: 'Max por Día Semana' },
  { id: 'est_individuales', emoji: '📈', title: 'Estadísticas Individuales' },
  { id: 'pairs_correlation', emoji: '🔀', title: 'Correlación de Pares' },
  { id: 'cycle_detector', emoji: '🔄', title: 'Radar de Ciclos' },
  { id: 'mirror_complement', emoji: '🪞', title: 'Sincronía Oculta' },
  { id: 'unodostres', emoji: '🔢', title: 'Fibonacci' },
  { id: 'unodostres_plus', emoji: '✨', title: 'Fibonacci PLUS' },
];

const diff = ref({
  ballbot_id: 'trend_momentum',
  ballbot_input: '',
  result: null,
});
const diffLoading = ref(false);

// POINT 4: Timeseries state
const ts = ref({
  algo: 'trend_momentum',
  bucket: 'month',
  series: [],
  loading: false,
});

const sortedStrategies = computed(() => {
  if (!result.value?.strategies) return [];
  // Sort by edge_15_pp descending (best first)
  return [...result.value.strategies].sort((a, b) => {
    const ae = a.retrospective?.edge_15_pp ?? -999;
    const be = b.retrospective?.edge_15_pp ?? -999;
    return be - ae;
  });
});

function formatPct(v) {
  if (v == null) return '—';
  return (Number(v) * 100).toFixed(1) + '%';
}
function formatX(v) {
  if (v == null) return '—';
  return Number(v).toFixed(3) + '×';
}
function formatEdgePp(v) {
  if (v == null) return '—';
  const n = Number(v);
  return (n >= 0 ? '+' : '') + n.toFixed(2) + 'pp';
}
function edgeClass(v) {
  if (v == null) return '';
  const n = Number(v);
  if (n >= 3.0) return 'bm-edge-strong';
  if (n >= 1.0) return 'bm-edge-mild';
  if (n >= 0)   return 'bm-edge-neutral';
  return 'bm-edge-negative';
}
function rowClass(s) {
  if (!s.retrospective) return '';
  const edge = s.retrospective.edge_15_pp ?? 0;
  if (edge >= 3) return 'bm-row-strong';
  if (edge >= 1) return 'bm-row-mild';
  return '';
}
function verdict(s) {
  if (!s.retrospective || s.retrospective.n_total === 0) return '—';
  const lo = s.retrospective.wilson_lo_15;
  if (lo > 0.15) return '🎯 edge real (Wilson > 15%)';
  if (s.retrospective.edge_15_pp >= 1) return '🟡 marginal';
  if (s.retrospective.edge_15_pp >= 0) return '⚪ baseline';
  return '🔻 below azar';
}

async function runMirror() {
  loading.value = true;
  result.value = null;
  try {
    const r = await apiPost('/api/ballbot-mirror/run', {
      game_type: form.value.game_type,
      draw_type: form.value.draw_type,
      half:      form.value.half,
      top_n:     Number(form.value.top_n),
    });
    result.value = r;
    // Auto-cargar timeseries del primer algo
    if (r?.strategies?.length) loadTimeseries();
  } catch (err) {
    console.error(err);
    alert('Error ejecutando mirror: ' + (err.message ?? err));
  } finally {
    loading.value = false;
  }
}

// POINT 3: Comparar candidatos Ballbot pegados vs HELIX
async function runDiff() {
  diffLoading.value = true;
  diff.value.result = null;
  try {
    // Parse pegado: extraer todos los 2-dígitos
    const parsed = (diff.value.ballbot_input || '')
      .split(/[\s,;\n\r]+/)
      .map(s => s.trim().replace(/^[0-9]*([0-9]{1,2})$/, '$1').padStart(2, '0'))
      .filter(s => /^[0-9]{2}$/.test(s));

    if (parsed.length === 0) {
      alert('No se encontraron candidatos válidos. Pega números de 2 dígitos.');
      diffLoading.value = false;
      return;
    }

    const r = await apiPost('/api/ballbot-mirror/diff', {
      ballbot_candidates: parsed,
      ballbot_id:         diff.value.ballbot_id,
      game_type:          form.value.game_type,
      draw_type:          form.value.draw_type,
      half:               form.value.half,
      top_n:              Number(form.value.top_n),
    });
    diff.value.result = r;
  } catch (err) {
    console.error(err);
    alert('Error en diff: ' + (err.message ?? err));
  } finally {
    diffLoading.value = false;
  }
}

// POINT 4: cargar evolución mensual
async function loadTimeseries() {
  if (!ts.value.algo) return;
  ts.value.loading = true;
  ts.value.series = [];
  try {
    const r = await apiGet(`/api/ballbot-mirror/timeseries?algo=${encodeURIComponent(ts.value.algo)}&game=${form.value.game_type}&draw=${form.value.draw_type}&half=${form.value.half}&bucket=${ts.value.bucket}`);
    ts.value.series = r.series ?? [];
  } catch (err) {
    console.error(err);
  } finally {
    ts.value.loading = false;
  }
}

watch(() => form.value.game_type, () => { if (result.value) loadTimeseries(); });
watch(() => form.value.draw_type, () => { if (result.value) loadTimeseries(); });
watch(() => form.value.half, () => { if (result.value) loadTimeseries(); });
</script>

<style scoped>
.bm-view {
  max-width: 1400px;
  margin: 0 auto;
  padding: 1rem 0;
  display: flex; flex-direction: column;
  gap: 1.25rem;
}

.bm-header {
  display: flex; justify-content: space-between; align-items: flex-end;
  flex-wrap: wrap; gap: 1rem;
  padding-bottom: 1rem;
  border-bottom: 1px solid #1e2d40;
}
.bm-title { display: flex; gap: 1rem; align-items: center; }
.bm-icon  { font-size: 2.5rem; }
.bm-h1    { margin: 0; font-size: 1.5rem; font-weight: 800; color: #e2e8f0; }
.bm-sub   { margin: 0.2rem 0 0; font-size: 0.78rem; color: #64748b; max-width: 600px; }

.bm-controls { display: flex; gap: 0.4rem; align-items: center; flex-wrap: wrap; }
.bm-sel, .bm-input {
  background: #0a0d14; color: #e2e8f0;
  border: 1px solid #1e2d40; border-radius: 4px;
  padding: 0.4rem 0.6rem; font-size: 0.85rem;
}
.bm-input { width: 70px; }
.bm-btn {
  background: linear-gradient(180deg, #1e3a5f, #1e40af);
  color: #fff; border: 1px solid #1e40af; border-radius: 6px;
  padding: 0.5rem 1rem; font-weight: 700; cursor: pointer;
}
.bm-btn:hover { background: linear-gradient(180deg, #1e40af, #2563eb); }
.bm-btn:disabled { opacity: 0.5; cursor: not-allowed; }

.bm-disclaimer {
  display: flex; gap: 1rem; align-items: flex-start;
  padding: 0.75rem 1rem;
  background: rgba(251, 191, 36, 0.06);
  border: 1px solid rgba(251, 191, 36, 0.3);
  border-radius: 8px;
  font-size: 0.82rem; color: #cbd5e1; line-height: 1.5;
}
.bm-disclaimer-icon { font-size: 1.3rem; flex-shrink: 0; }
.bm-disclaimer code { background: rgba(0,0,0,0.3); padding: 0.1rem 0.3rem; border-radius: 3px; color: #fbbf24; font-size: 0.75rem; }

.bm-helix-card {
  background: linear-gradient(135deg, rgba(96, 165, 250, 0.08), rgba(167, 139, 250, 0.05));
  border: 1px solid rgba(96, 165, 250, 0.25);
  border-radius: 10px;
  padding: 1rem 1.25rem;
}
.bm-helix-grid {
  display: grid; grid-template-columns: auto 1fr;
  gap: 1.25rem; align-items: center;
}
.bm-helix-stat { text-align: center; }
.bm-helix-disclosure { color: #cbd5e1; font-size: 0.85rem; line-height: 1.5; }

.bm-section-title {
  font-size: 0.85rem; font-weight: 700; color: #94a3b8;
  letter-spacing: 0.05em; text-transform: uppercase;
  margin: 0 0 0.5rem;
}

.bm-stat-val { font-size: 1.5rem; font-weight: 800; font-family: var(--font-mono, monospace); }
.bm-stat-val.good { color: #4ade80; }
.bm-stat-val.neutral { color: #fbbf24; }
.bm-stat-val.bad { color: #f87171; }
.bm-stat-lbl { font-size: 0.7rem; color: #64748b; text-transform: uppercase; }

/* Table */
.bm-table-wrap { overflow-x: auto; background: #0f1623; border-radius: 8px; border: 1px solid #1e2d40; }
.bm-table { width: 100%; border-collapse: collapse; font-size: 0.78rem; color: #cbd5e1; }
.bm-table th {
  background: #0a0d14; color: #64748b;
  font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em;
  padding: 0.5rem 0.5rem; text-align: left;
  border-bottom: 1px solid #1e2d40;
  position: sticky; top: 0;
}
.bm-th-strategy { min-width: 220px; }
.bm-table td { padding: 0.5rem 0.5rem; border-bottom: 1px solid #111827; vertical-align: middle; }
.bm-table tr:hover td { background: rgba(30, 45, 64, 0.4); }
.bm-row-strong td { background: rgba(34, 197, 94, 0.04); }
.bm-row-strong:hover td { background: rgba(34, 197, 94, 0.08); }
.bm-row-mild td { background: rgba(251, 191, 36, 0.03); }
.ta-r { text-align: right; }

.bm-strat-cell { display: flex; gap: 0.5rem; align-items: center; }
.bm-strat-emoji { font-size: 1.2rem; }
.bm-strat-title { font-weight: 600; color: #e2e8f0; font-size: 0.82rem; line-height: 1.3; }
.bm-strat-id { font-size: 0.65rem; color: #64748b; font-family: monospace; }

.bm-status { font-size: 0.65rem; padding: 0.15rem 0.4rem; border-radius: 3px; font-weight: 700; }
.bm-status-canon { background: rgba(34, 197, 94, 0.15); color: #4ade80; }
.bm-status-mirror { background: rgba(167, 139, 250, 0.15); color: #a78bfa; }

.bm-candidates { display: flex; gap: 0.2rem; flex-wrap: nowrap; justify-content: flex-end; }
.bm-pair-chip {
  background: #1e2d40; color: #cbd5e1;
  padding: 0.1rem 0.35rem; border-radius: 3px;
  font-family: monospace; font-size: 0.7rem;
}
.bm-more { font-size: 0.7rem; color: #64748b; padding: 0.1rem 0.3rem; }

.bm-hr { font-family: monospace; color: #e2e8f0; font-weight: 700; }
.bm-ci { font-family: monospace; font-size: 0.7rem; color: #94a3b8; }

.bm-edge-strong { color: #4ade80; font-weight: 700; }
.bm-edge-mild { color: #fbbf24; }
.bm-edge-neutral { color: #cbd5e1; }
.bm-edge-negative { color: #f87171; }

.bm-empty, .bm-loading {
  padding: 3rem 1rem; text-align: center;
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 10px;
  color: #64748b; font-size: 0.9rem;
}
.bm-empty p { margin: 0.25rem 0; }

/* POINT 3: Diff card */
.bm-diff-card {
  background: linear-gradient(135deg, rgba(96, 165, 250, 0.05), rgba(167, 139, 250, 0.04));
  border: 1px solid rgba(96, 165, 250, 0.2);
  border-radius: 10px; padding: 1.25rem 1.5rem;
}
.bm-diff-help { font-size: 0.8rem; color: #94a3b8; line-height: 1.5; margin: 0.25rem 0 1rem; }
.bm-diff-grid {
  display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.4fr);
  gap: 1.25rem;
}
.bm-diff-col { display: flex; flex-direction: column; gap: 0.5rem; }
.bm-diff-lbl { font-size: 0.75rem; color: #94a3b8; }
.bm-textarea {
  background: #0a0d14; color: #e2e8f0;
  border: 1px solid #1e2d40; border-radius: 6px;
  padding: 0.6rem 0.8rem; font-family: monospace; font-size: 0.85rem;
  resize: vertical;
}
.bm-textarea:focus { border-color: #60a5fa; outline: none; }

.bm-diff-result { display: flex; flex-direction: column; gap: 0.6rem; }
.bm-diff-metrics {
  display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.5rem;
}
.bm-diff-metric {
  background: rgba(0,0,0,0.3); border-radius: 6px;
  padding: 0.6rem; text-align: center;
}
.bm-diff-val {
  font-size: 1.3rem; font-weight: 800;
  font-family: var(--font-mono, monospace);
}
.bm-diff-val.good    { color: #4ade80; }
.bm-diff-val.neutral { color: #fbbf24; }
.bm-diff-val.bad     { color: #f87171; }
.bm-diff-lbl-sm { font-size: 0.65rem; color: #64748b; text-transform: uppercase; margin-top: 0.2rem; }

.bm-diff-table {
  width: 100%; border-collapse: collapse;
  font-size: 0.78rem; color: #cbd5e1;
  background: rgba(0,0,0,0.3); border-radius: 6px; overflow: hidden;
}
.bm-diff-table th, .bm-diff-table td {
  padding: 0.35rem 0.6rem; text-align: left;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.bm-diff-table th {
  font-size: 0.65rem; color: #64748b; text-transform: uppercase;
  background: rgba(0,0,0,0.4);
}
.bm-mono { font-family: monospace; }

.bm-diff-sets { font-size: 0.78rem; color: #cbd5e1; line-height: 1.6; }
.bm-diff-sets code { background: rgba(0,0,0,0.3); padding: 0.1rem 0.35rem; border-radius: 3px; color: #fbbf24; }

/* POINT 4: Timeseries card */
.bm-ts-card {
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 10px;
  padding: 1.25rem 1.5rem;
}
.bm-ts-controls { display: flex; gap: 0.5rem; margin-bottom: 1rem; flex-wrap: wrap; }
.bm-ts-chart {
  background: rgba(0,0,0,0.2); border-radius: 8px;
  padding: 1rem 0.75rem 0.5rem;
  position: relative;
}
.bm-ts-baseline {
  position: absolute; left: 0.75rem; top: 0.5rem;
  font-size: 0.65rem; color: #64748b;
}
.bm-ts-bars {
  display: flex; gap: 2px; align-items: flex-end;
  height: 120px; overflow-x: auto;
  border-bottom: 1px dashed #1e2d40;
}
.bm-ts-bar-wrap { display: flex; flex-direction: column; align-items: center; min-width: 28px; }
.bm-ts-bar {
  width: 22px; border-radius: 2px 2px 0 0;
  transition: opacity 0.15s; cursor: pointer;
}
.bm-ts-bar:hover { opacity: 0.7; }
.bm-ts-bar.good { background: #4ade80; }
.bm-ts-bar.neutral { background: #fbbf24; }
.bm-ts-bar.bad { background: #f87171; }
.bm-ts-label {
  font-size: 0.55rem; color: #64748b;
  margin-top: 0.25rem; transform: rotate(-45deg);
  transform-origin: top right;
  white-space: nowrap;
}
</style>
