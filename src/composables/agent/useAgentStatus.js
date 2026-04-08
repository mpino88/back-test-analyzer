// ═══════════════════════════════════════════════════════════════
// HITDASH — useAgentStatus
// SSE composable: /events/agent-status → live dashboard updates
// ═══════════════════════════════════════════════════════════════

import { ref, onMounted, onUnmounted } from 'vue';

export function useAgentStatus() {
  const status      = ref(null);   // último payload SSE
  const connected   = ref(false);
  const error       = ref(null);
  let eventSource   = null;

  function connect() {
    if (eventSource) return;

    eventSource = new EventSource('/events/agent-status');

    eventSource.onopen = () => {
      connected.value = true;
      error.value = null;
    };

    eventSource.onmessage = (e) => {
      try {
        status.value = JSON.parse(e.data);
      } catch {
        // heartbeat o datos no-JSON — ignorar
      }
    };

    eventSource.onerror = () => {
      connected.value = false;
      error.value = 'Conexión SSE perdida — reconectando...';
      // EventSource reconecta automáticamente
    };
  }

  function disconnect() {
    eventSource?.close();
    eventSource = null;
    connected.value = false;
  }

  onMounted(connect);
  onUnmounted(disconnect);

  return { status, connected, error };
}
