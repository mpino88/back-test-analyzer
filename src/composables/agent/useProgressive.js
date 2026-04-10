// ═══════════════════════════════════════════════════════════════
// HITDASH — useProgressive composable
// Gestiona Progressive Engine: fetch latest cache + trigger run
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue';
import { apiGet, apiPost } from '../../utils/apiClient.js';
import { useBacktestControl } from './useBacktestControl.js';

const SIGNAL_META = {
  PLAY:  { color: '#22c55e', bg: '#052e16', label: 'JUGAR',   icon: '▶', ring: '#16a34a' },
  WAIT:  { color: '#f59e0b', bg: '#1c1102', label: 'ESPERAR', icon: '⏸', ring: '#d97706' },
  ALERT: { color: '#ef4444', bg: '#1f0202', label: 'ALERTA',  icon: '⚠', ring: '#dc2626' },
};

const TREND_META = {
  up:     { color: '#22c55e', icon: '↑', label: 'Alza'    },
  down:   { color: '#ef4444', icon: '↓', label: 'Baja'    },
  stable: { color: '#94a3b8', icon: '→', label: 'Estable' },
};

export function useProgressive() {
  const { gameType, mode, setGameType, setMode } = useBacktestControl();

  const result   = ref(null);
  const loading  = ref(false);
  const running  = ref(false);
  const error    = ref(null);
  const runMsg   = ref('');
  const runError = ref(false);

  // ── Controls ──────────────────────────────────────────────────
  const mapSource = computed({
    get: () => gameType.value === 'pick3' ? 'p3' : 'p4',
    set: (v) => setGameType(v === 'p3' ? 'pick3' : 'pick4')
  });

  const period = computed({
    get: () => mode.value === 'evening' ? 'e' : 'm',
    set: (v) => setMode(v === 'evening' ? 'evening' : 'midday')
  });

  const topN       = ref(10);
  const startDate  = ref(oneYearAgo());
  const endDate    = ref(today());

  function oneYearAgo() {
    const d = new Date(); d.setFullYear(d.getFullYear() - 1);
    return d.toISOString().slice(0, 10);
  }
  function today() { return new Date().toISOString().slice(0, 10); }

  // ── Derived ───────────────────────────────────────────────────
  const subsets = computed(() => result.value?.topSubsets ?? []);

  /** Señal de consenso: mayoría entre las señales de todos los subsets */
  const consensusSignal = computed(() => {
    if (!subsets.value.length) return null;
    const counts = { PLAY: 0, WAIT: 0, ALERT: 0 };
    for (const s of subsets.value) {
      const sig = s.conditions?.playSignal;
      if (sig && sig in counts) counts[sig]++;
    }
    // ALERT tiene prioridad si alguno dispara
    if (counts.ALERT > 0) return 'ALERT';
    const total = subsets.value.length;
    if (counts.PLAY / total >= 0.5) return 'PLAY';
    if (counts.WAIT / total >= 0.5) return 'WAIT';
    return 'WAIT';
  });

  const playCount  = computed(() => subsets.value.filter(s => s.conditions?.playSignal === 'PLAY').length);
  const waitCount  = computed(() => subsets.value.filter(s => s.conditions?.playSignal === 'WAIT').length);
  const alertCount = computed(() => subsets.value.filter(s => s.conditions?.playSignal === 'ALERT').length);

  const avgHitRate = computed(() => {
    if (!subsets.value.length) return 0;
    return subsets.value.reduce((acc, s) => acc + s.hitRate, 0) / subsets.value.length;
  });

  const bestSubset = computed(() =>
    subsets.value.length ? subsets.value[0] : null
  );

  const cachedAt = computed(() => {
    if (!result.value?.cached_at && !result.value?.generatedAt) return null;
    const raw = result.value?.cached_at ?? result.value?.generatedAt;
    return new Date(raw).toLocaleString('es-DO', {
      dateStyle: 'medium', timeStyle: 'short',
    });
  });

  // ── API ───────────────────────────────────────────────────────
  async function fetchLatest() {
    loading.value = true;
    error.value   = null;
    try {
      result.value = await apiGet(
        `/api/agent/backtest/progressive/latest?map_source=${mapSource.value}&period=${period.value}`
      );
    } catch (e) {
      error.value   = e.message;
      result.value  = null;
    } finally {
      loading.value = false;
    }
  }

  async function runAnalysis() {
    running.value  = true;
    runMsg.value   = '';
    runError.value = false;
    try {
      await apiPost('/api/agent/backtest/progressive', {
        map_source: mapSource.value,
        period:     period.value,
        top_n:      topN.value,
        start_date: startDate.value,
        end_date:   endDate.value,
      });
      runMsg.value = '⚙️ Análisis en curso — puede tardar 30-90s. Se actualizará al completar.';
      await pollUntilFresh();
    } catch (e) {
      runMsg.value   = `❌ ${e.message}`;
      runError.value = true;
    } finally {
      running.value = false;
    }
  }

  async function pollUntilFresh() {
    const before = result.value?.generatedAt ?? result.value?.cached_at ?? '';
    const maxTries = 24;  // ~2 min
    for (let i = 0; i < maxTries; i++) {
      await sleep(5000);
      try {
        const fresh = await apiGet(
          `/api/agent/backtest/progressive/latest?map_source=${mapSource.value}&period=${period.value}`
        );
        const freshTs = fresh?.cached_at ?? fresh?.generatedAt ?? '';
        if (freshTs && freshTs !== before) {
          result.value = fresh;
          runMsg.value = '✅ Análisis completado.';
          return;
        }
      } catch {}
    }
    runMsg.value = '⏱ Análisis puede seguir corriendo en background. Recarga en 1 min.';
  }

  function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

  // ── Helpers ───────────────────────────────────────────────────
  function signalMeta(sig)  { return SIGNAL_META[sig]  ?? SIGNAL_META.WAIT; }
  function trendMeta(trend) { return TREND_META[trend] ?? TREND_META.stable; }
  function pct(v)           { return v != null && v >= 0 ? (v * 100).toFixed(1) + '%' : '—'; }
  function fmt(v)           { return v != null ? Math.round(v) : '—'; }

  return {
    // state
    result, loading, running, error, runMsg, runError,
    // controls
    mapSource, period, topN, startDate, endDate,
    // derived
    subsets, consensusSignal, playCount, waitCount, alertCount,
    avgHitRate, bestSubset, cachedAt,
    // actions
    fetchLatest, runAnalysis,
    // helpers
    signalMeta, trendMeta, pct, fmt,
    SIGNAL_META, TREND_META,
  };
}
