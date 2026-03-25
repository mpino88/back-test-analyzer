<template>
  <div class="chart-card glass-card">
    <h3 class="chart-card__title">📆 Hit Rate por Día de Semana</h3>
    <p class="chart-card__subtitle">Rendimiento según el día de la semana</p>
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
  dowRates: { type: Array, required: true },
});

const chartData = computed(() => {
  const maxRate = Math.max(...props.dowRates.map((d) => d.hitRate));

  const colors = props.dowRates.map((d) => {
    if (d.hitRate === maxRate) return { bg: 'rgba(52, 211, 153, 0.6)', border: '#34d399' };
    if (d.hitRate >= maxRate * 0.9) return { bg: 'rgba(52, 211, 153, 0.35)', border: 'rgba(52, 211, 153, 0.7)' };
    return { bg: 'rgba(129, 140, 248, 0.4)', border: 'rgba(129, 140, 248, 0.7)' };
  });

  return {
    labels: props.dowRates.map((d) => d.label),
    datasets: [
      {
        label: 'Hit Rate',
        data: props.dowRates.map((d) => +(d.hitRate * 100).toFixed(1)),
        backgroundColor: colors.map((c) => c.bg),
        borderColor: colors.map((c) => c.border),
        borderWidth: 1,
        borderRadius: 6,
      },
    ],
  };
});

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  indexAxis: 'y',
  plugins: {
    legend: { display: false },
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
          const dow = props.dowRates[ctx.dataIndex];
          return [`Hit Rate: ${ctx.raw}%`, `Aciertos: ${dow.hits}/${dow.total}`];
        },
      },
    },
  },
  scales: {
    x: {
      ticks: {
        color: '#64748b',
        font: { family: 'JetBrains Mono', size: 10 },
        callback: (v) => v + '%',
      },
      grid: { color: 'rgba(255,255,255,0.05)' },
    },
    y: {
      ticks: {
        color: '#94a3b8',
        font: { family: 'Inter', size: 12, weight: '500' },
      },
      grid: { display: false },
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
