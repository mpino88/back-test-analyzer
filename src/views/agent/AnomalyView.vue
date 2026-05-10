<template>
  <div class="anomaly-view">
    <!-- Header -->
    <div class="view-header">
      <div class="header-left">
        <h1 class="view-title">
          <span class="title-icon">🧬</span>
          Agente Autónomo
        </h1>
        <p class="view-subtitle">Detección de anomalías · Hipótesis · Micro-estrategias dinámicas</p>
      </div>
      <div class="header-controls">
        <div class="game-selector">
          <button
            v-for="g in GAMES"
            :key="g.key"
            :class="['game-btn', { active: selectedGame === g.key }]"
            @click="selectGame(g.key)"
          >{{ g.label }}</button>
        </div>
        <button class="btn-scan" :class="{ scanning }" @click="triggerScan" :disabled="scanning">
          <span class="btn-icon">{{ scanning ? '⟳' : '⚡' }}</span>
          {{ scanning ? 'Escaneando...' : 'Escanear ahora' }}
        </button>
        <button class="btn-refresh" @click="loadAll" :disabled="loading">
          <span>{{ loading ? '⟳' : '↻' }}</span>
        </button>
      </div>
    </div>

    <!-- Draw type tabs -->
    <div class="draw-tabs">
      <button
        v-for="dt in drawTypes"
        :key="dt"
        :class="['draw-tab', { active: selectedDrawType === dt }]"
        @click="selectedDrawType = dt; loadAll()"
      >{{ dt === 'midday' ? '☀️ Mediodía' : '🌙 Noche' }}</button>
    </div>

    <!-- Stats row -->
    <div class="stats-row" v-if="!loading">
      <div class="stat-card">
        <div class="stat-icon">📡</div>
        <div class="stat-body">
          <div class="stat-value">{{ anomalyReport?.signals?.length ?? 0 }}</div>
          <div class="stat-label">Señales activas</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🧪</div>
        <div class="stat-body">
          <div class="stat-value">{{ pendingCount }}</div>
          <div class="stat-label">Hipótesis pendientes</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">✅</div>
        <div class="stat-body">
          <div class="stat-value">{{ validatedCount }}</div>
          <div class="stat-label">Hipótesis validadas</div>
        </div>
      </div>
      <div class="stat-card">
        <div class="stat-icon">🚀</div>
        <div class="stat-body">
          <div class="stat-value">{{ activeStrategies.length }}</div>
          <div class="stat-label">Estrategias activas</div>
        </div>
      </div>
      <div class="stat-card" v-if="selectedGame === 'pick3' && digitAnalysis">
        <div class="stat-icon">🎯</div>
        <div class="stat-body">
          <div class="stat-value">{{ digitAnalysis.combined_pairs.length }}</div>
          <div class="stat-label">Pares candidatos (Digit)</div>
        </div>
      </div>
    </div>

    <!-- Main grid -->
    <div class="main-grid">

      <!-- LEFT: Anomaly signals + Digit Heatmap -->
      <div class="col-left">

        <!-- Anomaly Signals -->
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">📡 Señales de Anomalía</h2>
            <span class="badge-count">{{ anomalyReport?.signals?.length ?? 0 }}</span>
          </div>
          <div v-if="loadingAnomalies" class="loading-row">Cargando señales...</div>
          <div v-else-if="!anomalyReport?.signals?.length" class="empty-row">
            Sin señales estadísticas significativas (p &lt; 0.20)
          </div>
          <div v-else class="signal-list">
            <div
              v-for="sig in anomalyReport.signals"
              :key="sig.id ?? sig.value + sig.type"
              class="signal-item"
              :class="signalClass(sig)"
            >
              <div class="signal-left">
                <span class="signal-type-badge">{{ signalTypeLabel(sig.type) }}</span>
                <span class="signal-value">{{ sig.value }}</span>
                <span v-if="sig.position" class="signal-pos">pos:{{ sig.position }}</span>
              </div>
              <div class="signal-right">
                <div class="signal-stats">
                  <span class="z-score" :class="zScoreClass(sig.z_score)">
                    z={{ formatNum(sig.z_score) }}
                  </span>
                  <span class="confidence-bar-wrap">
                    <span class="confidence-bar" :style="{ width: (sig.confidence * 100).toFixed(0) + '%' }"></span>
                  </span>
                  <span class="conf-label">{{ (sig.confidence * 100).toFixed(0) }}%</span>
                </div>
                <div class="signal-window">ventana {{ sig.window }}d</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Digit Analysis (Pick3 only) -->
        <div class="panel" v-if="selectedGame === 'pick3'">
          <div class="panel-header">
            <h2 class="panel-title">🔢 Análisis Posicional Pick3</h2>
            <span class="badge-info">Decena · Unidad</span>
          </div>
          <div v-if="loadingDigits" class="loading-row">Cargando análisis...</div>
          <div v-else-if="!digitAnalysis" class="empty-row">Sin análisis disponible</div>
          <div v-else>
            <!-- Top picks -->
            <div class="digit-picks">
              <div class="digit-col">
                <div class="digit-label">🎯 Top Decenas (p2)</div>
                <div class="digit-chips">
                  <span
                    v-for="(d, i) in digitAnalysis.top_decenas"
                    :key="d"
                    class="digit-chip"
                    :class="['rank-' + (i + 1)]"
                  >{{ d }}</span>
                </div>
              </div>
              <div class="digit-col">
                <div class="digit-label">🎯 Top Unidades (p3)</div>
                <div class="digit-chips">
                  <span
                    v-for="(d, i) in digitAnalysis.top_unidades"
                    :key="d"
                    class="digit-chip"
                    :class="['rank-' + (i + 1)]"
                  >{{ d }}</span>
                </div>
              </div>
            </div>

            <!-- Combined pairs -->
            <div class="combined-section">
              <div class="combined-label">Pares candidatos (3×3 = {{ digitAnalysis.combined_pairs.length }})</div>
              <div class="pair-grid">
                <span
                  v-for="pair in digitAnalysis.combined_pairs"
                  :key="pair"
                  class="pair-chip"
                >{{ pair }}</span>
              </div>
            </div>

            <!-- Digit heatmap for decena -->
            <div class="heatmap-section">
              <div class="heatmap-label">Score por dígito</div>
              <div class="heatmap-grid">
                <div
                  v-for="row in digitAnalysis.decena"
                  :key="row.digit + '-d'"
                  class="heatmap-cell"
                  :style="{ opacity: 0.3 + row.score * 0.7 }"
                  :class="{ 'heatmap-top': digitAnalysis.top_decenas.includes(row.digit), 'anomaly-bonus': row.anomaly_bonus }"
                  :title="`d${row.digit}: score=${row.score.toFixed(3)} z=${row.z_score.toFixed(2)}`"
                >
                  <div class="hm-digit">{{ row.digit }}</div>
                  <div class="hm-score">{{ (row.score * 100).toFixed(0) }}</div>
                </div>
              </div>
            </div>

            <!-- Signals applied -->
            <div v-if="digitAnalysis.anomaly_signals_applied.length" class="signals-applied">
              <div class="applied-label">⚡ Señales aplicadas:</div>
              <div class="applied-list">
                <span v-for="s in digitAnalysis.anomaly_signals_applied" :key="s" class="applied-chip">{{ s }}</span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- RIGHT: Hypotheses + Dynamic Strategies -->
      <div class="col-right">

        <!-- Hypotheses -->
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">🧪 Hipótesis</h2>
            <div class="hyp-filters">
              <button
                v-for="s in HYP_STATUSES"
                :key="s.key"
                :class="['hyp-filter-btn', { active: hypStatusFilter === s.key }]"
                @click="hypStatusFilter = s.key; loadHypotheses()"
              >{{ s.label }}</button>
            </div>
          </div>
          <div v-if="loadingHyp" class="loading-row">Cargando hipótesis...</div>
          <div v-else-if="!hypotheses.length" class="empty-row">Sin hipótesis para este filtro</div>
          <div v-else class="hyp-list">
            <div v-for="hyp in hypotheses" :key="hyp.id" class="hyp-item" :class="'hyp-' + hyp.validation_status">
              <div class="hyp-header-row">
                <span class="hyp-status-badge" :class="'badge-' + hyp.validation_status">
                  {{ hypStatusIcon(hyp.validation_status) }} {{ hyp.validation_status }}
                </span>
                <span class="hyp-type">{{ hypTypeLabel(hyp.hypothesis_type) }}</span>
                <span class="hyp-date">{{ fmtDate(hyp.created_at) }}</span>
              </div>
              <div class="hyp-body">
                <div class="hyp-target">
                  <template v-if="hyp.predicted_pair">
                    Par: <strong>{{ hyp.predicted_pair }}</strong>
                  </template>
                  <template v-else-if="hyp.predicted_digit !== null">
                    Dígito <strong>{{ hyp.predicted_digit }}</strong> en <strong>{{ hyp.predicted_position }}</strong>
                  </template>
                </div>
                <div class="hyp-meta">
                  <span>hit_rate esperado: {{ (hyp.predicted_hit_rate * 100).toFixed(1) }}%</span>
                  <span v-if="hyp.validation_hit_rate != null">
                    · validado: {{ (hyp.validation_hit_rate * 100).toFixed(1) }}%
                    · lift: {{ hyp.validation_lift?.toFixed(2) }}x
                    · p={{ hyp.validation_p_value?.toFixed(3) }}
                  </span>
                </div>
                <div class="hyp-basis">{{ hyp.confidence_basis }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Dynamic Strategies -->
        <div class="panel">
          <div class="panel-header">
            <h2 class="panel-title">🚀 Estrategias Dinámicas</h2>
            <label class="toggle-retired">
              <input type="checkbox" v-model="showRetired" @change="loadStrategies" />
              Ver retiradas
            </label>
          </div>
          <div v-if="loadingStrats" class="loading-row">Cargando estrategias...</div>
          <div v-else-if="!allStrategies.length" class="empty-row">
            Sin estrategias dinámicas — el agente las crea desde hipótesis validadas
          </div>
          <div v-else class="strat-list">
            <div
              v-for="strat in allStrategies"
              :key="strat.id"
              class="strat-item"
              :class="'strat-' + strat.lifecycle_status"
            >
              <div class="strat-header-row">
                <span class="strat-status-badge" :class="'badge-' + strat.lifecycle_status">
                  {{ stratStatusIcon(strat.lifecycle_status) }} {{ strat.lifecycle_status }}
                </span>
                <span class="strat-name">{{ strat.name }}</span>
                <span class="strat-boost">+{{ (strat.score_boost * 100).toFixed(0) }}pts</span>
              </div>
              <div class="strat-body">
                <div v-if="strat.target_pairs?.length" class="strat-targets">
                  Pares: <strong>{{ strat.target_pairs.join(', ') }}</strong>
                </div>
                <div v-if="strat.target_digits" class="strat-targets">
                  Dígitos: <code>{{ JSON.stringify(strat.target_digits) }}</code>
                </div>
                <div class="strat-stats">
                  <span>Draws: {{ strat.draws_active }}</span>
                  <span>Hits: {{ strat.hits_in_prod }}</span>
                  <span>Misses: {{ strat.misses_in_prod }}</span>
                  <span v-if="strat.hits_in_prod + strat.misses_in_prod > 0">
                    HitRate: {{ ((strat.hits_in_prod / (strat.hits_in_prod + strat.misses_in_prod)) * 100).toFixed(1) }}%
                  </span>
                  <span v-if="strat.consecutive_misses > 0" class="warn-misses">
                    ⚠️ {{ strat.consecutive_misses }} misses consecutivos
                  </span>
                </div>
                <div v-if="strat.description" class="strat-desc">{{ strat.description }}</div>
              </div>
            </div>
          </div>
        </div>

        <!-- Scan Log -->
        <div class="panel panel-compact">
          <div class="panel-header">
            <h2 class="panel-title">📋 Log de Escaneos</h2>
          </div>
          <div v-if="!scanLog.length" class="empty-row">Sin escaneos registrados</div>
          <div v-else class="scan-log-list">
            <div v-for="entry in scanLog" :key="entry.id" class="scan-entry">
              <div class="scan-meta">
                <span class="scan-trigger" :class="'trigger-' + entry.triggered_by">{{ entry.triggered_by }}</span>
                <span class="scan-game">{{ entry.game_type }} {{ entry.draw_type }}</span>
                <span class="scan-date">{{ fmtDate(entry.created_at) }}</span>
              </div>
              <div class="scan-stats">
                <span>📡 {{ entry.signals_found }}</span>
                <span>🧪 {{ entry.hypotheses_generated }}</span>
                <span>✅ {{ entry.hypotheses_validated }}</span>
                <span>❌ {{ entry.hypotheses_rejected }}</span>
                <span>🚀 {{ entry.strategies_activated }}</span>
                <span class="scan-duration">{{ entry.scan_duration_ms }}ms</span>
              </div>
            </div>
          </div>
        </div>

      </div>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiFetch } from '../../utils/apiClient.js';

// ─── State ────────────────────────────────────────────────────
const GAMES = [
  { key: 'pick3', label: 'Pick 3' },
  { key: 'pick4', label: 'Pick 4' },
];
const HYP_STATUSES = [
  { key: 'all',       label: 'Todas' },
  { key: 'pending',   label: 'Pendientes' },
  { key: 'validated', label: 'Validadas' },
  { key: 'rejected',  label: 'Rechazadas' },
];

const selectedGame     = ref('pick3');
const selectedDrawType = ref('evening');
const drawTypes        = ['midday', 'evening'];

const loading          = ref(false);
const loadingAnomalies = ref(false);
const loadingHyp       = ref(false);
const loadingStrats    = ref(false);
const loadingDigits    = ref(false);
const scanning         = ref(false);

const anomalyReport  = ref(null);
const hypotheses     = ref([]);
const allStrategies  = ref([]);
const digitAnalysis  = ref(null);
const scanLog        = ref([]);

const hypStatusFilter = ref('all');
const showRetired     = ref(false);

// ─── Computed ─────────────────────────────────────────────────
const pendingCount   = computed(() => hypotheses.value.filter(h => h.validation_status === 'pending').length);
const validatedCount = computed(() => hypotheses.value.filter(h => h.validation_status === 'validated').length);
const activeStrategies = computed(() =>
  allStrategies.value.filter(s => ['monitoring', 'active', 'consolidated'].includes(s.lifecycle_status))
);

// ─── Actions ──────────────────────────────────────────────────
function selectGame(g) {
  selectedGame.value = g;
  loadAll();
}

async function loadAll() {
  loading.value = true;
  await Promise.all([
    loadAnomalies(),
    loadHypotheses(),
    loadStrategies(),
    loadDigitAnalysis(),
    loadScanLog(),
  ]);
  loading.value = false;
}

async function loadAnomalies() {
  loadingAnomalies.value = true;
  try {
    anomalyReport.value = await apiFetch(
      `/api/agent/anomalies?game_type=${selectedGame.value}&draw_type=${selectedDrawType.value}`
    );
  } catch { anomalyReport.value = null; }
  finally { loadingAnomalies.value = false; }
}

async function loadHypotheses() {
  loadingHyp.value = true;
  try {
    hypotheses.value = await apiFetch(
      `/api/agent/hypotheses?game_type=${selectedGame.value}&draw_type=${selectedDrawType.value}&status=${hypStatusFilter.value}`
    );
  } catch { hypotheses.value = []; }
  finally { loadingHyp.value = false; }
}

async function loadStrategies() {
  loadingStrats.value = true;
  try {
    allStrategies.value = await apiFetch(
      `/api/agent/dynamic-strategies?game_type=${selectedGame.value}&draw_type=${selectedDrawType.value}&include_retired=${showRetired.value}`
    );
  } catch { allStrategies.value = []; }
  finally { loadingStrats.value = false; }
}

async function loadDigitAnalysis() {
  if (selectedGame.value !== 'pick3') { digitAnalysis.value = null; return; }
  loadingDigits.value = true;
  try {
    digitAnalysis.value = await apiFetch(
      `/api/agent/digit-analysis?game_type=pick3&draw_type=${selectedDrawType.value}`
    );
  } catch { digitAnalysis.value = null; }
  finally { loadingDigits.value = false; }
}

async function loadScanLog() {
  try {
    scanLog.value = await apiFetch('/api/agent/anomaly-scan-log?limit=15');
  } catch { scanLog.value = []; }
}

async function triggerScan() {
  scanning.value = true;
  try {
    await apiFetch('/api/agent/anomalies/scan', {
      method: 'POST',
      body: JSON.stringify({ game_type: selectedGame.value, draw_type: selectedDrawType.value }),
    });
    await loadAll();
  } catch { /* silencio */ }
  finally { scanning.value = false; }
}

// ─── Formatters ───────────────────────────────────────────────
function formatNum(n) {
  return n != null ? Number(n).toFixed(2) : '—';
}

function fmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('es', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function signalClass(sig) {
  if (Math.abs(sig.z_score) >= 3) return 'signal-critical';
  if (Math.abs(sig.z_score) >= 2) return 'signal-high';
  return 'signal-medium';
}

function zScoreClass(z) {
  const a = Math.abs(z);
  if (a >= 3) return 'z-critical';
  if (a >= 2) return 'z-high';
  return 'z-medium';
}

function signalTypeLabel(type) {
  const map = {
    positional_digit_bias:  '📍 Digit Bias',
    pair_absence_streak:    '⏸️ Ausencia',
    pair_overrepresentation: '📈 Sobre-rep',
    cross_position_coupling: '🔗 Coupling',
    day_of_week_bias:       '📅 DoW',
  };
  return map[type] ?? type;
}

function hypStatusIcon(s) {
  const m = { pending: '⏳', validated: '✅', rejected: '❌' };
  return m[s] ?? '?';
}

function hypTypeLabel(t) {
  const m = {
    positional_bias:        'Bias posicional',
    temporal_pattern:       'Patrón temporal',
    absence_streak:         'Racha de ausencia',
    cross_draw_dependency:  'Dependencia cruzada',
    family_clustering:      'Clustering familia',
  };
  return m[t] ?? t;
}

function stratStatusIcon(s) {
  const m = {
    monitoring:   '👁️',
    active:       '🟢',
    degrading:    '🟡',
    retired:      '⛔',
    consolidated: '⭐',
  };
  return m[s] ?? '?';
}

// ─── Lifecycle ────────────────────────────────────────────────
onMounted(() => loadAll());
</script>

<style scoped>
.anomaly-view {
  padding: 1.5rem;
  display: flex;
  flex-direction: column;
  gap: 1.25rem;
  min-height: 100vh;
  background: #0a0a0f;
  color: #e0e0f0;
}

/* ── Header ── */
.view-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: 1rem;
}
.view-title {
  font-size: 1.6rem;
  font-weight: 700;
  color: #b388ff;
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0;
}
.title-icon { font-size: 1.8rem; }
.view-subtitle { font-size: 0.8rem; color: #888; margin: 0.25rem 0 0; }
.header-controls { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; }
.game-selector { display: flex; gap: 0.5rem; }
.game-btn {
  padding: 0.4rem 1rem;
  border-radius: 8px;
  border: 1px solid #333;
  background: #161620;
  color: #aaa;
  cursor: pointer;
  font-size: 0.82rem;
  transition: all 0.2s;
}
.game-btn.active { border-color: #b388ff; background: #1e1630; color: #b388ff; font-weight: 600; }

.btn-scan {
  padding: 0.5rem 1.1rem;
  border-radius: 8px;
  border: none;
  background: linear-gradient(135deg, #7c3aed, #4f46e5);
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  transition: opacity 0.2s;
}
.btn-scan:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-scan.scanning .btn-icon { animation: spin 1s linear infinite; }
.btn-refresh {
  padding: 0.4rem 0.7rem;
  border-radius: 8px;
  border: 1px solid #333;
  background: #161620;
  color: #aaa;
  cursor: pointer;
  font-size: 1.1rem;
}
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Draw Tabs ── */
.draw-tabs { display: flex; gap: 0.5rem; }
.draw-tab {
  padding: 0.4rem 1.1rem;
  border-radius: 8px;
  border: 1px solid #333;
  background: #161620;
  color: #aaa;
  cursor: pointer;
  font-size: 0.82rem;
}
.draw-tab.active { border-color: #00e5ff; background: #0d1e24; color: #00e5ff; font-weight: 600; }

/* ── Stats Row ── */
.stats-row {
  display: flex;
  gap: 0.75rem;
  flex-wrap: wrap;
}
.stat-card {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  background: #161620;
  border: 1px solid #2a2a3a;
  border-radius: 12px;
  padding: 0.75rem 1.1rem;
  flex: 1;
  min-width: 120px;
}
.stat-icon { font-size: 1.6rem; }
.stat-value { font-size: 1.5rem; font-weight: 700; color: #b388ff; line-height: 1; }
.stat-label { font-size: 0.72rem; color: #888; margin-top: 0.2rem; }

/* ── Main Grid ── */
.main-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
@media (max-width: 1100px) { .main-grid { grid-template-columns: 1fr; } }
.col-left, .col-right { display: flex; flex-direction: column; gap: 1rem; }

/* ── Panel ── */
.panel {
  background: #161620;
  border: 1px solid #2a2a3a;
  border-radius: 14px;
  padding: 1.1rem;
}
.panel-compact { max-height: 240px; overflow-y: auto; }
.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
  flex-wrap: wrap;
  gap: 0.5rem;
}
.panel-title { font-size: 0.95rem; font-weight: 700; color: #ccc; margin: 0; }
.badge-count {
  background: #2a2a40;
  color: #b388ff;
  font-weight: 700;
  font-size: 0.8rem;
  padding: 0.15rem 0.55rem;
  border-radius: 20px;
}
.badge-info {
  font-size: 0.72rem;
  color: #888;
  background: #1e1e30;
  padding: 0.15rem 0.5rem;
  border-radius: 6px;
}

/* ── Loading/Empty ── */
.loading-row, .empty-row {
  color: #555;
  font-size: 0.8rem;
  padding: 1rem 0;
  text-align: center;
  font-style: italic;
}

/* ── Signal List ── */
.signal-list { display: flex; flex-direction: column; gap: 0.5rem; max-height: 380px; overflow-y: auto; }
.signal-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  background: #1a1a28;
  border-radius: 8px;
  padding: 0.6rem 0.8rem;
  border-left: 3px solid transparent;
  gap: 0.5rem;
}
.signal-critical { border-left-color: #ff4444; }
.signal-high     { border-left-color: #ff8800; }
.signal-medium   { border-left-color: #4a9eff; }
.signal-left { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.signal-type-badge {
  font-size: 0.7rem;
  background: #2a2a40;
  padding: 0.1rem 0.45rem;
  border-radius: 4px;
  color: #b388ff;
}
.signal-value { font-weight: 700; font-size: 0.95rem; color: #e0e0f0; }
.signal-pos { font-size: 0.7rem; color: #888; }
.signal-right { display: flex; flex-direction: column; align-items: flex-end; gap: 0.2rem; }
.signal-stats { display: flex; align-items: center; gap: 0.5rem; }
.z-score { font-size: 0.75rem; font-weight: 700; }
.z-critical { color: #ff4444; }
.z-high     { color: #ff8800; }
.z-medium   { color: #4a9eff; }
.confidence-bar-wrap {
  width: 50px;
  height: 5px;
  background: #2a2a40;
  border-radius: 3px;
  overflow: hidden;
}
.confidence-bar {
  display: block;
  height: 100%;
  background: linear-gradient(90deg, #4a9eff, #b388ff);
  border-radius: 3px;
}
.conf-label { font-size: 0.7rem; color: #888; }
.signal-window { font-size: 0.65rem; color: #555; }

/* ── Digit Analysis ── */
.digit-picks { display: flex; gap: 1rem; margin-bottom: 0.75rem; }
.digit-col { flex: 1; }
.digit-label { font-size: 0.72rem; color: #888; margin-bottom: 0.4rem; }
.digit-chips { display: flex; gap: 0.4rem; }
.digit-chip {
  width: 2rem;
  height: 2rem;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 8px;
  font-weight: 700;
  font-size: 1rem;
  background: #2a2a40;
  color: #aaa;
}
.digit-chip.rank-1 { background: #7c3aed; color: #fff; }
.digit-chip.rank-2 { background: #4f46e5; color: #fff; }
.digit-chip.rank-3 { background: #1e3a8a; color: #93c5fd; }

.combined-section { margin-bottom: 0.75rem; }
.combined-label { font-size: 0.72rem; color: #888; margin-bottom: 0.4rem; }
.pair-grid { display: flex; flex-wrap: wrap; gap: 0.35rem; }
.pair-chip {
  background: #1a1a2e;
  border: 1px solid #2a2a50;
  border-radius: 6px;
  padding: 0.2rem 0.5rem;
  font-size: 0.8rem;
  font-weight: 600;
  color: #b388ff;
}

.heatmap-section { margin-bottom: 0.75rem; }
.heatmap-label { font-size: 0.72rem; color: #888; margin-bottom: 0.4rem; }
.heatmap-grid { display: flex; gap: 0.3rem; flex-wrap: wrap; }
.heatmap-cell {
  width: 2.8rem;
  background: #1e1e30;
  border-radius: 6px;
  padding: 0.3rem;
  text-align: center;
  border: 1px solid #2a2a40;
  transition: border-color 0.2s;
}
.heatmap-cell.heatmap-top { border-color: #7c3aed; }
.heatmap-cell.anomaly-bonus { border-color: #ff8800; }
.hm-digit { font-weight: 700; font-size: 0.9rem; color: #e0e0f0; }
.hm-score { font-size: 0.65rem; color: #888; }

.signals-applied { font-size: 0.72rem; }
.applied-label { color: #888; margin-bottom: 0.3rem; }
.applied-list { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.applied-chip {
  background: #1a1a20;
  border: 1px solid #ff8800;
  color: #ff8800;
  font-size: 0.68rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
}

/* ── Hypotheses ── */
.hyp-filters { display: flex; gap: 0.35rem; }
.hyp-filter-btn {
  padding: 0.2rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #333;
  background: #1a1a28;
  color: #888;
  cursor: pointer;
  font-size: 0.72rem;
}
.hyp-filter-btn.active { border-color: #b388ff; color: #b388ff; }
.hyp-list { display: flex; flex-direction: column; gap: 0.5rem; max-height: 380px; overflow-y: auto; }
.hyp-item {
  background: #1a1a28;
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  border-left: 3px solid #333;
}
.hyp-pending   { border-left-color: #4a9eff; }
.hyp-validated { border-left-color: #22c55e; }
.hyp-rejected  { border-left-color: #555; opacity: 0.7; }
.hyp-header-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
.hyp-status-badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-weight: 600;
}
.badge-pending   { background: #1e3a5f; color: #4a9eff; }
.badge-validated { background: #14532d; color: #22c55e; }
.badge-rejected  { background: #2a2a2a; color: #888; }
.hyp-type  { font-size: 0.72rem; color: #888; flex: 1; }
.hyp-date  { font-size: 0.68rem; color: #555; }
.hyp-body  { font-size: 0.8rem; }
.hyp-target { color: #ccc; margin-bottom: 0.25rem; }
.hyp-meta   { color: #888; font-size: 0.72rem; margin-bottom: 0.2rem; }
.hyp-basis  { color: #555; font-size: 0.68rem; font-style: italic; }

/* ── Dynamic Strategies ── */
.toggle-retired { display: flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; color: #888; cursor: pointer; }
.strat-list { display: flex; flex-direction: column; gap: 0.5rem; max-height: 400px; overflow-y: auto; }
.strat-item {
  background: #1a1a28;
  border-radius: 8px;
  padding: 0.7rem 0.9rem;
  border-left: 3px solid #333;
}
.strat-monitoring   { border-left-color: #4a9eff; }
.strat-active       { border-left-color: #22c55e; }
.strat-degrading    { border-left-color: #f59e0b; }
.strat-retired      { border-left-color: #555; opacity: 0.6; }
.strat-consolidated { border-left-color: #b388ff; }
.strat-header-row { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; margin-bottom: 0.4rem; }
.strat-status-badge {
  font-size: 0.7rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-weight: 600;
  background: #2a2a40;
  color: #888;
}
.badge-active       { background: #14532d; color: #22c55e; }
.badge-monitoring   { background: #1e3a5f; color: #4a9eff; }
.badge-degrading    { background: #451a03; color: #f59e0b; }
.badge-retired      { background: #2a2a2a; color: #666; }
.badge-consolidated { background: #2d1b69; color: #b388ff; }
.strat-name  { font-size: 0.78rem; color: #ccc; flex: 1; font-weight: 600; font-family: monospace; }
.strat-boost { font-size: 0.72rem; color: #22c55e; font-weight: 700; }
.strat-body  { font-size: 0.78rem; }
.strat-targets { color: #ccc; margin-bottom: 0.25rem; }
.strat-targets code { color: #b388ff; font-size: 0.72rem; }
.strat-stats { display: flex; gap: 0.75rem; color: #888; font-size: 0.72rem; flex-wrap: wrap; }
.warn-misses { color: #f59e0b; }
.strat-desc { color: #555; font-size: 0.68rem; font-style: italic; margin-top: 0.25rem; }

/* ── Scan Log ── */
.scan-log-list { display: flex; flex-direction: column; gap: 0.4rem; }
.scan-entry {
  background: #1a1a24;
  border-radius: 6px;
  padding: 0.4rem 0.6rem;
  font-size: 0.72rem;
}
.scan-meta { display: flex; align-items: center; gap: 0.5rem; margin-bottom: 0.2rem; }
.scan-trigger {
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  font-weight: 600;
  font-size: 0.68rem;
}
.trigger-post_draw { background: #1e3a5f; color: #4a9eff; }
.trigger-manual    { background: #14532d; color: #22c55e; }
.trigger-cron      { background: #2d1b69; color: #b388ff; }
.scan-game { color: #888; flex: 1; }
.scan-date { color: #555; }
.scan-stats { display: flex; gap: 0.5rem; color: #666; }
.scan-duration { color: #444; margin-left: auto; }
</style>
