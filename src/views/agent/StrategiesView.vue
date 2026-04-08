<template>
  <div class="strategies-view">
    <div class="page-header">
      <h1 class="page-title">Estrategias</h1>
      <button class="btn-refresh" @click="refresh('win_rate', 'desc')">↻ Actualizar</button>
    </div>

    <div v-if="loading" class="loading">Cargando estrategias...</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="strategies.length">
      <!-- Summary pills -->
      <div class="pills">
        <span class="pill pill--active">Active: {{ countByStatus('active') }}</span>
        <span class="pill pill--testing">Testing: {{ countByStatus('testing') }}</span>
        <span class="pill pill--retired">Retired: {{ countByStatus('retired') }}</span>
      </div>

      <!-- Strategy cards -->
      <div class="strategies-list">
        <div
          v-for="(s, i) in strategies"
          :key="s.id"
          class="strategy-card"
          :class="`strategy-card--${s.status}`"
        >
          <div class="strategy-card__rank">#{{ i + 1 }}</div>
          <div class="strategy-card__body">
            <div class="strategy-card__header">
              <span class="strategy-name">{{ s.name }}</span>
              <span class="badge" :class="`badge--${s.status}`">{{ s.status }}</span>
            </div>
            <div class="strategy-card__desc">{{ s.description ?? '—' }}</div>
            <div class="strategy-card__stats">
              <div class="stat">
                <span class="stat__label">Win Rate</span>
                <span class="stat__value" :class="winRateClass(s.win_rate)">
                  {{ (s.win_rate * 100).toFixed(1) }}%
                </span>
              </div>
              <div class="stat">
                <span class="stat__label">Tests</span>
                <span class="stat__value">{{ s.total_tests }}</span>
              </div>
              <div class="stat">
                <span class="stat__label">Algoritmo</span>
                <span class="stat__value mono">{{ s.algorithm }}</span>
              </div>
              <div class="stat">
                <span class="stat__label">Evaluado</span>
                <span class="stat__value">{{ formatDate(s.last_evaluated) }}</span>
              </div>
            </div>
            <!-- Win rate bar -->
            <div class="win-bar">
              <div class="win-bar__fill" :style="`width: ${Math.min(s.win_rate * 100 * 5, 100)}%`"></div>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="empty">Sin estrategias registradas</div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { useStrategies } from '../../composables/agent/useStrategies.js';

const { strategies, loading, error, refresh } = useStrategies();

const countByStatus = (s) => strategies.value.filter(x => x.status === s).length;

function winRateClass(wr) {
  if (wr >= 0.15) return 'text-green';
  if (wr >= 0.08) return 'text-yellow';
  return 'text-red';
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-PR', { month: 'short', day: 'numeric' });
}
</script>

<style scoped>
.strategies-view { max-width: 900px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
.page-title { font-size: 1.75rem; font-weight: 700; color: #f1f5f9; margin: 0; }
.btn-refresh { background: #1e2d40; color: #94a3b8; border: 1px solid #2d4a6b; border-radius: 8px; padding: 0.4rem 1rem; font-size: 0.85rem; cursor: pointer; }
.btn-refresh:hover { background: #2d4a6b; color: #e2e8f0; }

.pills { display: flex; gap: 0.75rem; margin-bottom: 1.5rem; }
.pill { padding: 0.3rem 0.8rem; border-radius: 999px; font-size: 0.8rem; font-weight: 600; }
.pill--active  { background: #14532d30; color: #4ade80; border: 1px solid #166534; }
.pill--testing { background: #1e3a5f30; color: #60a5fa; border: 1px solid #1d4ed8; }
.pill--retired { background: #1e293b30; color: #64748b; border: 1px solid #334155; }

.strategies-list { display: flex; flex-direction: column; gap: 0.75rem; }

.strategy-card {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  padding: 1rem 1.25rem;
  display: flex;
  gap: 1rem;
  align-items: flex-start;
}
.strategy-card--active  { border-left: 3px solid #22c55e; }
.strategy-card--testing { border-left: 3px solid #3b82f6; }
.strategy-card--retired { border-left: 3px solid #475569; opacity: 0.65; }

.strategy-card__rank { font-size: 1.25rem; font-weight: 800; color: #334155; min-width: 2rem; padding-top: 0.15rem; }
.strategy-card__body { flex: 1; min-width: 0; }
.strategy-card__header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.35rem; }
.strategy-name { font-size: 0.95rem; font-weight: 700; color: #e2e8f0; font-family: monospace; }
.strategy-card__desc { font-size: 0.8rem; color: #64748b; margin-bottom: 0.75rem; }

.strategy-card__stats { display: flex; gap: 1.5rem; flex-wrap: wrap; margin-bottom: 0.75rem; }
.stat { display: flex; flex-direction: column; gap: 0.15rem; }
.stat__label { font-size: 0.7rem; color: #475569; text-transform: uppercase; letter-spacing: 0.04em; }
.stat__value { font-size: 0.9rem; font-weight: 600; color: #94a3b8; }
.mono { font-family: monospace; font-size: 0.8rem; }

.win-bar { height: 4px; background: #1e2d40; border-radius: 2px; overflow: hidden; }
.win-bar__fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #22c55e); border-radius: 2px; transition: width 0.5s; }

.badge { padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.72rem; font-weight: 700; text-transform: uppercase; }
.badge--active  { background: #14532d; color: #4ade80; }
.badge--testing { background: #1e3a5f; color: #60a5fa; }
.badge--retired { background: #1e293b; color: #64748b; }

.text-green  { color: #4ade80 !important; }
.text-yellow { color: #facc15 !important; }
.text-red    { color: #f87171 !important; }

.loading, .empty { color: #64748b; font-size: 0.9rem; padding: 2rem 0; }
.error { color: #f87171; font-size: 0.9rem; }
</style>
