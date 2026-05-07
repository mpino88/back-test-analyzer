// ═══════════════════════════════════════════════════════════════
// HITDASH — useBacktestControl  (v3 — SINGLETON STATE)
//
// APEX FIX: El estado de configuración (gameType, mode, topN, etc.)
// se declara a NIVEL DE MÓDULO para que todas las vistas que llamen
// a este composable compartan el mismo estado reactivo.
// Así no hay desconexión entre los botones del header y la tabla de resultados.
// ═══════════════════════════════════════════════════════════════

import { ref, computed, readonly } from 'vue';
import { apiFetch } from '../../utils/apiClient.js';

const BASE    = '/api/backtest-control';
const POLL_MS = 1500;

// ─── Strategy catalog metadata ────────────────────────────────
export const CATEGORY_META = {
  meta:       { color: '#fbbf24', label: 'Meta-Estrategia' },
  baseline:   { color: '#4ade80', label: 'Baseline' },
  momentum:   { color: '#f59e0b', label: 'Momentum' },
  reversal:   { color: '#f87171', label: 'Reversión' },
  trend:      { color: '#60a5fa', label: 'Tendencia' },
  structural: { color: '#a3e635', label: 'Estructural' },
  cyclic:     { color: '#818cf8', label: 'Cíclica' },
};

// ─────────────────────────────────────────────────────────────
// ██  SINGLETON STATE — Nivel Módulo  ██
// Todos los componentes que usen este composable comparten
// exactamente estos mismos refs. No hay duplicación de estado.
// ─────────────────────────────────────────────────────────────

// Catálogo
const catalog        = ref([]);
const drawsMeta      = ref([]);
const catalogLoading = ref(false);

// Parámetros de configuración (The "Context" — Single Source of Truth)
const gameType       = ref('pick3');    // 'pick3' | 'pick4'
const mode           = ref('combined'); // 'midday' | 'evening' | 'combined'
const topN           = ref(15);
const dateFrom       = ref('');
const dateTo         = ref('');
const selectedStrats = ref(new Set());

// Estado de job activo
const activeJobId    = ref(null);
const jobStatus      = ref(null);
const jobProgress    = ref({ done: 0, total: 1, current_strategy: '' });
const jobResults     = ref(null);
const jobError       = ref(null);

// Historial
const history        = ref([]);

// Adaptive weights
const adaptiveState  = ref([]);

// Polling
let pollTimer = null;

// ─────────────────────────────────────────────────────────────
// ██  MUTATORS — Las ÚNICAS funciones que modifican el estado ██
// El Template NUNCA asigna directamente a un ref exportado.
// ─────────────────────────────────────────────────────────────
function setGameType(gt)  { gameType.value = gt; }
function setMode(m)       { mode.value     = m; }
function setTopN(n)       { topN.value     = Number(n); }
function setDateFrom(d)   { dateFrom.value = d; }
function setDateTo(d)     { dateTo.value   = d; }
function clearDates()     { dateFrom.value = ''; dateTo.value = ''; }

// ─── Polling ──────────────────────────────────────────────────
function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
}

// ─── Cargar catálogo ──────────────────────────────────────────
async function loadCatalog() {
  catalogLoading.value = true;
  try {
    const [catRes, metaRes] = await Promise.all([
      apiFetch(`${BASE}/strategies`),
      apiFetch(`${BASE}/draws/meta`),
    ]);
    if (catRes.ok) {
      const data = await catRes.json();
      catalog.value = Array.isArray(data) ? data : [];
    }
    if (metaRes.ok) {
      const data = await metaRes.json();
      drawsMeta.value = Array.isArray(data) ? data : [];
    }
    selectedStrats.value = new Set(
      catalog.value.filter(s => s.default_selected).map(s => s.id)
    );
  } catch (err) {
    console.error('[BT-Control] loadCatalog error:', err);
    catalog.value   = [];
    drawsMeta.value = [];
  } finally {
    catalogLoading.value = false;
  }
}

// ─── Cargar historial ─────────────────────────────────────────
async function loadHistory() {
  try {
    const res = await apiFetch(`${BASE}/history`);
    if (res.ok) {
      const data = await res.json();
      history.value = Array.isArray(data) ? data : [];
    }
  } catch (err) {
    console.error('[BT-Control] loadHistory error:', err);
  }
}

// ─── Cargar adaptive weights ──────────────────────────────────
// FIX: pg driver devuelve columnas NUMERIC como strings en JS.
// Si no normalizamos, aw.weight?.toFixed(3) explota con
// "c.toFixed is not a function" y Vue desmonta la vista en silencio.
async function loadAdaptiveState() {
  try {
    const res = await apiFetch(
      `${BASE}/adaptive-state?game_type=${gameType.value}&mode=${mode.value}`
    );
    if (res.ok) {
      const data = await res.json();
      adaptiveState.value = (Array.isArray(data) ? data : []).map(row => ({
        ...row,
        weight:            Number(row.weight   ?? 1),
        top_n:             Number(row.top_n    ?? 15),
        hit_rate_history:  Array.isArray(row.hit_rate_history)
                             ? row.hit_rate_history.map(Number)
                             : [],
      }));
    }
  } catch (err) {
    console.error('[BT-Control] loadAdaptiveState error:', err);
  }
}

// ─── Estrategias selection ────────────────────────────────────
function toggleStrategy(id) {
  const s = new Set(selectedStrats.value);
  if (s.has(id)) s.delete(id); else s.add(id);
  selectedStrats.value = s;
}
function selectAll()     { selectedStrats.value = new Set(catalog.value.map(s => s.id)); }
function selectNone()    { selectedStrats.value = new Set(); }
function selectDefault() { selectedStrats.value = new Set(catalog.value.filter(s => s.default_selected).map(s => s.id)); }

// ─── Lanzar backtest ──────────────────────────────────────────
const running = computed(() => ['queued', 'running'].includes(jobStatus.value));

async function runBacktest() {
  if (running.value) return;
  jobStatus.value   = 'queued';
  jobProgress.value = { done: 0, total: [...selectedStrats.value].length + 1, current_strategy: 'iniciando…' };
  jobResults.value  = null;
  jobError.value    = null;

  const body = {
    game_type:  gameType.value,
    mode:       mode.value,
    strategies: [...selectedStrats.value],
    top_n:      topN.value,
    date_from:  dateFrom.value || undefined,
    date_to:    dateTo.value   || undefined,
  };

  try {
    const res = await apiFetch(`${BASE}/run`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
      jobStatus.value = 'error';
      jobError.value  = err.error ?? 'Error al lanzar backtest';
      return;
    }
    const { job_id } = await res.json();
    activeJobId.value = job_id;
    startPolling(job_id);
  } catch (err) {
    jobStatus.value = 'error';
    jobError.value  = err instanceof Error ? err.message : 'Error de red';
  }
}

// ─── Polling ──────────────────────────────────────────────────
function startPolling(jobId) {
  stopPolling();
  pollTimer = setInterval(async () => {
    try {
      const res  = await apiFetch(`${BASE}/status/${jobId}`);
      if (!res.ok) return;
      const data = await res.json();
      jobStatus.value   = data.status;
      jobProgress.value = data.progress ?? jobProgress.value;
      if (data.status === 'completed') {
        stopPolling();
        await fetchResults(jobId);
        await loadHistory();
      } else if (data.status === 'error' || data.status === 'cancelled') {
        stopPolling();
        jobError.value = data.error ?? 'Job cancelado o con error';
        await loadHistory();
      }
    } catch { /* network hiccup */ }
  }, POLL_MS);
}

// ─── Resultados ───────────────────────────────────────────────
// FIX: pg devuelve NUMERIC como string. Normalizar TODOS los campos
// numéricos para evitar "x.toFixed is not a function" en el template.
function normalizeResults(raw) {
  return (raw ?? []).map(r => ({
    ...r,
    hit_rate:    Number(r.hit_rate    ?? 0),
    win_rate:    Number(r.win_rate    ?? 0),
    weight:      Number(r.weight      ?? 1),
    top_n:       Number(r.top_n       ?? 15),
    final_top_n: r.final_top_n != null ? Number(r.final_top_n) : null,
    mrr:         r.mrr    != null ? Number(r.mrr)    : null,
    sharpe:      r.sharpe != null ? Number(r.sharpe) : null,
    total_eval_pts: r.total_eval_pts != null ? Number(r.total_eval_pts) : null,
  }));
}

async function fetchResults(jobId) {
  const res = await apiFetch(`${BASE}/results/${jobId}`);
  if (res.ok && res.status !== 202) {
    const data = await res.json();
    jobResults.value = normalizeResults(data.results);
  }
}

async function loadJobResults(jobId) {
  activeJobId.value = jobId;
  jobResults.value  = null;
  jobError.value    = null;
  const res = await apiFetch(`${BASE}/results/${jobId}`);
  if (!res.ok) return;
  const data = await res.json();

  // Sync context selectors with the historical job being viewed
  if (data.game_type) setGameType(data.game_type);
  if (data.mode)      setMode(data.mode);
  if (data.top_n)     setTopN(data.top_n);
  if (data.date_from) setDateFrom(data.date_from.slice(0, 10));
  if (data.date_to)   setDateTo(data.date_to.slice(0, 10));

  jobStatus.value  = data.status ?? 'completed';
  jobResults.value = normalizeResults(data.results);
}

async function cancelJob() {
  if (!activeJobId.value) return;
  stopPolling();
  await apiFetch(`${BASE}/cancel/${activeJobId.value}`);
  jobStatus.value = 'cancelled';
}

// ─── Computados ───────────────────────────────────────────────
const progressPct = computed(() => {
  const { done, total } = jobProgress.value;
  return total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
});

const resultsSorted = computed(() => {
  if (!jobResults.value) return [];
  return [...jobResults.value].sort(
    (a, b) => (b.hit_rate ?? b.win_rate ?? 0) - (a.hit_rate ?? a.win_rate ?? 0)
  );
});

const drawsMetaForContext = computed(() => {
  if (!drawsMeta.value.length) return null;
  const g = gameType.value === 'pick3' ? 'p3' : 'p4';
  const p = mode.value === 'midday' ? 'm' : mode.value === 'evening' ? 'e' : null;
  const rows = drawsMeta.value.filter(r => r.game === g && (p === null || r.period === p));
  if (!rows.length) return null;
  return {
    count:    rows.reduce((s, r) => s + parseInt(r.count, 10), 0),
    date_min: rows.map(r => r.date_min).sort()[0],
    date_max: rows.map(r => r.date_max).sort().at(-1),
  };
});

function pct(v)     { return v != null ? (v * 100).toFixed(1) + '%' : '—'; }
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-PR', { dateStyle: 'short', timeStyle: 'short' });
}

// ─────────────────────────────────────────────────────────────
// ██  COMPOSABLE EXPORT  ██
// ─────────────────────────────────────────────────────────────
export function useBacktestControl() {
  return {
    // Catálogo (read-only desde fuera)
    catalog:     readonly(catalog),
    drawsMeta:   readonly(drawsMeta),
    catalogLoading,
    // Context — refs mutable sólo vía setters
    gameType:    readonly(gameType),
    mode:        readonly(mode),
    topN:        readonly(topN),
    dateFrom:    readonly(dateFrom),
    dateTo:      readonly(dateTo),
    selectedStrats,
    // Mutators explícitos (elimina la asignación directa de template)
    setGameType, setMode, setTopN, setDateFrom, setDateTo, clearDates,
    // Job
    activeJobId, jobStatus, jobProgress, jobResults, jobError, running,
    progressPct, resultsSorted,
    history:     readonly(history),
    adaptiveState: readonly(adaptiveState),
    drawsMetaForContext, pct, fmtDate,
    // Acciones
    loadCatalog, loadHistory, loadAdaptiveState,
    toggleStrategy, selectAll, selectNone, selectDefault,
    runBacktest, cancelJob, loadJobResults,
  };
}
