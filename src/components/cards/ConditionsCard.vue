<template>
  <div class="conditions-card">
    <div class="conditions-card__group">
      <span class="conditions-card__label">Mejores Días</span>
      <div class="conditions-card__tags">
        <span
          v-for="dow in conditions.bestDows"
          :key="dow.label"
          class="tag tag--hit"
        >
          {{ dow.label }} · {{ (dow.hitRate * 100).toFixed(1) }}%
        </span>
      </div>
    </div>

    <div class="conditions-card__group">
      <span class="conditions-card__label">Mejores Meses</span>
      <div class="conditions-card__tags">
        <span
          v-for="month in conditions.bestMonths"
          :key="month.label"
          class="tag tag--accent"
        >
          {{ month.label }} · {{ (month.hitRate * 100).toFixed(1) }}%
        </span>
      </div>
    </div>

    <div class="conditions-card__stats">
      <div class="stat-row">
        <span class="stat-row__label">Intervalo promedio</span>
        <span class="stat-row__value">{{ conditions.avgInterval }} ± {{ conditions.stdInterval }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-row__label">Banda pico</span>
        <span class="stat-row__value">{{ conditions.peakBand }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-row__label">IQR (P25–P75)</span>
        <span class="stat-row__value">{{ conditions.p25 }} – {{ conditions.p75 }}</span>
      </div>
      <div class="stat-row">
        <span class="stat-row__label">Hit → Hit</span>
        <span class="stat-row__value hit-value">{{ (conditions.hitAfterHit * 100).toFixed(1) }}%</span>
      </div>
      <div class="stat-row">
        <span class="stat-row__label">Miss → Hit</span>
        <span class="stat-row__value">{{ (conditions.hitAfterMiss * 100).toFixed(1) }}%</span>
      </div>
      <div class="stat-row">
        <span class="stat-row__label">Hit Rate Reciente</span>
        <span class="stat-row__value">{{ (conditions.recentHitRate * 100).toFixed(1) }}%</span>
      </div>
    </div>
  </div>
</template>

<script setup>
defineProps({
  conditions: { type: Object, required: true },
});
</script>

<style scoped>
.conditions-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.conditions-card__group {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.conditions-card__label {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  font-weight: var(--font-medium);
}

.conditions-card__tags {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.tag {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  font-family: var(--font-mono);
}

.tag--hit {
  background: var(--color-hit-bg);
  color: var(--color-hit);
  border: 1px solid var(--color-hit-glow);
}

.tag--accent {
  background: var(--accent-glow);
  color: var(--accent-primary-light);
  border: 1px solid var(--border-accent);
}

.conditions-card__stats {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.stat-row {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: var(--space-1) var(--space-2);
  border-radius: var(--radius-sm);
}

.stat-row:hover {
  background: var(--bg-glass);
}

.stat-row__label {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.stat-row__value {
  font-size: var(--text-xs);
  font-weight: var(--font-semibold);
  color: var(--text-primary);
  font-family: var(--font-mono);
}

.hit-value {
  color: var(--color-hit);
}
</style>
