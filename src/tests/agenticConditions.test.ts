// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: AgenticProgressiveEngine core logic
//
// Tests the pure-math internals that drive PLAY/WAIT/ALERT signals:
//   1. Welford online mean/variance algorithm
//   2. Play signal threshold logic (PLAY / WAIT / ALERT)
//   3. DoW and month best-bias detection (≥ 1.2× global)
//   4. Transition rates (hit-after-hit, hit-after-miss)
//   5. Clustering logic (HOT / COLD / NEUTRAL)
//   6. Trend detection (UP / DOWN / STABLE ±0.05 threshold)
//
// Self-contained: mirrors the logic from AgenticProgressiveEngine.ts
// without importing DB/logger dependencies.
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Welford online algorithm (mirror of AgenticProgressiveEngine.ts) ──
interface WelfordState { n: number; mean: number; M2: number; }

function welfordUpdate(state: WelfordState, x: number): WelfordState {
  const n     = state.n + 1;
  const delta = x - state.mean;
  const mean  = state.mean + delta / n;
  const M2    = state.M2 + delta * (x - mean);
  return { n, mean, M2 };
}

function welfordFinalize(state: WelfordState): { mean: number; std: number } {
  if (state.n < 2) return { mean: state.mean, std: 0 };
  return { mean: state.mean, std: Math.sqrt(state.M2 / (state.n - 1)) };
}

function freshWelford(): WelfordState { return { n: 0, mean: 0, M2: 0 }; }

// ─── Play signal logic (mirror of computeConditions in AgenticProgressiveEngine.ts) ──
function computePlaySignal(
  currentMissStreak: number,
  avgPreMiss: number,
  stdPreMiss: number
): 'PLAY' | 'WAIT' | 'ALERT' {
  const threshold = avgPreMiss + stdPreMiss;
  if (currentMissStreak >= threshold * 1.5) return 'ALERT';
  if (currentMissStreak >= threshold)       return 'PLAY';
  return 'WAIT';
}

// ─── Clustering logic ──────────────────────────────────────────
function computeClustering(
  recentHitRate: number,
  globalHitRate: number,
  currentMissStreak: number,
  avgPreMiss: number
): 'HOT' | 'COLD' | 'NEUTRAL' {
  if (recentHitRate >= globalHitRate * 1.2 && currentMissStreak < avgPreMiss * 0.5) return 'HOT';
  if (recentHitRate < globalHitRate * 0.8  || currentMissStreak > avgPreMiss * 1.5) return 'COLD';
  return 'NEUTRAL';
}

// ─── Trend logic ───────────────────────────────────────────────
function computeTrend(
  recentHitRate: number,
  globalHitRate: number
): 'UP' | 'DOWN' | 'STABLE' {
  const THRESHOLD = 0.05;
  if (recentHitRate >= globalHitRate + THRESHOLD) return 'UP';
  if (recentHitRate <= globalHitRate - THRESHOLD) return 'DOWN';
  return 'STABLE';
}

// ─── DoW / month bias detection (mirror of AgenticProgressiveEngine.ts) ──
function computeBestDows(
  evalPoints: Array<{ hit: boolean; dow: number; month: number }>,
  globalHitRate: number,
  BOOST_THRESHOLD = 1.2
): number[] {
  const dowHits: Record<number, { hits: number; total: number }> = {};
  for (const pt of evalPoints) {
    dowHits[pt.dow] = dowHits[pt.dow] ?? { hits: 0, total: 0 };
    dowHits[pt.dow]!.total++;
    if (pt.hit) dowHits[pt.dow]!.hits++;
  }
  return Object.entries(dowHits)
    .filter(([, v]) => v.total >= 5 && (v.hits / v.total) >= globalHitRate * BOOST_THRESHOLD)
    .map(([dow]) => parseInt(dow));
}

// ─── Sliding-window miss streak computation ────────────────────
function computeMissStreak(hits: boolean[]): {
  welford: WelfordState;
  currentMissStreak: number;
  maxPreMiss: number;
} {
  let w: WelfordState = freshWelford();
  let runningMiss = 0;
  let maxPreMiss = 0;
  for (const h of hits) {
    if (h) {
      if (runningMiss > 0) {
        w = welfordUpdate(w, runningMiss);
        maxPreMiss = Math.max(maxPreMiss, runningMiss);
      }
      runningMiss = 0;
    } else {
      runningMiss++;
    }
  }
  return { welford: w, currentMissStreak: runningMiss, maxPreMiss };
}

// ═══════════════════════════════════════════════════════════════
// SECTION 1 — Welford Algorithm
// ═══════════════════════════════════════════════════════════════
describe('Welford online mean/variance', () => {
  it('correctly computes mean after n=1 observation', () => {
    let s = freshWelford();
    s = welfordUpdate(s, 5);
    const { mean, std } = welfordFinalize(s);
    expect(mean).toBe(5);
    expect(std).toBe(0); // n < 2 → std = 0
  });

  it('correctly computes mean and std for [2, 4, 4, 4, 5, 5, 7, 9] (Wikipedia example)', () => {
    // Wikipedia uses POPULATION std (σ=2). Welford (and production code) uses SAMPLE std (s).
    // Sample std = sqrt(M2/(n-1)) = sqrt(32/7) ≈ 2.1381
    const values = [2, 4, 4, 4, 5, 5, 7, 9];
    let s = freshWelford();
    for (const v of values) s = welfordUpdate(s, v);
    const { mean, std } = welfordFinalize(s);
    expect(mean).toBeCloseTo(5, 10);
    expect(std).toBeCloseTo(Math.sqrt(32 / 7), 5); // sample std, not population std
  });

  it('matches naive mean/std for a known miss-streak dataset', () => {
    // Simulated miss streaks before each hit: [3, 5, 7, 3, 4]
    const streaks = [3, 5, 7, 3, 4];
    let s = freshWelford();
    for (const v of streaks) s = welfordUpdate(s, v);
    const { mean, std } = welfordFinalize(s);

    const naiveMean = streaks.reduce((a, b) => a + b, 0) / streaks.length;
    const naiveVariance = streaks.reduce((acc, v) => acc + (v - naiveMean) ** 2, 0) / (streaks.length - 1);
    const naiveStd = Math.sqrt(naiveVariance);

    expect(mean).toBeCloseTo(naiveMean, 8);
    expect(std).toBeCloseTo(naiveStd, 8);
  });

  it('handles single observation: std = 0 regardless of value', () => {
    for (const v of [0, 1, 100, 999]) {
      let s = freshWelford();
      s = welfordUpdate(s, v);
      const { std } = welfordFinalize(s);
      expect(std).toBe(0);
    }
  });

  it('handles all-equal observations: std = 0', () => {
    let s = freshWelford();
    for (let i = 0; i < 10; i++) s = welfordUpdate(s, 3);
    const { mean, std } = welfordFinalize(s);
    expect(mean).toBeCloseTo(3, 10);
    expect(std).toBeCloseTo(0, 10);
  });

  it('empty state returns mean=0 std=0', () => {
    const { mean, std } = welfordFinalize(freshWelford());
    expect(mean).toBe(0);
    expect(std).toBe(0);
  });

  it('online updates produce same result as batch computation', () => {
    const data = [1, 6, 3, 8, 2, 9, 4, 7, 5];
    // Online
    let s = freshWelford();
    for (const v of data) s = welfordUpdate(s, v);
    const { mean: onlineMean, std: onlineStd } = welfordFinalize(s);
    // Batch (two-pass)
    const batchMean = data.reduce((a, b) => a + b, 0) / data.length;
    const batchStd  = Math.sqrt(data.reduce((acc, v) => acc + (v - batchMean) ** 2, 0) / (data.length - 1));
    expect(onlineMean).toBeCloseTo(batchMean, 10);
    expect(onlineStd).toBeCloseTo(batchStd, 10);
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 2 — Miss Streak Computation
// ═══════════════════════════════════════════════════════════════
describe('Miss streak computation', () => {
  it('computes correct currentMissStreak and maxPreMiss', () => {
    // Sequence: MISS, MISS, HIT(streak=2), MISS, MISS, MISS, HIT(streak=3), MISS, MISS
    const hits = [false, false, true, false, false, false, true, false, false];
    const { currentMissStreak, maxPreMiss, welford } = computeMissStreak(hits);
    expect(currentMissStreak).toBe(2);   // 2 trailing misses
    expect(maxPreMiss).toBe(3);           // longest pre-hit streak was 3
    const { mean, std } = welfordFinalize(welford);
    expect(mean).toBeCloseTo((2 + 3) / 2, 5);
    expect(std).toBeGreaterThan(0);
  });

  it('no hits → currentMissStreak = total, welford n=0', () => {
    const hits = [false, false, false, false];
    const { currentMissStreak, maxPreMiss, welford } = computeMissStreak(hits);
    expect(currentMissStreak).toBe(4);
    expect(maxPreMiss).toBe(0); // no hits → no completed streaks
    expect(welford.n).toBe(0);
  });

  it('all hits → currentMissStreak = 0', () => {
    const hits = [true, true, true, true];
    const { currentMissStreak } = computeMissStreak(hits);
    expect(currentMissStreak).toBe(0);
  });

  it('alternating hit/miss → streaks of 1', () => {
    const hits = [true, false, true, false, true, false]; // ends on miss
    const { currentMissStreak, maxPreMiss, welford } = computeMissStreak(hits);
    expect(currentMissStreak).toBe(1);
    expect(maxPreMiss).toBe(1);
    const { mean } = welfordFinalize(welford);
    expect(mean).toBe(1); // all streaks = 1
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 3 — Play Signal Logic
// ═══════════════════════════════════════════════════════════════
describe('Play signal (PLAY / WAIT / ALERT)', () => {
  it('WAIT when currentMisses is well below threshold', () => {
    // avgPreMiss=5, std=2 → threshold=7 — currentMisses=3 → WAIT
    expect(computePlaySignal(3, 5, 2)).toBe('WAIT');
  });

  it('PLAY when currentMisses reaches threshold exactly', () => {
    // avgPreMiss=5, std=2 → threshold=7 → PLAY at 7
    expect(computePlaySignal(7, 5, 2)).toBe('PLAY');
  });

  it('PLAY for currentMisses between threshold and 1.5× threshold', () => {
    // threshold=7, 1.5×threshold=10.5 — at 9 → PLAY
    expect(computePlaySignal(9, 5, 2)).toBe('PLAY');
  });

  it('ALERT when currentMisses >= 1.5 × threshold', () => {
    // threshold=7, 1.5×threshold=10.5 — at 11 → ALERT
    expect(computePlaySignal(11, 5, 2)).toBe('ALERT');
  });

  it('ALERT exactly at 1.5 × threshold', () => {
    // threshold=10, 1.5×threshold=15 — at 15 → ALERT
    expect(computePlaySignal(15, 8, 2)).toBe('ALERT');
  });

  it('WAIT when avgPreMiss=0 and std=0 (threshold=0) and currentMisses=0', () => {
    // threshold=0, currentMisses=0: 0 >= 0 → PLAY? No: ALERT check: 0 >= 0 → ALERT
    // Actually: currentMisses=0, threshold=0 → 0 >= 0*1.5=0 → ALERT
    // This is an edge case: freshly computed, no history yet
    // Production code: if avgPreMiss=0 and std=0, threshold=0 → even 0 misses triggers ALERT
    const signal = computePlaySignal(0, 0, 0);
    expect(['ALERT', 'PLAY', 'WAIT']).toContain(signal); // deterministic, just verify it doesn't throw
    expect(signal).toBe('ALERT'); // 0 >= 0 * 1.5 = 0 → ALERT (boundary behavior)
  });

  it('real-world scenario: strategy hit every 8 draws on average (std=3)', () => {
    // avgPreMiss=7, std=3 → threshold=10, alertThreshold=15
    expect(computePlaySignal(5,  7, 3)).toBe('WAIT');   // normal range
    expect(computePlaySignal(10, 7, 3)).toBe('PLAY');   // hit threshold
    expect(computePlaySignal(13, 7, 3)).toBe('PLAY');   // between threshold and alert
    expect(computePlaySignal(15, 7, 3)).toBe('ALERT');  // extreme streak
    expect(computePlaySignal(20, 7, 3)).toBe('ALERT');  // deep alert
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 4 — Clustering Logic
// ═══════════════════════════════════════════════════════════════
describe('Clustering (HOT / COLD / NEUTRAL)', () => {
  it('HOT: recent > global×1.2 AND currentMisses < avg×0.5', () => {
    expect(computeClustering(0.30, 0.20, 2, 10)).toBe('HOT');
    // recent=0.30 ≥ 0.20×1.2=0.24 ✓, currentMisses=2 < 10×0.5=5 ✓
  });

  it('NOT HOT if recent passes threshold but currentMisses too high', () => {
    expect(computeClustering(0.30, 0.20, 6, 10)).not.toBe('HOT');
    // currentMisses=6 ≥ 10×0.5=5 → NOT HOT
  });

  it('COLD: recent < global×0.8', () => {
    // recent=0.10 < 0.20×0.8=0.16 → COLD
    expect(computeClustering(0.10, 0.20, 5, 10)).toBe('COLD');
  });

  it('COLD: currentMisses > avgPreMiss×1.5 even if recent is normal', () => {
    // recent=0.20 is fine, but currentMisses=18 > 10×1.5=15 → COLD
    expect(computeClustering(0.20, 0.20, 18, 10)).toBe('COLD');
  });

  it('NEUTRAL: neither HOT nor COLD', () => {
    // recent=0.22 (within ±20% of global 0.20), currentMisses=8 (within 1.5× avg=10)
    expect(computeClustering(0.22, 0.20, 8, 10)).toBe('NEUTRAL');
  });

  it('boundary: exactly global×1.2 → HOT if miss condition met', () => {
    // recent = global × 1.2 exactly: 0.20 × 1.2 = 0.24
    expect(computeClustering(0.24, 0.20, 2, 10)).toBe('HOT');
  });

  it('boundary: global×0.8 → JS floating point makes 0.16 < 0.16000000000000003 → COLD', () => {
    // JS: 0.20 * 0.8 = 0.16000000000000003 (IEEE 754)
    // So 0.16 < 0.16000000000000003 is TRUE → production code returns COLD.
    // This matches the actual implementation behavior.
    const result = computeClustering(0.16, 0.20, 5, 10);
    expect(result).toBe('COLD');  // floating point: 0.16 < 0.20*0.8
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 5 — Trend Detection
// ═══════════════════════════════════════════════════════════════
describe('Trend (UP / DOWN / STABLE)', () => {
  it('UP when recent > global + 0.05', () => {
    expect(computeTrend(0.30, 0.20)).toBe('UP');  // +0.10 > 0.05
  });

  it('DOWN when recent < global - 0.05', () => {
    expect(computeTrend(0.10, 0.20)).toBe('DOWN');  // -0.10 < -0.05
  });

  it('STABLE when within ±0.05', () => {
    expect(computeTrend(0.22, 0.20)).toBe('STABLE');  // +0.02 < 0.05
    expect(computeTrend(0.18, 0.20)).toBe('STABLE');  // -0.02 > -0.05
    expect(computeTrend(0.20, 0.20)).toBe('STABLE');  // exactly equal
  });

  it('boundary: exactly global + 0.05 → UP (inclusive >=)', () => {
    expect(computeTrend(0.25, 0.20)).toBe('UP');  // 0.25 >= 0.20+0.05=0.25 → UP
  });

  it('boundary: exactly global - 0.05 → DOWN (inclusive <=)', () => {
    expect(computeTrend(0.15, 0.20)).toBe('DOWN');  // 0.15 <= 0.20-0.05=0.15 → DOWN
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 6 — DoW / Month Best-Bias Detection
// ═══════════════════════════════════════════════════════════════
describe('Best DoW / Month bias detection', () => {
  it('identifies DoW with hit rate ≥ 1.2× global', () => {
    // Global hit rate = 0.20 (20%)
    // DoW=1 (Monday): 10 hits out of 10 appearances = 100% hit rate = 5× global → qualifies
    // DoW=3 (Wednesday): 1 hit out of 10 = 10% hit rate = 0.5× global → does NOT qualify
    const evalPoints = [
      // 10 Mondays all with hits
      ...Array.from({ length: 10 }, () => ({ hit: true,  dow: 1, month: 1 })),
      // 10 Wednesdays, only 1 hit
      { hit: true,  dow: 3, month: 1 },
      ...Array.from({ length: 9 }, () => ({ hit: false, dow: 3, month: 1 })),
      // 30 other Fridays: 6 hits = 20% = exactly global → does NOT qualify (not ≥ 1.2×)
      ...Array.from({ length: 6 }, () => ({ hit: true,  dow: 5, month: 2 })),
      ...Array.from({ length: 24 }, () => ({ hit: false, dow: 5, month: 2 })),
    ];
    const globalHitRate = evalPoints.filter(e => e.hit).length / evalPoints.length;
    const bestDows = computeBestDows(evalPoints, globalHitRate);
    expect(bestDows).toContain(1);   // Monday qualifies (100% >> global)
    expect(bestDows).not.toContain(3); // Wednesday does not (10% < global×1.2)
    expect(bestDows).not.toContain(5); // Friday does not (20% = global, not ≥ 1.2×)
  });

  it('minimum 5 appearances required for a DoW to qualify', () => {
    // DoW=2 appears only 4 times but with 100% hit rate → should NOT qualify
    const evalPoints = [
      ...Array.from({ length: 4 }, () => ({ hit: true, dow: 2, month: 1 })),
      ...Array.from({ length: 30 }, () => ({ hit: false, dow: 0, month: 1 })),
    ];
    const globalHitRate = 4 / 34;
    const bestDows = computeBestDows(evalPoints, globalHitRate);
    expect(bestDows).not.toContain(2); // < 5 appearances → excluded
  });

  it('empty evalPoints → no best DoW', () => {
    expect(computeBestDows([], 0.20)).toHaveLength(0);
  });

  it('all DoWs at equal hit rate → none qualifies (rate = global, not ≥ 1.2×)', () => {
    // 7 draws per DoW, 1 hit each → global = 7/49, each DoW = 1/7 = global exactly
    const evalPoints = Array.from({ length: 7 }, (_, dow) =>
      [...Array.from({ length: 6 }, () => ({ hit: false, dow, month: 1 })), { hit: true, dow, month: 1 }]
    ).flat();
    const globalHitRate = 7 / 49;
    const bestDows = computeBestDows(evalPoints, globalHitRate);
    expect(bestDows).toHaveLength(0); // exactly global, not ≥ 1.2×
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 7 — Transition Rates
// ═══════════════════════════════════════════════════════════════
describe('Transition rates (hit-after-hit, hit-after-miss)', () => {
  function computeTransitions(hits: boolean[]): { hitAfterHit: number; hitAfterMiss: number } {
    let hitAfterHit = 0, hitAfterMiss = 0;
    let hhTotal = 0, hmTotal = 0;
    for (let i = 1; i < hits.length; i++) {
      const prevHit = hits[i - 1]!;
      const curHit  = hits[i]!;
      if (prevHit) { hhTotal++; if (curHit) hitAfterHit++; }
      else         { hmTotal++; if (curHit) hitAfterMiss++; }
    }
    return {
      hitAfterHit:  hhTotal > 0 ? hitAfterHit  / hhTotal : 0,
      hitAfterMiss: hmTotal > 0 ? hitAfterMiss / hmTotal : 0,
    };
  }

  it('alternating H/M: hitAfterMiss = 1.0, hitAfterHit = 0.0', () => {
    const hits = [false, true, false, true, false, true, false, true];
    const { hitAfterHit, hitAfterMiss } = computeTransitions(hits);
    expect(hitAfterMiss).toBe(1.0);
    expect(hitAfterHit).toBe(0.0);
  });

  it('all hits: hitAfterHit = 1.0, hitAfterMiss = 0 (no misses)', () => {
    const hits = [true, true, true, true];
    const { hitAfterHit, hitAfterMiss } = computeTransitions(hits);
    expect(hitAfterHit).toBe(1.0);
    expect(hitAfterMiss).toBe(0); // undefined → 0
  });

  it('all misses: hitAfterHit = 0, hitAfterMiss = 0', () => {
    const hits = [false, false, false, false];
    const { hitAfterHit, hitAfterMiss } = computeTransitions(hits);
    expect(hitAfterHit).toBe(0);
    expect(hitAfterMiss).toBe(0);
  });

  it('known sequence: [T, T, F, T, F, F]', () => {
    // Transitions from this sequence (5 pairs):
    // T→T: hhTotal=1, hitAfterHit+=1
    // T→F: hhTotal=2        (no hit increment)
    // F→T: hmTotal=1, hitAfterMiss+=1
    // T→F: hhTotal=3        (no hit increment)
    // F→F: hmTotal=2        (no hit increment)
    // hitAfterHit  = 1/3 ≈ 0.3333
    // hitAfterMiss = 1/2 = 0.5
    const hits = [true, true, false, true, false, false];
    const { hitAfterHit, hitAfterMiss } = computeTransitions(hits);
    expect(hitAfterHit).toBeCloseTo(1 / 3, 5);
    expect(hitAfterMiss).toBeCloseTo(1 / 2, 5);
  });
});

// ═══════════════════════════════════════════════════════════════
// SECTION 8 — End-to-End: Full conditions computation
// ═══════════════════════════════════════════════════════════════
describe('Full conditions computation — integration', () => {
  it('builds correct conditions object from a known hit/miss sequence', () => {
    // Scenario: strategy with predictable hit pattern
    // Hits at indices: 5, 12, 19, 26 (every 7 draws) → avgPreMiss ≈ 6, std ≈ 0
    const totalDraws = 35;
    const hits: boolean[] = Array.from({ length: totalDraws }, (_, i) => (i + 1) % 7 === 0);

    // Global hit rate
    const totalHits = hits.filter(Boolean).length;
    const globalHitRate = totalHits / totalDraws;

    // Miss streaks
    const { welford, currentMissStreak, maxPreMiss } = computeMissStreak(hits);
    const { mean: avgPreMiss, std: stdPreMiss } = welfordFinalize(welford);

    expect(avgPreMiss).toBeCloseTo(6, 5); // 6 misses before each hit
    expect(stdPreMiss).toBeCloseTo(0, 5); // perfectly regular → std=0
    expect(currentMissStreak).toBe(35 % 7); // trailing misses = 0 (35 = 5×7)

    // Play signal: currentMissStreak=0, threshold=6+0=6 → 0 < 6 → WAIT
    const signal = computePlaySignal(currentMissStreak, avgPreMiss, stdPreMiss);
    expect(signal).toBe('WAIT');

    // Global hit rate = 5/35 ≈ 0.143
    expect(globalHitRate).toBeCloseTo(5 / 35, 5);

    // Recent 50 (same as full for 35 draws): same rate
    const recentHitRate = globalHitRate;
    expect(computeTrend(recentHitRate, globalHitRate)).toBe('STABLE');

    // Clustering: currentMissStreak=0 < avgPreMiss×0.5=3 ✓, but recent rate = global (not 1.2×) → check
    const clustering = computeClustering(recentHitRate, globalHitRate, currentMissStreak, avgPreMiss);
    // recent=global (not ≥ 1.2×) → NOT HOT. currentMisses=0 < avg×1.5=9 and recent ≥ global×0.8 → NOT COLD
    expect(clustering).toBe('NEUTRAL');

    expect(maxPreMiss).toBe(6);
  });

  it('scenario: extreme miss streak triggers ALERT', () => {
    // Normal history: hits every 5 draws (avgPreMiss=4, std=0)
    // But currently on 12-miss streak
    const avgPreMiss = 4, stdPreMiss = 0;
    const currentMissStreak = 12;
    // threshold = 4+0 = 4, alertThreshold = 4×1.5 = 6
    // currentMissStreak=12 >= 6 → ALERT
    expect(computePlaySignal(currentMissStreak, avgPreMiss, stdPreMiss)).toBe('ALERT');
    // COLD: currentMisses=12 > avgPreMiss×1.5=6 → COLD
    expect(computeClustering(0.15, 0.20, currentMissStreak, avgPreMiss)).toBe('COLD');
  });

  it('scenario: strategy on a hot streak triggers PLAY + HOT', () => {
    // Normal history: hits every 8 draws avg (std=2)
    // Currently: 8 misses (exactly threshold) → PLAY
    // Recent 50 hit rate = 0.30 vs global 0.20 → HOT if misses < avg×0.5=4
    const currentMissStreak = 8;
    const avgPreMiss = 6, stdPreMiss = 2;  // threshold=8
    expect(computePlaySignal(currentMissStreak, avgPreMiss, stdPreMiss)).toBe('PLAY');
    // But currentMisses=8 >= avg×0.5=3 → NOT HOT (miss count too high despite trend)
    expect(computeClustering(0.30, 0.20, currentMissStreak, avgPreMiss)).not.toBe('HOT');
    // recentHitRate=0.30, global=0.20, diff=0.10 > 0.05 → UP
    expect(computeTrend(0.30, 0.20)).toBe('UP');
  });
});
