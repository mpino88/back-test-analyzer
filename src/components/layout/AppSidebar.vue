<template>
  <aside class="sidebar">
    <div class="sidebar__section">
      <h3 class="sidebar__title">Resumen General</h3>
      <div class="sidebar__metrics stagger-children">
        <MetricCard
          label="Hit Rate"
          :value="formatPercent(summary.hitRate)"
          icon="target"
          :accent="hitRateColor"
        />
        <MetricCard
          label="Aciertos"
          :value="String(summary.hits)"
          icon="check"
          accent="var(--color-hit)"
        />
        <MetricCard
          label="Fallos"
          :value="String(summary.misses)"
          icon="x"
          accent="var(--color-miss)"
        />
        <MetricCard
          label="Tendencia"
          :value="trendLabel"
          :icon="trendIcon"
          :accent="trendColor"
        />
      </div>
    </div>

    <div class="sidebar__section">
      <h3 class="sidebar__title">Condiciones</h3>
      <ConditionsCard :conditions="summary.conditions" />
    </div>

    <div class="sidebar__section">
      <h3 class="sidebar__title">Contexto</h3>
      <div class="sidebar__info">
        <div class="info-row">
          <span class="info-row__label">Estrategia</span>
          <span class="info-row__value">{{ summary.label }}</span>
        </div>
        <div class="info-row">
          <span class="info-row__label">Top N</span>
          <span class="info-row__value">{{ summary.topN }}</span>
        </div>
        <div class="info-row">
          <span class="info-row__label">Estrategias</span>
          <span class="info-row__value">{{ summary.strategyCount }}</span>
        </div>
      </div>
    </div>
  </aside>
</template>

<script setup>
import { computed } from 'vue';
import MetricCard from '../cards/MetricCard.vue';
import ConditionsCard from '../cards/ConditionsCard.vue';

const props = defineProps({
  summary: { type: Object, required: true },
});

function formatPercent(value) {
  return (value * 100).toFixed(1) + '%';
}

const hitRateColor = computed(() => {
  const rate = props.summary.hitRate;
  if (rate >= 0.4) return 'var(--color-hit)';
  if (rate >= 0.25) return 'var(--color-warning)';
  return 'var(--color-miss)';
});

const trendLabel = computed(() => {
  const map = { stable: 'Estable', rising: 'Subiendo', falling: 'Bajando' };
  return map[props.summary.conditions?.trend] || props.summary.conditions?.trend || '—';
});

const trendIcon = computed(() => {
  const map = { stable: 'minus', rising: 'up', falling: 'down' };
  return map[props.summary.conditions?.trend] || 'minus';
});

const trendColor = computed(() => {
  const map = {
    stable: 'var(--color-info)',
    rising: 'var(--color-hit)',
    falling: 'var(--color-miss)',
  };
  return map[props.summary.conditions?.trend] || 'var(--text-secondary)';
});
</script>

<style scoped>
.sidebar {
  width: var(--sidebar-width);
  min-width: var(--sidebar-width);
  padding: var(--space-5);
  border-right: 1px solid var(--border-primary);
  background: var(--bg-card);
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-6);
  animation: fadeIn 0.4s ease;
}

.sidebar__section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.sidebar__title {
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--text-tertiary);
}

.sidebar__metrics {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.sidebar__info {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.info-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--bg-glass);
}

.info-row__label {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.info-row__value {
  font-size: var(--text-sm);
  font-weight: var(--font-semibold);
  color: var(--text-primary);
  font-family: var(--font-mono);
}

@media (max-width: 1024px) {
  .sidebar {
    width: 100%;
    min-width: 100%;
    border-right: none;
    border-bottom: 1px solid var(--border-primary);
    flex-direction: row;
    flex-wrap: wrap;
    overflow-y: visible;
  }
  .sidebar__section {
    flex: 1;
    min-width: 250px;
  }
}
</style>
