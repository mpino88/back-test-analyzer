<template>
  <header class="app-header">
    <div class="app-header__brand">
      <div class="app-header__logo">
        <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 3v18h18" />
          <path d="M7 16l4-8 4 4 4-12" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </div>
      <div>
        <h1 class="app-header__title">Backtest Analyzer</h1>
        <p class="app-header__subtitle">{{ fileName }}</p>
      </div>
    </div>
    <div class="app-header__meta">
      <div v-if="summary" class="app-header__badges">
        <span class="badge badge--accent">
          {{ summary.startDate }} → {{ summary.endDate }}
        </span>
        <span class="badge badge--info">
          {{ summary.datesAnalyzed }} días
        </span>
        <span class="badge badge--secondary">
          {{ summary.contexts?.[0]?.mapSource?.toUpperCase() }} · {{ summary.contexts?.[0]?.period?.toUpperCase() }}
        </span>
      </div>
      <button class="app-header__reset" @click="$emit('reset')" title="Cargar otro archivo">
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M3 12a9 9 0 019-9 9.75 9.75 0 016.74 2.74L21 8" />
          <path d="M21 3v5h-5" />
          <path d="M21 12a9 9 0 01-9 9 9.75 9.75 0 01-6.74-2.74L3 16" />
          <path d="M8 16H3v5" />
        </svg>
      </button>
    </div>
  </header>
</template>

<script setup>
defineProps({
  fileName: { type: String, default: '' },
  summary: { type: Object, default: null },
});

defineEmits(['reset']);
</script>

<style scoped>
.app-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: var(--space-4) var(--space-6);
  background: var(--bg-card);
  backdrop-filter: blur(12px);
  border-bottom: 1px solid var(--border-primary);
  height: var(--header-height);
  gap: var(--space-4);
  animation: fadeIn 0.4s ease;
}

.app-header__brand {
  display: flex;
  align-items: center;
  gap: var(--space-3);
}

.app-header__logo {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  background: linear-gradient(135deg, var(--accent-primary) 0%, var(--accent-secondary) 100%);
  border-radius: var(--radius-lg);
  color: white;
  flex-shrink: 0;
}

.app-header__title {
  font-size: var(--text-lg);
  font-weight: var(--font-bold);
  background: linear-gradient(135deg, var(--text-primary) 0%, var(--accent-primary-light) 100%);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}

.app-header__subtitle {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  font-family: var(--font-mono);
}

.app-header__meta {
  display: flex;
  align-items: center;
  gap: var(--space-4);
}

.app-header__badges {
  display: flex;
  gap: var(--space-2);
  flex-wrap: wrap;
}

.badge {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-full);
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  font-family: var(--font-mono);
  white-space: nowrap;
}

.badge--accent {
  background: var(--accent-glow);
  color: var(--accent-primary-light);
  border: 1px solid var(--border-accent);
}

.badge--info {
  background: rgba(56, 189, 248, 0.1);
  color: var(--color-info);
  border: 1px solid rgba(56, 189, 248, 0.2);
}

.badge--secondary {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-secondary);
  border: 1px solid var(--border-primary);
}

.app-header__reset {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.app-header__reset:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
  border-color: var(--accent-primary);
}

@media (max-width: 768px) {
  .app-header {
    flex-direction: column;
    height: auto;
    gap: var(--space-3);
    padding: var(--space-3) var(--space-4);
  }
  .app-header__badges {
    justify-content: center;
  }
}
</style>
