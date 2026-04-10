<template>
  <div class="cartones-view">
    <div class="page-header">
      <h1 class="page-title">Cartones generados</h1>
      <button class="btn-refresh" @click="refresh">↻ Actualizar</button>
    </div>

    <!-- Filtros -->
    <div class="filters">
      <select :value="gameType" @change="setGameType($event.target.value)" class="input-select">
        <option value="pick3">Pick 3</option>
        <option value="pick4">Pick 4</option>
      </select>
      <select :value="mode" @change="setMode($event.target.value)" class="input-select">
        <option value="combined">Todos los sorteos</option>
        <option value="midday">Midday</option>
        <option value="evening">Evening</option>
      </select>
      <select v-model="status" class="input-select">
        <option value="all">Todos los estados</option>
        <option value="pending">Pendiente</option>
        <option value="hit">Hit ✅</option>
        <option value="partial">Partial 🔶</option>
        <option value="miss">Miss ❌</option>
      </select>
      <select v-model.number="limit" class="input-select">
        <option :value="20">20</option>
        <option :value="50">50</option>
        <option :value="100">100</option>
      </select>
    </div>

    <!-- Loading -->
    <div v-if="loading" class="loading">Cargando cartones...</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <!-- Grid de cartones -->
    <div v-else-if="cartones.length" class="cartones-grid">
      <div v-for="carton in cartones" :key="carton.id" class="carton-card">
        <!-- Header -->
        <div class="carton-card__header">
          <span class="carton-card__game">{{ carton.game_type?.toUpperCase() }} {{ carton.draw_type }}</span>
          <span class="carton-card__status badge" :class="`badge--${carton.result_status}`">
            {{ STATUS_LABEL[carton.result_status] ?? carton.result_status }}
          </span>
        </div>

        <!-- Meta -->
        <div class="carton-card__meta">
          <span>📅 {{ formatDate(carton.draw_date) }}</span>
          <span>⚙️ {{ carton.strategy_name ?? 'consensus' }}</span>
          <span>🎯 {{ (carton.confidence_score * 100).toFixed(0) }}% conf</span>
        </div>

        <!-- Números en grid -->
        <div class="carton-card__grid" :style="`--cols: ${gridCols(carton.carton_size)}`">
          <span
            v-for="(num, i) in parseNumbers(carton.numbers)"
            :key="i"
            class="carton-number"
          >{{ num }}</span>
        </div>

        <!-- Footer -->
        <div class="carton-card__footer">
          {{ carton.carton_size }} números
        </div>
      </div>
    </div>

    <div v-else class="empty">No hay cartones para los filtros seleccionados</div>
  </div>
</template>

<script setup>
import { useCartones } from '../../composables/agent/useCartones.js';

const STATUS_LABEL = { pending: '⏳ Pendiente', hit: '✅ Hit', partial: '🔶 Partial', miss: '❌ Miss' };

const { cartones, loading, error, gameType, mode, status, limit, refresh, setGameType, setMode } = useCartones();

function parseNumbers(raw) {
  try {
    const nums = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return nums.map(n => n.value ?? n);
  } catch { return []; }
}

function gridCols(size) {
  if (size <= 9)  return 3;
  if (size <= 16) return 4;
  return 5;
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('es-PR', { month: 'short', day: 'numeric', year: 'numeric' });
}
</script>

<style scoped>
.cartones-view { max-width: 1200px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
.page-title { font-size: 1.75rem; font-weight: 700; color: #f1f5f9; margin: 0; }
.btn-refresh { background: #1e2d40; color: #94a3b8; border: 1px solid #2d4a6b; border-radius: 8px; padding: 0.4rem 1rem; font-size: 0.85rem; cursor: pointer; }
.btn-refresh:hover { background: #2d4a6b; color: #e2e8f0; }

.filters { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
.input-select {
  background: #0f1623; border: 1px solid #1e2d40; color: #e2e8f0;
  padding: 0.45rem 0.75rem; border-radius: 8px; font-size: 0.875rem; cursor: pointer;
}

/* Grid de cartones */
.cartones-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: 1.25rem;
}

.carton-card {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
  transition: border-color 0.15s;
}
.carton-card:hover { border-color: #2d4a6b; }

.carton-card__header { display: flex; justify-content: space-between; align-items: center; }
.carton-card__game { font-size: 0.8rem; font-weight: 700; color: #60a5fa; text-transform: uppercase; letter-spacing: 0.05em; }

.carton-card__meta { display: flex; flex-wrap: wrap; gap: 0.5rem; }
.carton-card__meta span { font-size: 0.75rem; color: #64748b; }

.carton-card__grid {
  display: grid;
  grid-template-columns: repeat(var(--cols, 3), 1fr);
  gap: 0.4rem;
}

.carton-number {
  background: #1a2535;
  color: #e2e8f0;
  text-align: center;
  padding: 0.4rem 0.2rem;
  border-radius: 6px;
  font-size: 0.85rem;
  font-weight: 600;
  font-family: monospace;
  letter-spacing: 0.08em;
}

.carton-card__footer { font-size: 0.75rem; color: #475569; text-align: right; }

/* Badges */
.badge { padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
.badge--pending  { background: #1e3a5f; color: #93c5fd; }
.badge--hit      { background: #14532d; color: #4ade80; }
.badge--partial  { background: #431407; color: #fb923c; }
.badge--miss     { background: #450a0a; color: #f87171; }

.loading, .empty { color: #64748b; font-size: 0.9rem; padding: 2rem 0; }
.error { color: #f87171; font-size: 0.9rem; padding: 1rem 0; }
</style>
