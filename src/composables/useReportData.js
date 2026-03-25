import { computed } from 'vue';
import {
  computeSummary,
  hitRateByMonth,
  hitRateByDow,
  rollingHitRate,
  streakDistribution,
  candidateFrequency,
} from '../utils/dataTransformers.js';

/**
 * Composable that processes raw report data into chart-ready computed properties.
 * @param {import('vue').Ref} reportData - Reactive ref containing the parsed JSON report
 */
export function useReportData(reportData) {
  const summary = computed(() => {
    if (!reportData.value) return null;
    return computeSummary(reportData.value);
  });

  const forensicLog = computed(() => {
    return reportData.value?.forensicLog || [];
  });

  const monthlyRates = computed(() => {
    return hitRateByMonth(forensicLog.value);
  });

  const dowRates = computed(() => {
    return hitRateByDow(forensicLog.value);
  });

  const rolling = computed(() => {
    return rollingHitRate(forensicLog.value, 20);
  });

  const streaks = computed(() => {
    return streakDistribution(forensicLog.value);
  });

  const candidates = computed(() => {
    return candidateFrequency(forensicLog.value);
  });

  return {
    summary,
    forensicLog,
    monthlyRates,
    dowRates,
    rolling,
    streaks,
    candidates,
  };
}
