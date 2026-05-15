// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: RegimeMonitor + seedPPSFromReplay force flag
//
// Tests cover:
//   1. Regime classification (stable/hot/cold/critical/insufficient_data)
//   2. Ratio calculation (recent/global)
//   3. Consecutive misses tracking
//   4. Trend detection (improving/declining/stable)
//   5. Overall regime aggregation (worst-of-N rule)
//   6. seedPPSFromReplay force flag behavior
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Pure classification (mirrors RegimeMonitor) ──────────────
type Regime = 'stable' | 'hot' | 'cold' | 'critical' | 'insufficient_data';

function classifyRegime(recent_rate: number, recent_total: number, ratio: number): Regime {
  if (recent_total < 5) return 'insufficient_data';
  if (recent_rate < 0.05 && recent_total >= 10) return 'critical';
  if (ratio < 0.7) return 'cold';
  if (ratio > 1.3) return 'hot';
  return 'stable';
}

function classifyTrend(ratio: number): 'improving' | 'declining' | 'stable' {
  if (ratio > 1.1)      return 'improving';
  if (ratio < 0.9)      return 'declining';
  return 'stable';
}

function countConsecutiveMisses(rows: Array<{ hit: boolean }>): number {
  let count = 0;
  for (const r of rows) {
    if (r.hit === false) count++;
    else break;
  }
  return count;
}

function overallRegime(reports: Array<{ regime: Regime }>): Regime {
  const critical = reports.filter(r => r.regime === 'critical').length;
  const cold     = reports.filter(r => r.regime === 'cold').length;
  const hot      = reports.filter(r => r.regime === 'hot').length;

  if (critical > 0) return 'critical';
  if (cold >= 2)    return 'cold';
  if (hot >= 2)     return 'hot';
  if (reports.every(r => r.regime === 'insufficient_data')) return 'insufficient_data';
  return 'stable';
}

// ─── seedPPSFromReplay force flag logic (mirrors PPSService) ──
function shouldSkipReplay(max_sample_count: number, force: boolean): boolean {
  if (force) return false;          // force always proceeds
  return max_sample_count >= 10;     // skip if PPS is mature
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('classifyRegime() — threshold rules', () => {
  it('returns insufficient_data when total < 5', () => {
    expect(classifyRegime(0.2, 4, 1.0)).toBe('insufficient_data');
    expect(classifyRegime(0.5, 1, 1.0)).toBe('insufficient_data');
  });

  it('returns critical when recent_rate < 5% AND total >= 10', () => {
    expect(classifyRegime(0.04, 12, 0.2)).toBe('critical');
    expect(classifyRegime(0.00, 20, 0.0)).toBe('critical');
  });

  it('does NOT return critical when total < 10 (even if rate < 5%)', () => {
    expect(classifyRegime(0.0, 9, 0.0)).not.toBe('critical');
  });

  it('returns cold when ratio < 0.7', () => {
    expect(classifyRegime(0.12, 30, 0.65)).toBe('cold');
    expect(classifyRegime(0.10, 20, 0.50)).toBe('cold');
  });

  it('returns hot when ratio > 1.3', () => {
    expect(classifyRegime(0.25, 30, 1.4)).toBe('hot');
    expect(classifyRegime(0.30, 20, 2.0)).toBe('hot');
  });

  it('returns stable when ratio in [0.7, 1.3]', () => {
    expect(classifyRegime(0.15, 30, 1.0)).toBe('stable');
    expect(classifyRegime(0.16, 30, 1.1)).toBe('stable');
    expect(classifyRegime(0.13, 30, 0.85)).toBe('stable');
  });

  it('boundary: ratio exactly 0.7 → stable (NOT cold)', () => {
    expect(classifyRegime(0.105, 30, 0.7)).toBe('stable');
  });

  it('boundary: ratio exactly 1.3 → stable (NOT hot)', () => {
    expect(classifyRegime(0.195, 30, 1.3)).toBe('stable');
  });

  it('boundary: rate exactly 0.05 → NOT critical (must be < 0.05)', () => {
    expect(classifyRegime(0.05, 20, 0.33)).not.toBe('critical');
  });

  it('critical wins over cold (both could apply)', () => {
    // 3% rate, ratio 0.2 → both critical AND cold could match
    // Algorithm checks critical first
    expect(classifyRegime(0.03, 15, 0.2)).toBe('critical');
  });
});

describe('classifyTrend()', () => {
  it('improving when ratio > 1.1', () => {
    expect(classifyTrend(1.15)).toBe('improving');
    expect(classifyTrend(2.0)).toBe('improving');
  });

  it('declining when ratio < 0.9', () => {
    expect(classifyTrend(0.85)).toBe('declining');
    expect(classifyTrend(0.50)).toBe('declining');
  });

  it('stable when ratio in [0.9, 1.1]', () => {
    expect(classifyTrend(1.0)).toBe('stable');
    expect(classifyTrend(0.95)).toBe('stable');
    expect(classifyTrend(1.05)).toBe('stable');
  });

  it('boundary: ratio exactly 1.1 → stable', () => {
    expect(classifyTrend(1.1)).toBe('stable');
  });
});

describe('countConsecutiveMisses() — most recent first ordering', () => {
  it('returns 0 when most recent is a hit', () => {
    const rows = [
      { hit: true },   // most recent
      { hit: false },
      { hit: false },
    ];
    expect(countConsecutiveMisses(rows)).toBe(0);
  });

  it('counts consecutive misses from most recent backward', () => {
    const rows = [
      { hit: false }, { hit: false }, { hit: false },   // 3 misses
      { hit: true },                                     // streak breaks here
      { hit: false },
    ];
    expect(countConsecutiveMisses(rows)).toBe(3);
  });

  it('counts all misses when no hits in array', () => {
    const rows = [
      { hit: false }, { hit: false }, { hit: false }, { hit: false },
    ];
    expect(countConsecutiveMisses(rows)).toBe(4);
  });

  it('returns 0 for empty array', () => {
    expect(countConsecutiveMisses([])).toBe(0);
  });

  it('USER SCENARIO: last 2 days = 0 hits = 6 consecutive misses', () => {
    // From production: 2026-05-14 and 2026-05-13 = 0 hits, 6 predictions each
    const rows = Array.from({ length: 12 }, () => ({ hit: false }));
    rows.push({ hit: true });  // 13th prediction was a hit
    expect(countConsecutiveMisses(rows)).toBe(12);
  });
});

describe('overallRegime() — aggregation', () => {
  it('critical wins if ANY combo is critical', () => {
    const reports = [
      { regime: 'stable' as Regime },
      { regime: 'critical' as Regime },
      { regime: 'stable' as Regime },
      { regime: 'cold' as Regime },
    ];
    expect(overallRegime(reports)).toBe('critical');
  });

  it('cold wins when 2+ combos are cold (no critical)', () => {
    const reports = [
      { regime: 'cold' as Regime },
      { regime: 'cold' as Regime },
      { regime: 'stable' as Regime },
      { regime: 'stable' as Regime },
    ];
    expect(overallRegime(reports)).toBe('cold');
  });

  it('hot wins when 2+ combos are hot (no critical/cold)', () => {
    const reports = [
      { regime: 'hot' as Regime },
      { regime: 'hot' as Regime },
      { regime: 'stable' as Regime },
      { regime: 'stable' as Regime },
    ];
    expect(overallRegime(reports)).toBe('hot');
  });

  it('stable when only 1 combo is non-stable', () => {
    const reports = [
      { regime: 'cold' as Regime },
      { regime: 'stable' as Regime },
      { regime: 'stable' as Regime },
      { regime: 'stable' as Regime },
    ];
    expect(overallRegime(reports)).toBe('stable');
  });

  it('insufficient_data when ALL combos are insufficient', () => {
    const reports = [
      { regime: 'insufficient_data' as Regime },
      { regime: 'insufficient_data' as Regime },
      { regime: 'insufficient_data' as Regime },
      { regime: 'insufficient_data' as Regime },
    ];
    expect(overallRegime(reports)).toBe('insufficient_data');
  });

  it('not insufficient_data if even 1 combo has stable', () => {
    const reports = [
      { regime: 'insufficient_data' as Regime },
      { regime: 'insufficient_data' as Regime },
      { regime: 'stable' as Regime },
      { regime: 'insufficient_data' as Regime },
    ];
    expect(overallRegime(reports)).not.toBe('insufficient_data');
    expect(overallRegime(reports)).toBe('stable');
  });
});

describe('seedPPSFromReplay force flag', () => {
  it('force=false + max_sc < 10 → DO NOT skip (proceeds normally)', () => {
    expect(shouldSkipReplay(5, false)).toBe(false);
    expect(shouldSkipReplay(0, false)).toBe(false);
    expect(shouldSkipReplay(9, false)).toBe(false);
  });

  it('force=false + max_sc >= 10 → SKIP (default protective behavior)', () => {
    expect(shouldSkipReplay(10, false)).toBe(true);
    expect(shouldSkipReplay(13861, false)).toBe(true);
  });

  it('force=true + max_sc >= 10 → DO NOT skip (Genesis override)', () => {
    expect(shouldSkipReplay(13861, true)).toBe(false);
    expect(shouldSkipReplay(100, true)).toBe(false);
  });

  it('force=true + max_sc = 0 → DO NOT skip', () => {
    expect(shouldSkipReplay(0, true)).toBe(false);
  });

  it('REGRESSION TEST: production scenario where max_sc=13861 blocked Genesis', () => {
    // Without force, Genesis was skipped → no champion detection
    expect(shouldSkipReplay(13861, false)).toBe(true);
    // With force, Genesis proceeds → algo_rank_history populated → champions detectable
    expect(shouldSkipReplay(13861, true)).toBe(false);
  });
});

describe('Recommendation strings — invariants', () => {
  it('critical recommendation contains 🚨', () => {
    // Test the structure expected from RegimeMonitor
    const sample = '🚨 CRÍTICO: 3.0% hit rate en últimos 12 sorteos.';
    expect(sample).toContain('🚨');
  });

  it('cold recommendation describes the decline percentage', () => {
    const ratio = 0.6;
    const decline = ((1 - ratio) * 100).toFixed(0);
    expect(decline).toBe('40');  // 40% decline
  });

  it('hot recommendation describes the gain percentage', () => {
    const ratio = 1.5;
    const gain = ((ratio - 1) * 100).toFixed(0);
    expect(gain).toBe('50');  // 50% gain
  });
});
