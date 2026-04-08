<template>
  <div class="subset-card card">
    <div class="subset-card__header">
      <h3 class="subset-card__title">{{ subset.label }}</h3>
      <span class="badge" :class="hitRateClass">{{ formattedHitRate }}</span>
    </div>
    
    <div class="subset-card__stats">
      <div class="stat-item">
        <span class="stat-item__value text-success">{{ subset.hits }}</span>
        <span class="stat-item__label">Hits</span>
      </div>
      <div class="stat-item">
        <span class="stat-item__value text-danger">{{ subset.misses }}</span>
        <span class="stat-item__label">Misses</span>
      </div>
      <div class="stat-item">
        <span class="stat-item__value text-muted">{{ total }}</span>
        <span class="stat-item__label">Total</span>
      </div>
    </div>

    <div v-if="hasConditions" class="subset-card__details">
      <h4 class="details-title">Conditions</h4>
      <ul class="details-list">
        <li v-if="subset.conditions.avgInterval">
          <span class="detail-label">Avg Interval:</span>
          <span class="detail-value">{{ subset.conditions.avgInterval.toFixed(1) }}</span>
        </li>
        <li v-if="subset.conditions.peakBand">
          <span class="detail-label">Peak Band:</span>
          <span class="detail-value">{{ subset.conditions.peakBand }}</span>
        </li>
        <li v-if="subset.conditions.trend">
          <span class="detail-label">Trend:</span>
          <span class="detail-value capitalize">{{ subset.conditions.trend }}</span>
        </li>
      </ul>
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
  subset: {
    type: Object,
    required: true,
  },
});

const total = computed(() => {
  return props.subset.hits + props.subset.misses + (props.subset.skipped || 0);
});

const formattedHitRate = computed(() => {
  return (props.subset.hitRate * 100).toFixed(2) + '%';
});

const hitRateClass = computed(() => {
  if (props.subset.hitRate > 0.15) return 'badge--success';
  if (props.subset.hitRate > 0.1) return 'badge--warning';
  return 'badge--danger';
});

const hasConditions = computed(() => {
  return props.subset.conditions && Object.keys(props.subset.conditions).length > 0;
});
</script>

<style scoped>
.subset-card {
  padding: var(--space-4);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  height: 100%;
}

.subset-card__header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.subset-card__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
  color: var(--text-primary);
}

.subset-card__stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: var(--space-2);
  padding-bottom: var(--space-3);
  border-bottom: 1px solid var(--border-color);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
}

.stat-item__value {
  font-size: var(--text-xl);
  font-weight: 700;
  line-height: 1.2;
}

.stat-item__label {
  font-size: var(--text-xs);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.subset-card__details {
  flex: 1;
}

.details-title {
  margin: 0 0 var(--space-2) 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
}

.details-list {
  list-style: none;
  padding: 0;
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.details-list li {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-sm);
}

.detail-label {
  color: var(--text-secondary);
}

.detail-value {
  color: var(--text-primary);
  font-family: var(--font-mono);
}

.capitalize {
  text-transform: capitalize;
}
</style>
