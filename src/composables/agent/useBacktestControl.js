// ═══════════════════════════════════════════════════════════════
// HITDASH — useBacktestControl
// Gestiona el ciclo de vida de jobs de backtest:
//   cargar catálogo → configurar parámetros → lanzar → polling → resultados
// ═══════════════════════════════════════════════════════════════

import { ref, computed, readonly } from 'vue';
import { apiFetch } from '../../utils/apiClient.js';

const BASE = '/api/backtest-control';
const POLL_MS = 1500; // poll cada 1.5s mientras corre

// ─── Strategy catalog (cargado desde API) ────────────────────────
export const CATEGORY_META = {
  meta:       { color: '#fbbf24', label: 'Meta-Estrategia' },
  baseline:   { color: '#4ade80', label: 'Baseline' },
  momentum:   { color: '#f59e0b', label: 'Momentum' },
  reversal:   { color: '#f87171', label: 'Reversión' },
  trend:      { color: '#60a5fa', label: 'Tendencia' },
  structural: { color: '#a3e635', label: 'Estructural' },
  cyclic:     { color: '#818cf8', label: 'Cíclica' },
};

export function useBacktestControl() {
  // ─── Catálogo ──────────────────────────────────────────────────
  const catalog         = ref([]);
  const drawsMeta       = ref([]);
  const catalogLoading  = ref(false);

  // ─── Parámetros de configuración ──────────────────────────────
  const gameType        = ref('pick3');   // pick3 | pick4
  const mode            = ref('combined'); // midday | evening | combined
  const topN            = ref(15);
  const dateFrom        = ref('');
  const dateTo          = ref('');
  const selectedStrats  = ref(new Set()); // Set de strategy IDs seleccionados

  // ─── Estado de job activo ──────────────────────────────────────
  const activeJobId     = ref(null);
  const jobStatus       = ref(null);   // 'queued'|'running'|'completed'|'error'|'cancelled'
  const jobProgress     = ref({ done: 0, total: 1, current_strategy: '' });
  const jobResults      = ref(null);
  const jobError        = ref(null);
  const running         = computed(() => ['queued', 'running'].includes(jobStatus.value));

  // ─── Historial ────────────────────────────────────────────────
  const history         = ref([]);

  // ─── Polling timer ────────────────────────────────────────────
  let pollTimer = null;

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // ─── Cargar catálogo de estrategias ────────────────────────────
  async function loadCatalog() {
    catalogLoading.value = true;
    try {
      const [catRes, metaRes] = await Promise.all([
        apiFetch(`${BASE}/strategies`),
        apiFetch(`${BASE}/draws/meta`),
      ]);
      if (catRes.ok)  catalog.value   = await catRes.json();
      if (metaRes.ok) drawsMeta.value = await metaRes.json();

      // Pre-seleccionar los que tienen default_selected
      selectedStrats.value = new Set(
        catalog.value.filter(s => s.default_selected).map(s => s.id)
      );
    } finally {
      catalogLoading.value = false;
    }
  }

  // ─── Cargar historial de jobs ──────────────────────────────────
  async function loadHistory() {
    const res = await apiFetch(`${BASE}/history`);
    if (res.ok) history.value = await res.json();
  }

  // ─── Toggle estrategia ─────────────────────────────────────────
  function toggleStrategy(id) {
    const s = new Set(selectedStrats.value);
    if (s.has(id)) s.delete(id);
    else           s.add(id);
    selectedStrats.value = s;
  }

  function selectAll()   { selectedStrats.value = new Set(catalog.value.map(s => s.id)); }
  function selectNone()  { selectedStrats.value = new Set(); }
  function selectDefault() {
    selectedStrats.value = new Set(catalog.value.filter(s => s.default_selected).map(s => s.id));
  }

  // ─── Lanzar backtest ──────────────────────────────────────────
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
  }

  // ─── Polling de estado ────────────────────────────────────────
  function startPolling(jobId) {
    stopPolling();
    pollTimer = setInterval(async () => {
      try {
        const res = await apiFetch(`${BASE}/status/${jobId}`);
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
      } catch { /* network hiccup — keep polling */ }
    }, POLL_MS);
  }

  // ─── Obtener resultados ───────────────────────────────────────
  async function fetchResults(jobId) {
    const res = await apiFetch(`${BASE}/results/${jobId}`);
    if (res.ok && res.status !== 202) {
      const data = await res.json();
      jobResults.value = data.results ?? null;
    }
  }

  // ─── Cargar resultados de job histórico ───────────────────────
  async function loadJobResults(jobId) {
    activeJobId.value = jobId;
    jobResults.value  = null;
    jobError.value    = null;
    const res = await apiFetch(`${BASE}/results/${jobId}`);
    if (!res.ok) return;
    const data = await res.json();
    jobStatus.value  = data.status ?? 'completed';
    jobResults.value = data.results ?? null;
  }

  // ─── Cancelar job activo ──────────────────────────────────────
  async function cancelJob() {
    if (!activeJobId.value) return;
    stopPolling();
    await apiFetch(`${BASE}/cancel/${activeJobId.value}`);
    jobStatus.value = 'cancelled';
  }

  // ─── Adaptive state ───────────────────────────────────────────
  const adaptiveState = ref([]);
  async function loadAdaptiveState() {
    const res = await apiFetch(
      `${BASE}/adaptive-state?game_type=${gameType.value}&mode=${mode.value}`
    );
    if (res.ok) adaptiveState.value = await res.json();
  }

  // ─── Helpers ──────────────────────────────────────────────────
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

  function pct(v) { return v != null ? (v * 100).toFixed(1) + '%' : '—'; }
  function fmtDate(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('es-PR', { dateStyle: 'short', timeStyle: 'short' });
  }

  return {
    // Catálogo
    catalog: readonly(catalog),
    drawsMeta: readonly(drawsMeta),
    catalogLoading,
    // Configuración
    gameType, mode, topN, dateFrom, dateTo, selectedStrats,
    // Job
    activeJobId, jobStatus, jobProgress, jobResults, jobError, running,
    progressPct, resultsSorted,
    // Historial
    history: readonly(history),
    // Adaptive
    adaptiveState: readonly(adaptiveState),
    // Helpers
    drawsMetaForContext, pct, fmtDate,
    // Acciones
    loadCatalog, loadHistory, loadAdaptiveState,
    toggleStrategy, selectAll, selectNone, selectDefault,
    runBacktest, cancelJob, loadJobResults,
  };
}
