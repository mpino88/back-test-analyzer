<template>
  <div class="dashboard">
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
      <span class="page-subtitle">Estado en tiempo real del agente Hitdash</span>
    </div>

    <!-- Status cards -->
    <div class="cards-grid">
      <div class="stat-card" :class="connected ? 'stat-card--live' : 'stat-card--offline'">
        <div class="stat-card__label">Estado del agente</div>
        <div class="stat-card__value">{{ connected ? '🟢 Online' : '🔴 Offline' }}</div>
        <div class="stat-card__sub">{{ connected ? 'SSE activo' : 'Sin conexión' }}</div>
      </div>

      <div class="stat-card">
        <div class="stat-card__label">Alertas pendientes</div>
        <div class="stat-card__value" :class="pendingAlerts > 0 ? 'text-red' : 'text-green'">
          {{ pendingAlerts }}
        </div>
        <div class="stat-card__sub">sin reconocer</div>
      </div>

      <div class="stat-card">
        <div class="stat-card__label">RAG knowledge</div>
        <div class="stat-card__value">{{ status?.rag_documents ?? '—' }}</div>
        <div class="stat-card__sub">documentos</div>
      </div>

      <div class="stat-card">
        <div class="stat-card__label">Redis</div>
        <div class="stat-card__value">{{ status?.redis_ok ? '🟢 OK' : '🔴 Down' }}</div>
        <div class="stat-card__sub">cola BullMQ</div>
      </div>
    </div>

    <!-- Última sesión -->
    <section class="section">
      <h2 class="section-title">Última sesión del agente</h2>
      <div v-if="lastSession" class="session-card">
        <div class="session-card__row">
          <span class="label">Juego</span>
          <span class="value">{{ lastSession.game_type?.toUpperCase() }} {{ lastSession.draw_type }}</span>
        </div>
        <div class="session-card__row">
          <span class="label">Estado</span>
          <span class="value badge" :class="`badge--${lastSession.status}`">{{ lastSession.status }}</span>
        </div>
        <div class="session-card__row">
          <span class="label">Modelo</span>
          <span class="value mono">{{ lastSession.model_used ?? '—' }}</span>
        </div>
        <div class="session-card__row">
          <span class="label">Costo</span>
          <span class="value">${{ lastSession.cost_usd?.toFixed(4) ?? '0.0000' }}</span>
        </div>
        <div class="session-card__row">
          <span class="label">Fecha</span>
          <span class="value">{{ formatDate(lastSession.created_at) }}</span>
        </div>
      </div>
      <div v-else class="empty">Sin sesiones registradas aún</div>
    </section>

    <!-- Trigger manual -->
    <section class="section">
      <h2 class="section-title">Disparo manual</h2>
      <div class="trigger-form">
        <select v-model="triggerGame" class="input-select">
          <option value="pick3">Pick 3</option>
          <option value="pick4">Pick 4</option>
        </select>
        <select v-model="triggerDraw" class="input-select">
          <option value="midday">Midday</option>
          <option value="evening">Evening</option>
        </select>
        <input v-model="triggerDate" type="date" class="input-date" />
        <button class="btn-trigger" :disabled="triggering" @click="triggerAgent">
          {{ triggering ? 'Disparando...' : '⚡ Ejecutar ahora' }}
        </button>
      </div>
      <div v-if="triggerMsg" class="trigger-msg" :class="triggerError ? 'trigger-msg--error' : 'trigger-msg--ok'">
        {{ triggerMsg }}
      </div>
    </section>

    <!-- Ingesta reciente -->
    <section class="section">
      <h2 class="section-title">Ingesta de datos</h2>
      <div class="info-row">
        <span class="label">Última ingesta</span>
        <span class="value">{{ formatDate(status?.last_ingestion) }}</span>
      </div>
      <div class="info-row">
        <span class="label">Último ciclo agente</span>
        <span class="value">{{ formatDate(status?.last_agent_cycle) }}</span>
      </div>
      <div class="info-row">
        <span class="label">RAG knowledge</span>
        <span class="value">{{ status?.rag_documents ?? '—' }} documentos</span>
      </div>
    </section>

    <!-- Últimas recomendaciones de pares -->
    <section class="section">
      <h2 class="section-title">Últimas Recomendaciones de Pares</h2>
      <div v-if="loadingRecs" class="empty">Cargando...</div>
      <div v-else-if="!latestRecs.length" class="empty">Sin recomendaciones aún — ejecuta el agente</div>
      <div v-else class="recs-grid">
        <div
          v-for="rec in latestRecs"
          :key="rec.id"
          class="rec-card"
          :class="rec.hit === true ? 'rec-card--hit' : rec.hit === false ? 'rec-card--miss' : ''"
        >
          <div class="rec-card__header">
            <span class="rec-badge">{{ rec.game_type?.toUpperCase() }} {{ rec.draw_type }}</span>
            <span class="rec-badge rec-badge--half">{{ rec.half?.toUpperCase() }}</span>
            <span class="rec-result" v-if="rec.hit !== null">
              {{ rec.hit ? '✓ HIT' : '✗ MISS' }}
            </span>
            <span class="rec-result rec-result--pending" v-else>⏳ Pendiente</span>
          </div>
          <div class="rec-card__n">
            <span class="rec-n-val">N={{ rec.optimal_n }}</span>
            <span class="rec-n-eff" v-if="rec.predicted_effectiveness > 0">
              {{ (rec.predicted_effectiveness * 100).toFixed(1) }}% efectividad mínima
            </span>
          </div>
          <div class="rec-pairs">
            <span
              v-for="pair in rec.pairs.slice(0, rec.optimal_n)"
              :key="pair"
              class="pair-chip"
              :class="{
                'pair-chip--hit': rec.actual_pair === pair,
                'pair-chip--top3': rec.pairs.indexOf(pair) < 3,
              }"
            >{{ pair }}</span>
          </div>
          <div class="rec-meta">{{ formatDate(rec.created_at) }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { useAgentStatus } from '../../composables/agent/useAgentStatus.js';
import { apiGet, apiPost } from '../../utils/apiClient.js';

const { status, connected } = useAgentStatus();
const pendingAlerts = computed(() => status.value?.pending_alerts ?? 0);
const lastSession   = computed(() => status.value?.last_session ?? null);

// ── Pair recommendations ─────────────────────────────────────────
const latestRecs  = ref([]);
const loadingRecs = ref(false);

async function fetchLatestRecs() {
  loadingRecs.value = true;
  try {
    latestRecs.value = await apiGet('/api/agent/pair-recommendations/latest');
  } catch {}
  finally { loadingRecs.value = false; }
}

onMounted(fetchLatestRecs);

const triggerGame  = ref('pick3');
const triggerDraw  = ref('midday');
const triggerDate  = ref(new Date().toISOString().split('T')[0]);
const triggering   = ref(false);
const triggerMsg   = ref('');
const triggerError = ref(false);

async function triggerAgent() {
  triggering.value = true;
  triggerMsg.value = '';
  try {
    const data = await apiPost('/api/agent/trigger', {
      game_type: triggerGame.value,
      draw_type: triggerDraw.value,
      draw_date: triggerDate.value,
    });
    triggerMsg.value = `✅ Job encolado: ${data.job_id}`;
    triggerError.value = false;
  } catch (e) {
    triggerMsg.value = `❌ ${e.message}`;
    triggerError.value = true;
  } finally {
    triggering.value = false;
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-PR', { dateStyle: 'short', timeStyle: 'short' });
}
</script>

<style scoped>
.dashboard { max-width: 960px; }
.page-header { margin-bottom: 2rem; }
.page-title { font-size: 1.75rem; font-weight: 700; color: #f1f5f9; margin: 0 0 0.25rem; }
.page-subtitle { color: #64748b; font-size: 0.9rem; }

/* Cards */
.cards-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
.stat-card {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  padding: 1.25rem;
}
.stat-card--live  { border-color: #166534; }
.stat-card--offline { border-color: #7f1d1d; }
.stat-card__label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
.stat-card__value { font-size: 1.5rem; font-weight: 700; color: #f1f5f9; margin-bottom: 0.25rem; }
.stat-card__sub   { font-size: 0.75rem; color: #475569; }

/* Sections */
.section { margin-bottom: 2rem; }
.section-title { font-size: 1rem; font-weight: 600; color: #94a3b8; margin: 0 0 1rem; text-transform: uppercase; letter-spacing: 0.05em; }

/* Session card */
.session-card { background: #0f1623; border: 1px solid #1e2d40; border-radius: 12px; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
.session-card__row, .info-row { display: flex; justify-content: space-between; align-items: center; }
.label { color: #64748b; font-size: 0.875rem; }
.value { color: #e2e8f0; font-size: 0.875rem; }
.mono { font-family: monospace; font-size: 0.8rem; }

/* Badge */
.badge { padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
.badge--completed { background: #14532d; color: #4ade80; }
.badge--running   { background: #1e3a5f; color: #60a5fa; }
.badge--failed    { background: #450a0a; color: #f87171; }

/* Colors */
.text-red   { color: #f87171; }
.text-green { color: #4ade80; }

/* Trigger form */
.trigger-form { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; }
.input-select, .input-date {
  background: #0f1623; border: 1px solid #1e2d40; color: #e2e8f0;
  padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.875rem;
}
.btn-trigger {
  background: #1d4ed8; color: white; border: none; border-radius: 8px;
  padding: 0.5rem 1.25rem; font-size: 0.875rem; font-weight: 600; cursor: pointer;
  transition: background 0.15s;
}
.btn-trigger:hover:not(:disabled) { background: #2563eb; }
.btn-trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.trigger-msg { margin-top: 0.75rem; font-size: 0.875rem; padding: 0.5rem 0.75rem; border-radius: 8px; }
.trigger-msg--ok    { background: #14532d30; color: #4ade80; }
.trigger-msg--error { background: #450a0a30; color: #f87171; }
.empty { color: #475569; font-size: 0.875rem; }

/* ── Pair Recs ───────────────────────────────────────────────── */
.recs-grid { display: flex; flex-direction: column; gap: 1rem; }

.rec-card {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.rec-card--hit  { border-color: #16a34a55; }
.rec-card--miss { border-color: #dc262644; }

.rec-card__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.rec-badge {
  font-size: 0.68rem;
  font-weight: 700;
  background: #1e2d40;
  color: #94a3b8;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  letter-spacing: 0.05em;
}
.rec-badge--half { background: #1a2535; color: #60a5fa; }
.rec-result { margin-left: auto; font-size: 0.75rem; font-weight: 700; color: #22c55e; }
.rec-result--pending { color: #f59e0b; }

.rec-card__n {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}
.rec-n-val { font-size: 1rem; font-weight: 700; color: #60a5fa; }
.rec-n-eff { font-size: 0.72rem; color: #475569; }

.rec-pairs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
.pair-chip {
  font-size: 0.75rem;
  font-weight: 600;
  font-family: monospace;
  background: #131c2b;
  border: 1px solid #1e2d40;
  color: #94a3b8;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
}
.pair-chip--top3  { color: #e2e8f0; border-color: #3b82f644; }
.pair-chip--hit   { background: #052e16; color: #4ade80; border-color: #22c55e; }

.rec-meta { font-size: 0.65rem; color: #334155; margin-top: 0.2rem; }

@media (max-width: 768px) { .cards-grid { grid-template-columns: 1fr 1fr; } }
</style>
