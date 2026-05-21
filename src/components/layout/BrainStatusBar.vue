<!--
═══════════════════════════════════════════════════════════════════
  BrainStatusBar — Sistema Nervioso Central VISIBLE

  Barra superior persistente que muestra el estado vivo del cerebro F1
  en TODAS las vistas. Inyecta de useHelixBrain (singleton global).

  Diseño: signos vitales del agente
  ┌─────────────────────────────────────────────────────────────────┐
  │ 🧠 HELIX │ 🔥 Quad Cluster (pick4) │ ⚡ ×3.58 boost │ 80% cob │
  └─────────────────────────────────────────────────────────────────┘
═══════════════════════════════════════════════════════════════════
-->
<template>
  <div v-if="brain" class="brain-bar" :style="{ borderBottom: `2px solid ${brain.regimeMeta.value.color}` }">
    <!-- Identidad -->
    <div class="bb-section bb-brand">
      <span class="bb-pulse" :style="{ background: brain.regimeMeta.value.color }"></span>
      <span class="bb-label">CEREBRO F1</span>
    </div>

    <!-- Régimen activo -->
    <div class="bb-section bb-regime" :title="regimeTooltip">
      <span class="bb-regime-emoji">{{ brain.regimeMeta.value.emoji }}</span>
      <div class="bb-regime-info">
        <div class="bb-regime-name" :style="{ color: brain.regimeMeta.value.color }">
          {{ brain.regimeMeta.value.label }}
        </div>
        <div class="bb-regime-meta">
          {{ brain.activeGame.value }} · str {{ brain.regimeStrength.value.toFixed(2) }}
          <span v-if="brain.daysSinceRareEvent.value !== null"> · {{ brain.daysSinceRareEvent.value }}d</span>
        </div>
      </div>
    </div>

    <!-- Hawkes intensity -->
    <div class="bb-section bb-intensity">
      <div class="bb-metric-label">Intensidad</div>
      <div class="bb-metric-val" :style="{ color: intensityColor }">
        {{ (brain.hawkesIntensity.value * 100).toFixed(0) }}%
      </div>
    </div>

    <!-- Top multiplier activo -->
    <div v-if="topMultiplier" class="bb-section bb-mult">
      <div class="bb-metric-label">Boost activo</div>
      <div class="bb-mult-pill" :class="topMultiplier.direction === 'boost' ? 'bb-mult--boost' : 'bb-mult--suppress'">
        {{ topMultiplier.algo }} ×{{ topMultiplier.weight }}
      </div>
    </div>

    <!-- Cobertura conformal -->
    <div v-if="brain.conformalCoverage.value" class="bb-section bb-coverage">
      <div class="bb-metric-label">Garantía cobertura</div>
      <div class="bb-metric-val bb-coverage-val">
        {{ (brain.conformalCoverage.value.level * 100).toFixed(0) }}%
        <span class="bb-coverage-pairs">/{{ brain.conformalCoverage.value.threshold }} pares</span>
      </div>
    </div>

    <!-- Top algo Thompson -->
    <div v-if="topThompson" class="bb-section bb-thompson">
      <div class="bb-metric-label">Líder UCB</div>
      <div class="bb-thompson-val">
        <span class="bb-thompson-algo">{{ topThompson.algo_name }}</span>
        <span class="bb-thompson-ucb">{{ (topThompson.ucb_score * 100).toFixed(1) }}%</span>
      </div>
    </div>

    <!-- Loop status + timestamp -->
    <div class="bb-section bb-loop">
      <button class="bb-refresh" @click="brain.refreshF1" :disabled="brain.f1Loading.value" title="Refrescar cerebro F1">
        <span :class="brain.f1Loading.value ? 'bb-spinning' : ''">↻</span>
      </button>
      <span class="bb-timestamp">{{ lastFetchLabel }}</span>
    </div>
  </div>
</template>

<script setup>
import { inject, computed } from 'vue';

const brain = inject('helixBrain', null);

const intensityColor = computed(() => {
  const i = brain?.hawkesIntensity.value ?? 0;
  if (i > 0.7) return '#dc2626';
  if (i > 0.4) return '#f59e0b';
  if (i > 0.2) return '#eab308';
  return '#64748b';
});

const topMultiplier = computed(() => brain?.activeMultipliers.value[0] ?? null);
const topThompson   = computed(() => brain?.thompsonLeaders.value[0] ?? null);

const lastFetchLabel = computed(() => {
  if (!brain?.lastF1Fetch.value) return '—';
  const d = new Date(brain.lastF1Fetch.value);
  return d.toLocaleTimeString().slice(0, 5);
});

const regimeTooltip = computed(() => {
  const exp = brain?.activeRegime?.value?.source?.gating?.explanation;
  return exp ?? 'Cerebro F1 — HELIX v2';
});
</script>

<style scoped>
.brain-bar {
  display: flex;
  align-items: stretch;
  gap: 0;
  background: linear-gradient(90deg, #0a0d14 0%, #0f1623 100%);
  padding: 0.5rem 1.25rem;
  position: sticky;
  top: 0;
  z-index: 100;
  border-radius: 0 0 8px 8px;
  font-size: 0.75rem;
  color: #e2e8f0;
  user-select: none;
  margin-bottom: 1rem;
  box-shadow: 0 2px 12px rgba(0,0,0,0.4);
}

.bb-section {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.25rem 0.85rem;
  border-right: 1px solid #1e2d40;
}
.bb-section:last-child { border-right: none; }

.bb-brand {
  font-weight: 800;
  letter-spacing: 0.08em;
  color: #60a5fa;
  font-size: 0.7rem;
}
.bb-pulse {
  width: 8px; height: 8px; border-radius: 50%;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50%     { opacity: 0.5; transform: scale(0.8); }
}

.bb-regime-info { display: flex; flex-direction: column; gap: 1px; }
.bb-regime-emoji { font-size: 1.3rem; }
.bb-regime-name  { font-weight: 700; font-size: 0.85rem; letter-spacing: 0.02em; }
.bb-regime-meta  { font-size: 0.65rem; color: #64748b; }

.bb-metric-label { font-size: 0.6rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
.bb-metric-val   { font-weight: 700; font-size: 0.95rem; }
.bb-intensity, .bb-coverage, .bb-thompson, .bb-mult {
  flex-direction: column; gap: 0.1rem; align-items: flex-start;
}

.bb-mult-pill {
  padding: 0.2rem 0.5rem;
  border-radius: 4px;
  font-size: 0.75rem;
  font-weight: 700;
}
.bb-mult--boost     { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
.bb-mult--suppress  { background: rgba(239, 68, 68, 0.15); color: #f87171; }

.bb-coverage-val { color: #22c55e; }
.bb-coverage-pairs { font-size: 0.65rem; font-weight: 400; color: #94a3b8; margin-left: 0.25rem; }

.bb-thompson-val { display: flex; flex-direction: column; gap: 1px; }
.bb-thompson-algo { font-size: 0.75rem; font-weight: 600; color: #fbbf24; }
.bb-thompson-ucb  { font-size: 0.7rem; color: #60a5fa; }

.bb-loop { margin-left: auto; }
.bb-refresh {
  background: transparent;
  border: 1px solid #1e2d40;
  color: #94a3b8;
  border-radius: 4px;
  padding: 0.2rem 0.45rem;
  cursor: pointer;
  font-size: 0.85rem;
}
.bb-refresh:hover { background: #1e2d40; color: #60a5fa; }
.bb-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.bb-spinning { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { 100% { transform: rotate(360deg); } }
.bb-timestamp { font-size: 0.65rem; color: #475569; }

@media (max-width: 900px) {
  .brain-bar { flex-wrap: wrap; padding: 0.4rem 0.75rem; gap: 0.25rem; }
  .bb-section { border-right: none; padding: 0.2rem 0.5rem; }
  .bb-loop { margin-left: 0; }
}
</style>
