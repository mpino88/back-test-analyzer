<template>
  <div class="accuracy-view">
    <div class="page-header">
      <h1 class="page-title">Accuracy Trend</h1>
      <div class="range-tabs">
        <button
          v-for="r in RANGES" :key="r.value"
          class="range-tab" :class="{ 'range-tab--active': range === r.value }"
          @click="range = r.value"
        >{{ r.label }}</button>
      </div>
    </div>

    <div v-if="loading" class="loading">Cargando datos...</div>
    <div v-else-if="error" class="error">{{ error }}</div>
    <template v-else-if="data">

      <!-- Summary cards -->
      <div class="summary-grid">
        <div class="stat-card">
          <div class="stat-card__label">Avg Accuracy</div>
          <div class="stat-card__value">{{ (avgAccuracy * 100).toFixed(2) }}%</div>
          <div class="stat-card__sub">vs baseline 10%</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__label">Total Hits Exactos</div>
          <div class="stat-card__value">{{ totalExact }}</div>
          <div class="stat-card__sub">coincidencias perfectas</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__label">Hits Parciales</div>
          <div class="stat-card__value">{{ totalPartial }}</div>
          <div class="stat-card__sub">≥2 dígitos correctos</div>
        </div>
        <div class="stat-card">
          <div class="stat-card__label">Total cartones</div>
          <div class="stat-card__value">{{ totalCartones }}</div>
          <div class="stat-card__sub">evaluados en el período</div>
        </div>
      </div>

      <!-- Chart canvas -->
      <div class="chart-container">
        <canvas ref="canvasRef"></canvas>
      </div>

      <!-- Table -->
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th>Día</th>
              <th>Cartones</th>
              <th>Avg Accuracy</th>
              <th>Hits Exactos</th>
              <th>Hits Parciales</th>
              <th>Trend</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in data.data" :key="row.day">
              <td>{{ row.day }}</td>
              <td>{{ row.total_cartones }}</td>
              <td>{{ (row.avg_accuracy * 100).toFixed(2) }}%</td>
              <td class="text-green">{{ row.total_hits_exact }}</td>
              <td class="text-orange">{{ row.total_hits_partial }}</td>
              <td>
                <span class="trend-bar">
                  <span class="trend-bar__fill" :style="`width: ${Math.min(row.avg_accuracy * 1000, 100)}%`"></span>
                </span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>

    <div v-else class="empty">Sin datos para el período seleccionado</div>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, nextTick } from 'vue';
import { Chart, registerables } from 'chart.js';
import { useAccuracy } from '../../composables/agent/useAccuracy.js';

Chart.register(...registerables);

const RANGES = [
  { value: '7d',   label: '7d' },
  { value: '30d',  label: '30d' },
  { value: '90d',  label: '90d' },
  { value: '365d', label: '1a' },
];

const { data, loading, error, range } = useAccuracy();
const canvasRef = ref(null);
let chartInstance = null;

const avgAccuracy  = computed(() => data.value?.data.length
  ? data.value.data.reduce((s, r) => s + r.avg_accuracy, 0) / data.value.data.length : 0);
const totalExact   = computed(() => data.value?.data.reduce((s, r) => s + r.total_hits_exact, 0) ?? 0);
const totalPartial = computed(() => data.value?.data.reduce((s, r) => s + r.total_hits_partial, 0) ?? 0);
const totalCartones= computed(() => data.value?.data.reduce((s, r) => s + r.total_cartones, 0) ?? 0);

function renderChart() {
  if (!canvasRef.value || !data.value?.data?.length) return;

  chartInstance?.destroy();

  const labels   = data.value.data.map(r => r.day);
  const accuracy = data.value.data.map(r => +(r.avg_accuracy * 100).toFixed(2));
  const baseline = Array(labels.length).fill(data.value.baseline_random * 100);

  chartInstance = new Chart(canvasRef.value, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          label: 'Avg Accuracy (%)',
          data: accuracy,
          borderColor: '#60a5fa',
          backgroundColor: '#60a5fa22',
          fill: true,
          tension: 0.35,
          pointRadius: 3,
        },
        {
          label: 'Baseline random (10%)',
          data: baseline,
          borderColor: '#475569',
          borderDash: [6, 4],
          pointRadius: 0,
          fill: false,
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { labels: { color: '#94a3b8', font: { size: 12 } } },
        tooltip: { mode: 'index', intersect: false },
      },
      scales: {
        x: { ticks: { color: '#64748b', maxTicksLimit: 12 }, grid: { color: '#1e2d40' } },
        y: {
          ticks: { color: '#64748b', callback: v => `${v}%` },
          grid: { color: '#1e2d40' },
          min: 0,
        },
      },
    },
  });
}

watch(data, async () => { await nextTick(); renderChart(); });
onMounted(async () => { await nextTick(); renderChart(); });
</script>

<style scoped>
.accuracy-view { max-width: 1100px; }
.page-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 1rem; }
.page-title { font-size: 1.75rem; font-weight: 700; color: #f1f5f9; margin: 0; }

.range-tabs { display: flex; gap: 0.4rem; }
.range-tab { background: #0f1623; border: 1px solid #1e2d40; color: #64748b; padding: 0.35rem 0.85rem; border-radius: 8px; font-size: 0.85rem; cursor: pointer; }
.range-tab:hover { color: #e2e8f0; }
.range-tab--active { background: #1d3a5f; border-color: #3b82f6; color: #60a5fa; }

.summary-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 1.5rem; }
.stat-card { background: #0f1623; border: 1px solid #1e2d40; border-radius: 12px; padding: 1.1rem; }
.stat-card__label { font-size: 0.72rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; }
.stat-card__value { font-size: 1.5rem; font-weight: 700; color: #f1f5f9; }
.stat-card__sub   { font-size: 0.72rem; color: #475569; margin-top: 0.2rem; }

.chart-container { background: #0f1623; border: 1px solid #1e2d40; border-radius: 12px; padding: 1.25rem; height: 320px; margin-bottom: 1.5rem; }
.chart-container canvas { height: 100% !important; }

.table-wrap { overflow-x: auto; }
.data-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; }
.data-table th { color: #64748b; font-weight: 600; text-transform: uppercase; font-size: 0.72rem; letter-spacing: 0.05em; padding: 0.6rem 0.75rem; border-bottom: 1px solid #1e2d40; text-align: left; }
.data-table td { padding: 0.6rem 0.75rem; color: #94a3b8; border-bottom: 1px solid #0f1623; }
.data-table tr:hover td { background: #0f1623; }

.trend-bar { display: block; width: 80px; height: 6px; background: #1e2d40; border-radius: 3px; overflow: hidden; }
.trend-bar__fill { display: block; height: 100%; background: #3b82f6; border-radius: 3px; transition: width 0.3s; }

.text-green  { color: #4ade80; }
.text-orange { color: #fb923c; }
.loading, .empty { color: #64748b; font-size: 0.9rem; padding: 2rem 0; }
.error { color: #f87171; font-size: 0.9rem; padding: 1rem 0; }

@media (max-width: 768px) { .summary-grid { grid-template-columns: 1fr 1fr; } }
</style>
