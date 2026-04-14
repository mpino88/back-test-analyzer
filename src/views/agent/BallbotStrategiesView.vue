<template>
  <div class="bb-view">
    <header class="bb-header">
      <div class="bb-header__title">
        <span class="bb-header__icon">🧬</span>
        <div>
          <h1>Estrategias Ballbot</h1>
          <p class="bb-header__sub">Condiciones de juego PLAY / WAIT / ALERT por estrategia</p>
        </div>
      </div>
      <div class="bb-header__controls">
        <select v-model="gameType" class="ctrl-select">
          <option value="pick3">Pick 3</option>
          <option value="pick4">Pick 4</option>
        </select>
        <select v-model="drawType" class="ctrl-select">
          <option value="midday">Midday</option>
          <option value="evening">Evening</option>
        </select>
        <button class="ctrl-btn ctrl-btn--primary" :disabled="loading" @click="fetchConditions(true)">
          <span v-if="loading" class="spin">⟳</span>
          <span v-else>⚡ Recalcular</span>
        </button>
        <button class="ctrl-btn" :disabled="loading" @click="fetchConditions(false)">
          Cargar guardadas
        </button>
      </div>
    </header>

    <!-- Summary chips -->
    <div v-if="conditions.length" class="bb-summary">
      <div class="chip chip--play">
        🟢 PLAY <strong>{{ playCount }}</strong>
      </div>
      <div class="chip chip--wait">
        🟡 WAIT <strong>{{ waitCount }}</strong>
      </div>
      <div class="chip chip--alert">
        🔴 ALERT <strong>{{ alertCount }}</strong>
      </div>
      <div class="chip chip--info">
        📊 {{ conditions.length }} estrategias | {{ computedAt }}
      </div>
    </div>

    <!-- Error -->
    <div v-if="error" class="bb-error">⚠️ {{ error }}</div>

    <!-- Empty state -->
    <div v-if="!loading && !conditions.length && !error" class="bb-empty">
      <p>Sin condiciones calculadas para <strong>{{ gameType }} {{ drawType }}</strong>.</p>
      <p>Haz clic en <strong>⚡ Recalcular</strong> para analizar el historial.</p>
    </div>

    <!-- Loading skeleton -->
    <div v-if="loading" class="bb-skeleton">
      <div v-for="i in 8" :key="i" class="skeleton-row"></div>
    </div>

    <!-- Conditions table -->
    <div v-if="!loading && conditions.length" class="bb-table-wrap">
      <table class="bb-table">
        <thead>
          <tr>
            <th>Estrategia</th>
            <th>Señal</th>
            <th>Misses actuales</th>
            <th>Avg pre-miss</th>
            <th>Clustering</th>
            <th>Tendencia</th>
            <th>Hit Rate</th>
            <th>Hit→Hit / Miss→Hit</th>
            <th>Best DoW</th>
          </tr>
        </thead>
        <tbody>
          <tr
            v-for="c in sortedConditions"
            :key="c.strategy_name"
            :class="`row--${c.play_signal.toLowerCase()}`"
          >
            <td class="cell--name">{{ formatName(c.strategy_name) }}</td>
            <td>
              <span :class="`signal signal--${c.play_signal.toLowerCase()}`">
                {{ signalEmoji(c.play_signal) }} {{ c.play_signal }}
              </span>
            </td>
            <td class="cell--num">
              <span :class="c.current_misses > c.avg_pre_miss ? 'warn' : ''">
                {{ c.current_misses }}
              </span>
              <span class="dim"> / {{ c.avg_pre_miss.toFixed(1) }}</span>
            </td>
            <td class="cell--num">{{ c.avg_pre_miss.toFixed(1) }} ± {{ c.std_pre_miss.toFixed(1) }}</td>
            <td>
              <span :class="`cluster cluster--${c.clustering.toLowerCase()}`">{{ c.clustering }}</span>
            </td>
            <td>{{ trendEmoji(c.trend) }} {{ c.trend }}</td>
            <td class="cell--num">
              <span class="bar-wrap">
                <span class="bar" :style="{ width: `${(c.recent_hit_rate * 100).toFixed(0)}%` }"></span>
              </span>
              {{ pct(c.recent_hit_rate) }} <span class="dim">/ {{ pct(c.global_hit_rate) }}</span>
            </td>
            <td class="cell--num">{{ pct(c.hit_after_hit) }} / {{ pct(c.hit_after_miss) }}</td>
            <td class="cell--dows">{{ formatDows(c.best_dows) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, watch } from 'vue';

const API_BASE = import.meta.env.VITE_API_BASE       ?? '';
const API_KEY  = import.meta.env.VITE_AGENT_API_KEY  ?? '';

const gameType   = ref('pick3');
const drawType   = ref('midday');
const conditions = ref([]);
const loading    = ref(false);
const error      = ref('');

const DOW_NAMES = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

const playCount  = computed(() => conditions.value.filter(c => c.play_signal === 'PLAY').length);
const waitCount  = computed(() => conditions.value.filter(c => c.play_signal === 'WAIT').length);
const alertCount = computed(() => conditions.value.filter(c => c.play_signal === 'ALERT').length);
const computedAt = computed(() => {
  const d = conditions.value[0]?.computed_at;
  return d ? new Date(d).toLocaleString('es-DO') : '';
});

// Sort: ALERT first, then PLAY, then WAIT; within group by strategy_name
const SIGNAL_ORDER = { ALERT: 0, PLAY: 1, WAIT: 2 };
const sortedConditions = computed(() =>
  [...conditions.value].sort((a, b) => {
    const so = (SIGNAL_ORDER[a.play_signal] ?? 3) - (SIGNAL_ORDER[b.play_signal] ?? 3);
    return so !== 0 ? so : a.strategy_name.localeCompare(b.strategy_name);
  })
);

async function fetchConditions(refresh = false) {
  loading.value = true;
  error.value   = '';
  try {
    const url = `${API_BASE}/api/agent/agentic-progressive?game_type=${gameType.value}&draw_type=${drawType.value}&refresh=${refresh}`;
    const res = await fetch(url, { headers: { 'x-api-key': API_KEY } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    conditions.value = data.conditions ?? [];
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function signalEmoji(s) {
  return s === 'PLAY' ? '🟢' : s === 'ALERT' ? '🔴' : '🟡';
}
function trendEmoji(t) {
  return t === 'UP' ? '📈' : t === 'DOWN' ? '📉' : '➡️';
}
function pct(v) {
  return `${(v * 100).toFixed(1)}%`;
}
function formatDows(dows) {
  if (!dows || dows.length === 0) return '—';
  return dows.map(d => DOW_NAMES[d] ?? d).join(', ');
}
function formatName(name) {
  return name.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

// Auto-reload when selector changes
watch([gameType, drawType], () => fetchConditions(false));

onMounted(() => fetchConditions(false));
</script>

<style scoped>
.bb-view {
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  color: #e2e8f0;
  font-family: 'Inter', system-ui, sans-serif;
}

/* ─── Header ──────────────────────────────────────────────────── */
.bb-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.bb-header__title { display: flex; align-items: center; gap: 0.75rem; }
.bb-header__icon  { font-size: 2rem; }
.bb-header h1     { margin: 0; font-size: 1.3rem; font-weight: 700; color: #60a5fa; }
.bb-header__sub   { margin: 0; font-size: 0.8rem; color: #64748b; }
.bb-header__controls { display: flex; gap: 0.5rem; flex-wrap: wrap; align-items: center; }

.ctrl-select {
  background: #1a2535; border: 1px solid #1e2d40; color: #e2e8f0;
  border-radius: 6px; padding: 0.4rem 0.75rem; font-size: 0.85rem; cursor: pointer;
}
.ctrl-btn {
  background: #1a2535; border: 1px solid #1e2d40; color: #94a3b8;
  border-radius: 6px; padding: 0.4rem 0.9rem; font-size: 0.85rem; cursor: pointer;
  transition: background 0.15s, color 0.15s;
}
.ctrl-btn:hover:not(:disabled) { background: #1d3a5f; color: #e2e8f0; }
.ctrl-btn--primary { background: #1d3a5f; color: #60a5fa; border-color: #2563eb; }
.ctrl-btn--primary:hover:not(:disabled) { background: #2563eb; color: #fff; }
.ctrl-btn:disabled { opacity: 0.4; cursor: not-allowed; }

/* ─── Summary chips ───────────────────────────────────────────── */
.bb-summary { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.chip {
  display: inline-flex; align-items: center; gap: 0.4rem;
  padding: 0.3rem 0.75rem; border-radius: 999px;
  font-size: 0.8rem; font-weight: 600;
}
.chip--play  { background: #052e16; color: #4ade80; border: 1px solid #166534; }
.chip--wait  { background: #422006; color: #fbbf24; border: 1px solid #92400e; }
.chip--alert { background: #3b0d0d; color: #f87171; border: 1px solid #991b1b; }
.chip--info  { background: #0f1623; color: #64748b; border: 1px solid #1e2d40; }

/* ─── Error / empty / skeleton ────────────────────────────────── */
.bb-error { background: #3b0d0d; border: 1px solid #991b1b; color: #f87171; padding: 0.75rem 1rem; border-radius: 8px; }
.bb-empty { text-align: center; color: #64748b; padding: 3rem 1rem; }
.bb-empty p { margin: 0.25rem 0; }

.bb-skeleton { display: flex; flex-direction: column; gap: 0.5rem; }
.skeleton-row {
  height: 44px; background: linear-gradient(90deg, #0f1623 25%, #1a2535 50%, #0f1623 75%);
  background-size: 200% 100%; animation: shimmer 1.4s infinite; border-radius: 6px;
}
@keyframes shimmer { 0% { background-position: 200% 0; } 100% { background-position: -200% 0; } }

/* ─── Table ───────────────────────────────────────────────────── */
.bb-table-wrap { overflow-x: auto; border-radius: 10px; border: 1px solid #1e2d40; }
.bb-table {
  width: 100%; border-collapse: collapse; font-size: 0.8rem;
}
.bb-table th {
  background: #0f1623; color: #64748b; font-weight: 600; padding: 0.6rem 0.75rem;
  text-align: left; white-space: nowrap; border-bottom: 1px solid #1e2d40;
}
.bb-table td {
  padding: 0.55rem 0.75rem; border-bottom: 1px solid #111827; vertical-align: middle;
}
.bb-table tr:last-child td { border-bottom: none; }

.row--play  { background: rgba(74, 222, 128, 0.04); }
.row--alert { background: rgba(248, 113, 113, 0.06); }
.row--wait  { background: transparent; }

.bb-table tr:hover td { background: rgba(255,255,255,0.03); }

.cell--name  { font-weight: 600; color: #cbd5e1; white-space: nowrap; }
.cell--num   { font-variant-numeric: tabular-nums; color: #94a3b8; }
.cell--dows  { color: #60a5fa; font-size: 0.75rem; }

.dim { color: #475569; }
.warn { color: #f87171; font-weight: 700; }

/* ─── Signal badges ───────────────────────────────────────────── */
.signal {
  display: inline-flex; align-items: center; gap: 0.3rem;
  padding: 0.2rem 0.55rem; border-radius: 999px; font-size: 0.75rem; font-weight: 700;
}
.signal--play  { background: #052e16; color: #4ade80; }
.signal--wait  { background: #422006; color: #fbbf24; }
.signal--alert { background: #3b0d0d; color: #f87171; }

/* ─── Cluster badges ──────────────────────────────────────────── */
.cluster {
  display: inline-block; padding: 0.15rem 0.5rem; border-radius: 4px;
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.04em;
}
.cluster--hot     { background: #422006; color: #fbbf24; }
.cluster--cold    { background: #0f172a; color: #60a5fa; }
.cluster--neutral { background: #0f1623; color: #64748b; }

/* ─── Hit rate bar ────────────────────────────────────────────── */
.bar-wrap {
  display: inline-block; width: 40px; height: 6px; background: #1e2d40;
  border-radius: 3px; vertical-align: middle; margin-right: 4px; overflow: hidden;
}
.bar {
  display: block; height: 100%; background: #22c55e; border-radius: 3px;
  max-width: 100%; transition: width 0.4s;
}

/* ─── Spin icon ───────────────────────────────────────────────── */
.spin { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
</style>
