// ═══════════════════════════════════════════════════════════════
// HITDASH — useAgentStatus
// SSE composable: /events/agent-status → live dashboard updates
// Includes exponential backoff guard to prevent connection storms
// ═══════════════════════════════════════════════════════════════

import { ref, onMounted, onUnmounted } from 'vue';
import { createAuthSSE } from '../../utils/apiClient.js';

const MAX_RETRIES = 10;

export function useAgentStatus() {
  const status      = ref(null);   // último payload SSE
  const connected   = ref(false);
  const error       = ref(null);
  let eventSource   = null;
  let retryCount    = 0;
  let retryTimer    = null;

  function connect() {
    if (eventSource) return;

    eventSource = createAuthSSE('/events/agent-status');

    eventSource.onopen = () => {
      connected.value = true;
      error.value  = null;
      retryCount   = 0;  // reset backoff on successful connection
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
      retryCount++;

      if (retryCount >= MAX_RETRIES) {
        // Detenemos el bucle automático de EventSource
        eventSource?.close();
        eventSource = null;
        error.value = `Servidor no disponible después de ${MAX_RETRIES} intentos. Recarga la página para reconectar.`;
        return;
      }

      // EventSource reconecta automáticamente, pero mostramos feedback
      const delay = Math.min(30, 2 ** retryCount);
      error.value = `Conexión SSE perdida — reconectando (intento ${retryCount}/${MAX_RETRIES}, en ${delay}s)…`;
    };
  }

  function disconnect() {
    clearTimeout(retryTimer);
    eventSource?.close();
    eventSource = null;
    connected.value = false;
  }

  onMounted(connect);
  onUnmounted(disconnect);

  return { status, connected, error };
}
