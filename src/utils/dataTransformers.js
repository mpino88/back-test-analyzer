/**
 * Pure data transformation functions for the backtest report.
 * No side effects, no Vue reactivity — just plain functions.
 */

const MONTH_LABELS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const DOW_LABELS = ['Dom', 'Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb'];

/**
 * Parse date string "MM/DD/YY" into a Date object.
 */
export function parseDate(dateStr) {
  const [month, day, year] = dateStr.split('/').map(Number);
  return new Date(2000 + year, month - 1, day);
}

/**
 * Calculate hit rate grouped by month from forensic log entries.
 * @returns {{ label: string, hits: number, total: number, hitRate: number }[]}
 */
export function hitRateByMonth(forensicLog) {
  const buckets = MONTH_LABELS.map((label) => ({ label, hits: 0, total: 0, hitRate: 0 }));

  for (const entry of forensicLog) {
    const date = parseDate(entry.x);
    const monthIdx = date.getMonth();
    buckets[monthIdx].total++;
    if (entry.y_hit) buckets[monthIdx].hits++;
  }

  for (const bucket of buckets) {
    bucket.hitRate = bucket.total > 0 ? bucket.hits / bucket.total : 0;
  }

  return buckets.filter((b) => b.total > 0);
}

/**
 * Calculate hit rate grouped by day of week.
 * @returns {{ label: string, hits: number, total: number, hitRate: number }[]}
 */
export function hitRateByDow(forensicLog) {
  const buckets = DOW_LABELS.map((label) => ({ label, hits: 0, total: 0, hitRate: 0 }));

  for (const entry of forensicLog) {
    const date = parseDate(entry.x);
    const dow = date.getDay();
    buckets[dow].total++;
    if (entry.y_hit) buckets[dow].hits++;
  }

  for (const bucket of buckets) {
    bucket.hitRate = bucket.total > 0 ? bucket.hits / bucket.total : 0;
  }

  return buckets.filter((b) => b.total > 0);
}

/**
 * Compute rolling hit rate over a window of N entries.
 * @returns {{ date: string, rate: number }[]}
 */
export function rollingHitRate(forensicLog, windowSize = 20) {
  const results = [];

  for (let i = windowSize - 1; i < forensicLog.length; i++) {
    const window = forensicLog.slice(i - windowSize + 1, i + 1);
    const hits = window.filter((e) => e.y_hit).length;
    results.push({
      date: forensicLog[i].x,
      rate: hits / windowSize,
    });
  }

  return results;
}

/**
 * Compute streaks of consecutive hits and misses.
 * @returns {{ type: 'hit' | 'miss', length: number, startDate: string, endDate: string }[]}
 */
export function computeStreaks(forensicLog) {
  if (forensicLog.length === 0) return [];

  const streaks = [];
  let currentType = forensicLog[0].y_hit ? 'hit' : 'miss';
  let currentLength = 1;
  let startDate = forensicLog[0].x;

  for (let i = 1; i < forensicLog.length; i++) {
    const entryType = forensicLog[i].y_hit ? 'hit' : 'miss';

    if (entryType === currentType) {
      currentLength++;
    } else {
      streaks.push({
        type: currentType,
        length: currentLength,
        startDate,
        endDate: forensicLog[i - 1].x,
      });
      currentType = entryType;
      currentLength = 1;
      startDate = forensicLog[i].x;
    }
  }

  streaks.push({
    type: currentType,
    length: currentLength,
    startDate,
    endDate: forensicLog[forensicLog.length - 1].x,
  });

  return streaks;
}

/**
 * Build streak-length distribution.
 * @returns {{ hitDistribution: { length: number, count: number }[], missDistribution: { length: number, count: number }[] }}
 */
export function streakDistribution(forensicLog) {
  const streaks = computeStreaks(forensicLog);
  const hitMap = {};
  const missMap = {};

  for (const s of streaks) {
    const map = s.type === 'hit' ? hitMap : missMap;
    map[s.length] = (map[s.length] || 0) + 1;
  }

  const toArray = (map) =>
    Object.entries(map)
      .map(([length, count]) => ({ length: Number(length), count }))
      .sort((a, b) => a.length - b.length);

  return {
    hitDistribution: toArray(hitMap),
    missDistribution: toArray(missMap),
  };
}

/**
 * Count how often each candidate number appears across all forensic log entries.
 * Also counts how often each number was a winning number.
 * @returns {{ number: number, candidateCount: number, winCount: number }[]}
 */
export function candidateFrequency(forensicLog) {
  const candidateMap = {};
  const winMap = {};

  for (const entry of forensicLog) {
    for (const c of entry.candidates) {
      candidateMap[c] = (candidateMap[c] || 0) + 1;
    }
    for (const w of entry.winning) {
      winMap[w] = (winMap[w] || 0) + 1;
    }
  }

  const allNumbers = new Set([
    ...Object.keys(candidateMap).map(Number),
    ...Object.keys(winMap).map(Number),
  ]);

  return [...allNumbers]
    .sort((a, b) => a - b)
    .map((num) => ({
      number: num,
      candidateCount: candidateMap[num] || 0,
      winCount: winMap[num] || 0,
    }));
}

/**
 * Compute summary metrics from the report data.
 */
export function computeSummary(report) {
  const subset = report.topSubsets?.[0];
  if (!subset) return null;

  return {
    label: subset.label,
    hits: subset.hits,
    misses: subset.misses,
    skipped: subset.skipped,
    total: subset.hits + subset.misses + subset.skipped,
    hitRate: subset.hitRate,
    conditions: subset.conditions,
    startDate: report.startDate,
    endDate: report.endDate,
    datesAnalyzed: report.datesAnalyzed,
    topN: report.topN,
    strategyCount: report.strategyCount,
    contexts: report.contexts,
  };
}
