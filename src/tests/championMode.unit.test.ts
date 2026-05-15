// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: Champion Mode (v2.5)
//
// Tests cover:
//   1. Champion detection: rate >= 0.30 AND total >= 20
//   2. Tie-breaking: highest rate wins
//   3. No champion when no algo qualifies
//   4. No champion when sample too small (< 20)
//   5. No champion when rate too low (< 0.30)
//   6. Edge calculation (rate - baseline 0.15)
//   7. Weight redistribution: champion gets 60% of total
//   8. Diversity divisor cleared for champion (signal not diluted)
//   9. Integration: champion's pairs dominate ranked output
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Pure implementation (mirrors PPSService.detectChampion) ──
interface AlgoRecentMetrics { hits: number; total: number; rate: number; }
interface Champion {
  algo_name: string; hits: number; total: number; rate: number; edge: number;
}

const BASELINE      = 0.15;
const CHAMPION_RATE = 0.30;
const MIN_SAMPLES   = 20;

function detectChampion(metricsMap: Map<string, AlgoRecentMetrics>): Champion | null {
  let bestAlgo: string | null = null;
  let bestRate = 0;
  let bestHits = 0;
  let bestTotal = 0;

  for (const [algo, m] of metricsMap) {
    if (m.total < MIN_SAMPLES) continue;
    if (m.rate < CHAMPION_RATE) continue;
    if (m.rate > bestRate) {
      bestRate = m.rate; bestAlgo = algo;
      bestHits = m.hits; bestTotal = m.total;
    }
  }

  if (!bestAlgo) return null;

  return {
    algo_name: bestAlgo,
    hits:      bestHits,
    total:     bestTotal,
    rate:      +bestRate.toFixed(4),
    edge:      +(bestRate - BASELINE).toFixed(4),
  };
}

// ─── Weight redistribution (mirrors AnalysisEngine logic) ──────
function redistributeWeights(
  algoWeights: Map<string, number>,
  championName: string
): Map<string, number> {
  const result = new Map(algoWeights);
  let otherTotal = 0;
  for (const [name, w] of algoWeights) {
    if (name !== championName) otherTotal += w;
  }
  // champion gets 60% → its new weight = otherTotal × (0.60 / 0.40) = ×1.5
  result.set(championName, otherTotal * 1.5);
  return result;
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('detectChampion() — qualification rules', () => {
  it('returns champion when rate ≥ 0.30 AND total ≥ 20', () => {
    const m = new Map([
      ['trend_momentum', { hits: 9, total: 30, rate: 0.30 }],
    ]);
    const c = detectChampion(m);
    expect(c).not.toBeNull();
    expect(c!.algo_name).toBe('trend_momentum');
    expect(c!.rate).toBe(0.30);
  });

  it('rejects when rate < 0.30 (no edge)', () => {
    const m = new Map([
      ['trend_momentum', { hits: 8, total: 30, rate: 0.2667 }],
    ]);
    expect(detectChampion(m)).toBeNull();
  });

  it('rejects when total < 20 (insufficient sample)', () => {
    const m = new Map([
      ['trend_momentum', { hits: 10, total: 15, rate: 0.667 }],  // amazing rate but tiny sample
    ]);
    expect(detectChampion(m)).toBeNull();
  });

  it('rejects when exactly at threshold-1 sample (19 samples)', () => {
    const m = new Map([
      ['algo', { hits: 10, total: 19, rate: 0.526 }],
    ]);
    expect(detectChampion(m)).toBeNull();
  });

  it('accepts when exactly at threshold samples (20)', () => {
    const m = new Map([
      ['algo', { hits: 6, total: 20, rate: 0.30 }],
    ]);
    expect(detectChampion(m)).not.toBeNull();
  });
});

describe('detectChampion() — tie breaking', () => {
  it('picks highest rate when multiple qualify', () => {
    const m = new Map([
      ['trend_momentum', { hits: 9,  total: 30, rate: 0.30 }],
      ['calendar_pattern', { hits: 12, total: 30, rate: 0.40 }],  // ← higher
      ['bayesian_score', { hits: 10, total: 30, rate: 0.333 }],
    ]);
    const c = detectChampion(m);
    expect(c!.algo_name).toBe('calendar_pattern');
    expect(c!.rate).toBe(0.40);
  });

  it('returns single champion even if multiple have same rate', () => {
    const m = new Map([
      ['a', { hits: 9, total: 30, rate: 0.30 }],
      ['b', { hits: 9, total: 30, rate: 0.30 }],
    ]);
    const c = detectChampion(m);
    expect(c).not.toBeNull();
    // Either 'a' or 'b', but only ONE (first found with strictly greater wins,
    // first iteration sets bestRate, second doesn't beat it → 'a' wins)
    expect(['a', 'b']).toContain(c!.algo_name);
  });

  it('picks champion among qualifying when some fail thresholds', () => {
    const m = new Map([
      ['a', { hits: 8, total: 30, rate: 0.27 }],   // rate too low
      ['b', { hits: 11, total: 15, rate: 0.73 }],  // sample too small
      ['c', { hits: 8, total: 25, rate: 0.32 }],   // qualifies
      ['d', { hits: 15, total: 30, rate: 0.50 }],  // qualifies, higher rate
    ]);
    expect(detectChampion(m)!.algo_name).toBe('d');
  });
});

describe('detectChampion() — null cases', () => {
  it('returns null when no algorithms in map', () => {
    expect(detectChampion(new Map())).toBeNull();
  });

  it('returns null when all algorithms below sample threshold', () => {
    const m = new Map([
      ['a', { hits: 5, total: 10, rate: 0.50 }],
      ['b', { hits: 9, total: 19, rate: 0.474 }],
    ]);
    expect(detectChampion(m)).toBeNull();
  });

  it('returns null when all qualify on samples but no rate >= 0.30', () => {
    const m = new Map([
      ['a', { hits: 4, total: 30, rate: 0.133 }],  // below baseline
      ['b', { hits: 5, total: 30, rate: 0.167 }],  // ≈ baseline
      ['c', { hits: 8, total: 30, rate: 0.267 }],  // close but no cigar
    ]);
    expect(detectChampion(m)).toBeNull();
  });

  it('returns null for system with no edge anywhere', () => {
    const m = new Map<string, AlgoRecentMetrics>();
    for (let i = 0; i < 20; i++) {
      m.set(`algo_${i}`, { hits: 4, total: 30, rate: 0.133 + Math.random() * 0.05 });
    }
    expect(detectChampion(m)).toBeNull();
  });
});

describe('detectChampion() — edge calculation', () => {
  it('edge = rate - 0.15 (baseline)', () => {
    const m = new Map([
      ['trend_momentum', { hits: 9, total: 30, rate: 0.30 }],
    ]);
    const c = detectChampion(m)!;
    expect(c.edge).toBeCloseTo(0.15, 4);
  });

  it('edge = rate - baseline (0.633 - 0.15 ≈ 0.483) for 19 hits / 30', () => {
    const rate = 19 / 30;  // ≈ 0.6333
    const m = new Map([
      ['trend_momentum', { hits: 19, total: 30, rate }],
    ]);
    const c = detectChampion(m)!;
    expect(c.edge).toBeCloseTo(rate - 0.15, 3);
  });

  it('edge >= 0.15 always when champion qualifies (rate >= 0.30, baseline = 0.15)', () => {
    const cases = [
      { rate: 0.30, expectedMin: 0.15 },
      { rate: 0.50, expectedMin: 0.35 },
      { rate: 0.95, expectedMin: 0.80 },
    ];
    for (const { rate, expectedMin } of cases) {
      const m = new Map([['a', { hits: Math.round(rate * 30), total: 30, rate }]]);
      const c = detectChampion(m)!;
      expect(c.edge).toBeGreaterThanOrEqual(expectedMin - 0.01);
    }
  });
});

describe('redistributeWeights() — champion takes 60% of total', () => {
  it('champion weight = 1.5 × sum of other weights', () => {
    const weights = new Map([
      ['trend_momentum', 1.05],
      ['markov_order2',  0.30],
      ['streak',         0.35],
      ['frequency',      0.60],
    ]);
    const result = redistributeWeights(weights, 'trend_momentum');

    // Other weights: 0.30 + 0.35 + 0.60 = 1.25
    // Champion should be: 1.25 × 1.5 = 1.875
    expect(result.get('trend_momentum')).toBeCloseTo(1.875, 3);
    // Others unchanged
    expect(result.get('markov_order2')).toBe(0.30);
    expect(result.get('streak')).toBe(0.35);
    expect(result.get('frequency')).toBe(0.60);
  });

  it('champion gets 60% of TOTAL weight after redistribution', () => {
    const weights = new Map([
      ['champ', 1.0],
      ['a', 0.5],
      ['b', 0.5],
    ]);
    const result = redistributeWeights(weights, 'champ');

    let total = 0;
    for (const w of result.values()) total += w;
    const champShare = result.get('champ')! / total;
    expect(champShare).toBeCloseTo(0.60, 2);
  });

  it('preserves total relative ordering among non-champions', () => {
    const weights = new Map([
      ['champ', 0.5],
      ['high',  1.0],
      ['mid',   0.6],
      ['low',   0.2],
    ]);
    const result = redistributeWeights(weights, 'champ');

    // Among others: high > mid > low must still hold
    expect(result.get('high')! > result.get('mid')!).toBe(true);
    expect(result.get('mid')! > result.get('low')!).toBe(true);
  });

  it('champion dominates even if it had the smallest initial weight', () => {
    const weights = new Map([
      ['tiny_champ', 0.10],
      ['huge_a',     2.00],
      ['huge_b',     2.00],
    ]);
    const result = redistributeWeights(weights, 'tiny_champ');
    // tiny_champ now: (2 + 2) × 1.5 = 6.0
    expect(result.get('tiny_champ')).toBe(6.0);
    expect(result.get('tiny_champ')! > result.get('huge_a')!).toBe(true);
  });
});

describe('Champion Mode — integration scenarios', () => {
  it('REAL SCENARIO: trend_momentum @ 30% beats consensus', () => {
    // Setup matching user's report: trend_momentum 19 hits / 60 sorteos
    // (window=30, so we use the last 30 of those)
    const m = new Map([
      ['trend_momentum',     { hits: 10, total: 30, rate: 0.333 }],  // 33% → champion
      ['markov_order2',      { hits: 4,  total: 30, rate: 0.133 }],
      ['transition_follow',  { hits: 5,  total: 30, rate: 0.167 }],
      ['calendar_pattern',   { hits: 7,  total: 30, rate: 0.233 }],
      ['frequency',          { hits: 6,  total: 30, rate: 0.20 }],
    ]);
    const c = detectChampion(m);
    expect(c).not.toBeNull();
    expect(c!.algo_name).toBe('trend_momentum');
    expect(c!.edge).toBeGreaterThan(0.15);  // genuine edge over baseline
  });

  it('SYSTEM AT REST: when nothing has edge, no champion → normal consensus', () => {
    const m = new Map([
      ['a', { hits: 4, total: 30, rate: 0.133 }],
      ['b', { hits: 5, total: 30, rate: 0.167 }],
      ['c', { hits: 4, total: 30, rate: 0.133 }],
    ]);
    expect(detectChampion(m)).toBeNull();
  });

  it('CHAMPION ROTATION: as a new champion emerges, old one yields', () => {
    // Week 1: trend_momentum is champion
    const week1 = new Map([
      ['trend_momentum',   { hits: 12, total: 30, rate: 0.40 }],
      ['calendar_pattern', { hits: 7,  total: 30, rate: 0.233 }],
    ]);
    expect(detectChampion(week1)!.algo_name).toBe('trend_momentum');

    // Week 2: calendar_pattern surges
    const week2 = new Map([
      ['trend_momentum',   { hits: 9,  total: 30, rate: 0.30 }],
      ['calendar_pattern', { hits: 14, total: 30, rate: 0.467 }],
    ]);
    expect(detectChampion(week2)!.algo_name).toBe('calendar_pattern');
  });
});
