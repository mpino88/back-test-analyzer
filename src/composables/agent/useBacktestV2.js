// ═══════════════════════════════════════════════════════════════
// HITDASH — useBacktestV2 composable
// Fetches, triggers, and manages backtest_results_v2 data
// ═══════════════════════════════════════════════════════════════
import { ref, computed } from 'vue';
import { apiGet, apiPost } from '../../utils/apiClient.js';
import { useBacktestControl } from './useBacktestControl.js';

const STRATEGY_META = {
  frequency_rank:    { label: 'Frequency Rank',     icon: '📊', color: '#3b82f6' },
  hot_cold_weighted: { label: 'Hot/Cold Weighted',  icon: '🌡', color: '#f59e0b' },
  gap_overdue_focus: { label: 'Gap Overdue Focus',  icon: '⏱',  color: '#10b981' },
  moving_avg_signal: { label: 'Moving Average',     icon: '📈', color: '#8b5cf6' },
  momentum_ema:      { label: 'Momentum EMA',       icon: '⚡', color: '#ec4899' },
  streak_reversal:   { label: 'Streak Reversal',    icon: '🔄', color: '#06b6d4' },
  position_bias:     { label: 'Position Bias',      icon: '🎯', color: '#84cc16' },
  pair_correlation:  { label: 'Pair Correlation',   icon: '🔗', color: '#f97316' },
  fibonacci_pisano:  { label: 'Fibonacci/Pisano',   icon: '🌀', color: '#a78bfa' },
  consensus_top:     { label: 'Consensus Top',      icon: '🧩', color: '#64748b' },
  apex_adaptive:     { label: 'APEX Adaptive',      icon: '🦾', color: '#60a5fa' },
};

export function useBacktestV2() {
  const results      = ref([]);
  const loading      = ref(false);
  const running      = ref(false);
  const error        = ref(null);
  const runMsg       = ref('');
  const runError     = ref(false);
  const selectedName = ref(null);

  // ── Controls ─────────────────────────────────────────────────
  const { gameType, mode, setGameType, setMode } = useBacktestControl();
  const halfFilter = ref('all');  // 'all' | 'du' | 'ab' | 'cd'

  // ── Derived ──────────────────────────────────────────────────
  const filtered = computed(() => {
    if (!results.value.length) return [];
    return results.value.filter(r => {
      if (halfFilter.value !== 'all' && r.half !== halfFilter.value) return false;
      return true;
    });
  });

  const bestStrategy = computed(() => {
    if (!filtered.value.length) return null;
    return [...filtered.value].sort((a, b) => b.hit_rate - a.hit_rate)[0];
  });

  const selected = computed(() =>
    filtered.value.find(r => r.strategy_name === selectedName.value) ?? bestStrategy.value
  );

  const avgHitRate = computed(() => {
    if (!filtered.value.length) return 0;
    return filtered.value.reduce((s, r) => s + r.hit_rate, 0) / filtered.value.length;
  });

  const avgKelly = computed(() => {
    if (!filtered.value.length) return 0;
    return filtered.value.reduce((s, r) => s + r.kelly_fraction, 0) / filtered.value.length;
  });

  const totalEvalPts = computed(() => filtered.value[0]?.total_eval_pts ?? 0);

  // ── Chart datasets ───────────────────────────────────────────
  const barChartData = computed(() => {
    const rows = [...filtered.value].sort((a, b) => b.hit_rate - a.hit_rate);
    return {
      labels: rows.map(r => STRATEGY_META[r.strategy_name]?.label ?? r.strategy_name),
      datasets: [
        {
          label: 'Hit Rate %',
          data: rows.map(r => +(r.hit_rate * 100).toFixed(2)),
          backgroundColor: rows.map(r => (STRATEGY_META[r.strategy_name]?.color ?? '#64748b') + 'cc'),
          borderColor:     rows.map(r => STRATEGY_META[r.strategy_name]?.color ?? '#64748b'),
          borderWidth: 1,
          borderRadius: 6,
        },
      ],
    };
  });

  const radarChartData = computed(() => {
    if (!selected.value) return null;
    const s = selected.value;
    return {
      labels: ['Hit Rate', 'MRR×10', 'P@10', 'Sharpe/3', 'Kelly×3', 'Wilson↓'],
      datasets: [{
        label: STRATEGY_META[s.strategy_name]?.label ?? s.strategy_name,
        data: [
          +(s.hit_rate * 100).toFixed(1),
          +(s.mrr * 1000).toFixed(1),
          +(s.precision_at_10 * 100).toFixed(1),
          +((s.sharpe / 3) * 100).toFixed(1),
          +(s.kelly_fraction * 300).toFixed(1),
          +(s.wilson_lower * 100).toFixed(1),
        ],
        backgroundColor: (STRATEGY_META[s.strategy_name]?.color ?? '#60a5fa') + '33',
        borderColor:      STRATEGY_META[s.strategy_name]?.color ?? '#60a5fa',
        borderWidth: 2,
        pointBackgroundColor: STRATEGY_META[s.strategy_name]?.color ?? '#60a5fa',
      }],
    };
  });

  // ── API calls ────────────────────────────────────────────────
  async function fetchResults() {
    loading.value = true;
    error.value   = null;
    try {
      results.value = await apiGet(
        `/api/agent/backtest/v2/results?game_type=${gameType.value}&mode=${mode.value}`
      );
      selectedName.value = null;
    } catch (e) {
      error.value = e.message;
      results.value = [];
    } finally {
      loading.value = false;
    }
  }

  async function runBacktest() {
    running.value  = true;
    runMsg.value   = '';
    runError.value = false;
    try {
      await apiPost('/api/agent/backtest/v2/run', { game_type: gameType.value, mode: mode.value });
      runMsg.value = `⚙️ Backtest encolado — puede tardar 1-3 min. Recarga al completar.`;
    } catch (e) {
      runMsg.value   = `❌ ${e.message}`;
      runError.value = true;
    } finally {
      running.value = false;
    }
  }

  function selectStrategy(name) {
    selectedName.value = selectedName.value === name ? null : name;
  }

  function meta(name) {
    return STRATEGY_META[name] ?? { label: name, icon: '📌', color: '#64748b' };
  }

  function pct(v)     { return v != null ? (v * 100).toFixed(1) + '%' : '—'; }
  function fmtN(v, d=3) { return v != null ? (+v).toFixed(d) : '—'; }
  function rank(v)    { return v != null ? (+v).toFixed(1) : '—'; }

  return {
    // state
    results, loading, running, error, runMsg, runError, selectedName,
    // controls
    gameType, mode, halfFilter,
    // derived
    filtered, bestStrategy, selected, avgHitRate, avgKelly, totalEvalPts,
    // charts
    barChartData, radarChartData,
    // actions
    fetchResults, runBacktest, selectStrategy,
    // helpers
    meta, pct, fmtN, rank,
  };
}
