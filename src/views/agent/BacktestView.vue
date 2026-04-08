<template>
  <div class="bt-page">

    <!-- ── HEADER + CONTROLS ────────────────────────────────── -->
    <div class="bt-header">
      <div class="bt-header__left">
        <h1 class="bt-title">Backtest Analyzer <span class="bt-title__tag">v2</span></h1>
        <p class="bt-subtitle">Análisis histórico de estrategias de pares con 15 métricas de precisión</p>
      </div>
      <div class="bt-controls">
        <select v-model="gameType" class="ctrl-select" @change="fetchResults">
          <option value="pick3">Pick 3</option>
          <option value="pick4">Pick 4</option>
        </select>
        <select v-model="mode" class="ctrl-select" @change="fetchResults">
          <option value="combined">Combined</option>
          <option value="midday">Midday</option>
          <option value="evening">Evening</option>
        </select>
        <select v-if="gameType === 'pick4'" v-model="halfFilter" class="ctrl-select">
          <option value="all">Todas halves</option>
          <option value="ab">AB (p1+p2)</option>
          <option value="cd">CD (p3+p4)</option>
        </select>
        <button class="ctrl-btn ctrl-btn--ghost" :disabled="loading" @click="fetchResults">
          <span :class="loading ? 'spin' : ''">↻</span> Actualizar
        </button>
        <button class="ctrl-btn ctrl-btn--primary" :disabled="running" @click="runBacktest">
          {{ running ? '⚙️ Corriendo...' : '▶ Nuevo backtest' }}
        </button>
      </div>
    </div>

    <!-- run message -->
    <div v-if="runMsg" class="run-msg" :class="runError ? 'run-msg--err' : 'run-msg--ok'">
      {{ runMsg }}
    </div>
    <div v-if="error" class="run-msg run-msg--err">Error al cargar: {{ error }}</div>

    <!-- ── LOADING ───────────────────────────────────────────── -->
    <div v-if="loading" class="bt-loading">
      <div class="loader"></div>
      <span>Cargando resultados...</span>
    </div>

    <!-- ── EMPTY STATE ───────────────────────────────────────── -->
    <div v-else-if="!filtered.length && !loading" class="bt-empty">
      <div class="bt-empty__icon">📭</div>
      <p>No hay resultados de backtest v2 para <strong>{{ gameType }} / {{ mode }}</strong></p>
      <p class="bt-empty__sub">Ejecuta un backtest nuevo con el botón de arriba (tarda ~1-3 min)</p>
    </div>

    <template v-else>

      <!-- ── KPI ROW ────────────────────────────────────────── -->
      <div class="kpi-row">
        <div class="kpi-card kpi-card--highlight">
          <div class="kpi-card__icon">{{ meta(bestStrategy?.strategy_name).icon }}</div>
          <div class="kpi-card__body">
            <div class="kpi-card__label">Mejor estrategia</div>
            <div class="kpi-card__value">{{ meta(bestStrategy?.strategy_name).label }}</div>
            <div class="kpi-card__sub">{{ pct(bestStrategy?.hit_rate) }} hit rate</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-card__icon">🎯</div>
          <div class="kpi-card__body">
            <div class="kpi-card__label">Hit rate promedio</div>
            <div class="kpi-card__value">{{ pct(avgHitRate) }}</div>
            <div class="kpi-card__sub">{{ filtered.length }} estrategias</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-card__icon">📐</div>
          <div class="kpi-card__body">
            <div class="kpi-card__label">Kelly promedio</div>
            <div class="kpi-card__value">{{ fmtN(avgKelly, 4) }}</div>
            <div class="kpi-card__sub">fracción óptima de cobertura</div>
          </div>
        </div>
        <div class="kpi-card">
          <div class="kpi-card__icon">🔬</div>
          <div class="kpi-card__body">
            <div class="kpi-card__label">Puntos evaluados</div>
            <div class="kpi-card__value">{{ totalEvalPts.toLocaleString() }}</div>
            <div class="kpi-card__sub">sorteos históricos</div>
          </div>
        </div>
        <div class="kpi-card" :class="bestStrategy?.p_value < 0.05 ? 'kpi-card--green' : 'kpi-card--yellow'">
          <div class="kpi-card__icon">{{ bestStrategy?.p_value < 0.05 ? '✅' : '⚠️' }}</div>
          <div class="kpi-card__body">
            <div class="kpi-card__label">Significancia</div>
            <div class="kpi-card__value">p = {{ fmtN(bestStrategy?.p_value, 4) }}</div>
            <div class="kpi-card__sub">{{ bestStrategy?.p_value < 0.05 ? 'Estadísticamente significativo' : 'No significativo' }}</div>
          </div>
        </div>
      </div>

      <!-- ── MAIN GRID ─────────────────────────────────────── -->
      <div class="bt-main-grid">

        <!-- LEFT: strategy list + bar chart -->
        <div class="bt-left">
          <!-- Bar chart -->
          <div class="panel">
            <div class="panel__header">
              <span class="panel__title">Comparativa Hit Rate por estrategia</span>
              <span class="panel__badge">{{ gameType.toUpperCase() }} · {{ mode }}</span>
            </div>
            <div class="chart-wrap chart-wrap--bar">
              <Bar :data="barChartData" :options="barOptions" />
            </div>
          </div>

          <!-- Strategy table -->
          <div class="panel mt-4">
            <div class="panel__header">
              <span class="panel__title">Ranking de estrategias</span>
            </div>
            <div class="strat-table-wrap">
              <table class="strat-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Estrategia</th>
                    <th v-if="gameType==='pick4'">Half</th>
                    <th>Hit%</th>
                    <th>MRR</th>
                    <th>Kelly</th>
                    <th>Sharpe</th>
                    <th>P@10</th>
                    <th>Wilson↓</th>
                    <th>N final</th>
                  </tr>
                </thead>
                <tbody>
                  <tr
                    v-for="(r, idx) in sortedFiltered"
                    :key="r.strategy_name + r.half"
                    class="strat-row"
                    :class="{ 'strat-row--selected': selected?.strategy_name === r.strategy_name && selected?.half === r.half }"
                    @click="selectStrategy(r.strategy_name)"
                  >
                    <td class="td-rank">
                      <span class="rank-badge" :style="{ background: rankColor(idx) }">{{ idx + 1 }}</span>
                    </td>
                    <td class="td-name">
                      <span class="strat-icon">{{ meta(r.strategy_name).icon }}</span>
                      {{ meta(r.strategy_name).label }}
                    </td>
                    <td v-if="gameType==='pick4'" class="td-half">
                      <span class="half-tag">{{ r.half.toUpperCase() }}</span>
                    </td>
                    <td class="td-metric">
                      <div class="bar-inline">
                        <div class="bar-inline__fill" :style="{ width: (r.hit_rate * 100 / maxHitRate * 100).toFixed(0) + '%', background: meta(r.strategy_name).color }"></div>
                        <span>{{ pct(r.hit_rate) }}</span>
                      </div>
                    </td>
                    <td class="td-metric">{{ fmtN(r.mrr, 4) }}</td>
                    <td class="td-metric" :class="r.kelly_fraction > 0 ? 'txt-green' : 'txt-dim'">
                      {{ fmtN(r.kelly_fraction, 4) }}
                    </td>
                    <td class="td-metric">{{ fmtN(r.sharpe, 3) }}</td>
                    <td class="td-metric">{{ pct(r.precision_at_10) }}</td>
                    <td class="td-metric">{{ pct(r.wilson_lower) }}</td>
                    <td class="td-metric txt-blue">{{ r.final_top_n }}</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </div>
        </div>

        <!-- RIGHT: selected strategy deep-dive -->
        <div class="bt-right" v-if="selected">
          <!-- Strategy header -->
          <div class="detail-header" :style="{ borderColor: meta(selected.strategy_name).color }">
            <div class="detail-header__icon" :style="{ color: meta(selected.strategy_name).color }">
              {{ meta(selected.strategy_name).icon }}
            </div>
            <div class="detail-header__body">
              <div class="detail-header__name">{{ meta(selected.strategy_name).label }}</div>
              <div class="detail-header__sub">
                {{ selected.game_type.toUpperCase() }} · {{ selected.mode }} · half: {{ selected.half.toUpperCase() }}
              </div>
            </div>
            <div class="detail-header__hit" :style="{ color: meta(selected.strategy_name).color }">
              {{ pct(selected.hit_rate) }}
            </div>
          </div>

          <!-- Cognitive N banner -->
          <div class="cog-banner">
            <div class="cog-banner__label">N cognitivo óptimo</div>
            <div class="cog-banner__n">{{ selected.final_top_n }}</div>
            <div class="cog-banner__eff">
              efectividad mínima estimada
              <span class="cog-banner__pct">{{ pct(selected.wilson_lower) }}</span>
              <span class="cog-banner__ci">Wilson 95% CI</span>
            </div>
          </div>

          <!-- Radar chart -->
          <div class="panel mt-4">
            <div class="panel__header">
              <span class="panel__title">Perfil de precisión</span>
            </div>
            <div class="chart-wrap chart-wrap--radar">
              <Radar v-if="radarChartData" :data="radarChartData" :options="radarOptions" />
            </div>
          </div>

          <!-- Metrics grid -->
          <div class="metrics-grid mt-4">
            <div class="m-card">
              <div class="m-card__label">MRR</div>
              <div class="m-card__value">{{ fmtN(selected.mrr, 4) }}</div>
              <div class="m-card__desc">Mean Reciprocal Rank</div>
            </div>
            <div class="m-card">
              <div class="m-card__label">Rank esperado</div>
              <div class="m-card__value">{{ rank(selected.expected_rank) }}</div>
              <div class="m-card__desc">Posición promedio del par real</div>
            </div>
            <div class="m-card">
              <div class="m-card__label">Brier Score</div>
              <div class="m-card__value" :class="selected.brier_score < 0.15 ? 'txt-green' : 'txt-yellow'">
                {{ fmtN(selected.brier_score, 4) }}
              </div>
              <div class="m-card__desc">Calibración (↓ mejor)</div>
            </div>
            <div class="m-card">
              <div class="m-card__label">Cohen's h</div>
              <div class="m-card__value" :class="cohenClass(selected.cohens_h)">
                {{ fmtN(selected.cohens_h, 3) }}
              </div>
              <div class="m-card__desc">{{ cohenLabel(selected.cohens_h) }}</div>
            </div>
            <div class="m-card">
              <div class="m-card__label">P-value</div>
              <div class="m-card__value" :class="selected.p_value < 0.05 ? 'txt-green' : 'txt-red'">
                {{ fmtN(selected.p_value, 4) }}
              </div>
              <div class="m-card__desc">{{ selected.p_value < 0.05 ? '✅ Significativo' : '⚠️ No significativo' }}</div>
            </div>
            <div class="m-card">
              <div class="m-card__label">CV Hit Rate</div>
              <div class="m-card__value" :class="selected.cv_hit_rate < 0.3 ? 'txt-green' : 'txt-yellow'">
                {{ fmtN(selected.cv_hit_rate, 3) }}
              </div>
              <div class="m-card__desc">Estabilidad de señal (↓ mejor)</div>
            </div>
            <div class="m-card">
              <div class="m-card__label">Sharpe</div>
              <div class="m-card__value" :class="selected.sharpe > 1 ? 'txt-green' : ''">
                {{ fmtN(selected.sharpe, 3) }}
              </div>
              <div class="m-card__desc">Rendimiento / riesgo</div>
            </div>
            <div class="m-card">
              <div class="m-card__label">Max Miss Streak</div>
              <div class="m-card__value" :class="selected.max_miss_streak > 20 ? 'txt-red' : 'txt-yellow'">
                {{ selected.max_miss_streak }}
              </div>
              <div class="m-card__desc">Racha máx. sin acierto</div>
            </div>
            <div class="m-card">
              <div class="m-card__label">Autocorr Lag-1</div>
              <div class="m-card__value">{{ fmtN(selected.autocorr_lag1, 3) }}</div>
              <div class="m-card__desc">{{ selected.autocorr_lag1 > 0 ? 'Momentum +' : 'Alternancia −' }}</div>
            </div>
          </div>

          <!-- Precision@K bar -->
          <div class="panel mt-4">
            <div class="panel__header">
              <span class="panel__title">Precision @ K</span>
            </div>
            <div class="pk-bars">
              <div class="pk-row" v-for="[k, v] in [['3', selected.precision_at_3], ['5', selected.precision_at_5], ['10', selected.precision_at_10]]" :key="k">
                <span class="pk-label">Top-{{ k }}</span>
                <div class="pk-track">
                  <div class="pk-fill" :style="{ width: (v * 100).toFixed(0) + '%', background: pkColor(v) }"></div>
                </div>
                <span class="pk-pct">{{ pct(v) }}</span>
              </div>
            </div>
          </div>

          <!-- Wilson CI bar -->
          <div class="panel mt-4">
            <div class="panel__header">
              <span class="panel__title">Intervalo de confianza Wilson 95%</span>
            </div>
            <div class="wilson-viz">
              <div class="wilson-track">
                <div class="wilson-range"
                  :style="{
                    left: (selected.wilson_lower * 100).toFixed(1) + '%',
                    width: ((selected.wilson_upper - selected.wilson_lower) * 100).toFixed(1) + '%',
                    background: meta(selected.strategy_name).color + '55',
                    borderColor: meta(selected.strategy_name).color
                  }">
                </div>
                <div class="wilson-center"
                  :style="{ left: (selected.hit_rate * 100).toFixed(1) + '%', background: meta(selected.strategy_name).color }">
                </div>
              </div>
              <div class="wilson-labels">
                <span>0%</span>
                <span>25%</span>
                <span>50%</span>
                <span>75%</span>
                <span>100%</span>
              </div>
              <div class="wilson-legend">
                <span class="wilson-dot" :style="{ background: meta(selected.strategy_name).color }"></span>
                Hit rate: <strong>{{ pct(selected.hit_rate) }}</strong>
                &nbsp;·&nbsp; CI: [{{ pct(selected.wilson_lower) }} – {{ pct(selected.wilson_upper) }}]
              </div>
            </div>
          </div>

          <!-- Run info -->
          <div class="run-info mt-4">
            <span>Período: <strong>{{ selected.date_from?.slice(0, 10) }} → {{ selected.date_to?.slice(0, 10) }}</strong></span>
            <span>Duración: <strong>{{ ((selected.run_duration_ms ?? 0) / 1000).toFixed(1) }}s</strong></span>
            <span>Puntos: <strong>{{ selected.total_eval_pts?.toLocaleString() }}</strong></span>
          </div>
        </div>

      </div>
    </template>
  </div>
</template>

<script setup>
import { onMounted, computed } from 'vue';
import { Bar, Radar } from 'vue-chartjs';
import {
  Chart as ChartJS,
  CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend,
  RadialLinearScale, PointElement, LineElement, Filler,
} from 'chart.js';

ChartJS.register(
  CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend,
  RadialLinearScale, PointElement, LineElement, Filler,
);

import { useBacktestV2 } from '../../composables/agent/useBacktestV2.js';

const {
  loading, running, error, runMsg, runError,
  gameType, mode, halfFilter,
  filtered, bestStrategy, selected, avgHitRate, avgKelly, totalEvalPts,
  barChartData, radarChartData,
  fetchResults, runBacktest, selectStrategy,
  meta, pct, fmtN, rank,
} = useBacktestV2();

// Sort filtered by hit_rate desc
const sortedFiltered = computed(() =>
  [...filtered.value].sort((a, b) => b.hit_rate - a.hit_rate)
);

const maxHitRate = computed(() =>
  sortedFiltered.value.length ? sortedFiltered.value[0].hit_rate : 1
);

// Chart options
const barOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: {
    legend: { display: false },
    tooltip: {
      callbacks: {
        label: ctx => ` ${ctx.parsed.y.toFixed(2)}%`,
      },
    },
  },
  scales: {
    x: {
      ticks: { color: '#94a3b8', font: { size: 11 }, maxRotation: 35 },
      grid:  { color: '#1e2d40' },
    },
    y: {
      ticks: { color: '#94a3b8', callback: v => v + '%' },
      grid:  { color: '#1e2d40' },
      min: 0,
    },
  },
};

const radarOptions = {
  responsive: true,
  maintainAspectRatio: false,
  plugins: { legend: { display: false } },
  scales: {
    r: {
      ticks:       { display: false },
      grid:        { color: '#1e2d4066' },
      pointLabels: { color: '#94a3b8', font: { size: 11 } },
      suggestedMin: 0,
    },
  },
};

// Helpers
function rankColor(idx) {
  if (idx === 0) return '#f59e0b';
  if (idx === 1) return '#94a3b8';
  if (idx === 2) return '#92400e';
  return '#1e2d40';
}

function pkColor(v) {
  if (v >= 0.15) return '#22c55e';
  if (v >= 0.10) return '#f59e0b';
  return '#ef4444';
}

function cohenClass(h) {
  if (h >= 0.8) return 'txt-green';
  if (h >= 0.5) return 'txt-yellow';
  if (h >= 0.2) return 'txt-blue';
  return 'txt-dim';
}

function cohenLabel(h) {
  if (h >= 0.8) return 'Efecto grande';
  if (h >= 0.5) return 'Efecto medio';
  if (h >= 0.2) return 'Efecto pequeño';
  return 'Sin efecto';
}

onMounted(fetchResults);
</script>

<style scoped>
/* ── Page ─────────────────────────────────────────────────── */
.bt-page { display: flex; flex-direction: column; gap: 1.5rem; }

/* ── Header ──────────────────────────────────────────────── */
.bt-header {
  display: flex; align-items: flex-start; justify-content: space-between; flex-wrap: wrap; gap: 1rem;
}
.bt-title {
  font-size: 1.6rem; font-weight: 800; color: #f1f5f9; margin: 0 0 0.25rem;
  display: flex; align-items: center; gap: 0.5rem;
}
.bt-title__tag {
  font-size: 0.65rem; font-weight: 700; background: #1d3a5f; color: #60a5fa;
  padding: 0.15rem 0.5rem; border-radius: 999px; letter-spacing: 0.05em; vertical-align: middle;
}
.bt-subtitle { color: #64748b; font-size: 0.85rem; margin: 0; }

.bt-controls { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.ctrl-select {
  background: #0f1623; border: 1px solid #1e2d40; color: #e2e8f0;
  padding: 0.45rem 0.75rem; border-radius: 8px; font-size: 0.85rem; cursor: pointer;
}
.ctrl-btn {
  padding: 0.45rem 1rem; border-radius: 8px; font-size: 0.85rem; font-weight: 600;
  cursor: pointer; border: none; transition: background 0.15s, opacity 0.15s;
}
.ctrl-btn:disabled { opacity: 0.5; cursor: not-allowed; }
.ctrl-btn--ghost   { background: #1e2d40; color: #94a3b8; }
.ctrl-btn--ghost:hover:not(:disabled) { background: #1a2535; color: #e2e8f0; }
.ctrl-btn--primary { background: #1d4ed8; color: white; }
.ctrl-btn--primary:hover:not(:disabled) { background: #2563eb; }

/* ── Messages ────────────────────────────────────────────── */
.run-msg {
  padding: 0.6rem 1rem; border-radius: 8px; font-size: 0.85rem;
}
.run-msg--ok  { background: #14532d33; color: #4ade80; border: 1px solid #14532d; }
.run-msg--err { background: #450a0a33; color: #f87171; border: 1px solid #450a0a; }

/* ── Loading ─────────────────────────────────────────────── */
.bt-loading {
  display: flex; align-items: center; gap: 1rem; padding: 3rem;
  justify-content: center; color: #64748b;
}
.loader {
  width: 24px; height: 24px; border: 3px solid #1e2d40;
  border-top-color: #60a5fa; border-radius: 50%; animation: spin 0.8s linear infinite;
}
@keyframes spin { to { transform: rotate(360deg); } }
.spin { display: inline-block; animation: spin 0.6s linear infinite; }

/* ── Empty ───────────────────────────────────────────────── */
.bt-empty {
  text-align: center; padding: 4rem 2rem; color: #64748b;
}
.bt-empty__icon { font-size: 3rem; margin-bottom: 1rem; }
.bt-empty p { margin: 0.25rem 0; }
.bt-empty__sub { font-size: 0.82rem; color: #475569; }

/* ── KPI row ─────────────────────────────────────────────── */
.kpi-row {
  display: grid; grid-template-columns: repeat(5, 1fr); gap: 1rem;
}
.kpi-card {
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 14px;
  padding: 1rem 1.25rem; display: flex; align-items: center; gap: 0.75rem;
}
.kpi-card--highlight { border-color: #1d3a5f; background: #0d1e33; }
.kpi-card--green  { border-color: #14532d; }
.kpi-card--yellow { border-color: #713f12; }
.kpi-card__icon { font-size: 1.5rem; flex-shrink: 0; }
.kpi-card__label { font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.15rem; }
.kpi-card__value { font-size: 1.2rem; font-weight: 700; color: #f1f5f9; }
.kpi-card__sub   { font-size: 0.7rem; color: #475569; margin-top: 0.1rem; }

/* ── Main grid ───────────────────────────────────────────── */
.bt-main-grid {
  display: grid; grid-template-columns: 1fr 380px; gap: 1.5rem; align-items: start;
}
.bt-left, .bt-right { display: flex; flex-direction: column; gap: 1rem; }

/* ── Panel ───────────────────────────────────────────────── */
.panel {
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 14px; overflow: hidden;
}
.panel__header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 0.85rem 1.25rem; border-bottom: 1px solid #1e2d40;
}
.panel__title { font-size: 0.85rem; font-weight: 600; color: #94a3b8; text-transform: uppercase; letter-spacing: 0.04em; }
.panel__badge {
  font-size: 0.7rem; background: #1e2d40; color: #60a5fa; padding: 0.15rem 0.6rem; border-radius: 999px;
}
.mt-4 { margin-top: 0; }

/* ── Charts ──────────────────────────────────────────────── */
.chart-wrap { padding: 1rem; }
.chart-wrap--bar   { height: 240px; }
.chart-wrap--radar { height: 220px; }

/* ── Strategy table ──────────────────────────────────────── */
.strat-table-wrap { overflow-x: auto; }
.strat-table {
  width: 100%; border-collapse: collapse; font-size: 0.82rem;
}
.strat-table th {
  text-align: left; padding: 0.6rem 0.75rem;
  color: #64748b; font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.05em;
  border-bottom: 1px solid #1e2d40; white-space: nowrap;
}
.strat-row { cursor: pointer; transition: background 0.12s; border-bottom: 1px solid #1e2d4055; }
.strat-row:hover { background: #1a2535; }
.strat-row--selected { background: #1d3a5f33; }
.strat-row td { padding: 0.6rem 0.75rem; color: #e2e8f0; vertical-align: middle; }

.td-rank { width: 36px; }
.rank-badge {
  display: inline-flex; align-items: center; justify-content: center;
  width: 22px; height: 22px; border-radius: 50%; font-size: 0.7rem; font-weight: 700; color: #fff;
}
.td-name { white-space: nowrap; }
.strat-icon { margin-right: 0.3rem; }
.td-half { white-space: nowrap; }
.half-tag {
  font-size: 0.65rem; background: #1e2d40; color: #94a3b8;
  padding: 0.1rem 0.4rem; border-radius: 4px; font-weight: 600;
}
.td-metric { font-family: monospace; font-size: 0.8rem; white-space: nowrap; }

/* inline bar */
.bar-inline { display: flex; align-items: center; gap: 0.4rem; min-width: 100px; }
.bar-inline__fill { height: 6px; border-radius: 3px; flex-shrink: 0; min-width: 2px; transition: width 0.3s; }

/* ── Detail panel ────────────────────────────────────────── */
.detail-header {
  background: #0f1623; border: 1px solid #1e2d40; border-left-width: 3px;
  border-radius: 14px; padding: 1rem 1.25rem;
  display: flex; align-items: center; gap: 0.75rem;
}
.detail-header__icon { font-size: 2rem; }
.detail-header__body { flex: 1; }
.detail-header__name { font-size: 1rem; font-weight: 700; color: #f1f5f9; }
.detail-header__sub  { font-size: 0.75rem; color: #64748b; margin-top: 0.15rem; }
.detail-header__hit  { font-size: 1.75rem; font-weight: 800; }

/* ── Cognitive N banner ──────────────────────────────────── */
.cog-banner {
  background: linear-gradient(135deg, #0d1e33 0%, #1a2535 100%);
  border: 1px solid #1d3a5f;
  border-radius: 14px; padding: 1.25rem;
  display: flex; align-items: center; gap: 1rem;
}
.cog-banner__label { font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; white-space: nowrap; }
.cog-banner__n {
  font-size: 3rem; font-weight: 900; color: #60a5fa; line-height: 1;
  text-shadow: 0 0 20px #60a5fa55;
}
.cog-banner__eff { font-size: 0.8rem; color: #94a3b8; }
.cog-banner__pct { font-size: 1.1rem; font-weight: 700; color: #4ade80; margin-left: 0.25rem; }
.cog-banner__ci  { font-size: 0.7rem; color: #475569; margin-left: 0.25rem; }

/* ── Metrics grid ─────────────────────────────────────────── */
.metrics-grid {
  display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0.75rem;
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 14px; padding: 1rem;
}
.m-card { }
.m-card__label { font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.2rem; }
.m-card__value { font-size: 1rem; font-weight: 700; color: #e2e8f0; font-family: monospace; }
.m-card__desc  { font-size: 0.65rem; color: #475569; margin-top: 0.1rem; }

/* ── Precision@K ─────────────────────────────────────────── */
.pk-bars { padding: 1rem 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
.pk-row  { display: flex; align-items: center; gap: 0.75rem; }
.pk-label { width: 40px; font-size: 0.8rem; color: #94a3b8; flex-shrink: 0; }
.pk-track { flex: 1; height: 8px; background: #1e2d40; border-radius: 4px; overflow: hidden; }
.pk-fill  { height: 100%; border-radius: 4px; transition: width 0.4s; }
.pk-pct   { width: 42px; text-align: right; font-size: 0.8rem; color: #e2e8f0; font-family: monospace; }

/* ── Wilson CI ───────────────────────────────────────────── */
.wilson-viz { padding: 1rem 1.25rem; }
.wilson-track {
  position: relative; height: 14px; background: #1e2d40;
  border-radius: 7px; margin-bottom: 0.4rem; overflow: visible;
}
.wilson-range {
  position: absolute; top: 0; height: 100%; border-radius: 7px; border: 1.5px solid;
}
.wilson-center {
  position: absolute; top: -3px; width: 8px; height: 20px; border-radius: 3px;
  transform: translateX(-50%);
}
.wilson-labels {
  display: flex; justify-content: space-between;
  font-size: 0.65rem; color: #475569; margin-bottom: 0.5rem;
}
.wilson-legend { font-size: 0.78rem; color: #94a3b8; display: flex; align-items: center; gap: 0.3rem; }
.wilson-dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

/* ── Run info ────────────────────────────────────────────── */
.run-info {
  display: flex; gap: 1rem; flex-wrap: wrap;
  font-size: 0.78rem; color: #64748b; padding: 0.75rem 0;
}
.run-info strong { color: #94a3b8; }

/* ── Color helpers ───────────────────────────────────────── */
.txt-green  { color: #4ade80; }
.txt-yellow { color: #fbbf24; }
.txt-red    { color: #f87171; }
.txt-blue   { color: #60a5fa; }
.txt-dim    { color: #475569; }

/* ── Responsive ──────────────────────────────────────────── */
@media (max-width: 1100px) {
  .bt-main-grid { grid-template-columns: 1fr; }
  .kpi-row { grid-template-columns: repeat(3, 1fr); }
}
@media (max-width: 640px) {
  .kpi-row { grid-template-columns: 1fr 1fr; }
  .bt-header { flex-direction: column; }
}
</style>
