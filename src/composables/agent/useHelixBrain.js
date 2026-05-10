// ═══════════════════════════════════════════════════════════════
// HELIX — useHelixBrain (Brain Store)
//
// Fuente única de verdad para el estado vivo del sistema.
// Derivado del SSE /events/agent-status (ya existe y corre cada 30s).
//
// USO:
//   En AgentLayout.vue:
//     import { createHelixBrain } from '../../composables/agent/useHelixBrain.js'
//     const brain = createHelixBrain(status)   // status = ref del SSE
//     provide('helixBrain', brain)
//
//   En cualquier view hijo:
//     const brain = inject('helixBrain')
//     brain.activeStrategies     // computed, siempre fresco
//     brain.pendingAlerts        // ya existía en AgentLayout, ahora centralizado
//     brain.latestPrediction     // última predicción emitida
//     brain.lastScan             // último escaneo autónomo
// ═══════════════════════════════════════════════════════════════

import { computed } from 'vue';

/**
 * Crea el brain store derivado del payload SSE.
 * @param {import('vue').Ref} sseStatus - ref con el último payload SSE
 */
export function createHelixBrain(sseStatus) {
  return {
    // ── Estado de sistema (ya existía en SSE) ───────────────────────
    isOnline:       computed(() => sseStatus.value?.online       ?? false),
    redisOk:        computed(() => sseStatus.value?.redis_ok     ?? true),
    pendingAlerts:  computed(() => sseStatus.value?.pending_alerts ?? 0),
    lastSession:    computed(() => sseStatus.value?.last_session  ?? null),
    lastAgentCycle: computed(() => sseStatus.value?.last_agent_cycle ?? null),
    ragDocuments:   computed(() => sseStatus.value?.rag_documents ?? 0),
    lastIngestion:  computed(() => sseStatus.value?.last_ingestion ?? null),

    // ── SISTEMA NERVIOSO CENTRAL (nuevo en SSE enriquecido) ─────────
    activeStrategies:      computed(() => sseStatus.value?.autonomous?.active_strategies       ?? 0),
    consolidatedStrategies: computed(() => sseStatus.value?.autonomous?.consolidated_strategies ?? 0),
    monitoringStrategies:  computed(() => sseStatus.value?.autonomous?.monitoring_strategies   ?? 0),
    totalLiveStrategies:   computed(() => {
      const a = sseStatus.value?.autonomous;
      return (a?.active_strategies ?? 0) + (a?.consolidated_strategies ?? 0) + (a?.monitoring_strategies ?? 0);
    }),
    lastScan:          computed(() => sseStatus.value?.autonomous?.last_scan          ?? null),
    latestPredictions: computed(() => sseStatus.value?.autonomous?.latest_predictions ?? []),
    latestPrediction:  computed(() => {
      const preds = sseStatus.value?.autonomous?.latest_predictions ?? [];
      return preds[0] ?? null;
    }),

    // ── Estado semáforo del cerebro ──────────────────────────────────
    brainStatus: computed(() => {
      const a = sseStatus.value?.autonomous;
      if (!a) return 'unknown';
      const total = (a.active_strategies ?? 0) + (a.consolidated_strategies ?? 0);
      if (total >= 3) return 'learning';    // aprendiendo activamente
      if (total >= 1) return 'watching';    // monitoreando
      return 'idle';                        // sin estrategias activas
    }),

    brainStatusLabel: computed(() => {
      const a = sseStatus.value?.autonomous;
      if (!a) return '...';
      const total = (a.active_strategies ?? 0) + (a.consolidated_strategies ?? 0);
      if (total >= 3) return `🧠 Aprendiendo (${total} estrategias)`;
      if (total >= 1) return `👁️ Monitoreando (${total} estrategia)`;
      return '💤 En espera de señales';
    }),
  };
}
