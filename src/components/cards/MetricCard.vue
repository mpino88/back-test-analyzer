<template>
  <div class="metric-card" :style="{ '--card-accent': accent }">
    <div class="metric-card__icon">
      <svg v-if="icon === 'target'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <circle cx="12" cy="12" r="10" /><circle cx="12" cy="12" r="6" /><circle cx="12" cy="12" r="2" />
      </svg>
      <svg v-else-if="icon === 'check'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="20 6 9 17 4 12" />
      </svg>
      <svg v-else-if="icon === 'x'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
      </svg>
      <svg v-else-if="icon === 'up'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="18 15 12 9 6 15" />
      </svg>
      <svg v-else-if="icon === 'down'" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="6 9 12 15 18 9" />
      </svg>
      <svg v-else width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <line x1="5" y1="12" x2="19" y2="12" />
      </svg>
    </div>
    <div class="metric-card__body">
      <span class="metric-card__value" :style="{ color: accent }">{{ value }}</span>
      <span class="metric-card__label">{{ label }}</span>
    </div>
  </div>
</template>

<script setup>
defineProps({
  label: { type: String, required: true },
  value: { type: String, required: true },
  icon: { type: String, default: 'target' },
  accent: { type: String, default: 'var(--accent-primary-light)' },
});
</script>

<style scoped>
.metric-card {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3) var(--space-4);
  border-radius: var(--radius-lg);
  background: var(--bg-glass);
  border: 1px solid var(--border-primary);
  transition: all var(--transition-fast);
}

.metric-card:hover {
  border-color: var(--card-accent, var(--border-secondary));
  background: rgba(255, 255, 255, 0.04);
}

.metric-card__icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border-radius: var(--radius-md);
  background: rgba(255, 255, 255, 0.03);
  color: var(--card-accent, var(--accent-primary-light));
  flex-shrink: 0;
}

.metric-card__body {
  display: flex;
  flex-direction: column;
}

.metric-card__value {
  font-size: var(--text-lg);
  font-weight: var(--font-bold);
  font-family: var(--font-mono);
  line-height: 1.2;
}

.metric-card__label {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  font-weight: var(--font-medium);
}
</style>
