// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: PairRecommender (pure logic, no DB)
//
// Tests cover:
//   1. recommend() — top-N slicing, confidence tiers, edge metric
//   2. Confidence tier proportions — MUST/COVER/WATCH invariants
//   3. LLM-validated pairs prioritization (COG-10)
//   4. has_edge calculation — edge >= 3pp
//   5. topNOverride behavior
//   6. recommendPick4() — two halves correctly
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Inline PairRecommender logic (mirrors production exactly) ─
type ConfidenceTiers = { must: string[]; cover: string[]; watch: string[] };

interface PairAnalysis {
  game_type: string;
  half: string;
  ranked_pairs: Array<{ pair: string; score: number }>;
  top_n: number;
  optimal_n: number;
  predicted_effectiveness: number;
  cognitive_basis: string;
  centena_plus?: number;
  draw_type: string;
  executed_at: Date;
  algorithms_succeeded: string[];
  algorithms_failed: Array<{ name: string; error: string }>;
  total_execution_ms: number;
}

interface PairRecommendation {
  game_type: string;
  half: string;
  pairs: string[];
  tiers: ConfidenceTiers;
  centena_plus?: number;
  top_n: number;
  confidence: number;
  strategy: string;
  optimal_n: number;
  predicted_effectiveness: number;
  cognitive_basis: string;
  baseline_random: number;
  expected_edge: number;
  has_edge: boolean;
}

function recommend(
  analysis: PairAnalysis,
  topNOverride?: number,
  validatedPairs?: string[]
): PairRecommendation {
  const n = topNOverride ?? analysis.optimal_n;

  let finalPairs: string[] = [];
  if (validatedPairs && validatedPairs.length > 0) {
    const llmSet = new Set(validatedPairs);
    const fromLLM = analysis.ranked_pairs.filter(r => llmSet.has(r.pair)).map(r => r.pair);
    const remaining = analysis.ranked_pairs
      .filter(r => !llmSet.has(r.pair))
      .slice(0, Math.max(0, n - fromLLM.length))
      .map(r => r.pair);
    finalPairs = [...fromLLM, ...remaining].slice(0, n);
  } else {
    finalPairs = analysis.ranked_pairs.slice(0, n).map(r => r.pair);
  }

  const topScore = analysis.ranked_pairs[0]?.score ?? 1;
  const topSlice = analysis.ranked_pairs.filter(r => finalPairs.includes(r.pair));
  const avgScore = topScore > 0
    ? topSlice.reduce((sum, r) => sum + r.score, 0) / (topSlice.length || 1) / topScore
    : 0;

  const mustCount  = Math.max(1, Math.ceil(finalPairs.length * 0.30));
  const coverCount = Math.ceil(finalPairs.length * 0.50);
  const tiers: ConfidenceTiers = {
    must:  finalPairs.slice(0, mustCount),
    cover: finalPairs.slice(mustCount, mustCount + coverCount),
    watch: finalPairs.slice(mustCount + coverCount),
  };

  const baseline_random = +(n / 100).toFixed(4);
  const expected_edge   = +(analysis.predicted_effectiveness - baseline_random).toFixed(4);
  const has_edge        = expected_edge >= 0.03;

  return {
    game_type:               analysis.game_type,
    half:                    analysis.half,
    pairs:                   finalPairs,
    tiers,
    centena_plus:            analysis.centena_plus,
    top_n:                   n,
    confidence:              +Math.min(1, avgScore).toFixed(3),
    strategy:                'apex_consensus_v2',
    optimal_n:               analysis.optimal_n,
    predicted_effectiveness: analysis.predicted_effectiveness,
    cognitive_basis:         analysis.cognitive_basis,
    baseline_random,
    expected_edge,
    has_edge,
  };
}

// ─── Helpers ──────────────────────────────────────────────────
function makeAnalysis(opts: {
  n?: number;
  pairs?: string[];
  effectiveness?: number;
  scores?: number[];
}): PairAnalysis {
  const n = opts.n ?? 10;
  // Build 100 pairs sorted by score
  const allPairs: Array<{ pair: string; score: number }> = [];
  for (let x = 0; x <= 9; x++) {
    for (let y = 0; y <= 9; y++) {
      allPairs.push({ pair: `${x}${y}`, score: 1.0 });
    }
  }
  // Apply custom scores if provided
  if (opts.pairs && opts.scores) {
    for (let i = 0; i < opts.pairs.length; i++) {
      const entry = allPairs.find(p => p.pair === opts.pairs![i]);
      if (entry) entry.score = opts.scores[i] ?? 1.0;
    }
  }
  // Sort descending
  allPairs.sort((a, b) => b.score - a.score);

  return {
    game_type:          'pick3',
    half:               'du',
    ranked_pairs:       allPairs,
    top_n:              n,
    optimal_n:          n,
    predicted_effectiveness: opts.effectiveness ?? 0.15,
    cognitive_basis:    'test',
    draw_type:          'midday',
    executed_at:        new Date(),
    algorithms_succeeded: ['frequency'],
    algorithms_failed:  [],
    total_execution_ms: 10,
  };
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('recommend() — basic invariants', () => {
  it('returns exactly top_n pairs when no override', () => {
    const analysis = makeAnalysis({ n: 10 });
    const rec = recommend(analysis);
    expect(rec.pairs).toHaveLength(10);
  });

  it('topNOverride takes precedence over optimal_n', () => {
    const analysis = makeAnalysis({ n: 10 });
    const rec = recommend(analysis, 5);
    expect(rec.pairs).toHaveLength(5);
    expect(rec.top_n).toBe(5);
  });

  it('all pairs are unique', () => {
    const analysis = makeAnalysis({ n: 15 });
    const rec = recommend(analysis);
    const unique = new Set(rec.pairs);
    expect(unique.size).toBe(15);
  });

  it('pairs are valid 2-digit strings (00-99)', () => {
    const analysis = makeAnalysis({ n: 10 });
    const rec = recommend(analysis);
    for (const pair of rec.pairs) {
      expect(pair).toHaveLength(2);
      expect(/^\d\d$/.test(pair)).toBe(true);
    }
  });

  it('strategy is always apex_consensus_v2', () => {
    const rec = recommend(makeAnalysis({ n: 10 }));
    expect(rec.strategy).toBe('apex_consensus_v2');
  });
});

describe('recommend() — confidence tiers', () => {
  it('tier sizes follow 30/50/20 split proportions', () => {
    const n = 10;
    const rec = recommend(makeAnalysis({ n }));
    const mustCount  = Math.max(1, Math.ceil(n * 0.30)); // 3
    const coverCount = Math.ceil(n * 0.50);              // 5
    const watchCount = n - mustCount - coverCount;       // 2

    expect(rec.tiers.must).toHaveLength(mustCount);
    expect(rec.tiers.cover).toHaveLength(coverCount);
    expect(rec.tiers.watch).toHaveLength(watchCount);
  });

  it('tier union = pairs (complete coverage, no duplicates)', () => {
    const n = 15;
    const rec = recommend(makeAnalysis({ n }));
    const allTierPairs = [...rec.tiers.must, ...rec.tiers.cover, ...rec.tiers.watch];
    expect(allTierPairs).toHaveLength(n);
    expect(new Set(allTierPairs).size).toBe(n);
    // Every pair in tiers should be in rec.pairs
    for (const p of allTierPairs) {
      expect(rec.pairs).toContain(p);
    }
  });

  it('must tier always has at least 1 pair', () => {
    const rec = recommend(makeAnalysis({ n: 1 }));
    expect(rec.tiers.must.length).toBeGreaterThanOrEqual(1);
  });

  it('must tier contains highest-ranked pairs', () => {
    const rec = recommend(makeAnalysis({ n: 10 }));
    const mustSet = new Set(rec.tiers.must);
    // First pair in rec.pairs must be in must tier
    expect(mustSet.has(rec.pairs[0]!)).toBe(true);
  });

  it('tiers are non-overlapping', () => {
    const rec = recommend(makeAnalysis({ n: 20 }));
    const mustSet  = new Set(rec.tiers.must);
    const coverSet = new Set(rec.tiers.cover);
    const watchSet = new Set(rec.tiers.watch);

    for (const p of coverSet) expect(mustSet.has(p)).toBe(false);
    for (const p of watchSet) {
      expect(mustSet.has(p)).toBe(false);
      expect(coverSet.has(p)).toBe(false);
    }
  });
});

describe('recommend() — LLM validated pairs integration (COG-10)', () => {
  it('LLM-validated pairs appear before unvalidated pairs', () => {
    const analysis = makeAnalysis({ n: 10 });
    // Force "99" to be lowest score (last in ranking)
    const lastPair = analysis.ranked_pairs[analysis.ranked_pairs.length - 1]!.pair;
    const rec = recommend(analysis, undefined, [lastPair]);
    // The LLM pair should be first (highest priority)
    expect(rec.pairs[0]).toBe(lastPair);
  });

  it('LLM pairs that are not in ranked_pairs are ignored', () => {
    const analysis = makeAnalysis({ n: 5 });
    // "XX" is not a valid pair in ranked_pairs
    const rec = recommend(analysis, undefined, ['INVALID_PAIR']);
    expect(rec.pairs).toHaveLength(5);
    expect(rec.pairs).not.toContain('INVALID_PAIR');
  });

  it('multiple LLM pairs all appear at the front', () => {
    const analysis = makeAnalysis({ n: 10 });
    // Pick last 3 pairs from ranking — lowest scores
    const last3 = analysis.ranked_pairs.slice(-3).map(p => p.pair);
    const rec = recommend(analysis, undefined, last3);
    // First 3 should be the LLM-validated ones
    for (const llmPair of last3) {
      expect(rec.pairs.slice(0, 3)).toContain(llmPair);
    }
  });

  it('total pairs = top_n even with LLM pairs', () => {
    const analysis = makeAnalysis({ n: 8 });
    const validatedPairs = ['37', '42', '55'];
    const rec = recommend(analysis, undefined, validatedPairs);
    expect(rec.pairs).toHaveLength(8);
  });

  it('without LLM validation, pairs follow engine ranking order', () => {
    const analysis = makeAnalysis({ n: 5 });
    const rec = recommend(analysis);
    // Should match top-5 of ranked_pairs
    const expected = analysis.ranked_pairs.slice(0, 5).map(p => p.pair);
    expect(rec.pairs).toEqual(expected);
  });
});

describe('recommend() — edge metric', () => {
  it('has_edge = true when predicted_effectiveness - baseline >= 0.03', () => {
    // N=10: baseline=0.10. effectiveness=0.15 → edge=0.05 → has_edge=true
    const rec = recommend(makeAnalysis({ n: 10, effectiveness: 0.15 }));
    expect(rec.expected_edge).toBeCloseTo(0.05, 2);
    expect(rec.has_edge).toBe(true);
  });

  it('has_edge = false when predicted_effectiveness - baseline < 0.03', () => {
    // N=10: baseline=0.10. effectiveness=0.12 → edge=0.02 → has_edge=false
    const rec = recommend(makeAnalysis({ n: 10, effectiveness: 0.12 }));
    expect(rec.has_edge).toBe(false);
  });

  it('baseline_random = N/100', () => {
    const n = 15;
    const rec = recommend(makeAnalysis({ n }));
    expect(rec.baseline_random).toBeCloseTo(n / 100, 4);
  });

  it('expected_edge = predicted_effectiveness - baseline_random', () => {
    const analysis = makeAnalysis({ n: 10, effectiveness: 0.20 });
    const rec = recommend(analysis);
    expect(rec.expected_edge).toBeCloseTo(rec.predicted_effectiveness - rec.baseline_random, 4);
  });

  it('has_edge = false when effectiveness = 0 (no-signal system)', () => {
    const rec = recommend(makeAnalysis({ n: 10, effectiveness: 0 }));
    expect(rec.has_edge).toBe(false);
    expect(rec.expected_edge).toBeLessThan(0.03);
  });
});

describe('recommend() — confidence score', () => {
  it('confidence is always in [0, 1]', () => {
    const rec = recommend(makeAnalysis({ n: 15 }));
    expect(rec.confidence).toBeGreaterThanOrEqual(0);
    expect(rec.confidence).toBeLessThanOrEqual(1);
  });

  it('confidence = 0 when all scores are 0', () => {
    const analysis = makeAnalysis({ n: 5 });
    // Override all scores to 0
    for (const p of analysis.ranked_pairs) p.score = 0;
    const rec = recommend(analysis);
    expect(rec.confidence).toBe(0);
  });
});

describe('recommendPick4() — two halves', () => {
  function recommendPick4(
    abAnalysis: PairAnalysis,
    cdAnalysis: PairAnalysis,
    topNOverride?: number,
    abValidated?: string[],
    cdValidated?: string[]
  ): PairRecommendation[] {
    return [
      recommend(abAnalysis, topNOverride, abValidated),
      recommend(cdAnalysis, topNOverride, cdValidated),
    ];
  }

  it('returns exactly 2 recommendations', () => {
    const ab = makeAnalysis({ n: 10 });
    const cd = makeAnalysis({ n: 10 });
    ab.half = 'ab'; cd.half = 'cd';
    const recs = recommendPick4(ab, cd);
    expect(recs).toHaveLength(2);
  });

  it('first rec is for AB half, second for CD half', () => {
    const ab = makeAnalysis({ n: 10 }); ab.half = 'ab';
    const cd = makeAnalysis({ n: 10 }); cd.half = 'cd';
    const recs = recommendPick4(ab, cd);
    expect(recs[0]!.half).toBe('ab');
    expect(recs[1]!.half).toBe('cd');
  });

  it('topNOverride applies to both halves', () => {
    const ab = makeAnalysis({ n: 10 }); ab.half = 'ab';
    const cd = makeAnalysis({ n: 10 }); cd.half = 'cd';
    const recs = recommendPick4(ab, cd, 5);
    expect(recs[0]!.pairs).toHaveLength(5);
    expect(recs[1]!.pairs).toHaveLength(5);
  });

  it('AB and CD can have independent validated pairs', () => {
    const ab = makeAnalysis({ n: 10 }); ab.half = 'ab';
    const cd = makeAnalysis({ n: 10 }); cd.half = 'cd';
    const abValidated = ['11'];
    const cdValidated = ['99'];
    const recs = recommendPick4(ab, cd, undefined, abValidated, cdValidated);
    expect(recs[0]!.pairs[0]).toBe('11');
    expect(recs[1]!.pairs[0]).toBe('99');
  });
});
