<template>
  <div class="rendimiento-view">
    <!-- Header -->
    <div class="page-header">
      <div class="page-header__left">
        <h1 class="page-title">Rendimiento en Vivo</h1>
        <span class="page-subtitle">Predicciones vs resultados reales — actualización automática</span>
      </div>
      <div class="page-header__controls">
        <select v-model="gameType" class="ctrl-select" @change="fetchData">
          <option value="pick3">Pick 3</option>
          <option value="pick4">Pick 4</option>
        </select>
        <select v-model="days" class="ctrl-select" @change="fetchData">
          <option :value="7">7 días</option>
          <option :value="14">14 días</option>
          <option :value="30">30 días</option>
          <option :value="60">60 días</option>
          <option :value="90">90 días</option>
        </select>
      </div>
    </div>

    <div v-if="loading" class="loading">Cargando rendimiento...</div>
    <div v-else-if="error" class="error-msg">{{ error }}</div>

    <template v-else-if="data">

      <!-- ── Summary Cards ────────────────────────────────────────── -->
      <div class="summary-grid">
        <div v-for="s in data.summary" :key="`${s.draw_type}-${s.half}`" class="stat-card"
             :class="s.vs_azar > 0 ? 'stat-card--green' : 'stat-card--neutral'">
          <div class="stat-card__label">
            {{ s.draw_type === 'midday' ? '🌤' : '🌆' }}
            {{ s.draw_type }} · {{ halfLabel(s.half) }}
          </div>
          <div class="stat-card__value">{{ pct(s.hit_rate) }}</div>
          <div class="stat-card__sub">
            <span :class="s.vs_azar >= 0 ? 'text-green' : 'text-red'">
              {{ s.vs_azar >= 0 ? '+' : '' }}{{ pct(s.vs_azar) }} vs azar
            </span>
          </div>
          <div class="stat-card__detail">
            {{ s.hits }}/{{ s.total }} hits · rank avg {{ s.avg_rank?.toFixed(1) ?? '—' }}
          </div>
        </div>

        <!-- Totals -->
        <div class="stat-card stat-card--accent">
          <div class="stat-card__label">Hit Rate Global</div>
          <div class="stat-card__value">{{ pct(globalHitRate) }}</div>
          <div class="stat-card__sub">
            <span :class="globalVsAzar >= 0 ? 'text-green' : 'text-red'">
              {{ globalVsAzar >= 0 ? '+' : '' }}{{ pct(globalVsAzar) }} vs azar
            </span>
          </div>
          <div class="stat-card__detail">{{ globalHits }}/{{ globalTotal }} hits totales</div>
        </div>
      </div>

      <!-- ── Strategy Performance Table (backtest) ────────────────── -->
      <section class="section" v-if="data.strategies.length > 0">
        <h2 class="section-title">Rendimiento por Estrategia <span class="badge-algo">Backtest v2</span></h2>
        <div class="table-wrap">
          <table class="data-table">
            <thead>
              <tr>
                <th>Estrategia</th>
                <th>Half</th>
                <th>Hit Rate</th>
                <th>p@5</th>
                <th>p@10</th>
                <th>Rank avg</th>
                <th>Sharpe</th>
                <th>Kelly f*</th>
                <th>Eval pts</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in data.strategies" :key="`${s.strategy_name}-${s.half}`"
                  :class="s.hit_rate > 0.12 ? 'row--hot' : ''">
                <td class="mono">{{ s.strategy_name }}</td>
                <td><span class="half-badge">{{ s.half }}</span></td>
                <td :class="s.hit_rate > 0.12 ? 'text-green' : 'text-muted'">
                  {{ pct(s.hit_rate) }}
                </td>
                <td :class="s.precision_at_5 > 0.10 ? 'text-green' : 'text-muted'">
                  {{ pct(s.precision_at_5) }}
                </td>
                <td>{{ pct(s.precision_at_10) }}</td>
                <td>{{ s.expected_rank?.toFixed(1) ?? '—' }}</td>
                <td :class="s.sharpe > 0.5 ? 'text-green' : s.sharpe < 0 ? 'text-red' : ''">
                  {{ s.sharpe?.toFixed(2) ?? '—' }}
                </td>
                <td :class="s.kelly_fraction > 0 ? 'text-green' : 'text-muted'">
                  {{ s.kelly_fraction > 0 ? s.kelly_fraction.toFixed(3) : '—' }}
                </td>
                <td class="text-muted">{{ s.total_eval_pts }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <!-- ── Timeline ─────────────────────────────────────────────── -->
      <section class="section">
        <h2 class="section-title">Historial de Predicciones</h2>

        <div class="timeline">
          <div v-for="row in groupedTimeline" :key="row.draw_date + row.draw_type"
               class="timeline-sorteo">
            <div class="timeline-sorteo__header">
              <span class="timeline-date">{{ row.draw_date }}</span>
              <span class="timeline-type">{{ row.draw_type === 'midday' ? '🌤 Midday' : '🌆 Evening' }}</span>
            </div>

            <div class="timeline-sorteo__halves">
              <div v-for="half in row.halves" :key="half.half" class="half-block">
                <div class="half-block__header">
                  <span class="half-label">{{ halfLabel(half.half) }}</span>
                  <span class="hit-badge"
                        :class="half.hit === true ? 'hit-badge--hit' :
                                half.hit === false ? 'hit-badge--miss' : 'hit-badge--pending'">
                    {{ half.hit === true ? `✓ HIT #${half.hit_at_rank}` :
                       half.hit === false ? '✗ MISS' : '⏳ Pendiente' }}
                  </span>
                </div>

                <div class="pairs-grid">
                  <span v-for="(pair, idx) in half.pairs.slice(0, half.optimal_n)" :key="pair"
                        class="pair-chip"
                        :class="{
                          'pair-chip--hit':    pair === half.actual_pair,
                          'pair-chip--ranked': idx < 5,
                        }">
                    {{ pair }}
                  </span>
                </div>

                <div class="half-block__meta" v-if="half.actual_pair">
                  Resultado real: <strong>{{ half.actual_pair }}</strong>
                  <span v-if="half.hit_at_rank"> · rank {{ half.hit_at_rank }}</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        <div v-if="groupedTimeline.length === 0" class="empty">
          Sin historial en los últimos {{ days }} días para este juego.
        </div>
      </section>

    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';

const API = import.meta.env.VITE_API_URL ?? '';

const gameType = ref('pick3');
const days     = ref(30);
const data     = ref(null);
const loading  = ref(false);
const error    = ref('');

async function fetchData() {
  loading.value = true;
  error.value   = '';
  try {
    const res = await fetch(`${API}/api/agent/rendimiento?game_type=${gameType.value}&days=${days.value}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    data.value = await res.json();
  } catch (e) {
    error.value = e.message ?? 'Error al cargar rendimiento';
  } finally {
    loading.value = false;
  }
}

onMounted(fetchData);

// ─── Helpers ─────────────────────────────────────────────────────
function pct(v) {
  if (v == null || isNaN(v)) return '—';
  return `${(v * 100).toFixed(1)}%`;
}

function halfLabel(half) {
  return half === 'du' ? 'D+U' : half === 'ab' ? 'AB' : 'CD';
}

// ─── Derived: global totals ──────────────────────────────────────
const globalTotal   = computed(() => (data.value?.summary ?? []).reduce((s, r) => s + r.total, 0));
const globalHits    = computed(() => (data.value?.summary ?? []).reduce((s, r) => s + r.hits,  0));
const globalHitRate = computed(() => globalTotal.value > 0 ? globalHits.value / globalTotal.value : 0);
const globalBaseline = computed(() =>
  (data.value?.summary ?? []).length > 0
    ? (data.value.summary.reduce((s, r) => s + r.baseline, 0) / data.value.summary.length)
    : 0.15
);
const globalVsAzar = computed(() => globalHitRate.value - globalBaseline.value);

// ─── Group timeline by draw_date + draw_type ─────────────────────
const groupedTimeline = computed(() => {
  const rows = data.value?.timeline ?? [];
  const map  = new Map();
  for (const row of rows) {
    const key = `${row.draw_date}__${row.draw_type}`;
    if (!map.has(key)) {
      map.set(key, { draw_date: row.draw_date, draw_type: row.draw_type, halves: [] });
    }
    map.get(key).halves.push(row);
  }
  return [...map.values()];
});
</script>

<style scoped>
.rendimiento-view { max-width: 1100px; }

.page-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.5rem;
  flex-wrap: wrap;
}
.page-header__controls { display: flex; gap: 0.5rem; }
.page-title { font-size: 1.5rem; font-weight: 700; color: #e2e8f0; margin: 0; }
.page-subtitle { font-size: 0.85rem; color: #64748b; }

.ctrl-select {
  background: #0f1623;
  border: 1px solid #1e2d40;
  color: #e2e8f0;
  border-radius: 6px;
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
  cursor: pointer;
}

/* ─── Summary cards ────────────────────────────────────────────── */
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 1rem;
  margin-bottom: 2rem;
}
.stat-card {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  padding: 1.1rem 1.25rem;
}
.stat-card--green  { border-color: #166534; }
.stat-card--accent { border-color: #1d4ed8; background: #0f1a33; }
.stat-card--neutral { border-color: #1e2d40; }
.stat-card__label  { font-size: 0.78rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.35rem; }
.stat-card__value  { font-size: 1.8rem; font-weight: 700; color: #e2e8f0; line-height: 1; }
.stat-card__sub    { font-size: 0.8rem; margin-top: 0.25rem; }
.stat-card__detail { font-size: 0.75rem; color: #64748b; margin-top: 0.5rem; }

.text-green { color: #22c55e; }
.text-red   { color: #ef4444; }
.text-muted { color: #64748b; }

/* ─── Strategy table ───────────────────────────────────────────── */
.section { margin-bottom: 2rem; }
.section-title {
  font-size: 1rem;
  font-weight: 600;
  color: #94a3b8;
  margin-bottom: 0.75rem;
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.badge-algo {
  background: #1d3a5f;
  color: #60a5fa;
  font-size: 0.7rem;
  font-weight: 600;
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
}
.table-wrap { overflow-x: auto; border-radius: 10px; border: 1px solid #1e2d40; }
.data-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.data-table th {
  background: #0f1623;
  color: #64748b;
  font-weight: 600;
  text-align: left;
  padding: 0.65rem 0.85rem;
  border-bottom: 1px solid #1e2d40;
  white-space: nowrap;
}
.data-table td {
  padding: 0.6rem 0.85rem;
  border-bottom: 1px solid #131b2a;
  color: #94a3b8;
}
.data-table tr:last-child td { border-bottom: none; }
.data-table tr:hover td { background: #0d1520; }
.row--hot td:first-child { border-left: 3px solid #22c55e; }
.mono { font-family: monospace; color: #60a5fa; }
.half-badge {
  background: #1d3a5f;
  color: #93c5fd;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-family: monospace;
}

/* ─── Timeline ─────────────────────────────────────────────────── */
.timeline { display: flex; flex-direction: column; gap: 1rem; }

.timeline-sorteo {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 10px;
  overflow: hidden;
}
.timeline-sorteo__header {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.6rem 1rem;
  background: #131b2a;
  border-bottom: 1px solid #1e2d40;
}
.timeline-date { font-weight: 600; color: #e2e8f0; font-size: 0.9rem; }
.timeline-type { color: #64748b; font-size: 0.82rem; }

.timeline-sorteo__halves { display: flex; flex-wrap: wrap; gap: 0; }

.half-block {
  flex: 1;
  min-width: 260px;
  padding: 0.85rem 1rem;
  border-right: 1px solid #1e2d40;
}
.half-block:last-child { border-right: none; }

.half-block__header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.6rem;
}
.half-label { font-size: 0.78rem; font-weight: 600; color: #64748b; text-transform: uppercase; }

.hit-badge {
  font-size: 0.75rem;
  font-weight: 700;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
}
.hit-badge--hit     { background: #14532d; color: #4ade80; }
.hit-badge--miss    { background: #1f1010; color: #f87171; }
.hit-badge--pending { background: #1c1a10; color: #fbbf24; }

.pairs-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  margin-bottom: 0.5rem;
}
.pair-chip {
  font-family: monospace;
  font-size: 0.82rem;
  font-weight: 600;
  padding: 0.15rem 0.4rem;
  border-radius: 5px;
  background: #1a2535;
  color: #94a3b8;
  border: 1px solid #1e2d40;
  transition: all 0.1s;
}
.pair-chip--ranked { background: #0f2240; color: #60a5fa; border-color: #1d4ed8; }
.pair-chip--hit    { background: #14532d; color: #4ade80; border-color: #166534; font-weight: 800; }

.half-block__meta { font-size: 0.75rem; color: #64748b; }
.half-block__meta strong { color: #e2e8f0; }

.empty { color: #475569; font-size: 0.9rem; padding: 2rem; text-align: center; }
.loading { color: #60a5fa; padding: 2rem; text-align: center; }
.error-msg { color: #ef4444; padding: 1rem; background: #1f1010; border-radius: 8px; }
</style>
