<template>
  <div class="app">
    <!-- Upload screen -->
    <FileDropzone
      v-if="!data"
      :error="error"
      @drop="handleDrop"
      @file-input="handleFileInput"
    />

    <!-- Dashboard -->
    <template v-else>
      <AppHeader
        :file-name="fileName"
        :summary="summary"
        @reset="reset"
      />
      <div class="app__body">
        <AppSidebar v-if="summary" :summary="summary" />
        <main class="app__main">
          <div class="charts-grid stagger-children">
            <div class="charts-grid__full">
              <HitMissTimeline
                :forensic-log="forensicLog"
                :rolling="rolling"
              />
            </div>
            <div class="charts-grid__half">
              <HitRateByMonth :monthly-rates="monthlyRates" />
            </div>
            <div class="charts-grid__half">
              <HitRateByDow :dow-rates="dowRates" />
            </div>
            <div class="charts-grid__half">
              <StreakAnalysis :streaks="streaks" />
            </div>
            <div class="charts-grid__half">
              <CandidateHeatmap :candidates="candidates" />
            </div>
          </div>
        </main>
      </div>
    </template>
  </div>
</template>

<script setup>
import { useFileLoader } from './composables/useFileLoader.js';
import { useReportData } from './composables/useReportData.js';

import FileDropzone from './components/upload/FileDropzone.vue';
import AppHeader from './components/layout/AppHeader.vue';
import AppSidebar from './components/layout/AppSidebar.vue';
import HitMissTimeline from './components/charts/HitMissTimeline.vue';
import HitRateByMonth from './components/charts/HitRateByMonth.vue';
import HitRateByDow from './components/charts/HitRateByDow.vue';
import StreakAnalysis from './components/charts/StreakAnalysis.vue';
import CandidateHeatmap from './components/charts/CandidateHeatmap.vue';

const { data, fileName, error, handleDrop, handleFileInput, reset } = useFileLoader();
const { summary, forensicLog, monthlyRates, dowRates, rolling, streaks, candidates } = useReportData(data);
</script>

<style scoped>
.app {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

.app__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.app__main {
  flex: 1;
  padding: var(--space-5);
  overflow-y: auto;
  animation: fadeIn 0.5s ease;
}

.charts-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--space-5);
}

.charts-grid__full {
  grid-column: 1 / -1;
}

.charts-grid__half {
  grid-column: span 1;
}

@media (max-width: 1024px) {
  .app__body {
    flex-direction: column;
  }

  .charts-grid {
    grid-template-columns: 1fr;
  }

  .charts-grid__half {
    grid-column: 1;
  }
}
</style>
