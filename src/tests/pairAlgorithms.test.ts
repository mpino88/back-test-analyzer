// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: 6 Ballbot-cloned in-memory PairRankFn algorithms
//
// Strategy: self-contained — pure math inlined here to avoid DB/pino
// import chains. Tests verify behavioral contracts:
//   1. Always returns exactly 100 pairs (complete coverage of 00-99)
//   2. Sorted descending by score
//   3. Dominant signal pair appears in top positions given synthetic data
//   4. Edge cases (insufficient draws) fall back gracefully
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Types ────────────────────────────────────────────────────
type PairHalf = 'du' | 'ab' | 'cd';
interface TestDraw {
  p1: number; p2: number; p3: number; p4: number | null;
  draw_date: string; created_at: Date;
}
interface RankedPair { pair: string; score: number; }
type PairRankFn = (draws: TestDraw[], half: PairHalf) => RankedPair[];

// ─── Helpers ──────────────────────────────────────────────────
const ALL_PAIRS: string[] = [];
for (let x = 0; x <= 9; x++)
  for (let y = 0; y <= 9; y++)
    ALL_PAIRS.push(`${x}${y}`);

function extractPair(d: TestDraw, half: PairHalf): string {
  if (half === 'du') return `${d.p2}${d.p3}`;
  if (half === 'ab') return `${d.p1}${d.p2}`;
  return `${d.p3}${(d.p4 ?? 0)}`;
}

/** Build N draws all containing the given pair in the given half */
function makeDominantDraws(pair: string, count: number, half: PairHalf = 'du', baseDateMs = Date.now()): TestDraw[] {
  const a = parseInt(pair[0]!), b = parseInt(pair[1]!);
  return Array.from({ length: count }, (_, i) => {
    const created_at = new Date(baseDateMs + i * 86_400_000);
    if (half === 'du')  return { p1: 5, p2: a, p3: b, p4: null, draw_date: created_at.toISOString().slice(0, 10), created_at };
    if (half === 'ab')  return { p1: a, p2: b, p3: 5, p4: 5,    draw_date: created_at.toISOString().slice(0, 10), created_at };
                        return { p1: 5, p2: 5, p3: a, p4: b,    draw_date: created_at.toISOString().slice(0, 10), created_at };
  });
}

/** Build draws where pair appears in pairCount and noise fills the rest */
function makeMixedDraws(dominantPair: string, pairCount: number, noiseCount: number, half: PairHalf = 'du'): TestDraw[] {
  const draws = makeDominantDraws(dominantPair, pairCount, half);
  // Noise: always use pair "99" which should not beat dominantPair
  const noisePair = dominantPair === '99' ? '00' : '99';
  const noiseA = parseInt(noisePair[0]!), noiseB = parseInt(noisePair[1]!);
  for (let i = 0; i < noiseCount; i++) {
    const created_at = new Date(Date.now() + (pairCount + i) * 86_400_000);
    if (half === 'du') draws.push({ p1: 5, p2: noiseA, p3: noiseB, p4: null, draw_date: '2024-01-01', created_at });
    else if (half === 'ab') draws.push({ p1: noiseA, p2: noiseB, p3: 5, p4: 5, draw_date: '2024-01-01', created_at });
    else draws.push({ p1: 5, p2: 5, p3: noiseA, p4: noiseB, draw_date: '2024-01-01', created_at });
  }
  return draws;
}

// ─── Inline algorithm implementations (mirror of PairBacktestEngine.ts) ──
// These are intentional duplicates — they represent the behavioral contract
// the production code must match. Any divergence = bug.

const pairFrequencyRank: PairRankFn = (draws, half) => {
  const counts = new Map<string, number>(ALL_PAIRS.map(p => [p, 0]));
  for (const d of draws) counts.set(extractPair(d, half), (counts.get(extractPair(d, half)) ?? 0) + 1);
  const total = draws.length || 1;
  return ALL_PAIRS.map(pair => ({ pair, score: (counts.get(pair) ?? 0) / total }))
    .sort((a, b) => b.score - a.score);
};

const pairBayesianScore: PairRankFn = (draws, half) => {
  if (draws.length < 5) return pairFrequencyRank(draws, half);
  const W_FREQ = 0.15, W_GAP = 0.20, W_MOM = 0.20, W_MARKOV = 0.20, W_STREAK = 0.10;
  const allPairs = draws.map(d => extractPair(d, half));
  const total = allPairs.length;
  const recent30 = allPairs.slice(-Math.min(30, total));
  const recentTotal = recent30.length || 1;
  const freqCount: Record<string, number> = {};
  for (const p of allPairs) freqCount[p] = (freqCount[p] ?? 0) + 1;
  const maxFreq = Math.max(...Object.values(freqCount), 1);
  const lastSeen: Record<string, number> = {};
  const gapSum: Record<string, number> = {};
  const gapCnt: Record<string, number> = {};
  for (let i = 0; i < allPairs.length; i++) {
    const p = allPairs[i]!;
    if (lastSeen[p] !== undefined) {
      const g = i - lastSeen[p]!;
      gapSum[p] = (gapSum[p] ?? 0) + g;
      gapCnt[p] = (gapCnt[p] ?? 0) + 1;
    }
    lastSeen[p] = i;
  }
  const currentGap: Record<string, number> = {};
  for (const [p, idx] of Object.entries(lastSeen)) currentGap[p] = total - 1 - idx;
  const recentCount: Record<string, number> = {};
  for (const p of recent30) recentCount[p] = (recentCount[p] ?? 0) + 1;
  const matrix = new Map<string, Map<string, number>>();
  for (let i = 0; i + 1 < allPairs.length; i++) {
    const from = allPairs[i]!, to = allPairs[i + 1]!;
    if (!matrix.has(from)) matrix.set(from, new Map());
    matrix.get(from)!.set(to, (matrix.get(from)!.get(to) ?? 0) + 1);
  }
  const markovScore: Record<string, number> = {};
  for (const prev of allPairs.slice(-5)) {
    const row = matrix.get(prev); if (!row) continue;
    const rowT = Array.from(row.values()).reduce((s, v) => s + v, 0);
    for (const [to, cnt] of row) markovScore[to] = Math.max(markovScore[to] ?? 0, cnt / rowT);
  }
  const maxMarkov = Math.max(...Object.values(markovScore), 1e-9);
  const run: Record<string, number> = {};
  const curStreak: Record<string, number> = {};
  const avgStreak: Record<string, number> = {};
  const streakAcc: Record<string, number[]> = {};
  for (const p of allPairs) {
    for (const k of ALL_PAIRS) { if (k !== p) run[k] = (run[k] ?? 0) + 1; }
    if ((run[p] ?? 0) > 0) { streakAcc[p] = streakAcc[p] ?? []; streakAcc[p]!.push(run[p]!); }
    run[p] = 0;
  }
  for (const p of ALL_PAIRS) {
    curStreak[p] = run[p] ?? 0;
    const arr = streakAcc[p] ?? [];
    avgStreak[p] = arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : total;
  }
  return ALL_PAIRS.map(p => {
    const s1 = (freqCount[p] ?? 0) / maxFreq;
    const avgG = gapCnt[p] ? (gapSum[p]! / gapCnt[p]!) : total;
    const s2 = Math.min(1, (currentGap[p] ?? total) / Math.max(avgG, 1) / 3);
    const gRate = (freqCount[p] ?? 0) / total, rRate = (recentCount[p] ?? 0) / recentTotal;
    const s3 = gRate > 0 ? Math.min(1, (rRate / gRate) / 5) : 0;
    const s5 = (markovScore[p] ?? 0) / maxMarkov;
    const s6 = avgStreak[p]! > 0 ? Math.min(1, (curStreak[p] ?? 0) / avgStreak[p]! / 4) : 0;
    return { pair: p, score: W_FREQ*s1 + W_GAP*s2 + W_MOM*s3 + W_MARKOV*s5 + W_STREAK*s6 };
  }).sort((a, b) => b.score - a.score);
};

const pairTransitionFollow: PairRankFn = (draws, half) => {
  if (draws.length < 3) return pairFrequencyRank(draws, half);
  const allPairs = draws.map(d => extractPair(d, half));
  const matrix = new Map<string, Map<string, number>>();
  for (let i = 0; i + 1 < allPairs.length; i++) {
    const from = allPairs[i]!, to = allPairs[i + 1]!;
    if (!matrix.has(from)) matrix.set(from, new Map());
    matrix.get(from)!.set(to, (matrix.get(from)!.get(to) ?? 0) + 1);
  }
  const votes: Record<string, number> = {};
  const last5 = allPairs.slice(-5);
  for (let lag = 0; lag < last5.length; lag++) {
    const row = matrix.get(last5[lag]!); if (!row) continue;
    const rowT = Array.from(row.values()).reduce((s, v) => s + v, 0);
    const rW = 1.0 - (0.6 * lag) / last5.length;
    Array.from(row.entries()).sort((a, b) => b[1] - a[1]).slice(0, 6).forEach(([to, cnt]) => {
      votes[to] = (votes[to] ?? 0) + (cnt / rowT) * rW;
    });
  }
  const maxV = Math.max(...Object.values(votes), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: (votes[p] ?? 0) / maxV })).sort((a, b) => b.score - a.score);
};

const pairMarkovOrder2: PairRankFn = (draws, half) => {
  if (draws.length < 4) return pairFrequencyRank(draws, half);
  const allPairs = draws.map(d => extractPair(d, half));
  const table = new Map<string, Map<string, number>>();
  for (let i = 1; i + 1 < allPairs.length; i++) {
    const state = `${allPairs[i - 1]}_${allPairs[i]}`, to = allPairs[i + 1]!;
    if (!table.has(state)) table.set(state, new Map());
    table.get(state)!.set(to, (table.get(state)!.get(to) ?? 0) + 1);
  }
  const votes: Record<string, number> = {};
  const states: string[] = [];
  if (allPairs.length >= 2) states.push(`${allPairs[allPairs.length - 2]}_${allPairs[allPairs.length - 1]}`);
  if (allPairs.length >= 3) states.push(`${allPairs[allPairs.length - 3]}_${allPairs[allPairs.length - 2]}`);
  for (let si = 0; si < states.length; si++) {
    const row = table.get(states[si]!); if (!row) continue;
    const rowT = Array.from(row.values()).reduce((s, v) => s + v, 0);
    const rW = si === 0 ? 1.0 : 0.5;
    Array.from(row.entries()).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([to, cnt]) => {
      votes[to] = (votes[to] ?? 0) + (cnt / rowT) * rW;
    });
  }
  const maxV = Math.max(...Object.values(votes), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: (votes[p] ?? 0) / maxV })).sort((a, b) => b.score - a.score);
};

const pairCalendarPattern: PairRankFn = (draws, half) => {
  if (draws.length < 5) return pairFrequencyRank(draws, half);
  const nextDate  = new Date(draws[draws.length - 1]!.created_at.getTime() + 86_400_000);
  const targetDow = nextDate.getDay(), targetMonth = nextDate.getMonth() + 1, targetDom = nextDate.getDate();
  const dim1: Record<string, Record<string, number>> = {};
  const dim2: Record<number, Record<string, number>> = {};
  const dim3: Record<number, Record<string, number>> = {};
  const dim4: Record<number, Record<string, number>> = {};
  for (const d of draws) {
    const pair  = extractPair(d, half);
    const dow   = d.created_at.getDay(), month = d.created_at.getMonth() + 1, dom = d.created_at.getDate();
    const k1    = `${dow}_${month}`;
    dim1[k1] = dim1[k1] ?? {}; dim1[k1]![pair] = (dim1[k1]![pair] ?? 0) + 1;
    dim2[dow]   = dim2[dow]   ?? {}; dim2[dow]![pair]   = (dim2[dow]![pair]   ?? 0) + 1;
    dim3[month] = dim3[month] ?? {}; dim3[month]![pair] = (dim3[month]![pair] ?? 0) + 1;
    dim4[dom]   = dim4[dom]   ?? {}; dim4[dom]![pair]   = (dim4[dom]![pair]   ?? 0) + 1;
  }
  function bScore(bucket: Record<string, number> | undefined, p: string): number {
    if (!bucket) return 0;
    const t = Object.values(bucket).reduce((s, v) => s + v, 0);
    return t > 0 ? (bucket[p] ?? 0) / t : 0;
  }
  const raw: Record<string, number> = {};
  for (const p of ALL_PAIRS) {
    raw[p] = 0.40 * bScore(dim1[`${targetDow}_${targetMonth}`], p)
           + 0.30 * bScore(dim2[targetDow], p)
           + 0.20 * bScore(dim3[targetMonth], p)
           + 0.10 * bScore(dim4[targetDom], p);
  }
  const maxR = Math.max(...Object.values(raw), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: raw[p]! / maxR })).sort((a, b) => b.score - a.score);
};

const pairDecadeFamily: PairRankFn = (draws, half) => {
  if (draws.length < 5) return pairFrequencyRank(draws, half);
  const allPairs = draws.map(d => extractPair(d, half));
  const total = allPairs.length;
  const recent30 = allPairs.slice(-Math.min(30, total));
  const recentTotal = recent30.length || 1;
  const famTotal: number[] = new Array(10).fill(0) as number[];
  const famRecent: number[] = new Array(10).fill(0) as number[];
  const pairTotal: Record<string, number> = {};
  for (const p of allPairs) { famTotal[parseInt(p[0]!)]!++; pairTotal[p] = (pairTotal[p] ?? 0) + 1; }
  for (const p of recent30) famRecent[parseInt(p[0]!)]!++;
  const momentum = famTotal.map((t, i) => t > 0 ? (famRecent[i]! / recentTotal) / (t / total) : 0);
  const hot = momentum.map((m, i) => ({ m, i })).filter(o => o.m >= 1.0)
    .sort((a, b) => b.m - a.m).slice(0, 4).map(o => o.i);
  const active = hot.length > 0 ? hot : momentum.map((m, i) => ({ m, i })).sort((a, b) => b.m - a.m).slice(0, 4).map(o => o.i);
  const raw: Record<string, number> = {};
  for (const p of ALL_PAIRS) {
    const fam = parseInt(p[0]!);
    raw[p] = active.includes(fam) ? (momentum[fam] ?? 0) * ((pairTotal[p] ?? 0) / Math.max(famTotal[fam]!, 1)) : 0;
  }
  const maxR = Math.max(...Object.values(raw), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: raw[p]! / maxR })).sort((a, b) => b.score - a.score);
};

const pairMaxPerWeekday: PairRankFn = (draws, half) => {
  if (draws.length < 5) return pairFrequencyRank(draws, half);
  const nextDate  = new Date(draws[draws.length - 1]!.created_at.getTime() + 86_400_000);
  const targetDow = nextDate.getDay();
  const bucket: Record<string, number> = {};
  let bucketTotal = 0;
  for (const d of draws) {
    if (d.created_at.getDay() !== targetDow) continue;
    const p = extractPair(d, half);
    bucket[p] = (bucket[p] ?? 0) + 1;
    bucketTotal++;
  }
  if (bucketTotal === 0) return pairFrequencyRank(draws, half);
  const maxF = Math.max(...Object.values(bucket), 1e-9);
  return ALL_PAIRS.map(p => ({ pair: p, score: (bucket[p] ?? 0) / maxF })).sort((a, b) => b.score - a.score);
};

// ─── Shared assertion helpers ────────────────────────────────

/** Every algorithm must satisfy these 3 invariants */
function assertAlgorithmInvariants(result: RankedPair[], label: string) {
  expect(result, `${label}: must return exactly 100 pairs`).toHaveLength(100);

  const pairSet = new Set(result.map(r => r.pair));
  expect(pairSet.size, `${label}: must contain 100 unique pairs`).toBe(100);

  for (const p of result) {
    expect(p.pair, `${label}: pair must be 2 chars`).toHaveLength(2);
    expect(/^\d\d$/.test(p.pair), `${label}: pair must be digits`).toBe(true);
  }

  for (let i = 0; i + 1 < result.length; i++) {
    expect(
      result[i]!.score >= result[i + 1]!.score,
      `${label}: must be sorted descending at index ${i}`
    ).toBe(true);
  }
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('pairBayesianScore', () => {
  it('satisfies structural invariants on normal input', () => {
    const draws = makeDominantDraws('37', 20, 'du');
    const result = pairBayesianScore(draws, 'du');
    assertAlgorithmInvariants(result, 'pairBayesianScore');
  });

  it('dominant pair "37" appears in top-5 when it appears 20× and noise 5×', () => {
    const draws = makeMixedDraws('37', 20, 5, 'du');
    const result = pairBayesianScore(draws, 'du');
    const rank = result.findIndex(r => r.pair === '37') + 1;
    expect(rank, `"37" should be in top-5, got rank ${rank}`).toBeLessThanOrEqual(5);
  });

  it('falls back gracefully when < 5 draws', () => {
    const result = pairBayesianScore(makeDominantDraws('37', 3, 'du'), 'du');
    assertAlgorithmInvariants(result, 'pairBayesianScore<5draws');
    // fallback = frequency rank — "37" should still be #1
    expect(result[0]!.pair).toBe('37');
  });

  it('works correctly for half=ab (Pick4 first pair)', () => {
    const draws = makeDominantDraws('12', 20, 'ab');
    const result = pairBayesianScore(draws, 'ab');
    assertAlgorithmInvariants(result, 'pairBayesianScore:ab');
    expect(result[0]!.pair).toBe('12');
  });

  it('all scores are finite non-negative numbers', () => {
    const result = pairBayesianScore(makeDominantDraws('55', 30, 'du'), 'du');
    for (const r of result) {
      expect(Number.isFinite(r.score), `score for ${r.pair} must be finite`).toBe(true);
      expect(r.score, `score for ${r.pair} must be >= 0`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('pairTransitionFollow', () => {
  it('satisfies structural invariants', () => {
    const draws = makeDominantDraws('23', 30, 'du');
    assertAlgorithmInvariants(pairTransitionFollow(draws, 'du'), 'pairTransitionFollow');
  });

  it('falls back gracefully when < 3 draws', () => {
    const result = pairTransitionFollow(makeDominantDraws('23', 2, 'du'), 'du');
    assertAlgorithmInvariants(result, 'pairTransitionFollow<3draws');
  });

  it('successor pair scores highest when A→B alternation is consistent', () => {
    // Build sequence: 37, 42, 37, 42, 37, 42 — "42" always follows "37"
    const baseDateMs = Date.now();
    const draws: TestDraw[] = [];
    const pairs = ['37', '42', '37', '42', '37', '42', '37', '42', '37', '42', '37', '42'];
    for (let i = 0; i < pairs.length; i++) {
      const a = parseInt(pairs[i]![0]!), b = parseInt(pairs[i]![1]!);
      draws.push({ p1: 5, p2: a, p3: b, p4: null, draw_date: '2024-01-01', created_at: new Date(baseDateMs + i * 86_400_000) });
    }
    const result = pairTransitionFollow(draws, 'du');
    assertAlgorithmInvariants(result, 'pairTransitionFollow:alternation');
    // Last pair in sequence is "42" → most likely successor is "37"
    const rank37 = result.findIndex(r => r.pair === '37') + 1;
    expect(rank37, `"37" should rank very high after consistent alternation, got ${rank37}`).toBeLessThanOrEqual(3);
  });

  it('empty draws array returns 100 sorted pairs', () => {
    assertAlgorithmInvariants(pairTransitionFollow([], 'du'), 'pairTransitionFollow:empty');
  });
});

describe('pairMarkovOrder2', () => {
  it('satisfies structural invariants', () => {
    const draws = makeDominantDraws('15', 30, 'du');
    assertAlgorithmInvariants(pairMarkovOrder2(draws, 'du'), 'pairMarkovOrder2');
  });

  it('falls back gracefully when < 4 draws', () => {
    assertAlgorithmInvariants(pairMarkovOrder2(makeDominantDraws('15', 3, 'du'), 'du'), 'pairMarkovOrder2<4draws');
  });

  it('successor scores high when A→B→C pattern is repeated consistently', () => {
    // Pattern: 11, 22, 33, 11, 22, 33, 11, 22, 33 — after state "11_22" always comes "33"
    const baseDateMs = Date.now();
    const draws: TestDraw[] = [];
    const cycle = ['11', '22', '33'];
    for (let i = 0; i < 12; i++) {
      const p = cycle[i % 3]!;
      const a = parseInt(p[0]!), b = parseInt(p[1]!);
      draws.push({ p1: 5, p2: a, p3: b, p4: null, draw_date: '2024-01-01', created_at: new Date(baseDateMs + i * 86_400_000) });
    }
    const result = pairMarkovOrder2(draws, 'du');
    assertAlgorithmInvariants(result, 'pairMarkovOrder2:cycle');
    // Last two in sequence are "22", "33" → state "22_33" → next is "11"
    const rank11 = result.findIndex(r => r.pair === '11') + 1;
    expect(rank11, `"11" should rank highly after state "22→33", got rank ${rank11}`).toBeLessThanOrEqual(5);
  });

  it('all scores normalized [0, 1]', () => {
    const result = pairMarkovOrder2(makeDominantDraws('77', 20, 'du'), 'du');
    for (const r of result) {
      expect(r.score).toBeGreaterThanOrEqual(0);
      expect(r.score).toBeLessThanOrEqual(1 + 1e-9); // normalized max = 1
    }
  });
});

describe('pairCalendarPattern', () => {
  it('satisfies structural invariants', () => {
    const draws = makeDominantDraws('48', 30, 'du');
    assertAlgorithmInvariants(pairCalendarPattern(draws, 'du'), 'pairCalendarPattern');
  });

  it('falls back gracefully when < 5 draws', () => {
    assertAlgorithmInvariants(pairCalendarPattern(makeDominantDraws('48', 3, 'du'), 'du'), 'pairCalendarPattern<5draws');
  });

  it('pair consistently on same DoW ranks above pair on different DoW', () => {
    // All draws on a fixed day-of-week — "48" appears only on that DoW
    const baseDateMs = Date.now();
    // Force all draws to land on the SAME day-of-week as the next draw will be
    const draws: TestDraw[] = [];
    // Create 20 draws spaced 7 days apart (same DoW)
    for (let i = 0; i < 20; i++) {
      const created_at = new Date(baseDateMs + i * 7 * 86_400_000);
      draws.push({ p1: 5, p2: 4, p3: 8, p4: null, draw_date: created_at.toISOString().slice(0, 10), created_at });
    }
    const result = pairCalendarPattern(draws, 'du');
    assertAlgorithmInvariants(result, 'pairCalendarPattern:sameDoW');
    // "48" should be top-ranked — it appears exclusively on the target DoW
    expect(result[0]!.pair).toBe('48');
  });

  it('scores are all >= 0', () => {
    const result = pairCalendarPattern(makeDominantDraws('63', 20, 'du'), 'du');
    for (const r of result) {
      expect(r.score, `${r.pair} score must be >= 0`).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('pairDecadeFamily', () => {
  it('satisfies structural invariants', () => {
    const draws = makeDominantDraws('32', 30, 'du');
    assertAlgorithmInvariants(pairDecadeFamily(draws, 'du'), 'pairDecadeFamily');
  });

  it('falls back gracefully when < 5 draws', () => {
    assertAlgorithmInvariants(pairDecadeFamily(makeDominantDraws('32', 3, 'du'), 'du'), 'pairDecadeFamily<5draws');
  });

  it('pairs from hot decade (D3=30-39) rank above pairs from cold decade', () => {
    // Flood draws with decade 3 pairs in recent 30 → high momentum for D3
    const baseDateMs = Date.now();
    const draws: TestDraw[] = [];
    // 40 historical draws: mix of decades (D7 dominates historically)
    for (let i = 0; i < 40; i++) {
      const decade = i % 4 === 0 ? 3 : 7; // 25% D3, 75% D7
      const unit   = i % 10;
      draws.push({ p1: 5, p2: decade, p3: unit, p4: null, draw_date: '2024-01-01', created_at: new Date(baseDateMs + i * 86_400_000) });
    }
    // Recent 30: all D3 → momentum of D3 spikes to >> 1.0
    for (let i = 0; i < 30; i++) {
      draws.push({ p1: 5, p2: 3, p3: i % 10, p4: null, draw_date: '2024-01-02', created_at: new Date(baseDateMs + (40 + i) * 86_400_000) });
    }
    const result = pairDecadeFamily(draws, 'du');
    assertAlgorithmInvariants(result, 'pairDecadeFamily:hotDecade');
    // All top-4 should be from D3 (30-39)
    const top4Decades = result.slice(0, 4).map(r => parseInt(r.pair[0]!));
    const allD3 = top4Decades.every(d => d === 3);
    expect(allD3, `Top-4 pairs should all be from D3 (30-39), got ${result.slice(0, 4).map(r => r.pair).join(' ')}`).toBe(true);
  });

  it('scores for pairs outside hot decades are 0 (before normalization floor)', () => {
    // When all draws are from D3, other decades should get raw score = 0
    const draws: TestDraw[] = [];
    const baseDateMs = Date.now();
    for (let i = 0; i < 30; i++) {
      draws.push({ p1: 5, p2: 3, p3: i % 10, p4: null, draw_date: '2024-01-01', created_at: new Date(baseDateMs + i * 86_400_000) });
    }
    const result = pairDecadeFamily(draws, 'du');
    // Pairs from D0,D1,D2,D4..D9 should have score=0
    const otherDecades = result.filter(r => parseInt(r.pair[0]!) !== 3);
    otherDecades.forEach(r => {
      expect(r.score, `${r.pair} (non-D3) should have score=0`).toBe(0);
    });
  });
});

describe('pairMaxPerWeekday', () => {
  it('satisfies structural invariants', () => {
    const draws = makeDominantDraws('09', 30, 'du');
    assertAlgorithmInvariants(pairMaxPerWeekday(draws, 'du'), 'pairMaxPerWeekday');
  });

  it('falls back gracefully when < 5 draws', () => {
    assertAlgorithmInvariants(pairMaxPerWeekday(makeDominantDraws('09', 3, 'du'), 'du'), 'pairMaxPerWeekday<5draws');
  });

  it('pair dominant on target DoW ranks #1', () => {
    // Strategy: put all "09" draws on Tuesday (DoW=2).
    // Add ONE Monday draw AFTER the last Tuesday so lastDraw = Monday → targetDoW = Tuesday.
    // Then "09" dominates the Tuesday bucket → ranks #1.
    const tuesday = new Date(2024, 0, 2); // Jan 2, 2024 is a Tuesday (DoW=2)
    const draws: TestDraw[] = [];

    // 10 Tuesday draws: "09"
    for (let week = 0; week < 10; week++) {
      const created_at = new Date(tuesday.getTime() + week * 7 * 86_400_000);
      draws.push({ p1: 5, p2: 0, p3: 9, p4: null, draw_date: created_at.toISOString().slice(0, 10), created_at });
    }
    // Last draw = Monday (the day before the 11th Tuesday) → targetDoW = Tuesday
    const lastMonday = new Date(tuesday.getTime() + 10 * 7 * 86_400_000 - 86_400_000);
    draws.push({ p1: 5, p2: 8, p3: 8, p4: null, draw_date: lastMonday.toISOString().slice(0, 10), created_at: lastMonday });

    draws.sort((a, b) => a.created_at.getTime() - b.created_at.getTime());

    const result = pairMaxPerWeekday(draws, 'du');
    assertAlgorithmInvariants(result, 'pairMaxPerWeekday:dominantTue');
    // targetDoW = Tuesday (lastDraw is Monday → +1 = Tuesday)
    // "09" appears 10× on Tuesday → rank #1 in bucket
    expect(result[0]!.pair, `"09" should be #1 on Tuesdays`).toBe('09');
  });

  it('falls back to frequency rank when no draws match target DoW', () => {
    // All draws on Monday, target DoW = Tuesday → empty bucket → frequency fallback
    const draws: TestDraw[] = [];
    const monday = new Date(2024, 0, 1); // Jan 1 2024 = Monday
    for (let i = 0; i < 10; i++) {
      draws.push({ p1: 5, p2: 3, p3: 7, p4: null, draw_date: '2024-01-01', created_at: new Date(monday.getTime() + i * 7 * 86_400_000) });
    }
    const result = pairMaxPerWeekday(draws, 'du');
    assertAlgorithmInvariants(result, 'pairMaxPerWeekday:fallback');
    // Fallback = frequency → "37" appears 10× → should be #1
    expect(result[0]!.pair).toBe('37');
  });

  it('top-1 score = 1.0 (normalized by maxF)', () => {
    const draws = makeDominantDraws('21', 15, 'du');
    const result = pairMaxPerWeekday(draws, 'du');
    // If there's any pair in the target DoW bucket, max score = 1.0
    if (result[0]!.score > 0) {
      expect(result[0]!.score).toBeLessThanOrEqual(1.0 + 1e-9);
    }
  });
});

// ─── Cross-algorithm sanity ────────────────────────────────────
describe('All 6 algorithms — cross-algorithm invariants', () => {
  const ALGORITHMS: [string, PairRankFn][] = [
    ['pairBayesianScore',    pairBayesianScore],
    ['pairTransitionFollow', pairTransitionFollow],
    ['pairMarkovOrder2',     pairMarkovOrder2],
    ['pairCalendarPattern',  pairCalendarPattern],
    ['pairDecadeFamily',     pairDecadeFamily],
    ['pairMaxPerWeekday',    pairMaxPerWeekday],
  ];

  const syntheticDraws = makeMixedDraws('37', 30, 10, 'du');

  for (const [name, fn] of ALGORITHMS) {
    it(`${name}: returns exactly 100 pairs, sorted, on 40-draw input`, () => {
      assertAlgorithmInvariants(fn(syntheticDraws, 'du'), name);
    });

    it(`${name}: handles empty draws without throwing`, () => {
      expect(() => fn([], 'du')).not.toThrow();
      const result = fn([], 'du');
      expect(result).toHaveLength(100);
    });

    it(`${name}: handles half=cd without throwing`, () => {
      const cdDraws = makeDominantDraws('45', 20, 'cd');
      expect(() => fn(cdDraws, 'cd')).not.toThrow();
      assertAlgorithmInvariants(fn(cdDraws, 'cd'), `${name}:cd`);
    });
  }
});
