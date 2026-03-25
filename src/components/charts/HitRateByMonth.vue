<template>
  <div class="chart-card glass-card">
    <h3 class="chart-card__title">📅 Hit Rate por Mes</h3>
    <p class="chart-card__subtitle">Rendimiento mensual de la estrategia</p>
    <div class="chart-card__canvas">
      <Bar :data="chartData" :options="chartOptions" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { Bar } from 'vue-chartjs';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  BarElement,
  Tooltip,
  Legend,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, BarElement, Tooltip, Legend);

const props = defineProps({
  monthlyRates: { type: Array, required: true },
});

const chartData = computed(() => {
  const maxRate = Math.max(...props.monthlyRates.map((m) => m.hitRate));

  return {
    labels: props.monthlyRates.map((m) => m.label),
    datasets: [
      {
        label: 'Hit Rate',
        data: props.monthlyRates.map((m) => +(m.hitRate * 100).toFixed(1)),
        backgroundColor: props.monthlyRates.map((m) =>
          m.hitRate === maxRate
            ? 'rgba(52, 211, 153, 0.7)'
            : 'rgba(129, 140, 248, 0.5)'
        ),
        borderColor: props.monthlyRates.map((m) =>
          m.hitRate === maxRate
            ? 'rgba(52, 211, 153, 1)'
            : 'rgba(129, 140, 248, 0.8)'
        ),
        borderWidth: 1,
        borderRadius: 6,
        hoverBackgroundColor: props.monthlyRates.map((m) =>
          m.hitRate === maxRate
            ? 'rgba(52, 211, 153, 0.9)'
            : 'rgba(129, 140, 248, 0.7)'
        ),
      },
      {
        label: 'Total Sorteos',
        data: props.monthlyRates.map((m) => m.total),
        backgroundColor: 'rgba(255, 255, 255, 0.06)',
        borderColor: 'rgba(255, 255, 255, 0.1)',
        borderWidth: 1,
        borderRadius: 6,
        yAxisID: 'y1',
      },
    ],
  };
});

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: { mode: 'index' },
  plugins: {
    legend: {
      labels: {
        color: '#94a3b8',
        font: { family: 'Inter', size: 11 },
        usePointStyle: true,
      },
    },
    tooltip: {
      backgroundColor: 'rgba(17, 24, 39, 0.95)',
      titleColor: '#f1f5f9',
      bodyColor: '#94a3b8',
      borderColor: 'rgba(255,255,255,0.1)',
      borderWidth: 1,
      cornerRadius: 8,
      padding: 12,
      callbacks: {
        label: (ctx) => {
          const idx = ctx.dataIndex;
          if (ctx.datasetIndex === 0) {
            return `Hit Rate: ${ctx.raw}%`;
          }
          return `Sorteos: ${ctx.raw}`;
        },
      },
    },
  },
  scales: {
    x: {
      ticks: { color: '#64748b', font: { family: 'Inter', size: 11 } },
      grid: { color: 'rgba(255,255,255,0.03)' },
    },
    y: {
      position: 'left',
      ticks: {
        color: '#64748b',
        font: { family: 'JetBrains Mono', size: 10 },
        callback: (v) => v + '%',
      },
      grid: { color: 'rgba(255,255,255,0.05)' },
    },
    y1: {
      position: 'right',
      ticks: {
        color: '#475569',
        font: { family: 'JetBrains Mono', size: 10 },
      },
      grid: { drawOnChartArea: false },
    },
  },
};
</script>

<style scoped>
.chart-card {
  padding: var(--space-5);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.chart-card__title {
  font-size: var(--text-base);
  font-weight: var(--font-semibold);
}

.chart-card__subtitle {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}

.chart-card__canvas {
  position: relative;
  height: 280px;
}
</style>
