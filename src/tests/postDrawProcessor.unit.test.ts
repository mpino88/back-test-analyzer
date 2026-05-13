// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: PostDrawProcessor pure logic (no DB)
//
// Tests cover:
//   1. Winning pair extraction per game_type / half
//   2. Hit detection: actualPair IN pairs array
//   3. Hit rank extraction (indexOf + 1)
//   4. Drift cooldown guard logic (6-hour window)
//   5. EMA rank feedback formula (apex_adaptive update)
//   6. Legacy carton filter (pair-mode rows have no digits)
//   7. Half mapping: pick3=du, pick4=ab+cd
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Extracted pure logic (mirrors PostDrawProcessor.ts exactly) ──

interface LotteryDigits {
  p1: number; p2: number; p3: number; p4?: number;
}

// Mirrors updateLivePairHits() winning pair construction
function extractWinningPairs(game_type: 'pick3' | 'pick4', actual_digits: LotteryDigits): {
  du: string | null;
  ab: string | null;
  cd: string | null;
} {
  if (game_type === 'pick3') {
    return {
      du: `${actual_digits.p2}${actual_digits.p3}`,
      ab: null,
      cd: null,
    };
  }
  return {
    du: null,
    ab: `${actual_digits.p1}${actual_digits.p2}`,
    cd: `${actual_digits.p3}${actual_digits.p4 ?? 0}`,
  };
}

// Mirrors hit resolution per half
function resolveHit(
  rec: { half: string; pairs: string[] },
  actual: { du: string | null; ab: string | null; cd: string | null }
): { hit: boolean; hit_at_rank: number | null } {
  let actualPair: string | null = null;
  if (rec.half === 'du') actualPair = actual.du;
  else if (rec.half === 'ab') actualPair = actual.ab;
  else if (rec.half === 'cd') actualPair = actual.cd;

  if (!actualPair) return { hit: false, hit_at_rank: null };

  const hit = rec.pairs.includes(actualPair);
  const hit_at_rank = hit ? rec.pairs.indexOf(actualPair) + 1 : null;
  return { hit, hit_at_rank };
}

// Mirrors drift cooldown guard: max 1 drift alert per 6h per game_type
function shouldEmitDriftAlert(recentDriftCount: number): boolean {
  return recentDriftCount === 0;
}

// Mirrors N-rank EMA feedback for apex_adaptive
function apexAdaptiveEmaUpdate(
  current_expected_rank: number,
  hit: boolean,
  hit_at_rank: number | null,
  alpha = 0.15
): number {
  const ema_rank = hit ? hit_at_rank! : 55; // 55 = mid-range penalty for miss
  return ema_rank * alpha + current_expected_rank * (1 - alpha);
}

// Mirrors legacy carton filter: pair-mode rows have numbers without digits field
function isLegacyCarton(numbers: Array<{ value: string; digits?: LotteryDigits }>): boolean {
  return numbers.every(n => n.digits != null);
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('extractWinningPairs()', () => {
  it('pick3: extracts du pair = p2+p3', () => {
    const digits: LotteryDigits = { p1: 5, p2: 3, p3: 7, p4: undefined };
    const pairs = extractWinningPairs('pick3', digits);
    expect(pairs.du).toBe('37');
    expect(pairs.ab).toBeNull();
    expect(pairs.cd).toBeNull();
  });

  it('pick4: extracts ab = p1+p2 and cd = p3+p4', () => {
    const digits: LotteryDigits = { p1: 1, p2: 2, p3: 4, p4: 8 };
    const pairs = extractWinningPairs('pick4', digits);
    expect(pairs.du).toBeNull();
    expect(pairs.ab).toBe('12');
    expect(pairs.cd).toBe('48');
  });

  it('pick4: p4 defaults to 0 when undefined', () => {
    const digits: LotteryDigits = { p1: 9, p2: 5, p3: 3, p4: undefined };
    const pairs = extractWinningPairs('pick4', digits);
    expect(pairs.cd).toBe('30');
  });

  it('pick3 du: result is always a 2-char string', () => {
    for (let p2 = 0; p2 <= 9; p2++) {
      for (let p3 = 0; p3 <= 9; p3++) {
        const { du } = extractWinningPairs('pick3', { p1: 0, p2, p3 });
        expect(du).toHaveLength(2);
        expect(/^\d\d$/.test(du!)).toBe(true);
      }
    }
  });

  it('pick4 ab+cd: both results are always 2-char strings', () => {
    const digits: LotteryDigits = { p1: 0, p2: 9, p3: 3, p4: 7 };
    const { ab, cd } = extractWinningPairs('pick4', digits);
    expect(ab).toHaveLength(2);
    expect(cd).toHaveLength(2);
  });

  it('pairs are numeric string representations (zero-preserving)', () => {
    const digits: LotteryDigits = { p1: 0, p2: 0, p3: 0 };
    const { du } = extractWinningPairs('pick3', digits);
    expect(du).toBe('00'); // NOT '0' or ''
  });
});

describe('resolveHit()', () => {
  it('HIT: actualPair found in pairs list', () => {
    const rec = { half: 'du', pairs: ['37', '42', '55', '18'] };
    const actual = { du: '42', ab: null, cd: null };
    const result = resolveHit(rec, actual);
    expect(result.hit).toBe(true);
    expect(result.hit_at_rank).toBe(2); // '42' is at index 1 → rank 2
  });

  it('MISS: actualPair not found in pairs list', () => {
    const rec = { half: 'du', pairs: ['37', '42', '55'] };
    const actual = { du: '99', ab: null, cd: null };
    const result = resolveHit(rec, actual);
    expect(result.hit).toBe(false);
    expect(result.hit_at_rank).toBeNull();
  });

  it('hit_at_rank = 1 when winning pair is rank #1', () => {
    const rec = { half: 'du', pairs: ['77', '42', '55'] };
    const actual = { du: '77', ab: null, cd: null };
    const result = resolveHit(rec, actual);
    expect(result.hit).toBe(true);
    expect(result.hit_at_rank).toBe(1);
  });

  it('hit_at_rank = N when winning pair is last in list', () => {
    const pairs = ['00', '11', '22', '33', '44', '55'];
    const rec = { half: 'du', pairs };
    const actual = { du: '55', ab: null, cd: null };
    const result = resolveHit(rec, actual);
    expect(result.hit).toBe(true);
    expect(result.hit_at_rank).toBe(6);
  });

  it('skip: no actualPair for mismatched half', () => {
    // ab record but only du pair known
    const rec = { half: 'ab', pairs: ['37', '42'] };
    const actual = { du: '37', ab: null, cd: null }; // ab=null
    const result = resolveHit(rec, actual);
    expect(result.hit).toBe(false);
    expect(result.hit_at_rank).toBeNull();
  });

  it('resolves pick4 ab half correctly', () => {
    const rec = { half: 'ab', pairs: ['12', '34', '56'] };
    const actual = { du: null, ab: '34', cd: '78' };
    const result = resolveHit(rec, actual);
    expect(result.hit).toBe(true);
    expect(result.hit_at_rank).toBe(2);
  });

  it('resolves pick4 cd half correctly', () => {
    const rec = { half: 'cd', pairs: ['78', '90', '12'] };
    const actual = { du: null, ab: '12', cd: '78' };
    const result = resolveHit(rec, actual);
    expect(result.hit).toBe(true);
    expect(result.hit_at_rank).toBe(1);
  });
});

describe('shouldEmitDriftAlert() — cooldown guard', () => {
  it('emits alert when no recent drift (count=0)', () => {
    expect(shouldEmitDriftAlert(0)).toBe(true);
  });

  it('suppresses alert when recent drift exists (count>0)', () => {
    expect(shouldEmitDriftAlert(1)).toBe(false);
    expect(shouldEmitDriftAlert(5)).toBe(false);
    expect(shouldEmitDriftAlert(97)).toBe(false);
  });

  it('exactly 1 recent alert → suppressed', () => {
    expect(shouldEmitDriftAlert(1)).toBe(false);
  });
});

describe('apexAdaptiveEmaUpdate() — N-rank EMA feedback', () => {
  it('HIT: uses actual rank in EMA update', () => {
    const current = 30.0;
    const updated = apexAdaptiveEmaUpdate(current, true, 5);
    // new = 5 * 0.15 + 30 * 0.85 = 0.75 + 25.5 = 26.25
    expect(updated).toBeCloseTo(26.25, 2);
  });

  it('MISS: uses penalty rank 55 in EMA update', () => {
    const current = 20.0;
    const updated = apexAdaptiveEmaUpdate(current, false, null);
    // new = 55 * 0.15 + 20 * 0.85 = 8.25 + 17 = 25.25
    expect(updated).toBeCloseTo(25.25, 2);
  });

  it('perfect prediction (rank=1) pulls expected_rank down toward 1', () => {
    let rank = 30.0;
    for (let i = 0; i < 30; i++) rank = apexAdaptiveEmaUpdate(rank, true, 1);
    expect(rank).toBeLessThan(5);
  });

  it('all misses pull expected_rank up toward 55', () => {
    let rank = 10.0;
    for (let i = 0; i < 50; i++) rank = apexAdaptiveEmaUpdate(rank, false, null);
    expect(rank).toBeGreaterThan(40);
    expect(rank).toBeLessThanOrEqual(55);
  });

  it('EMA formula: new = ema_rank * 0.15 + current * 0.85', () => {
    const current = 25.0;
    const ema_rank = 8;
    const expected = ema_rank * 0.15 + current * 0.85;
    expect(apexAdaptiveEmaUpdate(current, true, ema_rank)).toBeCloseTo(expected, 4);
  });
});

describe('isLegacyCarton() — carton format detection', () => {
  it('returns true when ALL numbers have digits field (legacy format)', () => {
    const numbers = [
      { value: '1', digits: { p1: 1, p2: 2, p3: 3 } },
      { value: '2', digits: { p1: 4, p2: 5, p3: 6 } },
    ];
    expect(isLegacyCarton(numbers)).toBe(true);
  });

  it('returns false when ANY number lacks digits field (pair-mode format)', () => {
    const numbers = [
      { value: '37' }, // pair-mode — no digits
      { value: '42' },
    ];
    expect(isLegacyCarton(numbers)).toBe(false);
  });

  it('returns false for mixed format (some digits, some without)', () => {
    const numbers = [
      { value: '1', digits: { p1: 1, p2: 2, p3: 3 } },
      { value: '37' }, // no digits
    ];
    expect(isLegacyCarton(numbers)).toBe(false);
  });

  it('returns true for empty array (edge case — no carton numbers)', () => {
    expect(isLegacyCarton([])).toBe(true); // every() on empty = vacuously true
  });
});

describe('Half mapping invariants', () => {
  it('pick3 uses only du half', () => {
    const { du, ab, cd } = extractWinningPairs('pick3', { p1: 1, p2: 3, p3: 7 });
    expect(du).not.toBeNull();
    expect(ab).toBeNull();
    expect(cd).toBeNull();
  });

  it('pick4 uses ab AND cd halves (both non-null)', () => {
    const { du, ab, cd } = extractWinningPairs('pick4', { p1: 1, p2: 2, p3: 3, p4: 4 });
    expect(du).toBeNull();
    expect(ab).not.toBeNull();
    expect(cd).not.toBeNull();
  });

  it('pick4 ab and cd are independent pairs', () => {
    const { ab, cd } = extractWinningPairs('pick4', { p1: 1, p2: 2, p3: 3, p4: 4 });
    expect(ab).toBe('12');
    expect(cd).toBe('34');
    // They should be different (unless digits repeat)
    expect(ab).not.toBe(cd);
  });
});
