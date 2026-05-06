<template>
  <div class="momentum-view">
    <div class="page-header">
      <div>
        <h1 class="page-title">📈 Fuerza de Tendencia Pro</h1>
        <span class="page-subtitle">Fórmula exacta Ballbot · freq_reciente / freq_histórica · ventana 30 sorteos</span>
      </div>
      <div class="controls">
        <select v-model="gameType" class="ctrl-select" @change="fetch">
          <option value="pick3">Pick 3</option>
          <option value="pick4">Pick 4</option>
        </select>
        <select v-model="drawType" class="ctrl-select" @change="fetch">
          <option value="midday">Midday</option>
          <option value="evening">Evening</option>
        </select>
        <select v-model="half" class="ctrl-select" @change="fetch">
          <option v-if="gameType === 'pick3'" value="du">D+U</option>
          <option v-if="gameType === 'pick4'" value="ab">AB</option>
          <option v-if="gameType === 'pick4'" value="cd">CD</option>
        </select>
        <select v-model="topN" class="ctrl-select" @change="fetch">
          <option :value="10">Top 10</option>
          <option :value="15">Top 15</option>
          <option :value="20">Top 20</option>
          <option :value="25">Top 25</option>
        </select>
        <button class="btn-refresh" @click="fetch" :disabled="loading">
          {{ loading ? '⏳' : '↻' }} Actualizar
        </button>
      </div>
    </div>

    <div v-if="loading" class="loading">Calculando momentum...</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="data">

      <!-- ── Métricas de backtesting ──────────────────────────────── -->
      <div class="metrics-grid">
        <div class="metric-card" :class="data.backtest.vs_azar > 0 ? 'metric-card--green' : ''">
          <div class="metric-label">Hit Rate (backtest)</div>
          <div class="metric-value">{{ pct(data.backtest.hit_rate) }}</div>
          <div class="metric-sub" :class="data.backtest.vs_azar > 0 ? 'text-green' : 'text-red'">
            {{ data.backtest.vs_azar >= 0 ? '+' : '' }}{{ pct(data.backtest.vs_azar) }} vs azar
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Hits / Total</div>
          <div class="metric-value">{{ data.backtest.hits }}/{{ data.backtest.sample_size }}</div>
          <div class="metric-sub">sorteos evaluados</div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Rank promedio ganador</div>
          <div class="metric-value">{{ data.backtest.avg_rank?.toFixed(1) ?? '—' }}</div>
          <div class="metric-sub">posición en ranking</div>
        </div>
        <div class="metric-card" :class="data.backtest.is_profitable ? 'metric-card--gold' : ''">
          <div class="metric-label">N óptimo (ROI ≥ 1%)</div>
          <div class="metric-value">{{ data.backtest.optimal_n }}</div>
          <div class="metric-sub">
            <span v-if="data.backtest.is_profitable" class="text-green">✓ Rentable</span>
            <span v-else class="text-muted">sin borde suficiente aún</span>
          </div>
        </div>
        <div class="metric-card">
          <div class="metric-label">Sorteos históricos</div>
          <div class="metric-value">{{ data.total_draws }}</div>
          <div class="metric-sub">ventana reciente: {{ data.recent_window }}</div>
        </div>
      </div>

      <!-- ── ROI por N — gráfica de barras ───────────────────────── -->
      <section class="section">
        <h2 class="section-title">ROI esperado por tamaño N <span class="badge">Florida $50 payout</span></h2>
        <div class="n-scan-chart">
          <div v-for="row in data.backtest.n_scan" :key="row.n" class="n-bar-wrap">
            <div class="n-bar-container">
              <div class="n-bar"
                   :style="`height: ${Math.max(2, Math.min(100, (row.hit_rate * 100) * 3))}%`"
                   :class="row.roi >= 0.01 ? 'n-bar--profit' : row.roi >= 0 ? 'n-bar--neutral' : 'n-bar--loss'"
                   :title="`N=${row.n} hit=${pct(row.hit_rate)} ROI=${(row.roi*100).toFixed(1)}%`">
              </div>
            </div>
            <div class="n-label">{{ row.n }}</div>
            <div class="n-roi" :class="row.roi >= 0.01 ? 'text-green' : row.roi >= 0 ? 'text-yellow' : 'text-muted'">
              {{ row.roi >= 0 ? '+' : '' }}{{ (row.roi * 100).toFixed(0) }}%
            </div>
          </div>
        </div>
      </section>

      <!-- ── Candidatos actuales con momentum ────────────────────── -->
      <section class="section">
        <h2 class="section-title">Candidatos AHORA <span class="badge">momentum ≥ 1.0x · sorteos recientes vs histórico</span></h2>
        <div class="candidates-table">
          <div class="candidates-header">
            <span>Par</span><span>Momentum</span><span>Reciente</span><span>Histórico</span><span>Apariciones</span><span>Señal</span>
          </div>
          <div v-for="c in data.top_candidates" :key="c.pair" class="candidates-row"
               :class="c.momentum >= 3 ? 'row--hot' : c.momentum >= 1.5 ? 'row--warm' : ''">
            <span class="pair-chip">{{ c.pair }}</span>
            <span class="momentum-val" :class="momentumClass(c.momentum)">
              {{ c.momentum.toFixed(2) }}x
            </span>
            <span>{{ pct(c.freq_recent) }}</span>
            <span class="text-muted">{{ pct(c.freq_all) }}</span>
            <span class="text-muted">{{ c.count_recent }}/{{ c.count_all }}</span>
            <span class="signal-arrow" :class="momentumClass(c.momentum)">
              {{ c.momentum >= 3 ? '↑↑↑' : c.momentum >= 1.5 ? '↑↑' : '↑' }}
            </span>
          </div>
        </div>
      </section>

      <!-- ── Timeline de hits/misses ────────────────────────────────── -->
      <section class="section">
        <h2 class="section-title">Timeline backtest <span class="badge">últimos {{ data.backtest.timeline.length }} sorteos</span></h2>
        <div class="timeline-strip">
          <div v-for="t in data.backtest.timeline" :key="t.draw_date"
               class="strip-cell"
               :class="t.hit ? 'strip-cell--hit' : 'strip-cell--miss'"
               :title="`${t.draw_date} · ganador: ${t.winning_pair} · ${t.hit ? 'HIT rank #' + t.rank : 'MISS'} · momentum=${t.momentum_of_winner}x`">
            <span class="strip-pair">{{ t.winning_pair }}</span>
            <span class="strip-rank" v-if="t.hit">#{{ t.rank }}</span>
          </div>
        </div>
        <div class="timeline-legend">
          <span class="legend-hit">■ HIT</span>
          <span class="legend-miss">■ MISS</span>
          <span class="text-muted">Hover para ver detalles</span>
        </div>
      </section>

    </template>
  </div>
</template>

<script setup>
import { ref, watch, onMounted } from 'vue';
import { apiFetch } from '../../utils/apiClient.js';

const gameType = ref('pick3');
const drawType = ref('evening');
const half     = ref('du');
const topN     = ref(15);
const data     = ref(null);
const loading  = ref(false);
const error    = ref('');

watch(gameType, () => {
  half.value = gameType.value === 'pick3' ? 'du' : 'ab';
  fetch();
});

async function fetch() {
  loading.value = true;
  error.value   = '';
  try {
    const res = await apiFetch(
      `/api/agent/trend-momentum?game_type=${gameType.value}&draw_type=${drawType.value}&half=${half.value}&top_n=${topN.value}&eval_last=90`
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data.value = await res.json();
  } catch (e) {
    error.value = e.message ?? 'Error cargando momentum';
  } finally {
    loading.value = false;
  }
}

onMounted(fetch);

function pct(v) {
  if (v == null || isNaN(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function momentumClass(m) {
  if (m >= 3)   return 'text-hot';
  if (m >= 1.5) return 'text-warm';
  return 'text-up';
}
</script>

<style scoped>
.momentum-view { max-width: 1100px; }

.page-header {
  display: flex; justify-content: space-between; align-items: flex-start;
  flex-wrap: wrap; gap: 1rem; margin-bottom: 1.5rem;
}
.page-title { font-size: 1.5rem; font-weight: 700; color: #e2e8f0; margin: 0; }
.page-subtitle { font-size: 0.82rem; color: #64748b; }

.controls { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }
.ctrl-select {
  background: #0f1623; border: 1px solid #1e2d40; color: #e2e8f0;
  padding: 0.4rem 0.75rem; border-radius: 6px; font-size: 0.82rem;
}
.btn-refresh {
  background: #1d4ed8; color: white; border: none; border-radius: 6px;
  padding: 0.4rem 1rem; font-size: 0.82rem; cursor: pointer;
}
.btn-refresh:disabled { opacity: 0.5; }

/* ── Metrics ─────────────────────────────────────────────────── */
.metrics-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
  gap: 1rem; margin-bottom: 2rem;
}
.metric-card {
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 12px; padding: 1rem;
}
.metric-card--green { border-color: #166534; }
.metric-card--gold  { border-color: #92400e; background: #1a1005; }
.metric-label { font-size: 0.72rem; color: #64748b; text-transform: uppercase; margin-bottom: 0.35rem; }
.metric-value { font-size: 1.6rem; font-weight: 700; color: #e2e8f0; line-height: 1; }
.metric-sub   { font-size: 0.75rem; margin-top: 0.3rem; color: #64748b; }

/* ── N-scan chart ────────────────────────────────────────────── */
.section { margin-bottom: 2rem; }
.section-title {
  font-size: 0.9rem; font-weight: 600; color: #94a3b8;
  margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem;
}
.badge {
  background: #1d3a5f; color: #60a5fa; font-size: 0.68rem;
  font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 999px;
}

.n-scan-chart {
  display: flex; align-items: flex-end; gap: 4px; height: 120px;
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 10px;
  padding: 1rem; overflow-x: auto;
}
.n-bar-wrap { display: flex; flex-direction: column; align-items: center; gap: 2px; min-width: 28px; }
.n-bar-container { height: 70px; display: flex; align-items: flex-end; }
.n-bar { width: 18px; border-radius: 3px 3px 0 0; min-height: 2px; transition: height 0.3s; }
.n-bar--profit  { background: #22c55e; }
.n-bar--neutral { background: #f59e0b; }
.n-bar--loss    { background: #475569; }
.n-label { font-size: 0.65rem; color: #64748b; }
.n-roi   { font-size: 0.6rem; font-weight: 600; }

/* ── Candidates table ────────────────────────────────────────── */
.candidates-table { background: #0f1623; border: 1px solid #1e2d40; border-radius: 10px; overflow: hidden; }
.candidates-header, .candidates-row {
  display: grid;
  grid-template-columns: 50px 90px 80px 80px 100px 70px;
  padding: 0.5rem 0.85rem;
  font-size: 0.82rem;
  gap: 0.5rem;
  align-items: center;
}
.candidates-header { background: #131b2a; color: #64748b; font-size: 0.72rem; text-transform: uppercase; font-weight: 600; border-bottom: 1px solid #1e2d40; }
.candidates-row { border-bottom: 1px solid #131b2a; }
.candidates-row:last-child { border-bottom: none; }
.row--hot  { background: #0f180a; }
.row--warm { background: #0d1510; }
.pair-chip { font-family: monospace; font-weight: 700; font-size: 0.9rem; color: #e2e8f0; }
.momentum-val { font-weight: 700; font-family: monospace; }
.signal-arrow { font-weight: 900; font-size: 0.9rem; }

/* ── Timeline ────────────────────────────────────────────────── */
.timeline-strip {
  display: flex; flex-wrap: wrap; gap: 4px;
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 10px; padding: 0.85rem;
}
.strip-cell {
  display: flex; flex-direction: column; align-items: center;
  width: 36px; padding: 4px 3px; border-radius: 5px; cursor: default;
}
.strip-cell--hit  { background: #052e16; }
.strip-cell--miss { background: #1a1010; }
.strip-pair { font-family: monospace; font-size: 0.72rem; font-weight: 700;
              color: #94a3b8; }
.strip-cell--hit .strip-pair  { color: #4ade80; }
.strip-rank { font-size: 0.6rem; color: #4ade80; font-weight: 600; }

.timeline-legend { display: flex; gap: 1rem; margin-top: 0.5rem; font-size: 0.75rem; }
.legend-hit  { color: #4ade80; }
.legend-miss { color: #7f1d1d; }

/* ── Colors ──────────────────────────────────────────────────── */
.text-green  { color: #22c55e; }
.text-yellow { color: #f59e0b; }
.text-red    { color: #ef4444; }
.text-muted  { color: #64748b; }
.text-hot    { color: #ef4444; }
.text-warm   { color: #fb923c; }
.text-up     { color: #60a5fa; }

.loading { color: #60a5fa; padding: 3rem; text-align: center; }
.error   { color: #ef4444; padding: 1rem; background: #1f1010; border-radius: 8px; }
</style>
