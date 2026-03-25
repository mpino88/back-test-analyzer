<template>
  <div class="chart-card glass-card">
    <h3 class="chart-card__title">🔥 Análisis de Rachas</h3>
    <p class="chart-card__subtitle">Distribución de rachas consecutivas de aciertos y fallos</p>
    <div class="chart-card__canvas">
      <Bar :data="chartData" :options="chartOptions" />
    </div>
    <div class="streak-summary">
      <div class="streak-stat">
        <span class="streak-stat__label">Racha max. aciertos</span>
        <span class="streak-stat__value streak-stat__value--hit">{{ maxHitStreak }}</span>
      </div>
      <div class="streak-stat">
        <span class="streak-stat__label">Racha max. fallos</span>
        <span class="streak-stat__value streak-stat__value--miss">{{ maxMissStreak }}</span>
      </div>
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
  streaks: { type: Object, required: true },
});

const maxHitStreak = computed(() => {
  if (!props.streaks.hitDistribution?.length) return 0;
  return Math.max(...props.streaks.hitDistribution.map((s) => s.length));
});

const maxMissStreak = computed(() => {
  if (!props.streaks.missDistribution?.length) return 0;
  return Math.max(...props.streaks.missDistribution.map((s) => s.length));
});

const chartData = computed(() => {
  const allLengths = new Set();
  for (const s of props.streaks.hitDistribution || []) allLengths.add(s.length);
  for (const s of props.streaks.missDistribution || []) allLengths.add(s.length);
  const labels = [...allLengths].sort((a, b) => a - b);

  const hitMap = {};
  const missMap = {};
  for (const s of props.streaks.hitDistribution || []) hitMap[s.length] = s.count;
  for (const s of props.streaks.missDistribution || []) missMap[s.length] = s.count;

  return {
    labels: labels.map((l) => l + ' días'),
    datasets: [
      {
        label: 'Rachas de Aciertos',
        data: labels.map((l) => hitMap[l] || 0),
        backgroundColor: 'rgba(52, 211, 153, 0.5)',
        borderColor: '#34d399',
        borderWidth: 1,
        borderRadius: 4,
      },
      {
        label: 'Rachas de Fallos',
        data: labels.map((l) => missMap[l] || 0),
        backgroundColor: 'rgba(248, 113, 113, 0.4)',
        borderColor: '#f87171',
        borderWidth: 1,
        borderRadius: 4,
      },
    ],
  };
});

const chartOptions = {
  responsive: true,
  maintainAspectRatio: false,
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
    },
  },
  scales: {
    x: {
      ticks: { color: '#64748b', font: { family: 'Inter', size: 11 } },
      grid: { color: 'rgba(255,255,255,0.03)' },
    },
    y: {
      ticks: {
        color: '#64748b',
        font: { family: 'JetBrains Mono', size: 10 },
        stepSize: 1,
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
  height: 260px;
}

.streak-summary {
  display: flex;
  gap: var(--space-6);
  padding-top: var(--space-2);
  border-top: 1px solid var(--border-primary);
}

.streak-stat {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.streak-stat__label {
  font-size: var(--text-xs);
  color: var(--text-secondary);
}

.streak-stat__value {
  font-size: var(--text-sm);
  font-weight: var(--font-bold);
  font-family: var(--font-mono);
}

.streak-stat__value--hit {
  color: var(--color-hit);
}

.streak-stat__value--miss {
  color: var(--color-miss);
}
</style>
