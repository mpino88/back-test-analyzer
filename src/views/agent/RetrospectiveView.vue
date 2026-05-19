<template>
  <div class="retro">
    <header class="retro-header">
      <h1>🔬 Validación Retrospectiva & Patrones</h1>
      <p class="subtitle">Métricas honestas calculadas sobre snapshots históricos reales — sin inflación.</p>
    </header>

    <!-- Controls -->
    <div class="controls">
      <select v-model="game_type" class="ctl">
        <option value="pick3">Pick 3</option>
        <option value="pick4">Pick 4</option>
      </select>
      <select v-model="draw_type" class="ctl">
        <option value="midday">Midday</option>
        <option value="evening">Evening</option>
      </select>
      <select v-model="half" class="ctl">
        <option value="du">DU (Pick3)</option>
        <option value="ab">AB (Pick4)</option>
        <option value="cd">CD (Pick4)</option>
      </select>
      <select v-model="days" class="ctl">
        <option :value="30">30 días</option>
        <option :value="90">90 días</option>
        <option :value="180">180 días</option>
        <option :value="365">365 días</option>
      </select>
      <button class="btn-primary" :disabled="loading" @click="loadAll">
        {{ loading ? 'Cargando…' : '🔄 Ejecutar análisis' }}
      </button>
    </div>

    <div v-if="error" class="error-box">⚠️ {{ error }}</div>

    <!-- ── Snapshot Backfill Panel ─────────────────────────────── -->
    <section class="section section--backfill">
      <div class="backfill-header">
        <div>
          <h2 class="backfill-title">⚡ Backfill Histórico</h2>
          <p class="backfill-sub">
            Genera snapshots point-in-time desde <code>ingested_results</code> para todas las fechas sin cobertura.
            Solo usa datos disponibles en cada fecha (sin data leakage).
          </p>
        </div>
        <div class="backfill-actions">
          <select v-model="backfillDays" class="ctl ctl--sm">
            <option :value="90">90 días</option>
            <option :value="180">180 días</option>
            <option :value="365">365 días</option>
            <option :value="730">2 años</option>
          </select>
          <button class="btn-backfill" :disabled="backfilling" @click="startBackfill">
            {{ backfilling ? `⟳ ${backfillProgress.pct}% (${backfillProgress.date})` : '🚀 Generar snapshots' }}
          </button>
          <button class="btn-status" @click="loadBackfillStatus">📊 Estado</button>
        </div>
      </div>

      <!-- Coverage status -->
      <div v-if="backfillStatus" class="coverage-bar-wrap">
        <div class="coverage-label">
          Cobertura: <strong>{{ backfillStatus.coverage_pct }}%</strong>
          ({{ backfillStatus.snapshots.total_dates }} fechas con snapshots /
           {{ backfillStatus.ingested_results_total }} sorteos totales)
        </div>
        <div class="coverage-track">
          <div
            class="coverage-fill"
            :style="{ width: backfillStatus.coverage_pct + '%' }"
            :class="backfillStatus.coverage_pct >= 80 ? 'fill--ok' : backfillStatus.coverage_pct >= 40 ? 'fill--mid' : 'fill--low'"
          ></div>
        </div>
        <div class="coverage-meta" v-if="backfillStatus.snapshots.total_dates > 0">
          {{ backfillStatus.snapshots.earliest }} → {{ backfillStatus.snapshots.latest }}
          · {{ backfillStatus.snapshots.algos?.length ?? 0 }} algoritmos cubiertos
        </div>
      </div>

      <!-- Backfill progress -->
      <div v-if="backfillResult" class="backfill-result" :class="backfillResult.error ? 'result--error' : 'result--ok'">
        <template v-if="backfillResult.error">⚠️ {{ backfillResult.error }}</template>
        <template v-else>
          ✅ Completado — {{ backfillResult.dates_processed }} fechas procesadas,
          {{ backfillResult.dates_skipped }} ya existían,
          {{ backfillResult.total_snapshots }} snapshots generados
          en {{ (backfillResult.duration_ms / 1000).toFixed(1) }}s.
          <button class="btn-primary btn-sm" @click="loadAll" style="margin-left:1rem">🔄 Validar ahora</button>
        </template>
      </div>
    </section>

    <!-- Validación retrospectiva -->
    <section v-if="metrics" class="section">
      <h2>📊 Performance del Consensus (snapshots reales)</h2>
      <div v-if="metrics.total_draws_evaluated === 0" class="empty">
        Sin snapshots históricos disponibles para este período. Ejecuta el backfill ↑
        <br/>
        <small>
          Los snapshots se acumulan automáticamente con cada predicción del agente.
          Espera a que el sistema procese algunos sorteos.
        </small>
      </div>
      <div v-else class="metrics-grid">
        <div class="metric-card">
          <div class="metric-label">Sorteos evaluados</div>
          <div class="metric-value">{{ metrics.total_draws_evaluated }}</div>
          <!-- FIX: optional chaining — date_range puede ser null si backtest es nuevo -->
          <div class="metric-detail">{{ metrics.date_range?.from ?? '—' }} → {{ metrics.date_range?.to ?? '—' }}</div>
        </div>
        <div class="metric-card" :class="metrics.consensus.has_edge ? 'card-edge' : 'card-no-edge'">
          <div class="metric-label">Hit Rate @15</div>
          <div class="metric-value">{{ (metrics.consensus.hit_rate_at_15 * 100).toFixed(1) }}%</div>
          <div class="metric-detail">Baseline aleatorio: {{ (metrics.random_baseline_at_15 * 100).toFixed(0) }}%</div>
        </div>
        <div class="metric-card" :class="metrics.consensus.has_edge ? 'card-edge' : 'card-no-edge'">
          <div class="metric-label">Edge sobre azar</div>
          <div class="metric-value">{{ (metrics.consensus.edge_at_15 * 100 >= 0 ? '+' : '') }}{{ (metrics.consensus.edge_at_15 * 100).toFixed(1) }}pp</div>
          <div class="metric-detail">{{ metrics.consensus.has_edge ? '🟢 borde medible' : '🟡 sin borde aún' }}</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Hit Rate @5</div>
          <div class="metric-value">{{ (metrics.consensus.hit_rate_at_5 * 100).toFixed(1) }}%</div>
          <div class="metric-detail">Baseline @5: 5%</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Rango esperado</div>
          <div class="metric-value">{{ metrics.consensus.expected_rank.toFixed(1) }}</div>
          <div class="metric-detail">Posición media del ganador</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">MRR</div>
          <div class="metric-value">{{ metrics.consensus.mrr.toFixed(3) }}</div>
          <div class="metric-detail">Mean Reciprocal Rank</div>
        </div>
      </div>
    </section>

    <!-- Per-algorithm -->
    <section v-if="metrics && metrics.per_algorithm.length > 0" class="section">
      <h2>🔍 Performance por Algoritmo</h2>
      <table class="ptable">
        <thead>
          <tr>
            <th>Algoritmo</th>
            <th>n</th>
            <th>Hit@1</th>
            <th>Hit@5</th>
            <th>Hit@15</th>
            <th>Edge</th>
            <th>Rank Esp.</th>
            <th>MRR</th>
            <th>Status</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in metrics.per_algorithm" :key="a.algo" :class="`row-${a.health_status}`">
            <td class="algo-name">{{ a.algo }}</td>
            <td>{{ a.samples }}</td>
            <td>{{ (a.hit_rate_at_1 * 100).toFixed(1) }}%</td>
            <td>{{ (a.hit_rate_at_5 * 100).toFixed(1) }}%</td>
            <td><strong>{{ (a.hit_rate_at_15 * 100).toFixed(1) }}%</strong></td>
            <td :class="a.has_edge ? 'edge-yes' : 'edge-no'">
              {{ a.edge_at_15 >= 0 ? '+' : '' }}{{ (a.edge_at_15 * 100).toFixed(1) }}pp
            </td>
            <td>{{ a.expected_rank.toFixed(1) }}</td>
            <td>{{ a.mrr.toFixed(3) }}</td>
            <td>
              <span class="badge" :class="`badge-${a.health_status}`">
                {{ a.health_status === 'healthy' ? '🟢' : a.health_status === 'degraded' ? '🟡' : '🔴' }}
                {{ a.health_status }}
              </span>
            </td>
          </tr>
        </tbody>
      </table>
    </section>

    <!-- Patrones -->
    <section v-if="patterns" class="section">
      <div class="patterns-meta-header">
        <h2>🔬 Patrones Empíricos</h2>
        <span class="patterns-meta">
          {{ patterns.total_draws ?? '?' }} sorteos
          <template v-if="patterns.date_range?.from">
            · {{ patterns.date_range.from }} → {{ patterns.date_range.to }}
          </template>
          <template v-if="patterns.computed_at">
            · calc. {{ formatDate(patterns.computed_at) }}
          </template>
        </span>
      </div>

      <h3 class="subhead">📅 Sesgos por día de la semana</h3>
      <div v-if="patterns.dow_biases.every(b => !b.significant)" class="info-box">
        Ningún sesgo día-semana con χ² significativo (sistema parece estadísticamente justo en ese eje).
      </div>
      <ul v-else class="bias-list">
        <li v-for="b in patterns.dow_biases.filter(x => x.significant)" :key="b.position">
          <strong>{{ b.position.toUpperCase() }}</strong> — χ² = {{ b.chi_square.toFixed(2) }} (p &lt; {{ b.p_value_lt }})
          <div class="bias-detail" v-if="b.hottest.length > 0">
            Top combos: <span v-for="(c, i) in b.hottest.slice(0, 3)" :key="i" class="combo">
              {{ c.day }} digit={{ c.digit }} ({{ (c.pct * 100).toFixed(1) }}%, lift {{ c.lift.toFixed(2) }}x)
            </span>
          </div>
        </li>
      </ul>

      <!-- month_biases: returned by PatternMiner but previously unredered -->
      <h3 class="subhead">📆 Sesgos por mes</h3>
      <div v-if="!patterns.month_biases || patterns.month_biases.every(b => !b.significant)" class="info-box">
        Ningún sesgo mensual con χ² significativo en este combo.
      </div>
      <ul v-else class="bias-list">
        <li v-for="b in patterns.month_biases.filter(x => x.significant)" :key="b.position">
          <strong>{{ b.position.toUpperCase() }}</strong> — χ² = {{ b.chi_square.toFixed(2) }} (p &lt; {{ b.p_value_lt }})
          <div class="bias-detail" v-if="b.hottest.length > 0">
            Top combos: <span v-for="(c, i) in b.hottest.slice(0, 3)" :key="i" class="combo">
              {{ c.month || c.day }} digit={{ c.digit }} ({{ (c.pct * 100).toFixed(1) }}%, lift {{ c.lift.toFixed(2) }}x)
            </span>
          </div>
        </li>
      </ul>

      <h3 class="subhead">🔁 Autocorrelaciones</h3>
      <table class="ptable">
        <thead>
          <tr>
            <th>Posición</th>
            <th>Lag 1</th>
            <th>Lag 2</th>
            <th>Lag 7</th>
            <th>Lag 30</th>
            <th>Interpretación</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="a in patterns.autocorrelations" :key="a.position">
            <td>{{ a.position }}</td>
            <td>{{ a.lag_1.toFixed(3) }}</td>
            <td>{{ a.lag_2.toFixed(3) }}</td>
            <td>{{ a.lag_7.toFixed(3) }}</td>
            <td>{{ a.lag_30.toFixed(3) }}</td>
            <td class="interp">{{ a.interpretation }}</td>
          </tr>
        </tbody>
      </table>

      <h3 class="subhead">⏳ Distribución de intervalos entre apariciones de pares</h3>
      <div v-for="r in patterns.pair_revisits" :key="r.half" class="revisit-box">
        <div class="revisit-header">
          <strong>Half: {{ r.half.toUpperCase() }}</strong>
          <span class="revisit-meta">
            n={{ r.total_pairs }} pares · media={{ r.mean_gap.toFixed(1) }}d · mediana={{ r.median_gap }}d · p25={{ r.p25_gap }}d · p75={{ r.p75_gap }}d
          </span>
        </div>
        <div class="revisit-examples">
          Top vencidos:
          <span v-for="ex in r.examples.slice(0, 5)" :key="ex.pair" class="due-pair">
            <strong>{{ ex.pair }}</strong> (gap {{ ex.current_gap }}d, media {{ ex.mean_gap }}d, {{ ex.due_score.toFixed(2) }}× due)
          </span>
        </div>
      </div>

      <h3 class="subhead">🔥 Streaks Notables</h3>
      <div v-if="patterns.streak_summary.length === 0" class="info-box">Sin streaks significativos.</div>
      <table v-else class="ptable">
        <thead>
          <tr>
            <th>Posición</th>
            <th>Dígito</th>
            <th>Streaks totales</th>
            <th>Media</th>
            <th>Máx observado</th>
            <th>Actual</th>
            <th>P(extender)</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="s in patterns.streak_summary.slice(0, 10)" :key="`${s.position}-${s.digit}`">
            <td>{{ s.position }}</td>
            <td>{{ s.digit }}</td>
            <td>{{ s.total_streaks }}</td>
            <td>{{ s.mean_length.toFixed(2) }}</td>
            <td><strong>{{ s.max_observed }}</strong></td>
            <td>{{ s.current_streak }}</td>
            <td>{{ (s.p_extend * 100).toFixed(0) }}%</td>
          </tr>
        </tbody>
      </table>
    </section>

    <footer class="retro-footer">
      <small>
        🔬 Calculado sobre {{ metrics?.total_draws_evaluated ?? 0 }} sorteos con snapshots reales.
        Última actualización: {{ formatDate(metrics?.computed_at) }}.
      </small>
    </footer>
  </div>
</template>

<script setup>
import { ref } from 'vue';
import { apiGet } from '../../utils/apiClient.js';

const game_type = ref('pick3');
const draw_type = ref('evening');
const half      = ref('du');
const days      = ref(90);
const loading   = ref(false);
const error     = ref('');
const metrics   = ref(null);
const patterns  = ref(null);

// ── Snapshot Backfill ──────────────────────────────────────────
const backfillDays     = ref(365);
const backfilling      = ref(false);
const backfillProgress = ref({ pct: 0, date: '' });
const backfillResult   = ref(null);
const backfillStatus   = ref(null);

async function loadBackfillStatus() {
  try {
    backfillStatus.value = await apiGet(
      `/api/agent/snapshot-backfill/status?game_type=${game_type.value}&draw_type=${draw_type.value}&half=${half.value}`
    );
  } catch { /* silent */ }
}

async function startBackfill() {
  backfilling.value    = true;
  backfillResult.value = null;
  backfillProgress.value = { pct: 0, date: '' };

  try {
    const res = await fetch('/api/agent/snapshot-backfill', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'text/event-stream' },
      body: JSON.stringify({
        game_type: game_type.value,
        draw_type: draw_type.value,
        half:      half.value,
        days_back: backfillDays.value,
        period:    backfillDays.value,
      }),
    });

    const reader = res.body?.getReader();
    const decoder = new TextDecoder();
    if (!reader) throw new Error('No SSE stream');

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const text = decoder.decode(value);
      for (const line of text.split('\n')) {
        if (!line.startsWith('data:')) continue;
        try {
          const evt = JSON.parse(line.slice(5).trim());
          if (evt.type === 'progress') backfillProgress.value = { pct: evt.pct, date: evt.date };
          if (evt.type === 'complete') { backfillResult.value = evt; await loadBackfillStatus(); }
          if (evt.type === 'error')    { backfillResult.value = { error: evt.message }; }
        } catch { /* json parse error */ }
      }
    }
  } catch (e) {
    backfillResult.value = { error: e.message };
  } finally {
    backfilling.value = false;
  }
}

async function loadAll() {
  loading.value = true;
  error.value   = '';
  try {
    const [m, p] = await Promise.all([
      apiGet(`/api/agent/retrospective/validate?game_type=${game_type.value}&draw_type=${draw_type.value}&half=${half.value}&days=${days.value}`),
      apiGet(`/api/agent/patterns/mine?game_type=${game_type.value}&draw_type=${draw_type.value}`),
    ]);
    metrics.value  = m;
    patterns.value = p;
  } catch (e) {
    error.value = e?.message || String(e);
  } finally {
    loading.value = false;
  }
}

function formatDate(iso) {
  if (!iso) return '';
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

loadAll();
loadBackfillStatus();
</script>

<style scoped>
.retro { padding: 1rem 1.5rem; color: #e2e8f0; max-width: 1400px; margin: 0 auto; }
.retro-header { margin-bottom: 1.5rem; }
.retro-header h1 { margin: 0 0 0.25rem; font-size: 1.5rem; color: #4a9eff; }
.subtitle { color: #94a3b8; font-size: 0.9rem; margin: 0; }

.controls { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.5rem; align-items: center; }
.ctl { background: #0f1623; border: 1px solid #1e2d40; color: #e2e8f0; padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.875rem; }
.btn-primary { background: #1d4ed8; color: #fff; border: 0; padding: 0.5rem 1.25rem; border-radius: 8px; font-weight: 600; cursor: pointer; }
.btn-primary:disabled { background: #334155; cursor: not-allowed; }
.error-box { background: #3b1f1f; border: 1px solid #7f1d1d; color: #fca5a5; padding: 0.75rem 1rem; border-radius: 8px; margin-bottom: 1rem; }

.section { background: #0f1623; border: 1px solid #1e2d40; border-radius: 12px; padding: 1.25rem; margin-bottom: 1.25rem; }
.section h2 { margin: 0 0 1rem; font-size: 1.1rem; color: #cbd5e1; }
.subhead { margin: 1.25rem 0 0.5rem; font-size: 0.95rem; color: #94a3b8; font-weight: 600; }

.metrics-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 0.75rem; }
.metric-card { background: #0a1018; border: 1px solid #1e2d40; border-radius: 10px; padding: 0.85rem 1rem; }
.metric-label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
.metric-value { font-size: 1.6rem; font-weight: 700; color: #e2e8f0; margin: 0.25rem 0; }
.metric-detail { font-size: 0.75rem; color: #64748b; }
.card-edge { border-color: #16a34a; }
.card-no-edge { border-color: #ca8a04; }

.empty { text-align: center; padding: 2rem 1rem; color: #94a3b8; }
.empty small { display: block; margin-top: 0.5rem; font-size: 0.75rem; color: #64748b; }

.ptable { width: 100%; border-collapse: collapse; font-size: 0.825rem; }
.ptable th, .ptable td { padding: 0.5rem 0.65rem; text-align: left; border-bottom: 1px solid #1e2d40; }
.ptable th { background: #1a2434; color: #94a3b8; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.04em; }
.ptable td { color: #e2e8f0; }
.algo-name { font-family: monospace; color: #4a9eff; }
.edge-yes { color: #4ade80; font-weight: 600; }
.edge-no { color: #ca8a04; }
.row-degraded { background: #1a1408; }
.row-disabled { background: #1f0c0c; opacity: 0.65; }

.badge { padding: 0.15rem 0.5rem; border-radius: 9999px; font-size: 0.7rem; font-weight: 600; }
.badge-healthy { background: #14532d; color: #4ade80; }
.badge-degraded { background: #422b03; color: #fbbf24; }
.badge-disabled { background: #4c0519; color: #f87171; }

.info-box { background: #0a1018; border: 1px dashed #1e2d40; padding: 0.75rem 1rem; border-radius: 8px; color: #94a3b8; font-size: 0.85rem; }
.bias-list { list-style: none; padding: 0; margin: 0; }
.bias-list li { padding: 0.5rem 0; border-bottom: 1px solid #1e2d40; }
.bias-detail { margin-top: 0.25rem; font-size: 0.8rem; color: #94a3b8; }
.combo { background: #1a2434; padding: 0.1rem 0.4rem; border-radius: 6px; margin-right: 0.5rem; font-family: monospace; }
.interp { color: #94a3b8; font-style: italic; }

.revisit-box { background: #0a1018; border: 1px solid #1e2d40; border-radius: 8px; padding: 0.75rem 1rem; margin-bottom: 0.5rem; }
.revisit-header { display: flex; justify-content: space-between; align-items: center; flex-wrap: wrap; gap: 0.5rem; }
.revisit-meta { font-size: 0.78rem; color: #94a3b8; font-family: monospace; }
.revisit-examples { margin-top: 0.5rem; font-size: 0.8rem; color: #cbd5e1; }
.due-pair { display: inline-block; background: #1a2434; padding: 0.15rem 0.5rem; border-radius: 6px; margin: 0.15rem 0.25rem 0.15rem 0; font-family: monospace; }
.due-pair strong { color: #fbbf24; }

.retro-footer { margin-top: 1.5rem; text-align: center; color: #64748b; }
.patterns-meta-header { display: flex; justify-content: space-between; align-items: baseline; flex-wrap: wrap; gap: 0.5rem; margin-bottom: 1rem; }
.patterns-meta-header h2 { margin: 0; }
.patterns-meta { font-size: 0.75rem; color: #475569; font-family: monospace; }

/* ── Backfill Panel ─────────────────────────────────────────── */
.section--backfill { border-color: #1d4ed844; background: #040d1a; }
.backfill-header { display: flex; justify-content: space-between; align-items: flex-start; flex-wrap: wrap; gap: 1rem; margin-bottom: 1rem; }
.backfill-title { margin: 0 0 0.25rem; font-size: 1.05rem; color: #60a5fa; }
.backfill-sub   { margin: 0; font-size: 0.78rem; color: #475569; }
.backfill-sub code { background: #0f1623; padding: 0.1rem 0.3rem; border-radius: 4px; color: #94a3b8; }
.backfill-actions { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.ctl--sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
.btn-backfill {
  background: #1d4ed8; color: #fff; border: none; border-radius: 8px;
  padding: 0.5rem 1.25rem; font-size: 0.875rem; font-weight: 600; cursor: pointer;
}
.btn-backfill:disabled { opacity: 0.6; cursor: not-allowed; }
.btn-backfill:hover:not(:disabled) { background: #2563eb; }
.btn-status { background: #1e2d40; color: #94a3b8; border: 1px solid #2d4a6b; border-radius: 8px; padding: 0.4rem 0.75rem; font-size: 0.8rem; cursor: pointer; }
.btn-status:hover { background: #2d4a6b; color: #e2e8f0; }
.btn-sm { padding: 0.3rem 0.75rem; font-size: 0.8rem; }

.coverage-bar-wrap { margin-bottom: 0.75rem; }
.coverage-label { font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.4rem; }
.coverage-track { height: 8px; background: #1e2d40; border-radius: 4px; overflow: hidden; margin-bottom: 0.25rem; }
.coverage-fill  { height: 100%; border-radius: 4px; transition: width 0.5s ease; }
.fill--ok  { background: linear-gradient(90deg, #16a34a, #22c55e); }
.fill--mid { background: linear-gradient(90deg, #854d0e, #f59e0b); }
.fill--low { background: linear-gradient(90deg, #7f1d1d, #ef4444); }
.coverage-meta { font-size: 0.72rem; color: #475569; font-family: monospace; }

.backfill-result { margin-top: 0.75rem; padding: 0.6rem 0.9rem; border-radius: 8px; font-size: 0.82rem; }
.result--ok    { background: #052e1620; color: #4ade80; border: 1px solid #16653444; }
.result--error { background: #1a050520; color: #f87171; border: 1px solid #7f1d1d44; }
</style>
