<template>
  <div class="pg-page">

    <!-- ══════════════════════════════════════════════════════════ -->
    <!-- HEADER + CONTROLS                                          -->
    <!-- ══════════════════════════════════════════════════════════ -->
    <div class="pg-header">
      <div>
        <h1 class="pg-title">
          Play Signal
          <span class="pg-tag">PROGRESSIVE ENGINE</span>
        </h1>
        <p class="pg-subtitle">¿Jugar hoy? — Motor de racha pre-acierto con 5 estrategias</p>
      </div>

      <div class="pg-controls">
        <div class="ctrl-group">
          <label class="ctrl-label">Juego</label>
          <select v-model="mapSource" class="ctrl-select" @change="fetchLatest">
            <option value="p3">Pick 3</option>
            <option value="p4">Pick 4</option>
          </select>
        </div>
        <div class="ctrl-group">
          <label class="ctrl-label">Periodo</label>
          <select v-model="period" class="ctrl-select" @change="fetchLatest">
            <option value="e">Evening</option>
            <option value="m">Midday</option>
          </select>
        </div>
        <div class="ctrl-group">
          <label class="ctrl-label">Desde</label>
          <input type="date" v-model="startDate" class="ctrl-input">
        </div>
        <div class="ctrl-group">
          <label class="ctrl-label">Top N</label>
          <input type="number" v-model.number="topN" class="ctrl-input ctrl-input--sm" min="5" max="30">
        </div>
        <button class="ctrl-btn ctrl-btn--ghost" :disabled="loading" @click="fetchLatest">
          <span :class="{ spin: loading }">↻</span>
        </button>
        <button class="ctrl-btn ctrl-btn--primary" :disabled="running" @click="runAnalysis">
          <span v-if="running" class="btn-spinner"></span>
          {{ running ? 'Analizando...' : '▶ Analizar' }}
        </button>
      </div>
    </div>

    <!-- run/error messages -->
    <Transition name="fade">
      <div v-if="runMsg" class="toast" :class="runError ? 'toast--err' : 'toast--ok'">
        {{ runMsg }}
      </div>
    </Transition>

    <!-- ── LOADING ──────────────────────────────────────────────── -->
    <div v-if="loading" class="state-center">
      <div class="pulse-loader">
        <div class="pulse-loader__ring"></div>
        <div class="pulse-loader__dot"></div>
      </div>
      <p class="state-label">Cargando análisis...</p>
    </div>

    <!-- ── EMPTY ────────────────────────────────────────────────── -->
    <div v-else-if="!result" class="state-center">
      <div class="empty-icon">📡</div>
      <p class="state-label">Sin datos en cache para <strong>{{ mapSource === 'p3' ? 'Pick 3' : 'Pick 4' }} / {{ period === 'e' ? 'Evening' : 'Midday' }}</strong></p>
      <p class="state-sub">Pulsa "▶ Analizar" para generar el análisis (30-90s)</p>
    </div>

    <!-- ══════════════════════════════════════════════════════════ -->
    <!-- MAIN CONTENT                                               -->
    <!-- ══════════════════════════════════════════════════════════ -->
    <template v-else>

      <!-- ── CONSENSUS COMMAND CENTER ────────────────────────────── -->
      <div class="command-center" :class="`cc--${consensusSignal?.toLowerCase()}`">

        <!-- Background glow -->
        <div class="cc-glow" :class="`glow--${consensusSignal?.toLowerCase()}`"></div>

        <!-- Left: Big signal -->
        <div class="cc-signal">
          <div class="signal-ring" :class="`ring--${consensusSignal?.toLowerCase()}`">
            <div class="signal-ring__inner">
              <span class="signal-ring__icon">{{ signalMeta(consensusSignal).icon }}</span>
              <span class="signal-ring__text" :style="{ color: signalMeta(consensusSignal).color }">
                {{ signalMeta(consensusSignal).label }}
              </span>
            </div>
            <svg class="signal-ring__svg" viewBox="0 0 120 120">
              <circle cx="60" cy="60" r="52" fill="none" stroke="#1e2d40" stroke-width="6"/>
              <circle cx="60" cy="60" r="52" fill="none"
                      :stroke="signalMeta(consensusSignal).color"
                      stroke-width="6"
                      stroke-linecap="round"
                      stroke-dasharray="327"
                      :stroke-dashoffset="327 - (327 * consensusScore / 5)"
                      transform="rotate(-90 60 60)"
                      style="transition: stroke-dashoffset 1s ease"/>
            </svg>
          </div>
          <div class="cc-signal__votes">
            <div class="vote-pill vote-pill--play">
              <span class="vote-pill__n">{{ playCount }}</span>
              <span class="vote-pill__label">PLAY</span>
            </div>
            <div class="vote-pill vote-pill--wait">
              <span class="vote-pill__n">{{ waitCount }}</span>
              <span class="vote-pill__label">WAIT</span>
            </div>
            <div class="vote-pill vote-pill--alert" v-if="alertCount > 0">
              <span class="vote-pill__n">{{ alertCount }}</span>
              <span class="vote-pill__label">ALERT</span>
            </div>
          </div>
        </div>

        <!-- Center: Stats grid -->
        <div class="cc-stats">
          <div class="cc-stat">
            <span class="cc-stat__val">{{ pct(avgHitRate) }}</span>
            <span class="cc-stat__label">Hit Rate Promedio</span>
          </div>
          <div class="cc-stat cc-stat--accent">
            <span class="cc-stat__val">{{ bestSubset?.conditions.currentMisses ?? '—' }}</span>
            <span class="cc-stat__label">Fallos Actuales (mejor)</span>
          </div>
          <div class="cc-stat">
            <span class="cc-stat__val">{{ result.datesAnalyzed }}</span>
            <span class="cc-stat__label">Fechas Analizadas</span>
          </div>
          <div class="cc-stat">
            <span class="cc-stat__val">{{ result.topN }}</span>
            <span class="cc-stat__label">Top N Pares</span>
          </div>
          <div class="cc-stat">
            <span class="cc-stat__val">{{ result.strategyCount }}</span>
            <span class="cc-stat__label">Estrategias</span>
          </div>
          <div class="cc-stat">
            <span class="cc-stat__val">{{ gameLabel }} / {{ periodLabel }}</span>
            <span class="cc-stat__label">Contexto</span>
          </div>
        </div>

        <!-- Right: Best strategy spotlight -->
        <div class="cc-spotlight" v-if="bestSubset">
          <div class="cc-spotlight__label">Mejor estrategia</div>
          <div class="cc-spotlight__name">{{ bestSubset.label }}</div>
          <div class="cc-spotlight__reason">{{ bestSubset.conditions.playReason }}</div>
          <div class="cc-spotlight__footer">
            <span class="cc-meta">
              {{ cachedAt ? 'Actualizado ' + cachedAt : 'En vivo' }}
            </span>
          </div>
        </div>
      </div>

      <!-- ── STRATEGY CARDS GRID ────────────────────────────────── -->
      <div class="cards-grid">
        <div
          v-for="(subset, idx) in subsets"
          :key="subset.strategyId"
          class="scard"
          :class="[
            `scard--${subset.conditions.playSignal.toLowerCase()}`,
            { 'scard--top': idx === 0 }
          ]"
        >
          <!-- Top glow line -->
          <div class="scard__topline"
               :style="{ background: signalMeta(subset.conditions.playSignal).color }"></div>

          <!-- Header -->
          <div class="scard__header">
            <div class="scard__rank">{{ idx + 1 }}</div>
            <div class="scard__name">{{ subset.label }}</div>
            <div class="scard__badge"
                 :class="`badge--${subset.conditions.playSignal.toLowerCase()}`">
              {{ signalMeta(subset.conditions.playSignal).icon }}
              {{ signalMeta(subset.conditions.playSignal).label }}
            </div>
          </div>

          <!-- Miss gauge + hit rate row -->
          <div class="scard__meters">

            <!-- SVG Arc Gauge -->
            <div class="arc-gauge">
              <svg viewBox="0 0 100 60" class="arc-gauge__svg">
                <!-- Track -->
                <path d="M 10 55 A 40 40 0 0 1 90 55"
                      fill="none" stroke="#1e2d40" stroke-width="8"
                      stroke-linecap="round"/>
                <!-- Fill -->
                <path d="M 10 55 A 40 40 0 0 1 90 55"
                      fill="none"
                      :stroke="signalMeta(subset.conditions.playSignal).color"
                      stroke-width="8"
                      stroke-linecap="round"
                      :stroke-dasharray="arcLen"
                      :stroke-dashoffset="arcOffset(subset.conditions)"
                      style="transition: stroke-dashoffset 0.8s ease"/>
                <!-- Threshold tick -->
                <line
                  :x1="thresholdX(subset.conditions, true)"
                  :y1="thresholdY(subset.conditions, true)"
                  :x2="thresholdX(subset.conditions, false)"
                  :y2="thresholdY(subset.conditions, false)"
                  stroke="#475569" stroke-width="2.5" stroke-linecap="round"/>
              </svg>
              <div class="arc-gauge__center">
                <span class="arc-gauge__val"
                      :style="{ color: missColor(subset.conditions) }">
                  {{ subset.conditions.currentMisses }}
                </span>
                <span class="arc-gauge__label">fallos</span>
              </div>
            </div>

            <!-- Hit rate vertical bar -->
            <div class="hit-meter">
              <div class="hit-meter__track">
                <div class="hit-meter__fill"
                     :style="{
                       height: Math.min(subset.hitRate / 0.35 * 100, 100) + '%',
                       background: signalMeta(subset.conditions.playSignal).color,
                     }"></div>
              </div>
              <span class="hit-meter__label">{{ pct(subset.hitRate) }}</span>
              <span class="hit-meter__sub">hit rate</span>
            </div>
          </div>

          <!-- Threshold bar with labels -->
          <div class="thresh-row">
            <span class="thresh-row__label">Racha</span>
            <div class="thresh-track">
              <div class="thresh-fill"
                   :style="{
                     width: thresholdPct(subset.conditions) + '%',
                     background: signalMeta(subset.conditions.playSignal).color + 'cc',
                   }"></div>
              <div class="thresh-marker"
                   :style="{ left: thresholdMarker(subset.conditions) + '%' }"
                   :title="`Umbral: avg(${subset.conditions.avgPreMiss})+σ(${subset.conditions.stdPreMiss})`">
              </div>
            </div>
            <span class="thresh-row__label">{{ subset.conditions.currentMisses }}/{{ subset.conditions.maxPreMiss }}</span>
          </div>

          <!-- Play reason pill -->
          <div class="reason-pill"
               :style="{ borderColor: signalMeta(subset.conditions.playSignal).ring + '88' }">
            {{ subset.conditions.playReason }}
          </div>

          <!-- Conditions table -->
          <div class="cond-table">
            <div class="cond-row">
              <span class="cond-key">Tendencia</span>
              <span class="cond-val" :style="{ color: trendMeta(subset.conditions.trend).color }">
                {{ trendMeta(subset.conditions.trend).icon }}
                {{ trendMeta(subset.conditions.trend).label }}
                <span v-if="subset.conditions.recentDelta !== 0" class="cond-delta">
                  {{ subset.conditions.recentDelta > 0 ? '+' : '' }}{{ subset.conditions.recentDelta.toFixed(1) }}pp
                </span>
              </span>
            </div>
            <div class="cond-row">
              <span class="cond-key">avg±σ pre-hit</span>
              <span class="cond-val">{{ subset.conditions.avgPreMiss }}±{{ subset.conditions.stdPreMiss }}</span>
            </div>
            <div class="cond-row">
              <span class="cond-key">Banda pico</span>
              <span class="cond-val">{{ subset.conditions.peakBand || '—' }} sorteos</span>
            </div>
            <div class="cond-row">
              <span class="cond-key">Intervalo</span>
              <span class="cond-val">{{ fmt(subset.conditions.avgInterval) }}±{{ fmt(subset.conditions.stdInterval) }}</span>
            </div>
            <div class="cond-row">
              <span class="cond-key">P(hit|hit)</span>
              <span class="cond-val" :style="{ color: subset.conditions.hitAfterHit > 0.2 ? '#22c55e' : '#94a3b8' }">
                {{ pct(subset.conditions.hitAfterHit) }}
              </span>
            </div>
            <div class="cond-row">
              <span class="cond-key">P(hit|miss)</span>
              <span class="cond-val" :style="{ color: subset.conditions.hitAfterMiss > 0.2 ? '#22c55e' : '#94a3b8' }">
                {{ pct(subset.conditions.hitAfterMiss) }}
              </span>
            </div>
          </div>

          <!-- Best months pills -->
          <div v-if="subset.conditions.bestMonths?.length" class="month-row">
            <span class="month-row__label">Mejores meses:</span>
            <span
              v-for="m in subset.conditions.bestMonths"
              :key="m.label"
              class="month-pill">
              {{ m.label }} <em>{{ pct(m.hitRate) }}</em>
            </span>
          </div>

          <!-- Footer stats -->
          <div class="scard__footer">
            <span class="scard__stat scard__stat--hit">✓ {{ subset.hits }} hits</span>
            <span class="scard__stat scard__stat--miss">✗ {{ subset.misses }} miss</span>
            <span class="scard__stat">skip {{ subset.skipped }}</span>
          </div>

          <!-- PLAY pulse overlay -->
          <div v-if="subset.conditions.playSignal === 'PLAY'" class="play-pulse"></div>
        </div>
      </div>

    </template>
  </div>
</template>

<script setup>
import { onMounted, computed } from 'vue';
import { useProgressive } from '../../composables/agent/useProgressive.js';

const {
  result, loading, running, error, runMsg, runError,
  mapSource, period, topN, startDate, endDate,
  subsets, consensusSignal, playCount, waitCount, alertCount,
  avgHitRate, bestSubset, cachedAt,
  fetchLatest, runAnalysis,
  signalMeta, trendMeta, pct, fmt,
} = useProgressive();

onMounted(fetchLatest);

const gameLabel   = computed(() => mapSource.value === 'p3' ? 'Pick 3' : 'Pick 4');
const periodLabel = computed(() => period.value === 'e' ? 'Evening' : 'Midday');

// How many strategies are in PLAY (0-5) — drives the ring arc
const consensusScore = computed(() => playCount.value + (alertCount.value > 0 ? 0 : 0));

// ── SVG Arc Gauge constants ──────────────────────────────────────
// Arc path "M 10 55 A 40 40 0 0 1 90 55" — half-circle, radius=40, center=(50,55)
// Arc length ≈ π × 40 ≈ 125.7
const arcLen = 125.7;

function arcOffset(cond) {
  if (!cond.maxPreMiss) return arcLen;
  const pct = Math.min(cond.currentMisses / cond.maxPreMiss, 1);
  return arcLen - arcLen * pct;
}

// Threshold tick position on the arc
function arcAngle(cond) {
  if (!cond.maxPreMiss) return 180; // start
  const threshold = cond.avgPreMiss + cond.stdPreMiss;
  const ratio = Math.min(threshold / cond.maxPreMiss, 1);
  // Arc goes from 180° to 0° (left to right)
  return 180 - ratio * 180;
}

function thresholdX(cond, inner) {
  const angle = arcAngle(cond) * (Math.PI / 180);
  const r = inner ? 35 : 45;
  return 50 + r * Math.cos(angle);
}

function thresholdY(cond, inner) {
  const angle = arcAngle(cond) * (Math.PI / 180);
  // Arc center is at (50,55), arc goes UPWARD → SVG y decreases as angle increases
  const r = inner ? 35 : 45;
  return 55 - r * Math.sin(angle);
}

function missColor(cond) {
  const threshold = cond.avgPreMiss + cond.stdPreMiss;
  if (cond.currentMisses > cond.maxPreMiss) return '#ef4444';
  if (cond.currentMisses >= threshold) return '#22c55e';
  if (cond.currentMisses >= cond.avgPreMiss) return '#f59e0b';
  return '#64748b';
}

function thresholdPct(cond) {
  if (!cond.maxPreMiss) return 0;
  return Math.min((cond.currentMisses / cond.maxPreMiss) * 100, 100);
}

function thresholdMarker(cond) {
  if (!cond.maxPreMiss) return 50;
  const threshold = cond.avgPreMiss + cond.stdPreMiss;
  return Math.min((threshold / cond.maxPreMiss) * 100, 96);
}
</script>

<style scoped>
/* ══════════════════════════════════════════════════════════════ */
/* Page                                                           */
/* ══════════════════════════════════════════════════════════════ */
.pg-page {
  min-height: 100vh;
  color: #e2e8f0;
  font-family: 'Inter', system-ui, sans-serif;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

/* ── Header ──────────────────────────────────────────────────── */
.pg-header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  flex-wrap: wrap;
}
.pg-title {
  font-size: 1.6rem;
  font-weight: 800;
  color: #f1f5f9;
  margin: 0 0 0.2rem;
  letter-spacing: -0.02em;
}
.pg-tag {
  font-size: 0.62rem;
  font-weight: 700;
  background: linear-gradient(135deg, #1e3a5f, #0f2640);
  color: #60a5fa;
  padding: 0.2rem 0.55rem;
  border-radius: 4px;
  vertical-align: middle;
  letter-spacing: 0.1em;
  border: 1px solid #253e6a;
}
.pg-subtitle { font-size: 0.82rem; color: #475569; margin: 0; }

/* ── Controls ────────────────────────────────────────────────── */
.pg-controls { display: flex; align-items: flex-end; gap: 0.6rem; flex-wrap: wrap; }

.ctrl-group { display: flex; flex-direction: column; gap: 0.2rem; }
.ctrl-label { font-size: 0.6rem; color: #475569; text-transform: uppercase; letter-spacing: 0.07em; }

.ctrl-select, .ctrl-input {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 6px;
  color: #e2e8f0;
  padding: 0.4rem 0.65rem;
  font-size: 0.82rem;
  outline: none;
  transition: border-color 0.15s;
}
.ctrl-select:hover, .ctrl-input:hover,
.ctrl-select:focus, .ctrl-input:focus { border-color: #3b82f6; }
.ctrl-input--sm { width: 64px; }

.ctrl-btn {
  padding: 0.45rem 0.9rem;
  border-radius: 6px;
  font-size: 0.82rem;
  font-weight: 600;
  cursor: pointer;
  border: none;
  display: flex;
  align-items: center;
  gap: 0.4rem;
  transition: opacity 0.15s, background 0.15s;
  align-self: flex-end;
}
.ctrl-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.ctrl-btn--ghost {
  background: #1e2d40;
  color: #94a3b8;
  border: 1px solid #253346;
  padding: 0.45rem 0.7rem;
}
.ctrl-btn--ghost:hover:not(:disabled) { background: #253346; }
.ctrl-btn--primary { background: #2563eb; color: #fff; }
.ctrl-btn--primary:hover:not(:disabled) { background: #1d4ed8; }

.btn-spinner {
  width: 12px; height: 12px;
  border: 2px solid rgba(255,255,255,0.3);
  border-top-color: #fff;
  border-radius: 50%;
  animation: spin 0.7s linear infinite;
  flex-shrink: 0;
}

/* ── Toast ───────────────────────────────────────────────────── */
.toast {
  border-radius: 8px;
  padding: 0.65rem 1rem;
  font-size: 0.82rem;
  animation: fadeIn 0.3s ease;
}
.toast--ok  { background: #052e16; color: #4ade80; border: 1px solid #16a34a55; }
.toast--err { background: #1f0202; color: #f87171; border: 1px solid #dc262655; }

/* ── States ──────────────────────────────────────────────────── */
.state-center {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 5rem 2rem;
  gap: 1rem;
  text-align: center;
}
.state-label { font-size: 0.95rem; color: #94a3b8; margin: 0; }
.state-sub   { font-size: 0.78rem; color: #475569; margin: 0; }
.empty-icon  { font-size: 3.5rem; }

/* Pulse loader */
.pulse-loader {
  position: relative;
  width: 56px; height: 56px;
}
.pulse-loader__ring {
  position: absolute; inset: 0;
  border: 3px solid #1e2d40;
  border-top-color: #3b82f6;
  border-radius: 50%;
  animation: spin 0.9s linear infinite;
}
.pulse-loader__dot {
  position: absolute;
  inset: 14px;
  background: #3b82f6;
  border-radius: 50%;
  animation: pulse 1.2s ease-in-out infinite;
}

/* ══════════════════════════════════════════════════════════════ */
/* COMMAND CENTER (Consensus Banner)                              */
/* ══════════════════════════════════════════════════════════════ */
.command-center {
  position: relative;
  border-radius: 16px;
  border: 1px solid #1e2d40;
  padding: 1.75rem 2rem;
  display: flex;
  align-items: center;
  gap: 2.5rem;
  flex-wrap: wrap;
  overflow: hidden;
  background: #0a0f1c;
}

.cc--play  { border-color: #16a34a55; }
.cc--wait  { border-color: #d9770655; }
.cc--alert { border-color: #dc262655; }

/* Ambient glow behind content */
.cc-glow {
  position: absolute;
  width: 300px; height: 300px;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.12;
  pointer-events: none;
  top: -80px; left: -60px;
}
.glow--play  { background: #22c55e; }
.glow--wait  { background: #f59e0b; }
.glow--alert { background: #ef4444; animation: alertPulse 1.5s ease-in-out infinite; }

/* Left: Signal ring */
.cc-signal { display: flex; flex-direction: column; align-items: center; gap: 1rem; flex-shrink: 0; }

.signal-ring {
  position: relative;
  width: 130px; height: 130px;
  display: flex;
  align-items: center;
  justify-content: center;
}
.signal-ring--play  { filter: drop-shadow(0 0 18px #22c55e55); }
.signal-ring--wait  { filter: drop-shadow(0 0 12px #f59e0b44); }
.signal-ring--alert { filter: drop-shadow(0 0 20px #ef444466); animation: alertPulse 1.5s ease-in-out infinite; }

.signal-ring__svg {
  position: absolute; inset: 0;
  width: 100%; height: 100%;
}
.signal-ring__inner {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  z-index: 1;
}
.signal-ring__icon { font-size: 1.8rem; line-height: 1; }
.signal-ring__text {
  font-size: 0.85rem;
  font-weight: 800;
  letter-spacing: 0.1em;
}

/* Vote pills */
.cc-signal__votes { display: flex; gap: 0.5rem; }

.vote-pill {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 0.3rem 0.6rem;
  border-radius: 8px;
  min-width: 44px;
}
.vote-pill--play  { background: #052e16; border: 1px solid #16a34a55; }
.vote-pill--wait  { background: #1c1102; border: 1px solid #d9770655; }
.vote-pill--alert { background: #1f0202; border: 1px solid #dc262655; }

.vote-pill__n {
  font-size: 1.2rem;
  font-weight: 800;
  line-height: 1;
}
.vote-pill--play  .vote-pill__n { color: #22c55e; }
.vote-pill--wait  .vote-pill__n { color: #f59e0b; }
.vote-pill--alert .vote-pill__n { color: #ef4444; }

.vote-pill__label {
  font-size: 0.55rem;
  font-weight: 700;
  letter-spacing: 0.1em;
  color: #475569;
  margin-top: 2px;
}

/* Center: Stats */
.cc-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem 1.5rem;
  flex: 1;
  min-width: 240px;
}

.cc-stat { display: flex; flex-direction: column; gap: 0.15rem; }
.cc-stat--accent .cc-stat__val { color: #60a5fa; }

.cc-stat__val {
  font-size: 1.25rem;
  font-weight: 700;
  color: #f1f5f9;
  line-height: 1;
}
.cc-stat__label {
  font-size: 0.6rem;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.07em;
}

/* Right: Spotlight */
.cc-spotlight {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  padding: 1rem 1.25rem;
  max-width: 240px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.cc-spotlight__label {
  font-size: 0.6rem;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: #475569;
}
.cc-spotlight__name {
  font-size: 1rem;
  font-weight: 700;
  color: #e2e8f0;
}
.cc-spotlight__reason {
  font-size: 0.75rem;
  color: #94a3b8;
  line-height: 1.5;
  flex: 1;
}
.cc-spotlight__footer { margin-top: auto; }
.cc-meta { font-size: 0.65rem; color: #334155; }

/* ══════════════════════════════════════════════════════════════ */
/* STRATEGY CARDS                                                 */
/* ══════════════════════════════════════════════════════════════ */
.cards-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(320px, 1fr));
  gap: 1.25rem;
}

.scard {
  position: relative;
  background: #0a0f1c;
  border: 1px solid #1a2535;
  border-radius: 14px;
  padding: 0 1.25rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
  overflow: hidden;
  transition: border-color 0.2s, box-shadow 0.2s;
}
.scard:hover { border-color: #2a3a50; box-shadow: 0 4px 24px rgba(0,0,0,0.4); }

.scard--top { border-color: #1a3a5f; box-shadow: 0 0 0 1px #1a3a5f; }
.scard--play  { }
.scard--wait  { }
.scard--alert { animation: alertBorder 2s ease-in-out infinite; }

/* Top accent line */
.scard__topline {
  height: 3px;
  width: 100%;
  margin: 0 -1.25rem;
  width: calc(100% + 2.5rem);
  border-radius: 0;
  margin-bottom: 0;
  flex-shrink: 0;
}

/* Header */
.scard__header {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding-top: 0.25rem;
}
.scard__rank {
  width: 22px; height: 22px;
  background: #1e2d40;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 0.65rem;
  font-weight: 700;
  color: #64748b;
  flex-shrink: 0;
}
.scard__name {
  flex: 1;
  font-size: 0.88rem;
  font-weight: 700;
  color: #e2e8f0;
}
.scard__badge {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.2rem 0.55rem;
  border-radius: 999px;
  letter-spacing: 0.06em;
  flex-shrink: 0;
}
.badge--play  { background: #052e16; color: #4ade80; border: 1px solid #16a34a66; }
.badge--wait  { background: #1c1102; color: #fbbf24; border: 1px solid #d9770666; }
.badge--alert { background: #1f0202; color: #f87171; border: 1px solid #dc262666; animation: alertPulse 1.2s ease-in-out infinite; }

/* ── Meters row ─────────────────────────────────────────────── */
.scard__meters {
  display: flex;
  align-items: flex-end;
  gap: 1rem;
}

/* SVG Arc Gauge */
.arc-gauge {
  position: relative;
  width: 110px;
  flex-shrink: 0;
}
.arc-gauge__svg { width: 100%; display: block; }
.arc-gauge__center {
  position: absolute;
  bottom: 4px;
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  line-height: 1;
}
.arc-gauge__val {
  font-size: 1.5rem;
  font-weight: 800;
}
.arc-gauge__label {
  font-size: 0.58rem;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* Hit rate vertical bar */
.hit-meter {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}
.hit-meter__track {
  width: 24px;
  height: 80px;
  background: #1e2d40;
  border-radius: 4px;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}
.hit-meter__fill {
  width: 100%;
  border-radius: 4px;
  transition: height 0.7s ease;
}
.hit-meter__label {
  font-size: 0.8rem;
  font-weight: 700;
  color: #e2e8f0;
}
.hit-meter__sub {
  font-size: 0.58rem;
  color: #475569;
  text-transform: uppercase;
  letter-spacing: 0.06em;
}

/* ── Threshold bar ──────────────────────────────────────────── */
.thresh-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.thresh-row__label {
  font-size: 0.65rem;
  color: #475569;
  white-space: nowrap;
}
.thresh-track {
  flex: 1;
  height: 6px;
  background: #1e2d40;
  border-radius: 3px;
  position: relative;
  overflow: visible;
}
.thresh-fill {
  height: 100%;
  border-radius: 3px;
  transition: width 0.5s ease;
}
.thresh-marker {
  position: absolute;
  top: -4px;
  width: 2px;
  height: 14px;
  background: #475569;
  border-radius: 1px;
  transform: translateX(-50%);
}
.thresh-marker::after {
  content: 'umbral';
  position: absolute;
  top: 16px;
  left: 50%;
  transform: translateX(-50%);
  font-size: 0.52rem;
  color: #334155;
  white-space: nowrap;
}

/* ── Reason pill ────────────────────────────────────────────── */
.reason-pill {
  font-size: 0.75rem;
  color: #94a3b8;
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 8px;
  padding: 0.5rem 0.7rem;
  line-height: 1.55;
  border-left-width: 3px;
}

/* ── Conditions table ───────────────────────────────────────── */
.cond-table {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.cond-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0.2rem 0;
  border-bottom: 1px solid #111827;
}
.cond-row:last-child { border-bottom: none; }
.cond-key {
  font-size: 0.68rem;
  color: #475569;
}
.cond-val {
  font-size: 0.75rem;
  font-weight: 600;
  color: #cbd5e1;
}
.cond-delta {
  font-size: 0.65rem;
  margin-left: 0.3rem;
  opacity: 0.8;
}

/* ── Month pills ────────────────────────────────────────────── */
.month-row {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
}
.month-row__label { font-size: 0.65rem; color: #475569; flex-shrink: 0; }
.month-pill {
  font-size: 0.68rem;
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 6px;
  padding: 0.15rem 0.45rem;
  color: #94a3b8;
}
.month-pill em { font-style: normal; color: #60a5fa; margin-left: 0.2rem; }

/* ── Card footer ────────────────────────────────────────────── */
.scard__footer {
  display: flex;
  gap: 0.75rem;
  font-size: 0.7rem;
  color: #334155;
  padding-top: 0.6rem;
  border-top: 1px solid #111827;
  margin-top: auto;
}
.scard__stat--hit  { color: #22c55e; font-weight: 600; }
.scard__stat--miss { color: #ef4444; font-weight: 600; }

/* ── PLAY pulse overlay ─────────────────────────────────────── */
.play-pulse {
  position: absolute;
  inset: 0;
  border-radius: 14px;
  pointer-events: none;
  box-shadow: inset 0 0 0 1px #22c55e22;
  animation: playGlow 3s ease-in-out infinite;
}

/* ══════════════════════════════════════════════════════════════ */
/* Animations                                                     */
/* ══════════════════════════════════════════════════════════════ */
@keyframes spin {
  to { transform: rotate(360deg); }
}
.spin { display: inline-block; animation: spin 0.7s linear infinite; }

@keyframes pulse {
  0%, 100% { opacity: 0.5; transform: scale(0.85); }
  50%       { opacity: 1;   transform: scale(1.15); }
}

@keyframes fadeIn {
  from { opacity: 0; transform: translateY(-4px); }
  to   { opacity: 1; transform: translateY(0); }
}

@keyframes alertPulse {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.65; }
}

@keyframes alertBorder {
  0%, 100% { border-color: #dc262644; }
  50%       { border-color: #dc262699; }
}

@keyframes playGlow {
  0%, 100% { box-shadow: inset 0 0 0 1px #22c55e22; }
  50%       { box-shadow: inset 0 0 0 1px #22c55e44, 0 0 20px #22c55e11; }
}

.fade-enter-active, .fade-leave-active { transition: opacity 0.3s, transform 0.3s; }
.fade-enter-from, .fade-leave-to { opacity: 0; transform: translateY(-6px); }

/* ── Responsive ─────────────────────────────────────────────── */
@media (max-width: 900px) {
  .command-center { flex-direction: column; align-items: flex-start; }
  .cc-spotlight   { max-width: 100%; width: 100%; }
  .cc-stats       { grid-template-columns: repeat(2, 1fr); }
}
</style>
