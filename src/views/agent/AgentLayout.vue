<template>
  <div class="agent-layout">

    <!-- Sidebar nav -->
    <aside class="agent-nav">
      <div class="agent-nav__brand">
        <span class="agent-nav__logo">⚡</span>
        <span class="agent-nav__title">Hitdash</span>
      </div>

      <nav class="agent-nav__links">
        <RouterLink to="/agent/dashboard"         class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">🎯</span> Dashboard
        </RouterLink>
        <RouterLink to="/agent/rendimiento"       class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">📊</span> Rendimiento
        </RouterLink>
        <RouterLink to="/agent/backtest"          class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">🔬</span> Backtest
        </RouterLink>
        <RouterLink to="/agent/backtest-control"  class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">⚙️</span> BT Control
        </RouterLink>
        <RouterLink to="/agent/tracking"          class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">🧠</span> Estrategias
        </RouterLink>
        <RouterLink to="/agent/ballbot-strategies" class="nav-link" active-class="nav-link--active">
          <span class="nav-link__icon">▶</span> Señal
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
      <RouterView />
    </main>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { RouterLink, RouterView } from 'vue-router';
import { useAgentStatus } from '../../composables/agent/useAgentStatus.js';

const { status, connected } = useAgentStatus();
const pendingAlerts = computed(() => status.value?.pending_alerts ?? 0);
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

.agent-nav__logo { font-size: 1.4rem; }
.agent-nav__title { font-size: 1.1rem; font-weight: 700; color: #60a5fa; letter-spacing: 0.03em; }

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

@media (max-width: 768px) {
  .agent-layout { flex-direction: column; }
  .agent-nav { width: 100%; height: auto; position: relative; flex-direction: row; flex-wrap: wrap; padding: 0.75rem; }
  .agent-nav__brand { border-bottom: none; margin-bottom: 0; padding-bottom: 0; }
  .agent-nav__links { flex-direction: row; flex-wrap: wrap; }
  .agent-nav__footer { flex-direction: row; border-top: none; }
  .agent-main { padding: 1rem; }
}
</style>
