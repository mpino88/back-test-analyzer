// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: PPSService core logic (pure, no DB)
//
// Tests cover:
//   1. adaptiveAlpha() — warmup vs mature thresholds
//   2. EMA update formula — math correctness
//   3. computeOptimalN() logic — ROI function, profitable / no-edge
//   4. Rank extraction from pair_scores
//   5. Edge cases: empty snapshots, all misses, perfect predictor
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Extracted pure logic (mirrors PPSService.ts exactly) ─────
const PPS_ALPHA_WARMUP   = 0.30;
const PPS_ALPHA_MATURE   = 0.15;
const PPS_WARMUP_THRESHOLD = 30;
const PPS_INITIAL   = 50.0;
const RANK_MISS     = 101;
const PAYOUT        = 50;
const TARGET_ROI    = 0.01;
const MAX_N         = 15;
const MAX_N_NO_EDGE = 10;

function adaptiveAlpha(sample_count: number): number {
  return sample_count < PPS_WARMUP_THRESHOLD ? PPS_ALPHA_WARMUP : PPS_ALPHA_MATURE;
}

function updatePPS(pps_before: number, rank_of_winner: number, sample_count: number): number {
  const alpha       = adaptiveAlpha(sample_count);
  const contribution = RANK_MISS - rank_of_winner;  // 0–100
  return +(alpha * contribution + (1 - alpha) * pps_before).toFixed(4);
}

function rankFromScores(pair_scores: Record<string, number>, winning_pair: string): number {
  const sorted = Object.entries(pair_scores)
    .sort((a, b) => b[1] - a[1])
    .map(([pair]) => pair);
  const idx = sorted.indexOf(winning_pair);
  return idx >= 0 ? idx + 1 : RANK_MISS;
}

// Mini computeOptimalN() — pure math, no DB
// PATCH 2026-05-15: fix tie-break N=1 bug.
// When all effective_ranks > MAX_N, hit_rate(N)=0 for all N∈[1,10] and roi=-1 for all.
// Old: N=1 won the tie (first to beat -Infinity), never displaced (no -1 > -1).
// New: on roi tie, prefer larger hit_rate; on hit_rate tie with hit_rate=0, prefer larger N.
//      → bestN advances to MAX_N_NO_EDGE (10) instead of staying at 1.
function computeOptimalN(effectiveRanks: number[]): {
  optimal_n: number; hit_rate: number; expected_roi: number; is_profitable: boolean;
} {
  if (effectiveRanks.length < 3) {
    return { optimal_n: 15, hit_rate: 0, expected_roi: 0, is_profitable: false };
  }

  const sorted = [...effectiveRanks].sort((a, b) => a - b);
  const totalDraws = sorted.length;

  let bestN = 15;
  let bestRoi = -Infinity;
  let bestHitRate = 0;
  let profitable = false;

  for (let N = 1; N <= MAX_N; N++) {
    let hits = 0;
    for (const r of sorted) {
      if (r <= N) hits++;
      else break;
    }
    const hitRate = hits / totalDraws;
    const roi = hitRate * PAYOUT / N - 1;

    if (!profitable && roi >= TARGET_ROI) {
      bestN = N; bestRoi = roi; bestHitRate = hitRate; profitable = true; break;
    }
    // PATCH 2026-05-15: tie-break — on roi tie prefer larger hit_rate, then larger N
    if (N <= MAX_N_NO_EDGE && (
      roi > bestRoi ||
      (roi === bestRoi && hitRate > bestHitRate) ||
      (roi === bestRoi && hitRate === bestHitRate && hitRate === 0)
    )) {
      bestRoi = roi; bestN = N; bestHitRate = hitRate;
    }
  }

  return { optimal_n: bestN, hit_rate: bestHitRate, expected_roi: bestRoi, is_profitable: profitable };
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('adaptiveAlpha()', () => {
  it('returns WARMUP alpha (0.30) when sample_count < 30', () => {
    expect(adaptiveAlpha(0)).toBe(PPS_ALPHA_WARMUP);
    expect(adaptiveAlpha(1)).toBe(PPS_ALPHA_WARMUP);
    expect(adaptiveAlpha(29)).toBe(PPS_ALPHA_WARMUP);
  });

  it('returns MATURE alpha (0.15) when sample_count >= 30', () => {
    expect(adaptiveAlpha(30)).toBe(PPS_ALPHA_MATURE);
    expect(adaptiveAlpha(100)).toBe(PPS_ALPHA_MATURE);
    expect(adaptiveAlpha(1000)).toBe(PPS_ALPHA_MATURE);
  });

  it('boundary: exactly 29 is warmup, exactly 30 is mature', () => {
    expect(adaptiveAlpha(29)).toBe(PPS_ALPHA_WARMUP);
    expect(adaptiveAlpha(30)).toBe(PPS_ALPHA_MATURE);
  });
});

describe('PPS EMA update formula', () => {
  it('perfect predictor (rank=1): PPS converges toward 100', () => {
    let pps = PPS_INITIAL;
    for (let i = 0; i < 200; i++) {
      pps = updatePPS(pps, 1, 50); // mature alpha, rank=1 → contribution=100
    }
    expect(pps).toBeGreaterThan(95);
  });

  it('total miss (rank=101): PPS converges toward 0', () => {
    let pps = PPS_INITIAL;
    for (let i = 0; i < 200; i++) {
      pps = updatePPS(pps, RANK_MISS, 50); // mature, rank=101 → contribution=0
    }
    expect(pps).toBeLessThan(5);
  });

  it('neutral predictor (rank=51): PPS stays near 50', () => {
    let pps = PPS_INITIAL;
    for (let i = 0; i < 100; i++) {
      pps = updatePPS(pps, 51, 50); // contribution = 101-51 = 50
    }
    // 50 * α + (1-α) * 50 = 50 forever
    expect(pps).toBeCloseTo(50, 1);
  });

  it('warmup alpha (0.30) updates faster than mature (0.15)', () => {
    let ppsMature  = PPS_INITIAL;
    let ppsWarmup  = PPS_INITIAL;

    // 5 perfect predictions from neutral
    for (let i = 0; i < 5; i++) {
      ppsMature = updatePPS(ppsMature, 1, 50);   // α=0.15
      ppsWarmup = updatePPS(ppsWarmup, 1, 0);    // α=0.30
    }
    expect(ppsWarmup).toBeGreaterThan(ppsMature);
  });

  it('EMA formula is correct: pps_after = α*(101-rank) + (1-α)*pps_before', () => {
    const pps_before = 60.0;
    const rank = 5;
    const alpha = 0.15;
    const expected = alpha * (101 - rank) + (1 - alpha) * pps_before;
    expect(updatePPS(pps_before, rank, 50)).toBeCloseTo(expected, 3);
  });

  it('PPS is always in range [0, 100] after many updates', () => {
    const testCases = [
      { rank: 1, alpha_sample: 0 },      // perfect, warmup
      { rank: RANK_MISS, alpha_sample: 100 }, // total miss, mature
      { rank: 50, alpha_sample: 15 },    // median
    ];
    for (const { rank, alpha_sample } of testCases) {
      let pps = PPS_INITIAL;
      for (let i = 0; i < 500; i++) {
        pps = updatePPS(pps, rank, alpha_sample);
        expect(pps, `PPS out of range for rank=${rank}`).toBeGreaterThanOrEqual(0);
        expect(pps, `PPS out of range for rank=${rank}`).toBeLessThanOrEqual(100);
      }
    }
  });
});

describe('rankFromScores()', () => {
  it('returns rank=1 when winning pair has highest score', () => {
    const scores: Record<string, number> = { '00': 0.1, '37': 0.9, '99': 0.5 };
    expect(rankFromScores(scores, '37')).toBe(1);
  });

  it('returns rank=2 when winning pair has second highest score', () => {
    const scores: Record<string, number> = { '00': 0.9, '37': 0.7, '99': 0.5 };
    expect(rankFromScores(scores, '37')).toBe(2);
  });

  it('returns RANK_MISS (101) when winning pair is not in scores', () => {
    const scores: Record<string, number> = { '00': 0.5, '11': 0.3 };
    expect(rankFromScores(scores, '99')).toBe(RANK_MISS);
  });

  it('returns rank=1 for the top pair in a full 100-pair map', () => {
    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        scores[`${x}${y}`] = Math.random() * 0.5;
      }
    }
    scores['42'] = 1.0; // guaranteed top
    expect(rankFromScores(scores, '42')).toBe(1);
  });

  it('consistent with sorted order when multiple pairs have equal score', () => {
    // Ties resolved by sort stability — pair should not get rank=MISS
    const scores: Record<string, number> = { '11': 0.5, '22': 0.5, '33': 0.5 };
    const rank11 = rankFromScores(scores, '11');
    const rank22 = rankFromScores(scores, '22');
    const rank33 = rankFromScores(scores, '33');
    // All ranks should be 1, 2, or 3 — never RANK_MISS
    expect(rank11).toBeLessThanOrEqual(3);
    expect(rank22).toBeLessThanOrEqual(3);
    expect(rank33).toBeLessThanOrEqual(3);
    // All ranks should be distinct
    expect(new Set([rank11, rank22, rank33]).size).toBe(3);
  });
});

describe('computeOptimalN() — ROI function', () => {
  it('returns profitable=true when many draws have rank <= small N', () => {
    // If the winner always lands at rank 2, then at N=2:
    // hit_rate = 1.0, roi = 1.0 * 50 / 2 - 1 = 24 (2400% ROI) → profitable
    const ranks = Array.from({ length: 30 }, () => 2);
    const result = computeOptimalN(ranks);
    expect(result.is_profitable).toBe(true);
    expect(result.optimal_n).toBeLessThanOrEqual(3);
  });

  it('returns profitable=false when winners always land outside top-15', () => {
    // If the winner always lands at rank 50, no N in [1,15] captures it
    const ranks = Array.from({ length: 30 }, () => 50);
    const result = computeOptimalN(ranks);
    expect(result.is_profitable).toBe(false);
    expect(result.optimal_n).toBeLessThanOrEqual(MAX_N_NO_EDGE);
  });

  it('optimal_n is bounded by MAX_N (15)', () => {
    const ranks = Array.from({ length: 50 }, (_, i) => i % 20 + 1);
    const result = computeOptimalN(ranks);
    expect(result.optimal_n).toBeLessThanOrEqual(MAX_N);
    expect(result.optimal_n).toBeGreaterThanOrEqual(1);
  });

  it('returns default when fewer than 3 effective ranks available', () => {
    const result = computeOptimalN([5, 8]); // only 2 draws
    expect(result.optimal_n).toBe(15);
    expect(result.is_profitable).toBe(false);
    expect(result.hit_rate).toBe(0);
  });

  it('ROI formula: hit_rate * PAYOUT / N - 1 is >= TARGET_ROI for profitable N', () => {
    // Set up: winner always at rank 1 → hit_rate(1) = 1.0, roi(1) = 50/1 - 1 = 49
    const ranks = Array.from({ length: 20 }, () => 1);
    const result = computeOptimalN(ranks);
    expect(result.is_profitable).toBe(true);
    expect(result.hit_rate * PAYOUT / result.optimal_n - 1).toBeGreaterThanOrEqual(TARGET_ROI);
  });

  it('no-edge fallback: optimal_n <= MAX_N_NO_EDGE (10) when no profitable N exists', () => {
    // Winners at rank 80 — completely outside top-15
    const ranks = Array.from({ length: 30 }, () => 80);
    const result = computeOptimalN(ranks);
    expect(result.is_profitable).toBe(false);
    expect(result.optimal_n).toBeLessThanOrEqual(MAX_N_NO_EDGE);
  });

  it('monotonically explores N from 1 upward — picks MINIMUM N with ROI', () => {
    // Winners at rank 5 → at N=5, hit_rate=1.0, roi=50/5-1=9 (900%)
    // Should pick N=5 not N=15
    const ranks = Array.from({ length: 30 }, () => 5);
    const result = computeOptimalN(ranks);
    expect(result.is_profitable).toBe(true);
    expect(result.optimal_n).toBeLessThanOrEqual(5);
  });

  it('hit_rate is always in [0, 1]', () => {
    const testCases = [
      Array.from({ length: 30 }, () => 1),      // perfect
      Array.from({ length: 30 }, () => 50),     // miss
      Array.from({ length: 30 }, (_, i) => i % 10 + 1), // mixed
    ];
    for (const ranks of testCases) {
      const { hit_rate } = computeOptimalN(ranks);
      expect(hit_rate).toBeGreaterThanOrEqual(0);
      expect(hit_rate).toBeLessThanOrEqual(1);
    }
  });
});

describe('PPSService — end-to-end scenario simulations', () => {
  it('scenario: algorithm that always ranks winner in top-3 reaches PPS > 70 in 50 sorteos', () => {
    let pps = PPS_INITIAL;
    for (let i = 0; i < 50; i++) {
      const rank = (i % 3) + 1; // alternates rank 1,2,3
      pps = updatePPS(pps, rank, i);
      // contribution = 101 - rank ∈ {98, 99, 100}
    }
    expect(pps).toBeGreaterThan(70);
  });

  it('scenario: algorithm with autocorr≈0 (rank uniform 1-100) stays near PPS 50', () => {
    let pps = PPS_INITIAL;
    // Random walk uniform [1, 100]
    const ranks = Array.from({ length: 100 }, (_, i) => ((i * 37 + 13) % 100) + 1);
    for (let i = 0; i < ranks.length; i++) {
      pps = updatePPS(pps, ranks[i]!, i);
    }
    // Average rank ≈ 50 → contribution ≈ 51 → PPS should be near 51
    expect(pps).toBeGreaterThan(30);
    expect(pps).toBeLessThan(70);
  });

  it('scenario: drift reset blends PPS toward 50 correctly', () => {
    // Simulates applyDriftWeightReduction(): pps_new = pps * 0.7 + 15
    const pps_high = 80;
    const pps_low  = 20;
    const resetHigh = pps_high * 0.7 + 15;
    const resetLow  = pps_low  * 0.7 + 15;
    // Both should be closer to 50 than original
    expect(Math.abs(resetHigh - 50)).toBeLessThan(Math.abs(pps_high - 50));
    expect(Math.abs(resetLow  - 50)).toBeLessThan(Math.abs(pps_low  - 50));
    // High PPS → reduced toward 50
    expect(resetHigh).toBeCloseTo(71, 0);
    // Low PPS → raised toward 50
    expect(resetLow).toBeCloseTo(29, 0);
  });
});

// ═══════════════════════════════════════════════════════════════
// REGRESSION: N=1 tie-break bug (2026-05-15)
// ═══════════════════════════════════════════════════════════════

describe('computeOptimalN() — REGRESSION: N=1 tie-break bug', () => {
  it('REGRESSION: all ranks > MAX_N should return MAX_N_NO_EDGE (10), NOT 1', () => {
    // BUG: When all effective_ranks > 15, hit_rate(N)=0 for all N∈[1,10].
    // roi=-1 for all N. Old code: N=1 won tie by beating -Infinity first.
    // New code: tie-breaking advances bestN to MAX_N_NO_EDGE=10.
    const ranks = Array.from({ length: 30 }, () => 50); // all outside top-15
    const result = computeOptimalN(ranks);
    expect(result.is_profitable).toBe(false);
    expect(result.optimal_n).toBe(MAX_N_NO_EDGE); // ← was 1 before fix
    expect(result.hit_rate).toBe(0);
  });

  it('REGRESSION: ranks between 16-30 (outside top-15 but existing) → MAX_N_NO_EDGE', () => {
    const ranks = Array.from({ length: 30 }, () => 20); // rank 20, outside top-15
    const result = computeOptimalN(ranks);
    expect(result.is_profitable).toBe(false);
    expect(result.optimal_n).toBe(MAX_N_NO_EDGE);
  });

  it('REGRESSION: after Genesis 5-year replay with high ranks → no N=1 trap', () => {
    // Simulates the Genesis scenario: 30 draws, winners ranked 25-40 in consensus.
    // Before fix: N=1 was returned. After fix: MAX_N_NO_EDGE (10).
    const ranks = Array.from({ length: 30 }, (_, i) => 25 + (i % 16)); // 25..40
    const result = computeOptimalN(ranks);
    expect(result.optimal_n).not.toBe(1);           // ← was the failing behavior
    expect(result.optimal_n).toBe(MAX_N_NO_EDGE);   // ← expected correct behavior
    expect(result.is_profitable).toBe(false);
  });

  it('real signal (some ranks ≤ 10) correctly returns profitable N < MAX_N_NO_EDGE', () => {
    // 40% of draws have winner at rank ≤ 5. At N=5: roi = 0.4 * 50/5 - 1 = 3.0 → profitable
    const goodRanks  = Array.from({ length: 12 }, () => 3);  // 12 hits
    const missRanks  = Array.from({ length: 18 }, () => 50); // 18 misses
    const mixed = [...goodRanks, ...missRanks];
    const result = computeOptimalN(mixed);
    expect(result.is_profitable).toBe(true);
    expect(result.optimal_n).toBeLessThan(MAX_N_NO_EDGE);
  });
});
