// ═══════════════════════════════════════════════════════════════
// HELIX — ContextGating v1.0.0 (2026-05-19)
//
// Gating network: computes per-algorithm weight multipliers based
// on the current EVT regime detected by EVTScorer.
//
// PROBLEM SOLVED:
//   In standard consensus, all algorithms have roughly equal weight.
//   When double_triple detects a Hawkes cluster (e.g. 6-6-6-6 after
//   8-8-8-8 17 days prior), it gets averaged out of the top-10.
//   ContextGating amplifies the relevant specialists and suppresses
//   noise algorithms during abnormal regimes.
//
// WEIGHT SEMANTICS:
//   All weights start at 1.0 (neutral). A weight of 2.0 means
//   "treat this algorithm as if it had 2x its normal confidence."
//   The consensus engine multiplies base ALGORITHM_WEIGHTS by these.
//
// REGIME → WEIGHT MAP:
//   HAWKES_QUAD_CLUSTER:   double_triple up to 4x, trend suppressed
//   HAWKES_TRIPLE_CLUSTER: double_triple up to 3x, streak boosted
//   EVT_QUAD_OVERDUE:      double_triple 1.8x
//   EVT_TRIPLE_OVERDUE:    double_triple 1.4x, streak 1.3x
//   NORMAL:                all 1.0 (no adjustment)
// ═══════════════════════════════════════════════════════════════

import { Pool } from 'pg';
import pino from 'pino';
import { EVTScorer, type EVTState } from './EVTScorer.js';
import { CANONICAL_ALGORITHMS } from '../types/analysis.types.js';

const logger = pino({ name: 'ContextGating' });

// ── Public interfaces ──────────────────────────────────────────
export interface GatingWeights {
  weights:          Record<string, number>;  // algo_name → multiplier
  regime:           string;
  regime_strength:  number;
  explanation:      string;
}

// ── Default (neutral) weight for any algorithm ────────────────
const NEUTRAL = 1.0;

// ══════════════════════════════════════════════════════════════
export class ContextGating {
  private readonly evtScorer: EVTScorer;

  constructor(private readonly pool: Pool) {
    this.evtScorer = new EVTScorer(pool);
  }

  // ─── Compute gating weights for current moment ─────────────
  async computeGating(
    game_type:   string,
    draw_type:   string,
    half:        string,
    as_of_date?: string,
  ): Promise<GatingWeights> {
    logger.debug({ game_type, draw_type, half, as_of_date }, 'computeGating start');

    const evt = await this.evtScorer.computeState(game_type, draw_type, as_of_date);

    // Initialise all canonical algorithms at neutral weight
    const weights: Record<string, number> = {};
    for (const algo of CANONICAL_ALGORITHMS) {
      weights[algo] = NEUTRAL;
    }

    let explanation: string;

    switch (evt.regime) {
      case 'HAWKES_QUAD_CLUSTER': {
        // Amplify the double/triple specialist
        const boostDT = 1 + 3.0 * evt.quad_hawkes_intensity;   // 1.0 .. 4.0
        weights['double_triple']    = round2(boostDT);
        // Suppress trend/calendar — less relevant when repetition is the signal
        weights['trend_momentum']    = 0.7;
        weights['trend_momentum_sweet'] = 0.7;
        weights['calendar_pattern']  = 0.5;
        explanation = `HAWKES_QUAD_CLUSTER (intensity=${evt.quad_hawkes_intensity.toFixed(3)}, ` +
          `days_since_quad=${evt.days_since_quad}): ` +
          `double_triple ×${boostDT.toFixed(2)}, trend_momentum ×0.7, calendar_pattern ×0.5`;
        break;
      }

      case 'HAWKES_TRIPLE_CLUSTER': {
        const boostDT = 1 + 2.0 * evt.triple_hawkes_intensity;  // 1.0 .. 3.0
        weights['double_triple']  = round2(boostDT);
        weights['streak']         = 1.5;
        weights['markov_order2']  = 1.3;
        explanation = `HAWKES_TRIPLE_CLUSTER (intensity=${evt.triple_hawkes_intensity.toFixed(3)}, ` +
          `days_since_triple=${evt.days_since_triple}): ` +
          `double_triple ×${boostDT.toFixed(2)}, streak ×1.5, markov_order2 ×1.3`;
        break;
      }

      case 'EVT_QUAD_OVERDUE': {
        weights['double_triple']     = 1.8;
        weights['transition_follow'] = 0.8;   // transitions less predictive when overdue
        explanation = `EVT_QUAD_OVERDUE (days_since_quad=${evt.days_since_quad}): ` +
          `double_triple ×1.8, transition_follow ×0.8`;
        break;
      }

      case 'EVT_TRIPLE_OVERDUE': {
        weights['double_triple'] = 1.4;
        weights['streak']        = 1.3;
        explanation = `EVT_TRIPLE_OVERDUE (days_since_triple=${evt.days_since_triple}): ` +
          `double_triple ×1.4, streak ×1.3`;
        break;
      }

      case 'NORMAL':
      default: {
        explanation = 'NORMAL regime — all weights at 1.0 (no adjustment)';
        break;
      }
    }

    logger.info(
      { game_type, draw_type, half, regime: evt.regime, regime_strength: evt.regime_strength },
      'ContextGating computed',
    );

    return {
      weights,
      regime:          evt.regime,
      regime_strength: evt.regime_strength,
      explanation,
    };
  }

  // Expose EVT state directly for callers that need it
  async getEVTState(
    game_type:   string,
    draw_type:   string,
    as_of_date?: string,
  ): Promise<EVTState> {
    return this.evtScorer.computeState(game_type, draw_type, as_of_date);
  }

  // Expose retrovalidate pass-through
  async retrovalidate(
    game_type: string,
    draw_type: string,
    from_date: string,
    to_date:   string,
  ) {
    return this.evtScorer.retrovalidate(game_type, draw_type, from_date, to_date);
  }
}

// ── Helpers ────────────────────────────────────────────────────
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
