// ═══════════════════════════════════════════════════════════════
// HELIX — useHelixBrain (Sistema Nervioso Central UNIFICADO v2.0)
//
// Una sola fuente de verdad para TODO el estado vivo del agente:
//   - SSE básico (online, alerts, strategies, predictions)
//   - HELIX v2 cerebro F1 (régimen EVT/Hawkes, gating, Thompson, conformal)
//   - Salud algoritmos (HARMFUL silenciados, edge confirmado)
//
// USO:
//   En AgentLayout.vue:
//     const brain = createHelixBrain(sseStatus);
//     provide('helixBrain', brain);
//
//   En cualquier view o componente:
//     const brain = inject('helixBrain');
//     brain.regime.value          // 'HAWKES_QUAD_CLUSTER' | ...
//     brain.activeMultipliers.value  // [{algo, weight, direction}]
//     brain.thompsonLeaders.value    // top 5 algos UCB
//     brain.conformalCoverage.value  // {threshold, pairs, level}
// ═══════════════════════════════════════════════════════════════

import { ref, computed, onUnmounted } from 'vue';
import { apiGet } from '../../utils/apiClient.js';

// ── Singleton state — UNA instancia por app ────────────────────
// Se crea por createHelixBrain() y se reutiliza via inject('helixBrain')
let _refreshTimer = null;
const _evtPick3Evening   = ref(null);
const _evtPick4Evening   = ref(null);
const _thompsonPick3     = ref([]);
const _thompsonPick4     = ref([]);
const _helixPredictPick4 = ref(null);
const _lastF1Fetch       = ref(null);
const _f1Loading         = ref(false);
const _f1Error           = ref(null);

// ── Régimen badge mapping ──────────────────────────────────────
const REGIME_META = {
  HAWKES_QUAD_CLUSTER:   { label: 'Quad Cluster',   color: '#dc2626', emoji: '🔥' },
  HAWKES_TRIPLE_CLUSTER: { label: 'Triple Cluster', color: '#f59e0b', emoji: '⚡' },
  EVT_QUAD_OVERDUE:      { label: 'Quad Overdue',   color: '#ea580c', emoji: '⏰' },
  EVT_TRIPLE_OVERDUE:    { label: 'Triple Overdue', color: '#eab308', emoji: '⏱' },
  NORMAL:                { label: 'Normal',          color: '#64748b', emoji: '⚪' },
};

// ── Fetcher unificado del cerebro F1 ───────────────────────────
async function refreshF1() {
  if (_f1Loading.value) return;
  _f1Loading.value = true;
  _f1Error.value = null;
  try {
    const [evt3, evt4, th3, th4, helix4] = await Promise.allSettled([
      apiGet('/api/agent/evt-state?game_type=pick3&draw_type=evening&half=du'),
      apiGet('/api/agent/evt-state?game_type=pick4&draw_type=evening&half=ab'),
      apiGet('/api/agent/thompson-state?game_type=pick3&draw_type=evening&half=du&n_at=15'),
      apiGet('/api/agent/thompson-state?game_type=pick4&draw_type=evening&half=ab&n_at=15'),
      apiGet('/api/agent/helix-v2/predict?game_type=pick4&draw_type=evening&half=ab'),
    ]);

    if (evt3.status === 'fulfilled') _evtPick3Evening.value = evt3.value;
    if (evt4.status === 'fulfilled') _evtPick4Evening.value = evt4.value;
    if (th3.status === 'fulfilled')  _thompsonPick3.value   = (th3.value.states ?? []).slice(0, 5);
    if (th4.status === 'fulfilled')  _thompsonPick4.value   = (th4.value.states ?? []).slice(0, 5);
    if (helix4.status === 'fulfilled') _helixPredictPick4.value = helix4.value;

    _lastF1Fetch.value = new Date().toISOString();
  } catch (e) {
    _f1Error.value = e?.message ?? String(e);
  } finally {
    _f1Loading.value = false;
  }
}

/**
 * Crea el brain store derivado del payload SSE + HELIX v2 endpoints.
 * @param {import('vue').Ref} sseStatus - ref con el último payload SSE
 */
export function createHelixBrain(sseStatus) {
  // ── Auto-fetch del cerebro F1 cada 30s ───────────────────────
  if (!_refreshTimer) {
    refreshF1();   // first immediate fetch
    _refreshTimer = setInterval(refreshF1, 30_000);
  }
  onUnmounted(() => {
    if (_refreshTimer) {
      clearInterval(_refreshTimer);
      _refreshTimer = null;
    }
  });

  // ── FIX (2026-05-21): mostrar AMBOS juegos en paralelo, no priorizar uno ──
  // Antes: priorizaba pick4 si en cluster → pick3 quedaba oculto.
  // Ahora: ambos games exponen su propio estado independiente, la UI
  // los muestra side-by-side.

  function buildGameView(evtRef, thompsonRef, game) {
    return computed(() => {
      const evt = evtRef.value;
      const state  = evt?.evt_state ?? {};
      const gating = evt?.gating ?? {};
      const regime = state.regime ?? 'NORMAL';
      const weights = gating.weights ?? {};
      const intensity = Math.max(
        state.quad_hawkes_intensity ?? 0,
        state.triple_hawkes_intensity ?? 0,
      );
      const daysSince = state.days_since_quad ?? state.days_since_triple ?? null;

      const multipliers = Object.entries(weights)
        .filter(([, v]) => Math.abs(v - 1.0) > 0.05)
        .map(([algo, v]) => ({ algo, weight: +v.toFixed(2), direction: v > 1 ? 'boost' : 'suppress' }))
        .sort((a, b) => Math.abs(b.weight - 1) - Math.abs(a.weight - 1));

      return {
        game,
        regime,
        meta: REGIME_META[regime] ?? REGIME_META.NORMAL,
        strength:    state.regime_strength ?? 0,
        intensity,
        daysSince,
        multipliers,
        topMultiplier: multipliers[0] ?? null,
        thompsonLeaders: (thompsonRef.value ?? []).slice(0, 5),
        topThompson:     (thompsonRef.value ?? [])[0] ?? null,
        explanation:     gating.explanation ?? null,
      };
    });
  }

  // ── Vista independiente por juego ───────────────────────────
  const pick3View = buildGameView(_evtPick3Evening, _thompsonPick3, 'pick3');
  const pick4View = buildGameView(_evtPick4Evening, _thompsonPick4, 'pick4');

  // ── Compatibilidad con código legacy (DashboardView usa esto) ──
  // Prioriza el juego con régimen no-NORMAL para "activeGame"
  const activeRegime = computed(() => {
    if (pick4View.value.regime !== 'NORMAL') return pick4View.value;
    if (pick3View.value.regime !== 'NORMAL') return pick3View.value;
    return pick4View.value; // default
  });

  const regime         = computed(() => activeRegime.value.regime);
  const regimeMeta     = computed(() => activeRegime.value.meta);
  const regimeStrength = computed(() => activeRegime.value.strength);
  const activeMultipliers = computed(() => activeRegime.value.multipliers);
  const thompsonLeaders   = computed(() => activeRegime.value.thompsonLeaders);
  const hawkesIntensity   = computed(() => activeRegime.value.intensity);
  const daysSinceRareEvent = computed(() => activeRegime.value.daysSince);

  const conformalCoverage = computed(() => {
    const p = _helixPredictPick4.value;
    if (!p) return null;
    return {
      threshold: p.coverage_80_threshold,
      pairs:     p.conformal_pairs_80?.length ?? 0,
      level:     p.confidence_level ?? 0.80,
    };
  });

  return {
    // ── SSE básico ─────────────────────────────────────────
    isOnline:       computed(() => sseStatus.value?.online       ?? false),
    redisOk:        computed(() => sseStatus.value?.redis_ok     ?? true),
    pendingAlerts:  computed(() => sseStatus.value?.pending_alerts ?? 0),
    lastSession:    computed(() => sseStatus.value?.last_session  ?? null),
    lastAgentCycle: computed(() => sseStatus.value?.last_agent_cycle ?? null),
    ragDocuments:   computed(() => sseStatus.value?.rag_documents ?? 0),
    lastIngestion:  computed(() => sseStatus.value?.last_ingestion ?? null),

    // ── SSE: estrategias autónomas ─────────────────────────
    activeStrategies:       computed(() => sseStatus.value?.autonomous?.active_strategies       ?? 0),
    consolidatedStrategies: computed(() => sseStatus.value?.autonomous?.consolidated_strategies ?? 0),
    monitoringStrategies:   computed(() => sseStatus.value?.autonomous?.monitoring_strategies   ?? 0),
    totalLiveStrategies:    computed(() => {
      const a = sseStatus.value?.autonomous;
      return (a?.active_strategies ?? 0) + (a?.consolidated_strategies ?? 0) + (a?.monitoring_strategies ?? 0);
    }),
    lastScan:          computed(() => sseStatus.value?.autonomous?.last_scan          ?? null),
    latestPredictions: computed(() => sseStatus.value?.autonomous?.latest_predictions ?? []),
    latestPrediction:  computed(() => {
      const preds = sseStatus.value?.autonomous?.latest_predictions ?? [];
      return preds[0] ?? null;
    }),

    // ── Semáforo legacy (mantenido para compatibilidad) ─────
    brainStatus: computed(() => {
      const a = sseStatus.value?.autonomous;
      if (!a) return 'unknown';
      const total = (a.active_strategies ?? 0) + (a.consolidated_strategies ?? 0);
      if (total >= 3) return 'learning';
      if (total >= 1) return 'watching';
      return 'idle';
    }),
    brainStatusLabel: computed(() => {
      const a = sseStatus.value?.autonomous;
      if (!a) return '...';
      const total = (a.active_strategies ?? 0) + (a.consolidated_strategies ?? 0);
      if (total >= 3) return `🧠 Aprendiendo (${total} estrategias)`;
      if (total >= 1) return `👁️ Monitoreando (${total} estrategia)`;
      return '💤 En espera de señales';
    }),

    // ═══════ HELIX v2 — CEREBRO F1 UNIFICADO ═══════
    // FIX 2026-05-21: vistas independientes por juego (no priorizar uno)
    pick3View,
    pick4View,

    // Legacy/compat — devuelve el juego "activo" (con régimen no-NORMAL si existe)
    activeGame:        computed(() => activeRegime.value.game),
    regime,
    regimeMeta,
    regimeStrength,
    activeMultipliers,
    thompsonLeaders,
    conformalCoverage,
    hawkesIntensity,
    daysSinceRareEvent,
    f1Loading:         _f1Loading,
    f1Error:           _f1Error,
    lastF1Fetch:       _lastF1Fetch,

    // Raw para vistas que necesitan detalle
    evtPick3Evening:   _evtPick3Evening,
    evtPick4Evening:   _evtPick4Evening,
    helixPredictPick4: _helixPredictPick4,

    // Acción manual
    refreshF1,
  };
}
