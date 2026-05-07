<template>
  <div class="agent-layout">

    <!-- Sidebar nav -->
    <aside class="agent-nav">
      <div class="agent-nav__brand">
        <span class="agent-nav__logo">🧬</span>
        <span class="agent-nav__title">HELIX</span>
        <span class="agent-nav__sub">by Hitdash</span>
      </div>

      <nav class="agent-nav__links">
        <RouterLink to="/agent/dashboard"         class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">🎯</span> Dashboard
        </RouterLink>
        <RouterLink to="/agent/rendimiento"       class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">📊</span> Rendimiento
        </RouterLink>
        <RouterLink to="/agent/momentum"          class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">📈</span> Momentum
        </RouterLink>
        <RouterLink to="/agent/backtest-control"  class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">⚙️</span> BT Control
        </RouterLink>
        <RouterLink to="/agent/tracking"          class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">📡</span> Cognición
        </RouterLink>
        <RouterLink to="/agent/alerts"            class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">🔔</span>
          Alertas
          <span v-if="pendingAlerts > 0" class="nav-link__badge">{{ pendingAlerts }}</span>
        </RouterLink>
        <RouterLink to="/agent/chat"              class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">🤖</span> Agente IA
        </RouterLink>
      </nav>

      <div class="agent-nav__footer">
        <RouterLink to="/" class="nav-link nav-link--secondary">
          <span class="nav-link__icon">◀</span> Analyzer
        </RouterLink>
        <div class="agent-nav__status" :class="connected ? 'status--live' : 'status--offline'">
          <span class="status__dot"></span>
          {{ connected ? 'Live' : 'Offline' }}
        </div>
      </div>
    </aside>

    <!-- Main content -->
    <main class="agent-main">
      <!-- ── Error boundary: captura crashes silenciosos de vistas hijas ── -->
      <div v-if="routeError" class="route-error">
        <div class="re-icon">⚠️</div>
        <div class="re-title">Error al renderizar la vista</div>
        <div class="re-msg">{{ routeError.message }}</div>
        <div class="re-info">{{ routeError.info }}</div>
        <button class="re-btn" @click="routeError = null">↻ Reintentar</button>
      </div>
      <RouterView v-else />
    </main>
  </div>
</template>

<script setup>
import { computed, ref, onErrorCaptured } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { useAgentStatus } from '../../composables/agent/useAgentStatus.js';

const { status, connected } = useAgentStatus();
const pendingAlerts = computed(() => status.value?.pending_alerts ?? 0);

// ─── Error boundary — captura cualquier crash silencioso en vistas hijas ───
// Sin esto, Vue desmonta el componente que falla y queda negro sin explicación.
const routeError = ref(null);
onErrorCaptured((err, _instance, info) => {
  const msg = err instanceof Error ? err.message : String(err);
  routeError.value = { message: msg, info };
  console.error('[HELIX] Vista crash capturado —', info, err);
  return false; // Detiene propagación — AgentLayout sigue renderizando
});
</script>

<style scoped>
.agent-layout {
  display: flex;
  min-height: 100vh;
  background: #0a0d14;
  color: #e2e8f0;
  font-family: 'Inter', system-ui, sans-serif;
}

/* ─── Sidebar ────────────────────────────────────────────────── */
.agent-nav {
  width: 220px;
  flex-shrink: 0;
  background: #0f1623;
  border-right: 1px solid #1e2d40;
  display: flex;
  flex-direction: column;
  padding: 1.5rem 0;
  position: sticky;
  top: 0;
  height: 100vh;
}

.agent-nav__brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0 1.25rem 1.5rem;
  border-bottom: 1px solid #1e2d40;
  margin-bottom: 1rem;
}

.agent-nav__logo  { font-size: 1.4rem; }
.agent-nav__title { font-size: 1.1rem; font-weight: 700; color: #60a5fa; letter-spacing: 0.05em; }
.agent-nav__sub   { font-size: 0.65rem; color: #334155; letter-spacing: 0.08em; text-transform: uppercase; margin-top: -2px; }

.agent-nav__links { flex: 1; display: flex; flex-direction: column; gap: 0.25rem; padding: 0 0.75rem; }

.nav-link {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.6rem 0.75rem;
  border-radius: 8px;
  color: #94a3b8;
  text-decoration: none;
  font-size: 0.875rem;
  font-weight: 500;
  transition: background 0.15s, color 0.15s;
  position: relative;
}
.nav-link:hover { background: #1a2535; color: #e2e8f0; }
.nav-link--active { background: #1d3a5f; color: #60a5fa; }
.nav-link--secondary { color: #64748b; font-size: 0.8rem; }
.nav-link__icon { font-size: 1rem; }
.nav-link__badge {
  margin-left: auto;
  background: #ef4444;
  color: white;
  font-size: 0.7rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
  min-width: 18px;
  text-align: center;
}

.agent-nav__footer {
  padding: 0.75rem;
  border-top: 1px solid #1e2d40;
  margin-top: auto;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}

.agent-nav__status {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  padding: 0.3rem 0.75rem;
  color: #64748b;
}
.status--live .status__dot { background: #22c55e; box-shadow: 0 0 6px #22c55e; }
.status--offline .status__dot { background: #ef4444; }
.status__dot { width: 8px; height: 8px; border-radius: 50%; display: inline-block; }

/* ─── Main ───────────────────────────────────────────────────── */
.agent-main {
  flex: 1;
  overflow-y: auto;
  padding: 2rem;
  min-width: 0;
}

/* ─── Route error boundary ──────────────────────────────────────── */
.route-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-height: 60vh;
  gap: 0.75rem;
  color: #f87171;
  text-align: center;
  padding: 2rem;
}
.re-icon  { font-size: 2.5rem; }
.re-title { font-size: 1.1rem; font-weight: 700; color: #fca5a5; }
.re-msg   { font-size: 0.85rem; color: #f87171; font-family: monospace; background: #1f1010; padding: 0.75rem 1rem; border-radius: 8px; border: 1px solid #7f1d1d; max-width: 600px; word-break: break-word; }
.re-info  { font-size: 0.7rem; color: #64748b; }
.re-btn   { margin-top: 0.5rem; background: #450a0a; border: 1px solid #f8717144; color: #f87171; padding: 0.5rem 1.25rem; border-radius: 8px; cursor: pointer; font-size: 0.85rem; }
.re-btn:hover { background: #7f1d1d; }

@media (max-width: 768px) {
  .agent-layout { flex-direction: column; }
  .agent-nav { width: 100%; height: auto; position: relative; flex-direction: row; flex-wrap: wrap; padding: 0.75rem; }
  .agent-nav__brand { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
  .agent-nav__links { flex-direction: row; flex-wrap: wrap; }
  .agent-nav__footer { flex-direction: row; border-top: none; }
  .agent-main { padding: 1rem; }
}
</style>
