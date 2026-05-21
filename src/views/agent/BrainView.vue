<!--
═══════════════════════════════════════════════════════════════
  BrainView — Vista dedicada para CEREBRO F1 / HELIX v2
  Ruta: /agent/brain

  Muestra el estado completo del sistema nervioso central:
  BrainStatusBar dual-game + detalle de Thompson UCB por algo.
═══════════════════════════════════════════════════════════════
-->
<template>
  <div class="brain-view">
    <div class="bv-title">
      <span class="bv-icon">🧠</span>
      <div>
        <h1 class="bv-h1">Cerebro F1</h1>
        <p class="bv-sub">Sistema Nervioso Central — HELIX v2 · Pick3 + Pick4</p>
      </div>
    </div>

    <!-- BrainStatusBar montado en este scope -->
    <BrainStatusBar />

    <!-- Thompson UCB detail — pick3 -->
    <section v-if="brain && brain.pick3View.value.thompsonLeaders.length" class="bv-section">
      <h2 class="bv-section-title">📊 Thompson UCB — Pick3 Evening (du)</h2>
      <div class="bv-table-wrap">
        <table class="bv-table">
          <thead>
            <tr>
              <th>Algoritmo</th>
              <th class="ta-r">μ (mean)</th>
              <th class="ta-r">UCB score</th>
              <th class="ta-r">CI 90%</th>
              <th class="ta-r">Observaciones</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in brain.pick3View.value.thompsonLeaders" :key="a.algo_name"
                :class="{ 'bv-tr--top': a.algo_name === brain.pick3View.value.topThompson?.algo_name }">
              <td class="bv-td-name">{{ a.algo_name }}</td>
              <td class="ta-r">{{ pct(a.mean) }}</td>
              <td class="ta-r bv-ucb">{{ pct(a.ucb_score) }}</td>
              <td class="ta-r bv-ci">{{ pct(a.credible_lo) }}–{{ pct(a.credible_hi) }}</td>
              <td class="ta-r bv-n">{{ a.n_total }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Thompson UCB detail — pick4 -->
    <section v-if="brain && brain.pick4View.value.thompsonLeaders.length" class="bv-section">
      <h2 class="bv-section-title">📊 Thompson UCB — Pick4 Evening (ab)</h2>
      <div class="bv-table-wrap">
        <table class="bv-table">
          <thead>
            <tr>
              <th>Algoritmo</th>
              <th class="ta-r">μ (mean)</th>
              <th class="ta-r">UCB score</th>
              <th class="ta-r">CI 90%</th>
              <th class="ta-r">Observaciones</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="a in brain.pick4View.value.thompsonLeaders" :key="a.algo_name"
                :class="{ 'bv-tr--top': a.algo_name === brain.pick4View.value.topThompson?.algo_name }">
              <td class="bv-td-name">{{ a.algo_name }}</td>
              <td class="ta-r">{{ pct(a.mean) }}</td>
              <td class="ta-r bv-ucb">{{ pct(a.ucb_score) }}</td>
              <td class="ta-r bv-ci">{{ pct(a.credible_lo) }}–{{ pct(a.credible_hi) }}</td>
              <td class="ta-r bv-n">{{ a.n_total }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <!-- Loading / empty state -->
    <div v-if="brain && brain.f1Loading.value" class="bv-loading">
      <span class="bv-spinner">⟳</span> Cargando estado del cerebro...
    </div>
    <div v-else-if="!brain" class="bv-empty">
      Brain store no disponible — asegúrate de entrar desde /agent
    </div>
  </div>
</template>

<script setup>
import { inject } from 'vue';
import BrainStatusBar from '../../components/layout/BrainStatusBar.vue';
import { pct } from '../../utils/format.js';

const brain = inject('helixBrain', null);
</script>

<style scoped>
.brain-view {
  max-width: 1100px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: 1.5rem;
}

.bv-title {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.bv-icon  { font-size: 2.5rem; }
.bv-h1    { margin: 0; font-size: 1.5rem; font-weight: 800; color: #e2e8f0; }
.bv-sub   { margin: 0.2rem 0 0; font-size: 0.8rem; color: #64748b; }

.bv-section { display: flex; flex-direction: column; gap: 0.75rem; }
.bv-section-title {
  font-size: 0.85rem; font-weight: 700; color: #94a3b8;
  letter-spacing: 0.06em; text-transform: uppercase;
  border-bottom: 1px solid #1e2d40; padding-bottom: 0.5rem;
}

.bv-table-wrap { overflow-x: auto; }
.bv-table {
  width: 100%; border-collapse: collapse;
  font-size: 0.82rem; color: #cbd5e1;
}
.bv-table th {
  background: #0f1623; color: #64748b;
  font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
  padding: 0.5rem 0.75rem; text-align: left;
  border-bottom: 1px solid #1e2d40;
}
.bv-table td { padding: 0.45rem 0.75rem; border-bottom: 1px solid #111827; }
.bv-table tr:hover td { background: rgba(30, 45, 64, 0.4); }
.bv-tr--top td { background: rgba(96, 165, 250, 0.07); }
.bv-tr--top .bv-td-name { color: #fbbf24; font-weight: 700; }

.ta-r     { text-align: right; }
.bv-ucb   { color: #60a5fa; font-weight: 700; font-family: var(--font-mono, monospace); }
.bv-ci    { color: #475569; font-size: 0.75rem; }
.bv-n     { color: #64748b; }
.bv-td-name { font-family: var(--font-mono, monospace); font-size: 0.78rem; }

.bv-loading {
  padding: 2rem; text-align: center; color: #64748b; font-size: 0.9rem;
}
.bv-spinner { display: inline-block; animation: spin 1s linear infinite; margin-right: 0.5rem; }
@keyframes spin { 100% { transform: rotate(360deg); } }

.bv-empty {
  padding: 3rem; text-align: center;
  color: #475569; font-size: 0.85rem;
  background: #0f1623; border-radius: 10px;
  border: 1px solid #1e2d40;
}
</style>
