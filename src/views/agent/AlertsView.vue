<template>
  <div class="alerts-view">
    <div class="page-header">
      <h1 class="page-title">Alertas proactivas</h1>
      <div class="header-actions">
        <label class="toggle-label">
          <input v-model="showAcked" type="checkbox" @change="refresh" />
          Mostrar reconocidas
        </label>
        <button class="btn-refresh" @click="refresh">↻ Actualizar</button>
      </div>
    </div>

    <div v-if="loading" class="loading">Cargando alertas...</div>
    <div v-else-if="error" class="error">{{ error }}</div>

    <template v-else-if="alerts.length">
      <div class="alerts-list">
        <div
          v-for="alert in alerts"
          :key="alert.id"
          class="alert-card"
          :class="`alert-card--${alert.priority}`"
        >
          <div class="alert-card__left">
            <span class="alert-priority-dot" :class="`dot--${alert.priority}`"></span>
          </div>
          <div class="alert-card__body">
            <div class="alert-card__header">
              <span class="alert-type">{{ ALERT_ICONS[alert.alert_type] ?? '⚠️' }} {{ alert.alert_type }}</span>
              <div class="alert-card__meta">
                <span class="badge" :class="`badge--${alert.priority}`">{{ alert.priority }}</span>
                <span v-if="alert.game_type" class="badge badge--game">{{ alert.game_type }}</span>
              </div>
            </div>
            <p class="alert-message">{{ alert.message }}</p>
            <div class="alert-card__footer">
              <span class="alert-date">{{ formatDate(alert.created_at) }}</span>
              <button
                v-if="!alert.acknowledged"
                class="btn-ack"
                @click="acknowledge(alert.id)"
              >✓ Reconocer</button>
              <span v-else class="acked-label">✓ Reconocida</span>
            </div>
          </div>
        </div>
      </div>
    </template>

    <div v-else class="empty">
      {{ showAcked ? 'No hay alertas' : '✅ Sin alertas pendientes' }}
    </div>
  </div>
</template>

<script setup>
import { useAlerts } from '../../composables/agent/useAlerts.js';

const ALERT_ICONS = {
  anomaly: '🔍', streak: '📉', overdue: '⏰',
  drift: '🌊', system: '⚙️', low_data: '📊',
};

const { alerts, loading, error, showAcked, refresh, acknowledge } = useAlerts();

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-PR', { dateStyle: 'short', timeStyle: 'short' });
}
</script>

<style scoped>
.alerts-view { max-width: 860px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem; }
.page-title { font-size: 1.75rem; font-weight: 700; color: #f1f5f9; margin: 0; }
.header-actions { display: flex; align-items: center; gap: 1rem; }
.toggle-label { display: flex; align-items: center; gap: 0.4rem; font-size: 0.85rem; color: #64748b; cursor: pointer; }
.toggle-label input { accent-color: #3b82f6; }
.btn-refresh { background: #1e2d40; color: #94a3b8; border: 1px solid #2d4a6b; border-radius: 8px; padding: 0.4rem 1rem; font-size: 0.85rem; cursor: pointer; }
.btn-refresh:hover { background: #2d4a6b; color: #e2e8f0; }

.alerts-list { display: flex; flex-direction: column; gap: 0.75rem; }

.alert-card {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  padding: 1rem 1.25rem;
  display: flex;
  gap: 0.75rem;
}
.alert-card--critical { border-color: #450a0a; background: #1a0505; }
.alert-card--high     { border-color: #431407; }
.alert-card--medium   { border-color: #451a03; }
.alert-card--low      { border-color: #1e293b; }

.alert-card__left { padding-top: 0.25rem; }
.alert-priority-dot { display: block; width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
.dot--critical { background: #ef4444; box-shadow: 0 0 8px #ef4444; }
.dot--high     { background: #f97316; }
.dot--medium   { background: #eab308; }
.dot--low      { background: #3b82f6; }

.alert-card__body { flex: 1; min-width: 0; }
.alert-card__header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.5rem; gap: 0.5rem; flex-wrap: wrap; }
.alert-type { font-size: 0.85rem; font-weight: 700; color: #e2e8f0; text-transform: capitalize; }
.alert-card__meta { display: flex; gap: 0.4rem; }

.alert-message { font-size: 0.875rem; color: #94a3b8; margin: 0 0 0.75rem; line-height: 1.5; }

.alert-card__footer { display: flex; justify-content: space-between; align-items: center; }
.alert-date { font-size: 0.75rem; color: #475569; }
.btn-ack {
  background: transparent; border: 1px solid #334155; color: #64748b;
  border-radius: 6px; padding: 0.25rem 0.75rem; font-size: 0.78rem; cursor: pointer;
  transition: all 0.15s;
}
.btn-ack:hover { background: #1e2d40; color: #e2e8f0; border-color: #60a5fa; }
.acked-label { font-size: 0.75rem; color: #4ade80; }

.badge { padding: 0.15rem 0.55rem; border-radius: 999px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; }
.badge--critical { background: #450a0a; color: #f87171; }
.badge--high     { background: #431407; color: #fb923c; }
.badge--medium   { background: #451a03; color: #fbbf24; }
.badge--low      { background: #1e3a5f; color: #60a5fa; }
.badge--game     { background: #1e293b; color: #94a3b8; }

.loading, .empty { color: #64748b; font-size: 0.9rem; padding: 2rem 0; }
.error { color: #f87171; font-size: 0.9rem; }
</style>
