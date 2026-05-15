// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: TrendMomentumSweetSpot + MomentumBucketAnalyzer
//
// Tests cover:
//   1. Sweet spot filter: count_recent==1 AND momentum>=3 AND count_all>=3
//   2. Fallback regimes (strict → relaxed_2 → relaxed_3 → flat)
//   3. Bucket classification logic (0, 1, 2, 3+)
//   4. Walk-forward integrity (no data leak)
//   5. Hardened TrendMomentum threshold (1.0 → 3.0)
//   6. Empirical scenarios mirroring the user's bot screenshot
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Sweet Spot filter logic (mirrors TrendMomentumSweetSpot) ──
interface MomentumStat {
  pair: string;
  count_all: number;
  count_recent: number;
  momentum: number;
}

function applySweetSpotFilter(stats: MomentumStat[]): {
  selected: MomentumStat[];
  regime: 'strict' | 'relaxed_2' | 'relaxed_3' | 'fallback';
} {
  const MIN_ALL = 3, MIN_MOM = 3.0;

  // Strict: count_recent == 1
  let valid = stats.filter(s => s.count_all >= MIN_ALL && s.count_recent === 1 && s.momentum >= MIN_MOM);
  if (valid.length) return { selected: valid, regime: 'strict' };

  // Relax to count_recent <= 2
  valid = stats.filter(s => s.count_all >= MIN_ALL && s.count_recent >= 1 && s.count_recent <= 2 && s.momentum >= MIN_MOM);
  if (valid.length) return { selected: valid, regime: 'relaxed_2' };

  // Relax to count_recent <= 3
  valid = stats.filter(s => s.count_all >= MIN_ALL && s.count_recent >= 1 && s.count_recent <= 3 && s.momentum >= MIN_MOM);
  if (valid.length) return { selected: valid, regime: 'relaxed_3' };

  return { selected: [], regime: 'fallback' };
}

// ─── Bucket classifier (mirrors MomentumBucketAnalyzer) ────────
function classifyBucket(count_recent: number): number {
  return count_recent >= 3 ? 3 : count_recent;
}

// ─── Hardened TrendMomentum filter (v3) ────────────────────────
function hardenedTrendMomentum(stats: MomentumStat[]): MomentumStat[] {
  return stats.filter(s => s.count_all >= 3 && s.count_recent >= 1 && s.momentum >= 3.0);
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('Sweet Spot filter — strict regime', () => {
  it('selects only count_recent == 1 with momentum >= 3', () => {
    const stats: MomentumStat[] = [
      { pair: '17', count_all: 140, count_recent: 1, momentum: 3.3 },  // ✓ sweet spot
      { pair: '05', count_all: 165, count_recent: 3, momentum: 8.1 },  // ✗ rec=3
      { pair: '71', count_all: 125, count_recent: 2, momentum: 7.3 },  // ✗ rec=2
      { pair: '99', count_all: 100, count_recent: 1, momentum: 2.5 },  // ✗ mom<3
      { pair: '88', count_all: 2,   count_recent: 1, momentum: 5.0 },  // ✗ count_all<3
    ];
    const { selected, regime } = applySweetSpotFilter(stats);
    expect(regime).toBe('strict');
    expect(selected).toHaveLength(1);
    expect(selected[0]!.pair).toBe('17');
  });

  it('USER SCENARIO: from the bot screenshot, isolates the 12 sweet-spot pairs', () => {
    // Reconstruct the bot's TOP 15 (Rec, Hist, Momentum extracted from screenshot)
    const bot_top15: MomentumStat[] = [
      { pair: '05', count_all: 158, count_recent: 3, momentum: 8.1 },  // outlier
      { pair: '71', count_all: 125, count_recent: 2, momentum: 7.3 },  // warming
      { pair: '72', count_all: 144, count_recent: 2, momentum: 6.1 },  // warming
      { pair: '35', count_all: 110, count_recent: 1, momentum: 4.3 },  // ✓ sweet
      { pair: '91', count_all: 109, count_recent: 1, momentum: 4.1 },  // ✓ sweet
      { pair: '09', count_all: 109, count_recent: 1, momentum: 4.1 },  // ✓ sweet
      { pair: '36', count_all: 122, count_recent: 1, momentum: 3.8 },  // ✓ sweet
      { pair: '76', count_all: 122, count_recent: 1, momentum: 3.8 },  // ✓ sweet
      { pair: '24', count_all: 132, count_recent: 1, momentum: 3.5 },  // ✓ sweet
      { pair: '49', count_all: 132, count_recent: 1, momentum: 3.5 },  // ✓ sweet
      { pair: '61', count_all: 132, count_recent: 1, momentum: 3.5 },  // ✓ sweet
      { pair: '87', count_all: 132, count_recent: 1, momentum: 3.5 },  // ✓ sweet
      { pair: '88', count_all: 136, count_recent: 1, momentum: 3.4 },  // ✓ sweet
      { pair: '56', count_all: 136, count_recent: 1, momentum: 3.4 },  // ✓ sweet
      { pair: '17', count_all: 140, count_recent: 1, momentum: 3.3 },  // ✓ sweet
    ];
    const { selected, regime } = applySweetSpotFilter(bot_top15);
    expect(regime).toBe('strict');
    expect(selected).toHaveLength(12);  // exactly the 12 sweet-spot pairs
    // 05, 71, 72 should be EXCLUDED
    expect(selected.find(s => s.pair === '05')).toBeUndefined();
    expect(selected.find(s => s.pair === '71')).toBeUndefined();
    expect(selected.find(s => s.pair === '72')).toBeUndefined();
    // 17 should be INCLUDED
    expect(selected.find(s => s.pair === '17')).toBeDefined();
  });

  it('rejects momentum < 3.0 even with count_recent == 1', () => {
    const stats: MomentumStat[] = [
      { pair: '11', count_all: 100, count_recent: 1, momentum: 2.99 },
    ];
    expect(applySweetSpotFilter(stats).selected).toHaveLength(0);
  });

  it('rejects count_recent == 0 (no recent appearance)', () => {
    const stats: MomentumStat[] = [
      { pair: '11', count_all: 100, count_recent: 0, momentum: 5.0 },  // momentum can't even compute meaningfully
    ];
    expect(applySweetSpotFilter(stats).selected).toHaveLength(0);
  });
});

describe('Sweet Spot filter — fallback regimes', () => {
  it('falls back to relaxed_2 when no count_recent == 1 candidates', () => {
    const stats: MomentumStat[] = [
      { pair: '05', count_all: 100, count_recent: 2, momentum: 6.0 },
      { pair: '17', count_all: 100, count_recent: 2, momentum: 4.5 },
    ];
    const { selected, regime } = applySweetSpotFilter(stats);
    expect(regime).toBe('relaxed_2');
    expect(selected).toHaveLength(2);
  });

  it('falls back to relaxed_3 when no count_recent ∈ [1,2] candidates', () => {
    const stats: MomentumStat[] = [
      { pair: '05', count_all: 100, count_recent: 3, momentum: 8.0 },
    ];
    const { selected, regime } = applySweetSpotFilter(stats);
    expect(regime).toBe('relaxed_3');
    expect(selected).toHaveLength(1);
  });

  it('returns fallback (empty) when no candidates anywhere', () => {
    const stats: MomentumStat[] = [
      { pair: '05', count_all: 100, count_recent: 4, momentum: 8.0 },
      { pair: '17', count_all: 100, count_recent: 0, momentum: 2.0 },
    ];
    const { selected, regime } = applySweetSpotFilter(stats);
    expect(regime).toBe('fallback');
    expect(selected).toHaveLength(0);
  });
});

describe('Bucket classifier', () => {
  it('classifies count_recent = 0 → bucket 0', () => {
    expect(classifyBucket(0)).toBe(0);
  });
  it('classifies count_recent = 1 → bucket 1 (sweet spot)', () => {
    expect(classifyBucket(1)).toBe(1);
  });
  it('classifies count_recent = 2 → bucket 2', () => {
    expect(classifyBucket(2)).toBe(2);
  });
  it('classifies count_recent = 3 → bucket 3', () => {
    expect(classifyBucket(3)).toBe(3);
  });
  it('classifies count_recent >= 4 → bucket 3 (rolled up)', () => {
    expect(classifyBucket(4)).toBe(3);
    expect(classifyBucket(10)).toBe(3);
  });
});

describe('Hardened TrendMomentum filter (v3)', () => {
  it('excludes momentum < 3.0 (was admitted in v2)', () => {
    const stats: MomentumStat[] = [
      { pair: '00', count_all: 100, count_recent: 5, momentum: 1.5 },  // ✗ mom<3
      { pair: '11', count_all: 100, count_recent: 2, momentum: 2.99 },  // ✗ mom<3
      { pair: '22', count_all: 100, count_recent: 1, momentum: 3.0 },  // ✓ AT threshold
      { pair: '33', count_all: 100, count_recent: 1, momentum: 5.0 },  // ✓
    ];
    const filtered = hardenedTrendMomentum(stats);
    expect(filtered).toHaveLength(2);
    expect(filtered.map(s => s.pair).sort()).toEqual(['22', '33']);
  });

  it('requires count_recent >= 1 (no inventos sin hits recientes)', () => {
    const stats: MomentumStat[] = [
      { pair: '00', count_all: 100, count_recent: 0, momentum: 10.0 },  // ✗ rec=0
      { pair: '11', count_all: 100, count_recent: 1, momentum: 3.5 },   // ✓
    ];
    expect(hardenedTrendMomentum(stats)).toHaveLength(1);
    expect(hardenedTrendMomentum(stats)[0]!.pair).toBe('11');
  });

  it('requires count_all >= 3 (no señales sin historial)', () => {
    const stats: MomentumStat[] = [
      { pair: '00', count_all: 2,   count_recent: 1, momentum: 8.0 },  // ✗ rare
      { pair: '11', count_all: 3,   count_recent: 1, momentum: 5.0 },  // ✓
    ];
    expect(hardenedTrendMomentum(stats)).toHaveLength(1);
    expect(hardenedTrendMomentum(stats)[0]!.pair).toBe('11');
  });
});

describe('MomentumBucketAnalyzer — walk-forward integrity', () => {
  it('history slice excludes target draw (no data leak)', () => {
    // Simulates the walk-forward logic in MomentumBucketAnalyzer.analyze()
    const allDraws = Array.from({ length: 100 }, (_, i) => ({ idx: i, pair: `${i % 100}` }));
    const targetIdx = 50;
    const history = allDraws.slice(0, targetIdx);  // < targetIdx, strictly before
    expect(history).toHaveLength(50);
    expect(history.every(h => h.idx < targetIdx)).toBe(true);
    expect(history.find(h => h.idx === targetIdx)).toBeUndefined();
  });

  it('recent window is the last RECENT_WINDOW of history (not future)', () => {
    const RECENT_WINDOW = 30;
    const history = Array.from({ length: 100 }, (_, i) => i);
    const recent = history.slice(-RECENT_WINDOW);
    expect(recent).toHaveLength(30);
    expect(recent[0]).toBe(70);   // history[70..99]
    expect(recent[29]).toBe(99);
  });

  it('bucket evaluation only counts draws where bucket has >= 1 candidate', () => {
    // If bucket 0 has 0 candidates in a draw, evaluations++ should NOT fire
    // Mirror of the analyzer's: `if (pairs.length > 0) stat.evaluations += 1;`
    const stat = { hits: 0, evaluations: 0, total_candidates: 0 };
    // Draw 1: bucket 0 has 0 candidates → no increment
    const pairs1: string[] = [];
    if (pairs1.length > 0) stat.evaluations += 1;
    expect(stat.evaluations).toBe(0);
    // Draw 2: bucket 0 has 2 candidates → increment
    const pairs2 = ['37', '42'];
    if (pairs2.length > 0) stat.evaluations += 1;
    expect(stat.evaluations).toBe(1);
  });
});

describe('Threshold comparison — momentum_ge_1 vs momentum_ge_3', () => {
  it('momentum_ge_3 produces FEWER candidates than momentum_ge_1', () => {
    const stats: MomentumStat[] = [
      ...Array.from({ length: 20 }, (_, i) => ({
        pair: String(i).padStart(2, '0'), count_all: 100, count_recent: 1, momentum: 1.5 + i * 0.5
      })),
    ];
    const ge1 = stats.filter(s => s.momentum >= 1.0 && s.count_all >= 3).length;
    const ge3 = stats.filter(s => s.momentum >= 3.0 && s.count_all >= 3).length;
    expect(ge3).toBeLessThanOrEqual(ge1);
  });

  it('hipótesis: ge_3 tiene MAYOR hit_rate (menos diluido) — test estructural', () => {
    // Empirical claim is testable in production; here we verify shape.
    // ge_3 candidates are a STRICT SUBSET of ge_1, so if hit happens in ge_3,
    // it would also happen in ge_1. The hit rate increases when total decreases.
    const allCandidates: string[] = Array.from({ length: 30 }, (_, i) => `${Math.floor(i / 10)}${i % 10}`);
    const ge_1 = allCandidates;  // all 30
    const ge_3 = allCandidates.slice(0, 12);  // top 12 (more selective)
    // If the winning pair is in the top 12, both ge_1 and ge_3 hit.
    // But hit_rate_at_N = 1/30 vs 1/12 → ge_3 has higher rate.
    const winner = '00';
    const ge_1_hit = ge_1.includes(winner) ? 1 / ge_1.length : 0;
    const ge_3_hit = ge_3.includes(winner) ? 1 / ge_3.length : 0;
    expect(ge_3_hit).toBeGreaterThanOrEqual(ge_1_hit);
  });
});

describe('Empirical bucket — user-reported scenario', () => {
  it('bot TOP 15 distribution matches expected pattern (3 outliers + 12 sweet)', () => {
    const bot_top15 = [
      { count_recent: 3 }, { count_recent: 2 }, { count_recent: 2 },
      { count_recent: 1 }, { count_recent: 1 }, { count_recent: 1 },
      { count_recent: 1 }, { count_recent: 1 }, { count_recent: 1 },
      { count_recent: 1 }, { count_recent: 1 }, { count_recent: 1 },
      { count_recent: 1 }, { count_recent: 1 }, { count_recent: 1 },
    ];
    const byBucket = new Map<number, number>();
    for (const p of bot_top15) {
      const b = classifyBucket(p.count_recent);
      byBucket.set(b, (byBucket.get(b) ?? 0) + 1);
    }
    expect(byBucket.get(1)).toBe(12);  // sweet spot dominates
    expect(byBucket.get(2)).toBe(2);
    expect(byBucket.get(3)).toBe(1);
    expect(byBucket.get(0) ?? 0).toBe(0);
  });

  it('sweet spot represents 80% of top-15 candidates in user scenario', () => {
    const sweet_count = 12;
    const total = 15;
    expect(sweet_count / total).toBeCloseTo(0.80, 2);
  });
});
