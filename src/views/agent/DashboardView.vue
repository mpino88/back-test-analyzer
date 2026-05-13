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
        <label class="topn-label">
          <span class="topn-badge">N={{ triggerTopN }}</span>
          <input v-model.number="triggerTopN" type="range" min="5" max="15" step="1" class="topn-slider" title="Número de pares a predecir (5-15)" />
        </label>
        <button class="btn-trigger" :disabled="triggering" @click="triggerAgent">
          {{ triggering ? 'Disparando...' : '⚡ Ejecutar ahora' }}
        </button>
      </div>
      <div v-if="triggerMsg" class="trigger-msg" :class="triggerError ? 'trigger-msg--error' : 'trigger-msg--ok'">
        {{ triggerMsg }}
      </div>
    </section>

    <!-- ── MOTOR-Σ PPS State ────────────────────────────────────── -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">Motor-Σ — Estado de aprendizaje</h2>
        <div class="pps-controls">
          <select v-model="ppsGame" class="input-select input-select--sm" @change="fetchPPS">
            <option value="pick3">Pick 3</option>
            <option value="pick4">Pick 4</option>
          </select>
          <select v-model="ppsDraw" class="input-select input-select--sm" @change="fetchPPS">
            <option value="midday">Midday</option>
            <option value="evening">Evening</option>
          </select>
          <select v-model="ppsHalf" class="input-select input-select--sm" @change="fetchPPS">
            <option value="du">DU</option>
            <option v-if="ppsGame === 'pick4'" value="ab">AB</option>
            <option v-if="ppsGame === 'pick4'" value="cd">CD</option>
          </select>
          <button class="btn-refresh-sm" @click="fetchPPS">↻</button>
        </div>
      </div>

      <div v-if="loadingPPS" class="empty">Cargando estado del motor...</div>
      <div v-else-if="ppsError" class="empty pps-error">{{ ppsError }}</div>
      <template v-else-if="ppsData">
        <!-- Summary chips -->
        <div class="pps-summary">
          <div class="pps-chip" :class="ppsData.is_profitable ? 'pps-chip--green' : 'pps-chip--red'">
            <span class="pps-chip__label">N óptimo</span>
            <span class="pps-chip__val">{{ ppsData.optimal_n }}</span>
          </div>
          <div class="pps-chip" :class="ppsData.is_profitable ? 'pps-chip--green' : 'pps-chip--yellow'">
            <span class="pps-chip__label">Hit@N</span>
            <span class="pps-chip__val">{{ ((ppsData.hit_rate ?? 0) * 100).toFixed(1) }}%</span>
          </div>
          <div class="pps-chip" :class="ppsData.is_profitable ? 'pps-chip--green' : 'pps-chip--red'">
            <span class="pps-chip__label">Borde</span>
            <span class="pps-chip__val">{{ ppsData.is_profitable ? '✓ Sí' : '✗ No' }}</span>
          </div>
          <div class="pps-chip pps-chip--neutral">
            <span class="pps-chip__label">Base</span>
            <span class="pps-chip__val pps-chip__val--sm">{{ ppsData.motor_basis }}</span>
          </div>
        </div>

        <!-- Algorithm table -->
        <div class="pps-table-wrap" v-if="ppsData.algorithms?.length">
          <div class="pps-row pps-row--header">
            <span>Algoritmo</span>
            <span>PPS</span>
            <span>Muestras</span>
            <span>Estado</span>
          </div>
          <div
            v-for="algo in ppsData.algorithms"
            :key="algo.algo_name"
            class="pps-row"
          >
            <span class="pps-algo-name">{{ algo.algo_name }}</span>
            <span class="pps-bar-cell">
              <span class="pps-bar-track">
                <span
                  class="pps-bar-fill"
                  :style="{ width: algo.pps + '%' }"
                  :class="algo.pps >= 65 ? 'bar--high' : algo.pps >= 45 ? 'bar--mid' : 'bar--low'"
                ></span>
              </span>
              <span class="pps-num" :class="algo.pps >= 65 ? 'num--high' : algo.pps >= 45 ? 'num--mid' : 'num--low'">
                {{ algo.pps?.toFixed(1) }}
              </span>
            </span>
            <span class="pps-samples">
              {{ algo.sample_count }}
              <span class="warmup-badge" v-if="algo.sample_count < 30">warmup</span>
            </span>
            <span>
              <span
                class="health-dot"
                :class="algo.pps >= 65 ? 'dot--healthy' : algo.pps >= 40 ? 'dot--degraded' : 'dot--low'"
                :title="algo.pps >= 65 ? 'Señal fuerte' : algo.pps >= 40 ? 'Señal débil' : 'Penalizado'"
              ></span>
            </span>
          </div>
        </div>
        <div v-else class="empty">
          Sin datos PPS aún — el motor acumula datos sorteo a sorteo
        </div>
      </template>
      <div v-else class="empty">Selecciona un combo para ver el estado del motor</div>
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
          <div class="rec-tiers" v-if="rec.tiers">
            <div class="tier-row" v-if="rec.tiers.must?.length">
              <span class="tier-label tier-label--must">CERTEZA</span>
              <span
                v-for="pair in rec.tiers.must" :key="'m'+pair"
                class="pair-chip pair-chip--must"
                :class="{ 'pair-chip--hit': rec.actual_pair === pair }"
              >{{ pair }}</span>
            </div>
            <div class="tier-row" v-if="rec.tiers.cover?.length">
              <span class="tier-label tier-label--cover">COBERTURA</span>
              <span
                v-for="pair in rec.tiers.cover" :key="'c'+pair"
                class="pair-chip pair-chip--cover"
                :class="{ 'pair-chip--hit': rec.actual_pair === pair }"
              >{{ pair }}</span>
            </div>
            <div class="tier-row" v-if="rec.tiers.watch?.length">
              <span class="tier-label tier-label--watch">VIGILANCIA</span>
              <span
                v-for="pair in rec.tiers.watch" :key="'w'+pair"
                class="pair-chip pair-chip--watch"
                :class="{ 'pair-chip--hit': rec.actual_pair === pair }"
              >{{ pair }}</span>
            </div>
          </div>
          <div class="rec-pairs" v-else>
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

const triggerGame  = ref('pick3');
const triggerDraw  = ref('midday');
const triggerDate  = ref(new Date().toISOString().split('T')[0]);
const triggerTopN  = ref(10);
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
      top_n: triggerTopN.value,
    });
    triggerMsg.value = `✅ Job encolado: ${data.job_id} (N=${triggerTopN.value})`;
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

// ── MOTOR-Σ PPS State ────────────────────────────────────────────
const ppsGame    = ref('pick3');
const ppsDraw    = ref('evening');
const ppsHalf    = ref('du');
const ppsData    = ref(null);
const loadingPPS = ref(false);
const ppsError   = ref('');

async function fetchPPS() {
  loadingPPS.value = true;
  ppsError.value   = '';
  try {
    ppsData.value = await apiGet(
      `/api/agent/pps?game_type=${ppsGame.value}&draw_type=${ppsDraw.value}&half=${ppsHalf.value}`
    );
  } catch (e) {
    ppsError.value = `Error cargando PPS: ${e.message}`;
  } finally {
    loadingPPS.value = false;
  }
}

onMounted(() => {
  fetchLatestRecs();
  fetchPPS();
});
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
.topn-label { display: flex; align-items: center; gap: 0.5rem; }
.topn-badge { background: #1e2d40; color: #4a9eff; border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 0.8rem; font-weight: 700; min-width: 3rem; text-align: center; }
.topn-slider { width: 80px; accent-color: #1d4ed8; cursor: pointer; }
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
/* ── Tiered pairs ──────────────────────────────────────────────── */
.rec-tiers { display: flex; flex-direction: column; gap: 0.4rem; }
.tier-row  { display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem; }

.tier-label {
  font-size: 0.6rem; font-weight: 700; letter-spacing: 0.06em;
  padding: 0.1rem 0.4rem; border-radius: 3px; white-space: nowrap;
  margin-right: 0.2rem;
}
.tier-label--must  { background: #450a0a; color: #f87171; border: 1px solid #7f1d1d; }
.tier-label--cover { background: #451a03; color: #fb923c; border: 1px solid #7c2d12; }
.tier-label--watch { background: #1a2535; color: #64748b; border: 1px solid #1e2d40; }

.pair-chip {
  font-size: 0.75rem; font-weight: 600; font-family: monospace;
  padding: 0.15rem 0.4rem; border-radius: 4px;
  background: #131c2b; border: 1px solid #1e2d40; color: #94a3b8;
}
.pair-chip--must  { background: #1f0a0a; color: #fca5a5; border-color: #7f1d1d55; }
.pair-chip--cover { background: #1a1005; color: #fdba74; border-color: #7c2d1244; }
.pair-chip--watch { color: #64748b; }
.pair-chip--hit   { background: #052e16 !important; color: #4ade80 !important; border-color: #22c55e !important; }
.pair-chip--top3  { color: #e2e8f0; border-color: #3b82f644; }

.rec-meta { font-size: 0.65rem; color: #334155; margin-top: 0.2rem; }

/* ── MOTOR-Σ PPS Panel ─────────────────────────────────────────── */
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem; }
.pps-controls { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.input-select--sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
.btn-refresh-sm { background: #1e2d40; color: #64748b; border: 1px solid #2d4a6b; border-radius: 6px; padding: 0.3rem 0.6rem; font-size: 0.85rem; cursor: pointer; }
.btn-refresh-sm:hover { color: #e2e8f0; background: #2d4a6b; }

.pps-summary { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
.pps-chip { background: #0f1623; border: 1px solid #1e2d40; border-radius: 10px; padding: 0.6rem 1rem; display: flex; flex-direction: column; gap: 0.2rem; min-width: 90px; }
.pps-chip--green  { border-color: #16653444; background: #052e16; }
.pps-chip--red    { border-color: #7f1d1d44; background: #1a0505; }
.pps-chip--yellow { border-color: #78350f44; background: #1c1100; }
.pps-chip--neutral { border-color: #1e2d40; }
.pps-chip__label { font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
.pps-chip__val { font-size: 1.15rem; font-weight: 700; color: #e2e8f0; }
.pps-chip__val--sm { font-size: 0.72rem; font-weight: 500; color: #94a3b8; word-break: break-all; }

.pps-table-wrap { background: #0a0d14; border: 1px solid #1e2d40; border-radius: 10px; overflow: hidden; }
.pps-row { display: grid; grid-template-columns: 1fr 2fr 80px 40px; gap: 0.5rem; align-items: center; padding: 0.5rem 1rem; font-size: 0.8rem; border-bottom: 1px solid #0f1a2a; }
.pps-row:last-child { border-bottom: none; }
.pps-row--header { background: #0f1623; font-size: 0.68rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; }
.pps-algo-name { font-family: monospace; font-size: 0.75rem; color: #94a3b8; }
.pps-bar-cell { display: flex; align-items: center; gap: 0.5rem; }
.pps-bar-track { flex: 1; height: 6px; background: #1e2d40; border-radius: 3px; overflow: hidden; }
.pps-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
.bar--high { background: linear-gradient(90deg, #16a34a, #22c55e); }
.bar--mid  { background: linear-gradient(90deg, #854d0e, #f59e0b); }
.bar--low  { background: linear-gradient(90deg, #7f1d1d, #ef4444); }
.pps-num { font-size: 0.75rem; font-weight: 700; min-width: 30px; text-align: right; }
.num--high { color: #4ade80; }
.num--mid  { color: #f59e0b; }
.num--low  { color: #f87171; }
.pps-samples { font-size: 0.72rem; color: #64748b; display: flex; align-items: center; gap: 0.3rem; }
.warmup-badge { background: #1e3a5f; color: #60a5fa; font-size: 0.6rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 4px; }
.health-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.dot--healthy  { background: #22c55e; box-shadow: 0 0 5px #22c55e66; }
.dot--degraded { background: #f59e0b; }
.dot--low      { background: #ef4444; }
.pps-error { color: #f87171; font-size: 0.8rem; }

@media (max-width: 768px) {
  .cards-grid { grid-template-columns: 1fr 1fr; }
  .pps-row { grid-template-columns: 1fr 1.5fr 60px 30px; font-size: 0.72rem; }
}
</style>
