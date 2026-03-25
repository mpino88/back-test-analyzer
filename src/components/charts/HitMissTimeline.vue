<template>
  <div class="chart-card glass-card">
    <h3 class="chart-card__title">📈 Timeline de Aciertos / Fallos</h3>
    <p class="chart-card__subtitle">Hit rate móvil (ventana de 20 días) con puntos de acierto/fallo</p>
    <div class="chart-card__canvas">
      <Line :data="chartData" :options="chartOptions" />
    </div>
  </div>
</template>

<script setup>
import { computed } from 'vue';
import { Line } from 'vue-chartjs';
import {
  Chart as ChartJS,
  CategoryScale,
  LinearScale,
  PointElement,
  LineElement,
  Filler,
  Tooltip,
  Legend,
} from 'chart.js';

ChartJS.register(CategoryScale, LinearScale, PointElement, LineElement, Filler, Tooltip, Legend);

const props = defineProps({
  forensicLog: { type: Array, required: true },
  rolling: { type: Array, required: true },
});

const chartData = computed(() => {
  const labels = props.forensicLog.map((e) => e.x);
  const offset = props.forensicLog.length - props.rolling.length;

  const rollingData = new Array(offset).fill(null).concat(props.rolling.map((r) => r.rate * 100));

  const hitPoints = props.forensicLog.map((e) => (e.y_hit ? 100 : null));
  const missPoints = props.forensicLog.map((e) => (e.z_miss ? 0 : null));

  return {
    labels,
    datasets: [
      {
        label: 'Hit Rate Móvil (%)',
        data: rollingData,
        borderColor: '#818cf8',
        backgroundColor: 'rgba(129, 140, 248, 0.08)',
        borderWidth: 2,
        fill: true,
        tension: 0.3,
        pointRadius: 0,
        pointHoverRadius: 4,
        order: 1,
      },
      {
        label: 'Acierto',
        data: hitPoints,
        borderColor: 'transparent',
        backgroundColor: '#34d399',
        pointRadius: 3,
        pointHoverRadius: 5,
        showLine: false,
        order: 0,
      },
      {
        label: 'Fallo',
        data: missPoints,
        borderColor: 'transparent',
        backgroundColor: 'rgba(248, 113, 113, 0.4)',
        pointRadius: 2,
        pointHoverRadius: 4,
        showLine: false,
        order: 2,
      },
    ],
  };
});

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
  interaction: {
    mode: 'index',
    intersect: false,
  },
  plugins: {
    legend: {
      labels: {
        color: '#94a3b8',
        font: { family: 'Inter', size: 11 },
        usePointStyle: true,
        pointStyleWidth: 8,
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
      titleFont: { family: 'Inter', weight: '600' },
      bodyFont: { family: 'JetBrains Mono', size: 11 },
    },
  },
  scales: {
    x: {
      ticks: {
        color: '#64748b',
        font: { family: 'Inter', size: 10 },
        maxTicksLimit: 15,
        maxRotation: 45,
      },
      grid: { color: 'rgba(255,255,255,0.03)' },
    },
    y: {
      min: 0,
      max: 100,
      ticks: {
        color: '#64748b',
        font: { family: 'JetBrains Mono', size: 10 },
        callback: (v) => v + '%',
      },
      grid: { color: 'rgba(255,255,255,0.05)' },
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
  height: 300px;
}
</style>
