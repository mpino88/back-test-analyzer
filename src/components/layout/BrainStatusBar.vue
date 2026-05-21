<!--
═══════════════════════════════════════════════════════════════════
  BrainStatusBar — Sistema Nervioso Central VISIBLE (v2 — dual game)

  FIX 2026-05-21: muestra pick3 Y pick4 simultáneamente en paralelo.
  Antes priorizaba uno y ocultaba el otro.

  ┌─────────────────────────────────────────────────────────────────┐
  │ 🧠 CEREBRO F1                                          ↻ 22:09 │
  ├──────────────────────────────┬──────────────────────────────────┤
  │ PICK3 │ ⚪ Normal │ 0% int   │ PICK4 │ 🔥 Quad Cluster │ 86% int│
  │ pick3 evening du · 14d       │ pick4 evening ab · 3d            │
  │ — sin multipliers             │ double_triple ×3.58              │
  │ Líder: streak 17.4%           │ Líder: markov_order2 21.3%       │
  └──────────────────────────────┴──────────────────────────────────┘
═══════════════════════════════════════════════════════════════════
-->
<template>
  <div v-if="brain" class="brain-bar">
    <!-- Header global -->
    <div class="bb-header">
      <div class="bb-brand">
        <span class="bb-pulse" :style="{ background: globalColor }"></span>
        <span class="bb-label">CEREBRO F1 — HELIX v2</span>
      </div>
      <div class="bb-controls">
        <span class="bb-timestamp">{{ lastFetchLabel }}</span>
        <button class="bb-refresh" @click="brain.refreshF1" :disabled="brain.f1Loading.value" title="Refrescar">
          <span :class="brain.f1Loading.value ? 'bb-spinning' : ''">↻</span>
        </button>
      </div>
    </div>

    <!-- Dual games side-by-side -->
    <div class="bb-games">
      <GamePanel
        v-if="brain.pick3View"
        :view="brain.pick3View.value"
        label="PICK3"
        half="du"
      />
      <GamePanel
        v-if="brain.pick4View"
        :view="brain.pick4View.value"
        label="PICK4"
        half="ab"
      />
    </div>

    <!-- Cobertura conformal global -->
    <div v-if="brain.conformalCoverage.value" class="bb-conformal">
      <span class="bb-conformal-label">Garantía cobertura (conformal):</span>
      <span class="bb-conformal-val">
        {{ (brain.conformalCoverage.value.level * 100).toFixed(0) }}% / {{ brain.conformalCoverage.value.threshold }} pares
      </span>
    </div>
  </div>
</template>

<script setup>
import { inject, computed, h } from 'vue';

const brain = inject('helixBrain', null);

// Color global = el más extremo de los dos juegos
const globalColor = computed(() => {
  if (!brain) return '#475569';
  const p3 = brain.pick3View.value.meta.color;
  const p4 = brain.pick4View.value.meta.color;
  // Si alguno está en HAWKES (rojo/naranja), priorizar
  if (brain.pick4View.value.regime !== 'NORMAL') return p4;
  if (brain.pick3View.value.regime !== 'NORMAL') return p3;
  return '#64748b';
});

const lastFetchLabel = computed(() => {
  if (!brain?.lastF1Fetch.value) return '—';
  return new Date(brain.lastF1Fetch.value).toLocaleTimeString().slice(0, 5);
});

// ── Sub-component: GamePanel (pick3 o pick4) ──
const GamePanel = {
  name: 'GamePanel',
  props: {
    view:  { type: Object, required: true },
    label: { type: String, required: true },
    half:  { type: String, default: 'du' },
  },
  setup(props) {
    return () => {
      const v = props.view;
      const intensityColor = v.intensity > 0.7 ? '#dc2626'
                           : v.intensity > 0.4 ? '#f59e0b'
                           : v.intensity > 0.2 ? '#eab308' : '#64748b';

      return h('div', { class: 'gp', style: { borderTop: `3px solid ${v.meta.color}` } }, [
        // Header del juego
        h('div', { class: 'gp-header' }, [
          h('span', { class: 'gp-game' }, props.label),
          h('span', { class: 'gp-regime', style: { color: v.meta.color } }, [
            h('span', { class: 'gp-emoji' }, v.meta.emoji),
            h('span', { class: 'gp-regime-name' }, v.meta.label),
          ]),
        ]),

        // Metadata: half + days since
        h('div', { class: 'gp-meta' }, [
          `evening · half=${props.half}`,
          v.daysSince !== null ? h('span', { class: 'gp-days' }, ` · ${v.daysSince}d desde último evento`) : null,
        ]),

        // Vital signs: intensity + top multiplier
        h('div', { class: 'gp-vitals' }, [
          h('div', { class: 'gp-vital' }, [
            h('span', { class: 'gp-vital-label' }, 'Intensidad'),
            h('span', { class: 'gp-vital-val', style: { color: intensityColor } },
              `${(v.intensity * 100).toFixed(0)}%`),
          ]),
          v.strength > 0 ? h('div', { class: 'gp-vital' }, [
            h('span', { class: 'gp-vital-label' }, 'Strength'),
            h('span', { class: 'gp-vital-val' }, v.strength.toFixed(2)),
          ]) : null,
        ]),

        // Top multiplier active
        v.topMultiplier
          ? h('div', { class: 'gp-mult' }, [
              h('span', { class: 'gp-mult-label' }, 'Boost activo:'),
              h('span', {
                class: ['gp-mult-pill', v.topMultiplier.direction === 'boost' ? 'gp-mult--boost' : 'gp-mult--suppress']
              }, `${v.topMultiplier.algo} ×${v.topMultiplier.weight}`),
            ])
          : h('div', { class: 'gp-mult-empty' }, '— sin multipliers (régimen normal)'),

        // Top Thompson UCB
        v.topThompson
          ? h('div', { class: 'gp-thompson' }, [
              h('span', { class: 'gp-mult-label' }, 'Líder UCB:'),
              h('span', { class: 'gp-thompson-algo' }, v.topThompson.algo_name),
              h('span', { class: 'gp-thompson-ucb' },
                `${(v.topThompson.ucb_score * 100).toFixed(1)}% (μ${(v.topThompson.mean * 100).toFixed(1)}%)`),
            ])
          : null,
      ]);
    };
  },
};
</script>

<style scoped>
.brain-bar {
  background: linear-gradient(180deg, #0a0d14 0%, #0f1623 100%);
  padding: 0.6rem 1rem;
  position: sticky;
  top: 0;
  z-index: 100;
  margin-bottom: 1rem;
  border-radius: 0 0 10px 10px;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.4);
  color: #e2e8f0;
  user-select: none;
}

.bb-header {
  display: flex; justify-content: space-between; align-items: center;
  padding-bottom: 0.5rem; border-bottom: 1px solid #1e2d40; margin-bottom: 0.6rem;
}
.bb-brand { display: flex; align-items: center; gap: 0.5rem; }
.bb-pulse {
  width: 10px; height: 10px; border-radius: 50%;
  animation: pulse 2s ease-in-out infinite;
}
@keyframes pulse {
  0%,100% { opacity: 1; transform: scale(1); }
  50%     { opacity: 0.4; transform: scale(0.7); }
}
.bb-label  { font-weight: 800; font-size: 0.75rem; color: #60a5fa; letter-spacing: 0.08em; }
.bb-controls { display: flex; align-items: center; gap: 0.5rem; font-size: 0.7rem; }
.bb-timestamp { color: #475569; }
.bb-refresh {
  background: transparent; border: 1px solid #1e2d40; color: #94a3b8;
  border-radius: 4px; padding: 0.15rem 0.4rem; cursor: pointer; font-size: 0.8rem;
}
.bb-refresh:hover { background: #1e2d40; color: #60a5fa; }
.bb-refresh:disabled { opacity: 0.5; cursor: not-allowed; }
.bb-spinning { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { 100% { transform: rotate(360deg); } }

/* ─── Dual game panels ────────────────────────────────────── */
.bb-games {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
}

.gp {
  background: rgba(15, 22, 35, 0.6);
  border-radius: 8px;
  padding: 0.6rem 0.85rem;
  font-size: 0.75rem;
}
.gp-header {
  display: flex; justify-content: space-between; align-items: center;
  margin-bottom: 0.35rem;
}
.gp-game {
  font-weight: 800; font-size: 0.7rem; color: #94a3b8;
  letter-spacing: 0.1em; padding: 0.2rem 0.5rem;
  background: rgba(30, 45, 64, 0.6); border-radius: 4px;
}
.gp-regime { display: flex; align-items: center; gap: 0.4rem; font-weight: 700; }
.gp-emoji  { font-size: 1.1rem; }
.gp-regime-name { font-size: 0.8rem; }

.gp-meta  { font-size: 0.65rem; color: #64748b; margin-bottom: 0.4rem; }
.gp-days  { color: #94a3b8; }

.gp-vitals {
  display: flex; gap: 1rem; margin-bottom: 0.4rem;
}
.gp-vital { display: flex; flex-direction: column; gap: 1px; }
.gp-vital-label { font-size: 0.6rem; color: #64748b; text-transform: uppercase; }
.gp-vital-val   { font-size: 0.9rem; font-weight: 700; }

.gp-mult {
  display: flex; align-items: center; gap: 0.4rem; margin-top: 0.3rem;
}
.gp-mult-empty { font-size: 0.7rem; color: #64748b; font-style: italic; }
.gp-mult-label { font-size: 0.65rem; color: #94a3b8; }
.gp-mult-pill {
  padding: 0.15rem 0.45rem; border-radius: 4px;
  font-size: 0.7rem; font-weight: 700;
}
.gp-mult--boost    { background: rgba(34, 197, 94, 0.2); color: #4ade80; }
.gp-mult--suppress { background: rgba(239, 68, 68, 0.15); color: #f87171; }

.gp-thompson {
  display: flex; align-items: center; gap: 0.4rem; margin-top: 0.3rem;
  flex-wrap: wrap;
}
.gp-thompson-algo { color: #fbbf24; font-weight: 600; font-size: 0.7rem; }
.gp-thompson-ucb  { color: #60a5fa; font-size: 0.65rem; }

/* ─── Conformal global ───────────────────────────────────── */
.bb-conformal {
  margin-top: 0.6rem; padding-top: 0.6rem;
  border-top: 1px solid #1e2d40;
  display: flex; gap: 0.5rem; align-items: center;
  font-size: 0.7rem;
}
.bb-conformal-label { color: #64748b; }
.bb-conformal-val   { color: #22c55e; font-weight: 700; }

@media (max-width: 900px) {
  .bb-games { grid-template-columns: 1fr; }
}
</style>
