<template>
  <div class="chart-card glass-card">
    <h3 class="chart-card__title">🎯 Frecuencia de Candidatos</h3>
    <p class="chart-card__subtitle">Cuántas veces aparece cada número como candidato vs. como ganador</p>
    <div class="heatmap-controls">
      <button
        :class="['heatmap-btn', { active: viewMode === 'top' }]"
        @click="viewMode = 'top'"
      >
        Top 30
      </button>
      <button
        :class="['heatmap-btn', { active: viewMode === 'all' }]"
        @click="viewMode = 'all'"
      >
        Todos
      </button>
    </div>
    <div class="chart-card__canvas">
      <Bar :data="chartData" :options="chartOptions" />
    </div>
  </div>
</template>

<script setup>
import { computed, ref } from 'vue';
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
  candidates: { type: Array, required: true },
});

const viewMode = ref('top');

const filteredCandidates = computed(() => {
  const sorted = [...props.candidates].sort((a, b) => b.candidateCount - a.candidateCount);
  return viewMode.value === 'top' ? sorted.slice(0, 30) : sorted;
});

const chartData = computed(() => {
  const data = filteredCandidates.value;

  return {
    labels: data.map((c) => '#' + c.number),
    datasets: [
      {
        label: 'Apariciones como Candidato',
        data: data.map((c) => c.candidateCount),
        backgroundColor: 'rgba(129, 140, 248, 0.45)',
        borderColor: 'rgba(129, 140, 248, 0.7)',
        borderWidth: 1,
        borderRadius: 4,
      },
      {
        label: 'Veces Ganador',
        data: data.map((c) => c.winCount),
        backgroundColor: 'rgba(251, 191, 36, 0.5)',
        borderColor: 'rgba(251, 191, 36, 0.8)',
        borderWidth: 1,
        borderRadius: 4,
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
        afterBody: (items) => {
          const idx = items[0]?.dataIndex;
          if (idx == null) return '';
          const c = filteredCandidates.value[idx];
          const ratio = c.candidateCount > 0
            ? ((c.winCount / c.candidateCount) * 100).toFixed(1)
            : '0.0';
          return `Ratio Win/Candidato: ${ratio}%`;
        },
      },
    },
  },
  scales: {
    x: {
      ticks: {
        color: '#64748b',
        font: { family: 'JetBrains Mono', size: 9 },
        maxRotation: 90,
        minRotation: 45,
      },
      grid: { color: 'rgba(255,255,255,0.03)' },
    },
    y: {
      ticks: {
        color: '#64748b',
        font: { family: 'JetBrains Mono', size: 10 },
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

.heatmap-controls {
  display: flex;
  gap: var(--space-2);
}

.heatmap-btn {
  padding: var(--space-1) var(--space-3);
  border-radius: var(--radius-md);
  border: 1px solid var(--border-secondary);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--text-xs);
  font-weight: var(--font-medium);
  cursor: pointer;
  transition: all var(--transition-fast);
}

.heatmap-btn:hover {
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-primary);
}

.heatmap-btn.active {
  background: var(--accent-glow);
  border-color: var(--border-accent);
  color: var(--accent-primary-light);
}

.chart-card__canvas {
  position: relative;
  height: 320px;
}
</style>
