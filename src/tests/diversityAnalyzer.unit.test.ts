// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: AlgorithmDiversityAnalyzer (pure logic, no DB)
//
// Tests cover:
//   1. Jaccard similarity calculation (correct formula)
//   2. Redundancy detection (threshold 0.65)
//   3. Cluster building (transitive closure / union-find)
//   4. Diversity score computation [0, 1]
//   5. Recommendation thresholds: healthy/redundant/collapsed
//   6. Divisor assignment from clusters
//   7. Edge cases: < 2 algos, identical rankings, disjoint rankings
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Pure implementation (mirrors AlgorithmDiversityAnalyzer.ts) ──

const REDUNDANCY_THRESHOLD = 0.65;

interface AlgoOverlap {
  algo_a: string; algo_b: string;
  jaccard: number; shared: number; redundant: boolean;
}

interface DiversityReport {
  total_algos:          number;
  overlap_pairs:        AlgoOverlap[];
  redundancy_clusters:  string[][];
  diversity_score:      number;
  recommendation:       'healthy' | 'redundant' | 'collapsed';
}

function computeJaccard(setA: Set<string>, setB: Set<string>): number {
  const intersection = [...setA].filter(x => setB.has(x)).length;
  const union = new Set([...setA, ...setB]).size;
  return union > 0 ? intersection / union : 0;
}

function buildClusters(algos: string[], overlaps: AlgoOverlap[]): string[][] {
  const parent = new Map<string, string>();
  for (const a of algos) parent.set(a, a);

  const find = (x: string): string => {
    if (parent.get(x) === x) return x;
    const root = find(parent.get(x)!);
    parent.set(x, root);
    return root;
  };
  const union = (a: string, b: string): void => {
    const ra = find(a), rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  };

  for (const o of overlaps) {
    if (o.redundant) union(o.algo_a, o.algo_b);
  }

  const groups = new Map<string, string[]>();
  for (const a of algos) {
    const root = find(a);
    const g = groups.get(root) ?? [];
    g.push(a);
    groups.set(root, g);
  }
  return [...groups.values()].filter(g => g.length > 1);
}

function analyze(algoScores: Map<string, Record<string, number>>, topN = 15): DiversityReport {
  const algos = Array.from(algoScores.keys());
  if (algos.length < 2) {
    return { total_algos: algos.length, overlap_pairs: [], redundancy_clusters: [], diversity_score: 1.0, recommendation: 'healthy' };
  }

  const topSets = new Map<string, Set<string>>();
  for (const a of algos) {
    const scores = algoScores.get(a)!;
    const top = Object.entries(scores)
      .sort(([, x], [, y]) => y - x)
      .slice(0, topN)
      .map(([pair]) => pair);
    topSets.set(a, new Set(top));
  }

  const overlaps: AlgoOverlap[] = [];
  for (let i = 0; i < algos.length; i++) {
    for (let j = i + 1; j < algos.length; j++) {
      const A = topSets.get(algos[i]!)!;
      const B = topSets.get(algos[j]!)!;
      const jac = computeJaccard(A, B);
      overlaps.push({ algo_a: algos[i]!, algo_b: algos[j]!, jaccard: +jac.toFixed(3), shared: [...A].filter(x => B.has(x)).length, redundant: jac > REDUNDANCY_THRESHOLD });
    }
  }
  overlaps.sort((a, b) => b.jaccard - a.jaccard);

  const clusters = buildClusters(algos, overlaps);
  const algosInClusters = new Set<string>(clusters.flat());
  const diversity_score = +((1 - algosInClusters.size / algos.length)).toFixed(3);
  const recommendation: DiversityReport['recommendation'] =
    diversity_score >= 0.7 ? 'healthy' :
    diversity_score >= 0.4 ? 'redundant' : 'collapsed';

  return { total_algos: algos.length, overlap_pairs: overlaps.slice(0, 20), redundancy_clusters: clusters, diversity_score, recommendation };
}

// ─── Helpers ──────────────────────────────────────────────────
function makeAlgoWithTopPairs(topPairs: string[], totalPairs = 100): Record<string, number> {
  const scores: Record<string, number> = {};
  for (let x = 0; x <= 9; x++) {
    for (let y = 0; y <= 9; y++) {
      scores[`${x}${y}`] = 0.01; // low baseline
    }
  }
  for (let i = 0; i < topPairs.length; i++) {
    scores[topPairs[i]!] = 1.0 - i * 0.05; // decreasing from 1.0
  }
  return scores;
}

const TOP_15 = ['00','01','02','03','04','05','06','07','08','09','10','11','12','13','14'];
const TOP_15B = ['00','01','02','03','04','05','06','07','08','09','10','11','12','13','99']; // 14/16 overlap

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('computeJaccard()', () => {
  it('identical sets → Jaccard = 1.0', () => {
    const s = new Set(['37', '42', '55']);
    expect(computeJaccard(s, s)).toBeCloseTo(1.0, 4);
  });

  it('completely disjoint sets → Jaccard = 0', () => {
    const a = new Set(['11', '22', '33']);
    const b = new Set(['44', '55', '66']);
    expect(computeJaccard(a, b)).toBe(0);
  });

  it('50% overlap: |A|=4, |B|=4, |A∩B|=2 → 2/6 ≈ 0.333', () => {
    const a = new Set(['11', '22', '33', '44']);
    const b = new Set(['33', '44', '55', '66']);
    expect(computeJaccard(a, b)).toBeCloseTo(2/6, 3);
  });

  it('14/16 overlap ≈ 0.875 (above redundancy threshold)', () => {
    const a = new Set(TOP_15);
    const b = new Set(TOP_15B);
    const j = computeJaccard(a, b);
    expect(j).toBeGreaterThan(REDUNDANCY_THRESHOLD);
  });

  it('empty sets → Jaccard = 0', () => {
    expect(computeJaccard(new Set(), new Set())).toBe(0);
  });

  it('one empty, one non-empty → Jaccard = 0', () => {
    expect(computeJaccard(new Set(['37']), new Set())).toBe(0);
  });
});

describe('analyze() — redundancy detection', () => {
  it('marks pair as redundant when Jaccard > 0.65', () => {
    const scores = new Map([
      ['markov_order2', makeAlgoWithTopPairs(TOP_15)],
      ['cross_draw',    makeAlgoWithTopPairs(TOP_15B)], // 14/16 overlap
    ]);
    const report = analyze(scores, 15);
    expect(report.overlap_pairs[0]!.redundant).toBe(true);
    expect(report.overlap_pairs[0]!.jaccard).toBeGreaterThan(REDUNDANCY_THRESHOLD);
  });

  it('does NOT mark pair as redundant when Jaccard <= 0.65', () => {
    const differentTop = Array.from({ length: 15 }, (_, i) => `${Math.floor(i/10)}${i%10}`);
    const anotherTop   = ['99','98','97','96','95','94','93','92','91','90','89','88','87','86','85'];
    const scores = new Map([
      ['algo_a', makeAlgoWithTopPairs(differentTop)],
      ['algo_b', makeAlgoWithTopPairs(anotherTop)],
    ]);
    const report = analyze(scores, 15);
    // No overlap between low and high pairs → Jaccard ≈ 0 → not redundant
    expect(report.overlap_pairs[0]!.redundant).toBe(false);
  });

  it('returns all pairwise overlaps (n choose 2 for n algos)', () => {
    const scores = new Map([
      ['a', makeAlgoWithTopPairs(TOP_15)],
      ['b', makeAlgoWithTopPairs(TOP_15B)],
      ['c', makeAlgoWithTopPairs(['90','91','92','93','94','95','96','97','98','99','80','81','82','83','84'])],
    ]);
    const report = analyze(scores, 15);
    // 3 algos → C(3,2) = 3 pairwise comparisons
    expect(report.overlap_pairs.length).toBe(3);
  });
});

describe('Cluster building (union-find)', () => {
  it('two redundant algos form a cluster of 2', () => {
    const scores = new Map([
      ['markov_order2', makeAlgoWithTopPairs(TOP_15)],
      ['cross_draw',    makeAlgoWithTopPairs(TOP_15B)],
    ]);
    const report = analyze(scores, 15);
    expect(report.redundancy_clusters).toHaveLength(1);
    expect(report.redundancy_clusters[0]).toHaveLength(2);
    expect(report.redundancy_clusters[0]).toContain('markov_order2');
    expect(report.redundancy_clusters[0]).toContain('cross_draw');
  });

  it('three mutually redundant algos form a single cluster', () => {
    const scores = new Map([
      ['a', makeAlgoWithTopPairs(TOP_15)],
      ['b', makeAlgoWithTopPairs(TOP_15B)],
      ['c', makeAlgoWithTopPairs(TOP_15)], // same as a → all 3 are redundant
    ]);
    const report = analyze(scores, 15);
    expect(report.redundancy_clusters).toHaveLength(1);
    expect(report.redundancy_clusters[0]).toHaveLength(3);
  });

  it('independent algos produce no clusters', () => {
    const disjointA = ['00','01','02','03','04','05','06','07','08','09','10','11','12','13','14'];
    const disjointB = ['90','91','92','93','94','95','96','97','98','99','80','81','82','83','84'];
    const scores = new Map([
      ['a', makeAlgoWithTopPairs(disjointA)],
      ['b', makeAlgoWithTopPairs(disjointB)],
    ]);
    const report = analyze(scores, 15);
    expect(report.redundancy_clusters).toHaveLength(0);
  });
});

describe('Diversity score', () => {
  it('returns 1.0 when all algos are independent (no clusters)', () => {
    const disjointA = ['00','01','02','03','04','05','06','07','08','09','10','11','12','13','14'];
    const disjointB = ['90','91','92','93','94','95','96','97','98','99','80','81','82','83','84'];
    const scores = new Map([
      ['a', makeAlgoWithTopPairs(disjointA)],
      ['b', makeAlgoWithTopPairs(disjointB)],
    ]);
    expect(analyze(scores, 15).diversity_score).toBe(1.0);
  });

  it('returns 0 when all algos are in one cluster (all redundant)', () => {
    const sameTop = TOP_15;
    const scores = new Map([
      ['a', makeAlgoWithTopPairs(sameTop)],
      ['b', makeAlgoWithTopPairs(sameTop)],
    ]);
    const report = analyze(scores, 15);
    // Both in cluster → 2/2 in clusters → diversity = 1 - 2/2 = 0
    expect(report.diversity_score).toBe(0);
  });

  it('diversity_score is always in [0, 1]', () => {
    const scoreSets = [
      new Map([['a', makeAlgoWithTopPairs(TOP_15)], ['b', makeAlgoWithTopPairs(TOP_15)]]),
      new Map([['a', makeAlgoWithTopPairs(TOP_15)], ['b', makeAlgoWithTopPairs(['99','98','97','96','95','94','93','92','91','90','89','88','87','86','85'])]]),
    ];
    for (const scores of scoreSets) {
      const { diversity_score } = analyze(scores, 15);
      expect(diversity_score).toBeGreaterThanOrEqual(0);
      expect(diversity_score).toBeLessThanOrEqual(1);
    }
  });
});

describe('Recommendation thresholds', () => {
  it('healthy when diversity_score >= 0.7', () => {
    // 2 independent algos → diversity = 1.0 → healthy
    const scores = new Map([
      ['a', makeAlgoWithTopPairs(TOP_15)],
      ['b', makeAlgoWithTopPairs(['90','91','92','93','94','95','96','97','98','99','80','81','82','83','84'])],
    ]);
    expect(analyze(scores, 15).recommendation).toBe('healthy');
  });

  it('returns healthy for < 2 algos (trivially diverse)', () => {
    const scores = new Map([['only', makeAlgoWithTopPairs(TOP_15)]]);
    expect(analyze(scores, 15).recommendation).toBe('healthy');
    expect(analyze(scores, 15).diversity_score).toBe(1.0);
  });
});

describe('Divisor assignment from clusters', () => {
  it('cluster of 2 → each algo gets divisor = 2', () => {
    const scores = new Map([
      ['markov_order2', makeAlgoWithTopPairs(TOP_15)],
      ['cross_draw',    makeAlgoWithTopPairs(TOP_15B)],
    ]);
    const report = analyze(scores, 15);
    // Both in same cluster of 2
    const cluster = report.redundancy_clusters[0]!;
    const divisors = new Map<string, number>();
    for (const c of report.redundancy_clusters) {
      for (const algo of c) divisors.set(algo, c.length);
    }
    expect(divisors.get('markov_order2')).toBe(2);
    expect(divisors.get('cross_draw')).toBe(2);
  });

  it('non-clustered algo gets divisor = 1 (not in any cluster)', () => {
    const scores = new Map([
      ['markov_order2', makeAlgoWithTopPairs(TOP_15)],
      ['cross_draw',    makeAlgoWithTopPairs(TOP_15B)],
      ['calendar_pattern', makeAlgoWithTopPairs(['90','91','92','93','94','95','96','97','98','99','80','81','82','83','84'])],
    ]);
    const report = analyze(scores, 15);
    const divisors = new Map<string, number>();
    for (const c of report.redundancy_clusters) {
      for (const algo of c) divisors.set(algo, c.length);
    }
    // calendar_pattern should NOT be in any cluster
    expect(divisors.has('calendar_pattern')).toBe(false);
    // When used in AnalysisEngine: divisors.get(name) ?? 1 → 1
    expect(divisors.get('calendar_pattern') ?? 1).toBe(1);
  });
});
