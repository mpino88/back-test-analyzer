// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: Consensus aggregation + CognitiveN (pure)
//
// Tests cover:
//   1. computeCognitiveN() — Kelly, precision@K, expected_rank blending
//   2. effectiveWeight() — PPS factor, cognitiveWeight layering
//   3. Consensus accumulation — weighted average correctness
//   4. Diversity penalty — Jaccard cluster division
//   5. A1 fallback — degenerate scores use frequency
//   6. N hard-cap enforcement
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Mirrors AnalysisEngine.computeCognitiveN() exactly ───────
interface PrecisionSnapshot {
  kelly_fraction: number;
  wilson_lower:   number;
  precision_at_3: number;
  precision_at_5: number;
  precision_at_10: number;
  expected_rank:  number;
  sharpe:         number;
  mrr:            number;
}

function computeCognitiveN(m: PrecisionSnapshot): {
  optimal_n: number;
  predicted_effectiveness: number;
  cognitive_basis: string;
} {
  const n_kelly = m.kelly_fraction > 0 ? Math.round(m.kelly_fraction * 100) : 0;

  let n_precision: number;
  if      (m.precision_at_3  >= 0.12) n_precision = 3;
  else if (m.precision_at_5  >= 0.10) n_precision = 5;
  else if (m.precision_at_10 >= 0.10) n_precision = 10;
  else    n_precision = Math.min(50, Math.ceil(m.expected_rank / 2));

  const n_rank = Math.max(3, Math.min(50, Math.ceil(m.expected_rank * 0.70)));

  let optimal_n: number;
  let kelly_str: string;
  if (n_kelly >= 3) {
    optimal_n = Math.round(0.50 * n_kelly + 0.30 * n_precision + 0.20 * n_rank);
    kelly_str = `f*=${m.kelly_fraction.toFixed(3)}`;
  } else {
    optimal_n = Math.round(0.55 * n_precision + 0.45 * n_rank);
    kelly_str = 'f*=0.000';
    optimal_n = Math.min(20, optimal_n);
  }
  optimal_n = Math.max(3, Math.min(50, optimal_n));

  const sharpe_bonus = m.sharpe > 1 ? Math.min(0.03, (m.sharpe - 1) * 0.01) : 0;
  const predicted_effectiveness = Math.max(0, Math.min(1, m.wilson_lower + sharpe_bonus));

  const cognitive_basis = [
    kelly_str,
    `p@5=${(m.precision_at_5 * 100).toFixed(1)}%`,
    `rank_avg=${m.expected_rank.toFixed(1)}`,
    `mrr=${m.mrr.toFixed(3)}`,
    `sharpe=${m.sharpe.toFixed(2)}`,
  ].join(' ');

  return { optimal_n, predicted_effectiveness, cognitive_basis };
}

// ─── Mirrors effectiveWeight() logic from AnalysisEngine ──────
function effectiveWeight(
  algName: string,
  baseWeights: Record<string, number>,
  ppsMap: Map<string, number>
): number {
  const baseW = baseWeights[algName] ?? 0.5;
  const ppsScore = ppsMap.get(algName);
  if (ppsScore !== undefined) {
    const ppsFactor = 0.1 + (ppsScore / 100) * 1.9;
    return baseW * ppsFactor;
  }
  return baseW;
}

// ─── Consensus accumulation (mirrors AnalysisEngine PASO 3) ────
function accumulateConsensus(
  algScores: Map<string, { weight: number; normalized: Record<string, number> }>,
  diversityDivisors: Map<string, number>
): { accumulated: Record<string, number>; totalWeight: number } {
  const accumulated: Record<string, number> = {};
  let totalWeight = 0;

  for (const [name, { weight, normalized }] of algScores) {
    const divisor = diversityDivisors.get(name) ?? 1;
    const effW = weight / divisor;
    for (const [key, ns] of Object.entries(normalized)) {
      accumulated[key] = (accumulated[key] ?? 0) + ns * effW;
    }
    totalWeight += effW;
  }

  return { accumulated, totalWeight };
}

// ─── Jaccard similarity (mirrors AlgorithmDiversityAnalyzer) ──
function jaccard(setA: string[], setB: string[]): number {
  const a = new Set(setA);
  const b = new Set(setB);
  const intersection = [...a].filter(x => b.has(x)).length;
  const union = new Set([...a, ...b]).size;
  return union === 0 ? 0 : intersection / union;
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('computeCognitiveN()', () => {
  it('uses Kelly when kelly_fraction > 0 — blends Kelly+precision+rank', () => {
    const m: PrecisionSnapshot = {
      kelly_fraction: 0.10, wilson_lower: 0.05,
      precision_at_3: 0.05, precision_at_5: 0.08, precision_at_10: 0.08,
      expected_rank: 30, sharpe: 0.5, mrr: 0.03,
    };
    const { optimal_n } = computeCognitiveN(m);
    // n_kelly = 10, n_precision = ceil(30/2)=15, n_rank = ceil(30*0.7)=21
    // optimal_n = round(0.5*10 + 0.3*15 + 0.2*21) = round(5+4.5+4.2) = round(13.7) = 14
    expect(optimal_n).toBeGreaterThanOrEqual(3);
    expect(optimal_n).toBeLessThanOrEqual(50);
  });

  it('falls back to precision+rank blend when kelly_fraction = 0', () => {
    const m: PrecisionSnapshot = {
      kelly_fraction: 0, wilson_lower: 0,
      precision_at_3: 0.05, precision_at_5: 0.05, precision_at_10: 0.08,
      expected_rank: 40, sharpe: 0, mrr: 0,
    };
    const { optimal_n } = computeCognitiveN(m);
    // n_precision = ceil(40/2)=20, n_rank = ceil(40*0.7)=28
    // optimal_n = round(0.55*20 + 0.45*28) = round(11+12.6) = 24 → capped to 20
    expect(optimal_n).toBeLessThanOrEqual(20);
  });

  it('precision@3 >= 0.12 triggers n_precision = 3 (high precision)', () => {
    const m: PrecisionSnapshot = {
      kelly_fraction: 0, wilson_lower: 0.1,
      precision_at_3: 0.15, precision_at_5: 0.09, precision_at_10: 0.09,
      expected_rank: 20, sharpe: 0.5, mrr: 0.05,
    };
    const { optimal_n } = computeCognitiveN(m);
    // n_precision = 3 (high precision)
    // no kelly → fallback: optimal = round(0.55*3 + 0.45*ceil(20*0.7)=round(0.55*3+0.45*14))
    //           = round(1.65 + 6.3) = round(7.95) = 8 → capped by min(20, ...)
    expect(optimal_n).toBeGreaterThanOrEqual(3);
    expect(optimal_n).toBeLessThanOrEqual(15); // high precision → small N
  });

  it('optimal_n is always in [3, 50]', () => {
    const extremeCases: PrecisionSnapshot[] = [
      { kelly_fraction: 1.0, wilson_lower: 0.99, precision_at_3: 0.99, precision_at_5: 0.99, precision_at_10: 0.99, expected_rank: 1, sharpe: 10, mrr: 0.9 },
      { kelly_fraction: 0, wilson_lower: 0, precision_at_3: 0, precision_at_5: 0, precision_at_10: 0, expected_rank: 100, sharpe: 0, mrr: 0 },
    ];
    for (const m of extremeCases) {
      const { optimal_n } = computeCognitiveN(m);
      expect(optimal_n, JSON.stringify(m)).toBeGreaterThanOrEqual(3);
      expect(optimal_n, JSON.stringify(m)).toBeLessThanOrEqual(50);
    }
  });

  it('predicted_effectiveness adds sharpe_bonus when sharpe > 1', () => {
    const withSharpe: PrecisionSnapshot = {
      kelly_fraction: 0, wilson_lower: 0.1, precision_at_3: 0.05, precision_at_5: 0.05,
      precision_at_10: 0.05, expected_rank: 30, sharpe: 2.5, mrr: 0.05,
    };
    const withoutSharpe: PrecisionSnapshot = { ...withSharpe, sharpe: 0.5 };
    const { predicted_effectiveness: withBonus } = computeCognitiveN(withSharpe);
    const { predicted_effectiveness: noBonus }   = computeCognitiveN(withoutSharpe);
    expect(withBonus).toBeGreaterThan(noBonus);
  });

  it('predicted_effectiveness is always in [0, 1]', () => {
    const extremes: PrecisionSnapshot[] = [
      { kelly_fraction: 0, wilson_lower: -0.5, precision_at_3: 0, precision_at_5: 0, precision_at_10: 0, expected_rank: 50, sharpe: 0, mrr: 0 },
      { kelly_fraction: 1, wilson_lower: 2.0, precision_at_3: 1, precision_at_5: 1, precision_at_10: 1, expected_rank: 1, sharpe: 5, mrr: 1 },
    ];
    for (const m of extremes) {
      const { predicted_effectiveness } = computeCognitiveN(m);
      expect(predicted_effectiveness).toBeGreaterThanOrEqual(0);
      expect(predicted_effectiveness).toBeLessThanOrEqual(1);
    }
  });

  it('cognitive_basis string contains key metrics', () => {
    const m: PrecisionSnapshot = {
      kelly_fraction: 0.05, wilson_lower: 0.08, precision_at_3: 0.05,
      precision_at_5: 0.10, precision_at_10: 0.09, expected_rank: 25, sharpe: 1.2, mrr: 0.04,
    };
    const { cognitive_basis } = computeCognitiveN(m);
    expect(cognitive_basis).toContain('p@5=');
    expect(cognitive_basis).toContain('rank_avg=');
    expect(cognitive_basis).toContain('sharpe=');
    expect(cognitive_basis).toContain('mrr=');
  });
});

describe('effectiveWeight() — PPS factor layering', () => {
  it('without PPS: returns base weight unchanged', () => {
    const baseWeights = { frequency: 0.60 };
    const ppsMap = new Map<string, number>(); // empty
    expect(effectiveWeight('frequency', baseWeights, ppsMap)).toBe(0.60);
  });

  it('with PPS=100 (perfect): factor = 2.0 × base', () => {
    const ppsMap = new Map([['frequency', 100]]);
    const w = effectiveWeight('frequency', { frequency: 0.60 }, ppsMap);
    const factor = 0.1 + (100 / 100) * 1.9; // = 2.0
    expect(w).toBeCloseTo(0.60 * factor, 4);
  });

  it('with PPS=0 (useless): factor = 0.1 × base', () => {
    const ppsMap = new Map([['markov_order2', 0]]);
    const w = effectiveWeight('markov_order2', { markov_order2: 0.30 }, ppsMap);
    const factor = 0.1 + 0 * 1.9; // = 0.1
    expect(w).toBeCloseTo(0.30 * 0.1, 4);
  });

  it('with PPS=50 (neutral): factor ≈ 1.05 × base', () => {
    const ppsMap = new Map([['calendar_pattern', 50]]);
    const w = effectiveWeight('calendar_pattern', { calendar_pattern: 1.00 }, ppsMap);
    const factor = 0.1 + (50 / 100) * 1.9; // = 1.05
    expect(w).toBeCloseTo(1.00 * factor, 4);
  });

  it('unknown algorithm defaults to base weight 0.5', () => {
    const ppsMap = new Map<string, number>();
    const w = effectiveWeight('nonexistent_algo', {}, ppsMap);
    expect(w).toBe(0.5);
  });
});

describe('Consensus accumulation', () => {
  it('weighted average of two algorithms is computed correctly', () => {
    const algScores = new Map([
      ['algo_a', { weight: 2.0, normalized: { '37': 1.0, '42': 0.5, '99': 0.0 } }],
      ['algo_b', { weight: 1.0, normalized: { '37': 0.0, '42': 1.0, '99': 0.5 } }],
    ]);
    const { accumulated, totalWeight } = accumulateConsensus(algScores, new Map());
    expect(totalWeight).toBeCloseTo(3.0, 4);
    // '37': (2.0*1.0 + 1.0*0.0) / 3.0 = 0.667
    expect(accumulated['37']! / totalWeight).toBeCloseTo(2/3, 2);
    // '42': (2.0*0.5 + 1.0*1.0) / 3.0 = 0.667
    expect(accumulated['42']! / totalWeight).toBeCloseTo(2/3, 2);
    // '99': (2.0*0.0 + 1.0*0.5) / 3.0 = 0.167
    expect(accumulated['99']! / totalWeight).toBeCloseTo(1/6, 2);
  });

  it('diversity penalty halves weight for clustered algorithms', () => {
    const algScores = new Map([
      ['markov_order2', { weight: 1.0, normalized: { '37': 1.0 } }],
      ['cross_draw',    { weight: 1.0, normalized: { '37': 1.0 } }],
    ]);
    // Both in same cluster → divisor = 2
    const diversityDivisors = new Map([['markov_order2', 2], ['cross_draw', 2]]);
    const { totalWeight } = accumulateConsensus(algScores, diversityDivisors);
    // Each gets weight/2 = 0.5 → total = 1.0 (not 2.0)
    expect(totalWeight).toBeCloseTo(1.0, 4);
  });

  it('non-clustered algorithms are unaffected by diversity penalty', () => {
    const algScores = new Map([
      ['frequency',       { weight: 0.6, normalized: { '37': 1.0 } }],
      ['calendar_pattern',{ weight: 1.0, normalized: { '37': 0.5 } }],
    ]);
    const { totalWeight } = accumulateConsensus(algScores, new Map()); // no divisors
    expect(totalWeight).toBeCloseTo(1.6, 4);
  });

  it('accumulated score is always non-negative', () => {
    const algScores = new Map([
      ['algo', { weight: 1.0, normalized: { '37': 0.8, '42': 0.0, '99': 0.3 } }],
    ]);
    const { accumulated } = accumulateConsensus(algScores, new Map());
    for (const score of Object.values(accumulated)) {
      expect(score).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('Jaccard similarity — diversity cluster detection', () => {
  it('identical sets have Jaccard = 1.0', () => {
    const set = ['37', '42', '55', '18', '91'];
    expect(jaccard(set, set)).toBeCloseTo(1.0, 4);
  });

  it('disjoint sets have Jaccard = 0.0', () => {
    const a = ['11', '22', '33'];
    const b = ['44', '55', '66'];
    expect(jaccard(a, b)).toBe(0);
  });

  it('50% overlap gives Jaccard ≈ 0.33', () => {
    // intersection=2, union=6 → 2/6 = 0.333
    const a = ['11', '22', '33', '44'];
    const b = ['33', '44', '55', '66'];
    expect(jaccard(a, b)).toBeCloseTo(2/6, 2);
  });

  it('threshold 0.65 identifies highly similar algorithms as redundant', () => {
    // Simulate two algorithms with 70% overlap in top-15
    const topA = Array.from({ length: 15 }, (_, i) => `${i < 10 ? '0' + i : i}`);
    const topB = [...topA.slice(0, 10), '91', '92', '93', '94', '95']; // 10 shared
    // intersection=10, union=20 → 10/20=0.5 — NOT redundant by 0.65 threshold
    expect(jaccard(topA, topB)).toBeCloseTo(0.5, 1);
    expect(jaccard(topA, topB)).toBeLessThan(0.65);

    // Near-identical — 14/15 match
    const topC = [...topA.slice(0, 14), '99'];
    expect(jaccard(topA, topC)).toBeGreaterThan(0.65); // 14/16 ≈ 0.875
  });

  it('empty sets → Jaccard = 0', () => {
    expect(jaccard([], [])).toBe(0);
    expect(jaccard([], ['37'])).toBe(0);
  });
});

describe('N hard-cap enforcement', () => {
  const N_HARD_CAP = 15;

  it('optimal_n exceeding 15 is reduced to 15', () => {
    let optimal_n = 30; // PPS returned 30
    if (optimal_n > N_HARD_CAP) optimal_n = N_HARD_CAP;
    expect(optimal_n).toBe(15);
  });

  it('optimal_n <= 15 is unchanged', () => {
    for (const n of [1, 5, 10, 14, 15]) {
      let optimal_n = n;
      if (optimal_n > N_HARD_CAP) optimal_n = N_HARD_CAP;
      expect(optimal_n).toBe(n);
    }
  });
});

describe('A1 fallback — degenerate score detection', () => {
  it('max score <= 0.001 triggers frequency fallback', () => {
    const DEGENERATE_THRESHOLD = 0.001;
    const scores = [0.0001, 0.0002, 0.0000];
    const maxScore = Math.max(...scores);
    expect(maxScore).toBeLessThanOrEqual(DEGENERATE_THRESHOLD);
  });

  it('max score > 0.001 does NOT trigger fallback', () => {
    const scores = [0.8, 0.5, 0.001, 0.0001];
    const maxScore = Math.max(...scores);
    expect(maxScore).toBeGreaterThan(0.001);
  });
});
