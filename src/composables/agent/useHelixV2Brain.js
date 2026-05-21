// ═══════════════════════════════════════════════════════════════
// HITDASH — useHelixV2Brain composable (C1, 2026-05-20)
//
// Consume todos los endpoints del cerebro F1 en una vista unificada:
//   - /api/agent/evt-state               → régimen actual + gating weights
//   - /api/agent/thompson-state          → Top 5 algos por UCB Bayesiano
//   - /api/agent/multivariate-hawkes     → señales dígito-a-dígito (si las hay)
//   - /api/agent/helix-v2/predict        → predicción integrada
//
// Auto-refresh cada 30s. Tolerante a fallos por endpoint.
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onMounted, onUnmounted } from 'vue';
import { apiGet } from '../../utils/apiClient.js';
import { useBacktestControl } from './useBacktestControl.js';

export function useHelixV2Brain() {
  const { gameType, mode } = useBacktestControl();

  const evtState        = ref(null);
  const gating          = ref(null);
  const thompsonAlgos   = ref([]);
  const helixPrediction = ref(null);
  const hawkesSignal    = ref(null);
  const loading         = ref(false);
  const error           = ref(null);
  const lastFetch       = ref(null);

  // Half por defecto según game_type
  const defaultHalf = computed(() => gameType.value === 'pick3' ? 'du' : 'ab');

  async function refresh() {
    loading.value = true;
    error.value   = null;
    try {
      const half = defaultHalf.value;

      // Llamadas paralelas, tolerantes a fallos
      const [evt, thompson, helix, hawkes] = await Promise.allSettled([
        apiGet(`/api/agent/evt-state?game_type=${gameType.value}&draw_type=${mode.value}&half=${half}`),
        apiGet(`/api/agent/thompson-state?game_type=${gameType.value}&draw_type=${mode.value}&half=${half}&n_at=15`),
        apiGet(`/api/agent/helix-v2/predict?game_type=${gameType.value}&draw_type=${mode.value}&half=${half}`),
        apiGet(`/api/agent/multivariate-hawkes?game_type=${gameType.value}&draw_type=${mode.value}&digit_pos=p2`),
      ]);

      if (evt.status === 'fulfilled') {
        evtState.value = evt.value.evt_state ?? null;
        gating.value   = evt.value.gating    ?? null;
      }
      if (thompson.status === 'fulfilled') {
        const states = thompson.value.states ?? [];
        thompsonAlgos.value = states.slice(0, 5);
      }
      if (helix.status === 'fulfilled') {
        helixPrediction.value = helix.value;
      }
      if (hawkes.status === 'fulfilled') {
        hawkesSignal.value = hawkes.value;
      }

      lastFetch.value = new Date().toISOString();
    } catch (e) {
      error.value = e?.message ?? String(e);
    } finally {
      loading.value = false;
    }
  }

  // ─── Computeds ───────────────────────────────────────────────
  const regimeBadge = computed(() => {
    if (!evtState.value) return { label: '—', color: '#475569', emoji: '⚪' };
    const r = evtState.value.regime;
    switch (r) {
      case 'HAWKES_QUAD_CLUSTER':   return { label: 'Quad Cluster', color: '#dc2626', emoji: '🔥' };
      case 'HAWKES_TRIPLE_CLUSTER': return { label: 'Triple Cluster', color: '#f59e0b', emoji: '⚡' };
      case 'EVT_QUAD_OVERDUE':      return { label: 'Quad Overdue', color: '#ea580c', emoji: '⏰' };
      case 'EVT_TRIPLE_OVERDUE':    return { label: 'Triple Overdue', color: '#eab308', emoji: '⏱' };
      case 'NORMAL':                return { label: 'Normal', color: '#64748b', emoji: '⚪' };
      default:                      return { label: r ?? '—', color: '#475569', emoji: '⚪' };
    }
  });

  const activeMultipliers = computed(() => {
    if (!gating.value?.weights) return [];
    return Object.entries(gating.value.weights)
      .filter(([, w]) => Math.abs(w - 1.0) > 0.05)
      .map(([algo, w]) => ({ algo, weight: +w.toFixed(2), direction: w > 1 ? 'boost' : 'suppress' }))
      .sort((a, b) => Math.abs(b.weight - 1) - Math.abs(a.weight - 1));
  });

  const hawkesPairCount = computed(() =>
    hawkesSignal.value?.significant_pairs?.length ?? 0
  );

  const topHawkesPairs = computed(() =>
    (hawkesSignal.value?.significant_pairs ?? [])
      .slice(0, 5)
      .map(p => ({
        from: p.digit_from,
        to:   p.digit_to,
        lift: p.lift,
        effect: p.effect,
      }))
  );

  const conformalCoverage = computed(() => {
    if (!helixPrediction.value) return null;
    return {
      threshold: helixPrediction.value.coverage_80_threshold,
      pairs:     helixPrediction.value.conformal_pairs_80?.length ?? 0,
      level:     helixPrediction.value.confidence_level ?? 0.80,
    };
  });

  // ─── Lifecycle ───────────────────────────────────────────────
  let timer = null;
  onMounted(() => {
    refresh();
    timer = setInterval(refresh, 30_000);
  });
  onUnmounted(() => {
    if (timer) clearInterval(timer);
  });

  return {
    // state
    evtState, gating, thompsonAlgos, helixPrediction, hawkesSignal,
    loading, error, lastFetch,
    // controls
    gameType, mode,
    // computed
    regimeBadge, activeMultipliers, hawkesPairCount, topHawkesPairs, conformalCoverage,
    // actions
    refresh,
  };
}
