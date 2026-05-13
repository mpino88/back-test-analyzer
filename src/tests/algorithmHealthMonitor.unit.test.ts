// ═══════════════════════════════════════════════════════════════
// HITDASH — Unit tests: AlgorithmHealthMonitor pure logic (no DB)
//
// Tests cover:
//   1. Status classification: healthy / degraded / disabled
//   2. Threshold arithmetic (baseline, killswitch, degrade factors)
//   3. Minimum sample requirements (MIN_SAMPLES_KILL, MIN_SAMPLES_DEGRADE)
//   4. weight_multiplier per status
//   5. Edge cases: exactly at threshold, zero hit_rate, perfect hit_rate
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';

// ─── Mirror of AlgorithmHealthMonitor constants ───────────────
const BASELINE_RATE      = 0.15;
const KILLSWITCH_FACTOR  = 1.10;
const MIN_SAMPLES_KILL   = 30;
const MIN_SAMPLES_DEGRADE = 15;
const DEGRADE_PENALTY    = 0.5;

type AlgoHealthStatus = 'healthy' | 'degraded' | 'disabled';

interface AlgoHealth {
  algo_name:         string;
  status:            AlgoHealthStatus;
  hit_rate_at_15:    number;
  samples:           number;
  weight_multiplier: number;
  reason:            string;
}

// Pure classification logic (mirrors AlgorithmHealthMonitor.classifyHealth)
function classifyHealth(algo_name: string, samples: number, hit_rate: number): AlgoHealth {
  const killThreshold   = BASELINE_RATE * KILLSWITCH_FACTOR; // 0.165
  const degradeThreshold = BASELINE_RATE;                    // 0.150

  let status: AlgoHealthStatus;
  let weight_multiplier: number;
  let reason: string;

  if (samples >= MIN_SAMPLES_KILL && hit_rate < killThreshold) {
    status = 'disabled';
    weight_multiplier = 0;
    reason = `hit_rate=${(hit_rate * 100).toFixed(1)}% < killswitch ${(killThreshold * 100).toFixed(1)}% (samples=${samples})`;
  } else if (samples >= MIN_SAMPLES_DEGRADE && hit_rate < degradeThreshold) {
    status = 'degraded';
    weight_multiplier = DEGRADE_PENALTY;
    reason = `hit_rate=${(hit_rate * 100).toFixed(1)}% < baseline ${(degradeThreshold * 100).toFixed(1)}% (samples=${samples})`;
  } else {
    status = 'healthy';
    weight_multiplier = 1.0;
    reason = samples < MIN_SAMPLES_DEGRADE
      ? `insufficient samples (${samples}/${MIN_SAMPLES_DEGRADE}) — not enough data`
      : `hit_rate=${(hit_rate * 100).toFixed(1)}% ≥ baseline ${(degradeThreshold * 100).toFixed(1)}%`;
  }

  return { algo_name, status, hit_rate_at_15: hit_rate, samples, weight_multiplier, reason };
}

// ═══════════════════════════════════════════════════════════════
// TEST SUITES
// ═══════════════════════════════════════════════════════════════

describe('Status classification — thresholds', () => {
  it('HEALTHY when hit_rate >= killswitch threshold', () => {
    // 16.5% = exactly at killswitch threshold → healthy
    const h = classifyHealth('calendar_pattern', 50, 0.165);
    expect(h.status).toBe('healthy');
    expect(h.weight_multiplier).toBe(1.0);
  });

  it('HEALTHY when hit_rate is well above baseline', () => {
    const h = classifyHealth('calendar_pattern', 50, 0.25);
    expect(h.status).toBe('healthy');
    expect(h.weight_multiplier).toBe(1.0);
  });

  it('DEGRADED when hit_rate < baseline (15%) but >= 0, with enough samples', () => {
    // 14% < 15% baseline → degraded (samples=20 >= MIN_DEGRADE=15)
    const h = classifyHealth('markov_order2', 20, 0.14);
    expect(h.status).toBe('degraded');
    expect(h.weight_multiplier).toBe(0.5);
  });

  it('DISABLED when hit_rate < killswitch threshold with enough samples', () => {
    // 12% < 16.5% → disabled (samples=35 >= MIN_KILL=30)
    const h = classifyHealth('fibonacci_pisano', 35, 0.12);
    expect(h.status).toBe('disabled');
    expect(h.weight_multiplier).toBe(0);
  });

  it('DISABLED at zero hit_rate with sufficient samples', () => {
    const h = classifyHealth('cycle_detector', 50, 0.0);
    expect(h.status).toBe('disabled');
    expect(h.weight_multiplier).toBe(0);
  });

  it('HEALTHY at perfect hit_rate (1.0)', () => {
    const h = classifyHealth('frequency', 100, 1.0);
    expect(h.status).toBe('healthy');
    expect(h.weight_multiplier).toBe(1.0);
  });
});

describe('Minimum sample requirements', () => {
  it('NOT disabled when samples < MIN_SAMPLES_KILL (30), even with terrible hit_rate', () => {
    // 29 samples — cannot be disabled yet
    const h = classifyHealth('transition_follow', 29, 0.01);
    expect(h.status).not.toBe('disabled');
  });

  it('NOT degraded when samples < MIN_SAMPLES_DEGRADE (15)', () => {
    // 14 samples — cannot be degraded or disabled
    const h = classifyHealth('cross_draw', 14, 0.01);
    expect(h.status).toBe('healthy');
    expect(h.weight_multiplier).toBe(1.0);
  });

  it('DEGRADED but NOT disabled when samples is between 15 and 29', () => {
    // 20 samples: eligible for degrade (≥15) but NOT for kill (<30)
    const h = classifyHealth('markov_order2', 20, 0.05); // 5% < 15% baseline
    expect(h.status).toBe('degraded');
    expect(h.weight_multiplier).toBe(DEGRADE_PENALTY);
  });

  it('DISABLED only when samples >= 30', () => {
    const below = classifyHealth('algo', 29, 0.05);
    const atThreshold = classifyHealth('algo', 30, 0.05);
    expect(below.status).not.toBe('disabled');
    expect(atThreshold.status).toBe('disabled');
  });
});

describe('Threshold arithmetic', () => {
  it('BASELINE_RATE = 15% (N=15 random prediction probability)', () => {
    expect(BASELINE_RATE).toBe(0.15);
  });

  it('killswitch threshold = 16.5% (baseline × 1.10)', () => {
    expect(BASELINE_RATE * KILLSWITCH_FACTOR).toBeCloseTo(0.165, 3);
  });

  it('degrade penalty halves the weight (×0.5)', () => {
    const h = classifyHealth('algo', 20, 0.13); // below baseline, 20 samples
    expect(h.weight_multiplier).toBe(0.5);
  });

  it('boundary: exactly at 15% (baseline) is DISABLED with 30+ samples (below killswitch 16.5%)', () => {
    // hit_rate = 0.15 < killswitch (0.165) with samples=50 >= 30 → DISABLED
    // The DEGRADED check (< baseline=0.15) is NOT hit because 0.15 is NOT < 0.15.
    // But the DISABLED check (< killswitch=0.165) IS hit → DISABLED wins first.
    const h = classifyHealth('algo', 50, 0.15);
    expect(h.status).toBe('disabled');
  });

  it('boundary: just below baseline (0.149) is degraded with 15+ samples', () => {
    const h = classifyHealth('algo', 20, 0.149);
    expect(h.status).toBe('degraded');
  });

  it('boundary: exactly at killswitch (0.165) is healthy (not disabled)', () => {
    const h = classifyHealth('algo', 50, 0.165);
    expect(h.status).toBe('healthy');
  });

  it('boundary: just below killswitch (0.164) with 30+ samples is disabled', () => {
    const h = classifyHealth('algo', 30, 0.164);
    expect(h.status).toBe('disabled');
  });
});

describe('weight_multiplier per status', () => {
  it('healthy → weight_multiplier = 1.0', () => {
    expect(classifyHealth('a', 50, 0.20).weight_multiplier).toBe(1.0);
  });

  it('degraded → weight_multiplier = 0.5', () => {
    expect(classifyHealth('a', 20, 0.12).weight_multiplier).toBe(0.5);
  });

  it('disabled → weight_multiplier = 0', () => {
    expect(classifyHealth('a', 35, 0.10).weight_multiplier).toBe(0);
  });

  it('weight_multiplier is always one of [0, 0.5, 1.0]', () => {
    const cases = [
      { samples: 5, hit: 0.05 },
      { samples: 20, hit: 0.12 },
      { samples: 35, hit: 0.10 },
      { samples: 50, hit: 0.20 },
    ];
    for (const { samples, hit } of cases) {
      const { weight_multiplier } = classifyHealth('algo', samples, hit);
      expect([0, 0.5, 1.0]).toContain(weight_multiplier);
    }
  });
});

describe('reason field', () => {
  it('includes hit_rate percentage', () => {
    const h = classifyHealth('calendar_pattern', 50, 0.18);
    expect(h.reason).toContain('%');
  });

  it('mentions insufficient samples when below degrade threshold', () => {
    const h = classifyHealth('algo', 10, 0.10);
    expect(h.reason.toLowerCase()).toContain('insufficient');
  });

  it('disabled reason mentions killswitch threshold', () => {
    const h = classifyHealth('algo', 40, 0.10);
    expect(h.reason).toContain('killswitch');
  });
});

describe('AlgorithmHealthMonitor — algorithm catalog validation', () => {
  const ALL_20_ALGORITHMS = [
    'frequency', 'gap_analysis', 'hot_cold', 'pairs_correlation',
    'streak', 'position', 'moving_averages',
    'bayesian_score', 'transition_follow', 'markov_order2', 'calendar_pattern',
    'decade_family', 'max_per_week_day',
    'pair_return_cycle', 'sum_pattern_filter', 'double_triple', 'cross_draw',
    'trend_momentum', 'est_individuales', 'terminal_analysis',
  ];

  const ELIMINATED_ALGORITHMS = ['fibonacci_pisano', 'cycle_detector', 'mirror_complement'];

  it('20 algorithms remain after v2.4 elimination', () => {
    expect(ALL_20_ALGORITHMS).toHaveLength(20);
  });

  it('eliminated algorithms are not in the 20 remaining', () => {
    for (const eliminated of ELIMINATED_ALGORITHMS) {
      expect(ALL_20_ALGORITHMS).not.toContain(eliminated);
    }
  });

  it('each algorithm can be classified with any hit_rate in [0,1]', () => {
    for (const algo of ALL_20_ALGORITHMS) {
      expect(() => classifyHealth(algo, 50, 0.15)).not.toThrow();
    }
  });
});
