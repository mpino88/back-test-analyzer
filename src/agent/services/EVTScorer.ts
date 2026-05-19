// ═══════════════════════════════════════════════════════════════
// HELIX — EVTScorer v1.0.0 (2026-05-19)
//
// Extreme Value Theory scorer for rare-event detection.
//
// MOTIVATION:
//   When rare patterns (doubles/triples/quads) become likely via
//   Hawkes clustering, standard consensus averaging kills the signal
//   from the `double_triple` detector. This scorer quantifies the
//   current regime so ContextGating can amplify the relevant algo.
//
// PROVEN RETROSPECTIVE (do NOT re-query):
//   • In 30 days AFTER a quad: P(double_pair) = 12.15% vs 10% baseline
//     → +21.5% relative lift
//   • 2026-05-18 6-6-6-6 occurred 17 days after 2026-05-01 8-8-8-8
//     → pure Hawkes clustering confirmed
//   • double_triple had "66" at rank #6 but consensus averaged it out
//   • With Hawkes gating (4x weight), "66" would have been top-5
//
// DESIGN:
//   - Hawkes intensity decays exponentially: I = exp(-λ × days_since)
//     λ=0.05 quads, λ=0.10 triples
//   - No data leakage: all queries use WHERE draw_date < as_of_date
// ═══════════════════════════════════════════════════════════════

import { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'EVTScorer' });

// ── Hawkes decay constants ─────────────────────────────────────
const LAMBDA_QUAD   = 0.05;  // slower decay — quads are rarer
const LAMBDA_TRIPLE = 0.10;  // faster decay — triples less extreme

// ── Regime thresholds ──────────────────────────────────────────
const HAWKES_QUAD_INTENSITY_THRESHOLD   = 0.3;  // ≈ days_since ≤ 24
const HAWKES_TRIPLE_INTENSITY_THRESHOLD = 0.3;  // ≈ days_since ≤ 12
const EVT_QUAD_OVERDUE_DAYS             = 300;
const EVT_TRIPLE_OVERDUE_DAYS           = 60;

// ── Public interfaces ──────────────────────────────────────────
export type EVTRegime =
  | 'HAWKES_QUAD_CLUSTER'
  | 'HAWKES_TRIPLE_CLUSTER'
  | 'EVT_QUAD_OVERDUE'
  | 'EVT_TRIPLE_OVERDUE'
  | 'NORMAL';

export interface EVTState {
  game_type:    string;
  draw_type:    string;
  as_of_date:   string;

  // Quads (pick4 only: p1=p2=p3=p4)
  days_since_quad:        number | null;
  quad_hawkes_intensity:  number;   // 0..1
  quad_overdue_score:     number;   // 0..1

  // Triples (pick4: 3 consecutive equal; pick3: p1=p2=p3)
  days_since_triple:        number | null;
  triple_hawkes_intensity:  number;
  triple_overdue_score:     number;

  // Palindromes (pick3 only: p1=p3, e.g. 1-2-1)
  days_since_palindrome:    number | null;
  palindrome_overdue_score: number;

  // Overall regime
  regime:          EVTRegime;
  regime_strength: number;   // 0..3
}

export interface RetroReportEntry {
  regime:           string;
  draws:            number;
  double_win_rate:  number;   // fraction of draws where winning pair was same-digit
  baseline:         number;   // 10 same-digit pairs / 100 = 0.10
  lift_pp:          number;   // percentage points above baseline
  lift_pct:         number;   // relative % improvement
}

export interface RetroReport {
  game_type:    string;
  draw_type:    string;
  from_date:    string;
  to_date:      string;
  total_draws:  number;

  by_regime:    RetroReportEntry[];

  // Hawkes window aggregate
  hawkes_window_draws:           number;
  hawkes_window_double_win_rate: number;
  baseline_double_win_rate:      number;
  total_improvement_draws:       number;  // extra catches vs baseline
}

// ── Internal DB row shapes ─────────────────────────────────────
interface RawDaysRow {
  days_since_quad:      string | null;
  days_since_triple:    string | null;
  days_since_palindrome: string | null;
}

interface RetroDrawRow {
  draw_date:    string;
  p1:           number;
  p2:           number;
  p3:           number;
  p4:           number | null;
}

// ══════════════════════════════════════════════════════════════
export class EVTScorer {
  constructor(private readonly pool: Pool) {}

  // ─── Compute current EVT state ─────────────────────────────
  async computeState(
    game_type:   string,
    draw_type:   string,
    as_of_date?: string,
  ): Promise<EVTState> {
    const asOf = as_of_date ?? new Date().toISOString().slice(0, 10);
    const isP3  = game_type.toLowerCase().includes('pick3') || game_type === 'pick3';

    logger.debug({ game_type, draw_type, asOf }, 'computeState start');

    // ── Quad condition (pick4 only) ────────────────────────────
    const quadCondition = isP3
      ? 'FALSE'   // quads impossible in pick3
      : 'p1=p2 AND p2=p3 AND p3=p4';

    // ── Triple condition ───────────────────────────────────────
    const tripleCondition = isP3
      ? 'p1=p2 AND p2=p3'
      : '(p1=p2 AND p2=p3) OR (p2=p3 AND p3=p4)';

    // ── Palindrome condition (pick3 only: p1=p3) ───────────────
    const palindromeCondition = isP3 ? 'p1=p3' : 'FALSE';

    const sql = `
      WITH quad_last AS (
        SELECT MAX(draw_date) AS last_quad
        FROM hitdash.ingested_results
        WHERE game_type = $1
          AND draw_type = $2
          AND (${quadCondition})
          AND draw_date < $3
      ),
      triple_last AS (
        SELECT MAX(draw_date) AS last_triple
        FROM hitdash.ingested_results
        WHERE game_type = $1
          AND draw_type = $2
          AND (${tripleCondition})
          AND draw_date < $3
      ),
      palindrome_last AS (
        SELECT MAX(draw_date) AS last_palindrome
        FROM hitdash.ingested_results
        WHERE game_type = $1
          AND draw_type = $2
          AND (${palindromeCondition})
          AND draw_date < $3
      )
      SELECT
        ($3::date - last_quad)::int       AS days_since_quad,
        ($3::date - last_triple)::int     AS days_since_triple,
        ($3::date - last_palindrome)::int AS days_since_palindrome
      FROM quad_last, triple_last, palindrome_last
    `;

    const result = await this.pool.query<RawDaysRow>(sql, [game_type, draw_type, asOf]);
    const row    = result.rows[0];

    const daysSinceQuad      = row?.days_since_quad      != null ? parseInt(String(row.days_since_quad))      : null;
    const daysSinceTriple    = row?.days_since_triple    != null ? parseInt(String(row.days_since_triple))    : null;
    const daysSincePalindrome = row?.days_since_palindrome != null ? parseInt(String(row.days_since_palindrome)) : null;

    // ── Hawkes intensities ─────────────────────────────────────
    const quadHawkes   = daysSinceQuad   != null ? Math.exp(-LAMBDA_QUAD   * daysSinceQuad)   : 0;
    const tripleHawkes = daysSinceTriple != null ? Math.exp(-LAMBDA_TRIPLE * daysSinceTriple) : 0;

    // ── Overdue scores (0..1, capped) ─────────────────────────
    const quadOverdue      = daysSinceQuad   != null ? Math.min(daysSinceQuad   / EVT_QUAD_OVERDUE_DAYS,   1) : 0;
    const tripleOverdue    = daysSinceTriple != null ? Math.min(daysSinceTriple / EVT_TRIPLE_OVERDUE_DAYS, 1) : 0;
    const palindromeOverdue = daysSincePalindrome != null ? Math.min(daysSincePalindrome / 30, 1) : 0;

    // ── Regime classification (priority order) ─────────────────
    let regime: EVTRegime = 'NORMAL';
    let regimeStrength    = 0;

    if (quadHawkes > HAWKES_QUAD_INTENSITY_THRESHOLD) {
      regime         = 'HAWKES_QUAD_CLUSTER';
      regimeStrength = Math.min(3, 1 + 2 * quadHawkes);
    } else if (tripleHawkes > HAWKES_TRIPLE_INTENSITY_THRESHOLD) {
      regime         = 'HAWKES_TRIPLE_CLUSTER';
      regimeStrength = Math.min(3, 1 + 2 * tripleHawkes);
    } else if (daysSinceQuad != null && daysSinceQuad > EVT_QUAD_OVERDUE_DAYS) {
      regime         = 'EVT_QUAD_OVERDUE';
      regimeStrength = Math.min(3, quadOverdue * 2);
    } else if (daysSinceTriple != null && daysSinceTriple > EVT_TRIPLE_OVERDUE_DAYS) {
      regime         = 'EVT_TRIPLE_OVERDUE';
      regimeStrength = Math.min(3, tripleOverdue * 2);
    }

    logger.info(
      { game_type, draw_type, asOf, regime, regimeStrength, daysSinceQuad, daysSinceTriple },
      'EVT state computed',
    );

    return {
      game_type,
      draw_type,
      as_of_date:              asOf,
      days_since_quad:         daysSinceQuad,
      quad_hawkes_intensity:   round4(quadHawkes),
      quad_overdue_score:      round4(quadOverdue),
      days_since_triple:       daysSinceTriple,
      triple_hawkes_intensity: round4(tripleHawkes),
      triple_overdue_score:    round4(tripleOverdue),
      days_since_palindrome:   daysSincePalindrome,
      palindrome_overdue_score: round4(palindromeOverdue),
      regime,
      regime_strength:         round4(regimeStrength),
    };
  }

  // ─── Score multiplier for a single pair ────────────────────
  // Returns 1.0 (neutral) up to 4.0 (maximum boost)
  async scorePair(pair: string, state: EVTState): Promise<number> {
    if (pair.length !== 2) return 1.0;

    const a = parseInt(pair[0]!, 10);
    const b = parseInt(pair[1]!, 10);

    const isSameDigit = a === b;             // 00, 11, 22, ... 99
    const isMirror    = (a + b === 9);       // 09,18,27,36,45 (+ reverses)

    switch (state.regime) {
      case 'HAWKES_QUAD_CLUSTER':
        if (isSameDigit) {
          return round4(1 + 3.0 * state.quad_hawkes_intensity);  // up to 4.0
        }
        return 1.0;

      case 'HAWKES_TRIPLE_CLUSTER':
        if (isSameDigit || isMirror) {
          return round4(1 + 2.0 * state.triple_hawkes_intensity);  // up to 3.0
        }
        return 1.0;

      case 'EVT_QUAD_OVERDUE':
        if (isSameDigit) {
          return round4(1 + 0.8 * state.quad_overdue_score);  // up to 1.8
        }
        return 1.0;

      case 'EVT_TRIPLE_OVERDUE':
        if (isSameDigit) {
          return round4(1 + 0.4 * state.triple_overdue_score);  // up to 1.4
        }
        if (isMirror) {
          return round4(1 + 0.2 * state.triple_overdue_score);
        }
        return 1.0;

      case 'NORMAL':
      default:
        return 1.0;
    }
  }

  // ─── Retrospective validation ───────────────────────────────
  // Computes EVT state for every draw in [from_date, to_date] and
  // measures whether same-digit pairs win more during Hawkes windows.
  async retrovalidate(
    game_type: string,
    draw_type: string,
    from_date: string,
    to_date:   string,
  ): Promise<RetroReport> {
    logger.info({ game_type, draw_type, from_date, to_date }, 'retrovalidate start');

    // Fetch all draws in the range with their actual results
    const draws = await this.pool.query<RetroDrawRow>(
      `SELECT draw_date::text, p1, p2, p3, COALESCE(p4, -1) AS p4
       FROM hitdash.ingested_results
       WHERE game_type = $1
         AND draw_type = $2
         AND draw_date >= $3
         AND draw_date <= $4
       ORDER BY draw_date ASC`,
      [game_type, draw_type, from_date, to_date],
    );

    const rows       = draws.rows;
    const totalDraws = rows.length;

    if (totalDraws === 0) {
      return emptyRetroReport(game_type, draw_type, from_date, to_date);
    }

    // Tally by regime
    const regimeTally: Record<string, { draws: number; double_wins: number }> = {};
    const ALL_REGIMES: EVTRegime[] = [
      'HAWKES_QUAD_CLUSTER',
      'HAWKES_TRIPLE_CLUSTER',
      'EVT_QUAD_OVERDUE',
      'EVT_TRIPLE_OVERDUE',
      'NORMAL',
    ];
    for (const r of ALL_REGIMES) {
      regimeTally[r] = { draws: 0, double_wins: 0 };
    }

    let hawkesWindowDraws  = 0;
    let hawkesWindowDoubleWins = 0;

    for (const row of rows) {
      // Compute EVT state as-of this draw date (no leakage)
      const state = await this.computeState(game_type, draw_type, row.draw_date);

      // Determine if the actual "ab" pair (p1+p2) is a double
      // For pick3: p1+p2 pair (du would be p2+p3 but we check the result's first pair)
      // We check both halves: ab = p1p2 and cd = p3p4
      const isDouble_ab = (row.p1 === row.p2);
      const isDouble_cd = row.p4 !== -1 ? (row.p3 === row.p4) : false;
      const isDouble    = isDouble_ab || isDouble_cd;

      const regime = state.regime;
      if (regimeTally[regime]) {
        regimeTally[regime]!.draws++;
        if (isDouble) regimeTally[regime]!.double_wins++;
      }

      // Track Hawkes window aggregate
      if (regime === 'HAWKES_QUAD_CLUSTER' || regime === 'HAWKES_TRIPLE_CLUSTER') {
        hawkesWindowDraws++;
        if (isDouble) hawkesWindowDoubleWins++;
      }
    }

    const BASELINE = 0.10;  // 10 same-digit pairs / 100

    const byRegime: RetroReportEntry[] = ALL_REGIMES.map((regime) => {
      const tally     = regimeTally[regime]!;
      const winRate   = tally.draws > 0 ? tally.double_wins / tally.draws : 0;
      const lift_pp   = winRate - BASELINE;
      const lift_pct  = BASELINE > 0 ? (lift_pp / BASELINE) * 100 : 0;
      return {
        regime,
        draws:           tally.draws,
        double_win_rate: round4(winRate),
        baseline:        BASELINE,
        lift_pp:         round4(lift_pp),
        lift_pct:        round4(lift_pct),
      };
    }).filter(e => e.draws > 0);

    const hawkesWinRate = hawkesWindowDraws > 0
      ? hawkesWindowDoubleWins / hawkesWindowDraws
      : 0;
    const totalImprovementDraws = Math.round(
      (hawkesWinRate - BASELINE) * hawkesWindowDraws,
    );

    // Baseline win rate across full range
    const totalDoubleWins = rows.filter(r => r.p1 === r.p2 || (r.p4 !== -1 && r.p3 === r.p4)).length;
    const baselineWinRate = totalDraws > 0 ? totalDoubleWins / totalDraws : BASELINE;

    logger.info(
      { totalDraws, hawkesWindowDraws, hawkesWinRate, baselineWinRate },
      'retrovalidate complete',
    );

    return {
      game_type,
      draw_type,
      from_date,
      to_date,
      total_draws:                   totalDraws,
      by_regime:                     byRegime,
      hawkes_window_draws:           hawkesWindowDraws,
      hawkes_window_double_win_rate: round4(hawkesWinRate),
      baseline_double_win_rate:      round4(baselineWinRate),
      total_improvement_draws:       totalImprovementDraws,
    };
  }
}

// ── Helpers ────────────────────────────────────────────────────
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}

function emptyRetroReport(
  game_type: string,
  draw_type: string,
  from_date: string,
  to_date:   string,
): RetroReport {
  return {
    game_type, draw_type, from_date, to_date,
    total_draws:                   0,
    by_regime:                     [],
    hawkes_window_draws:           0,
    hawkes_window_double_win_rate: 0,
    baseline_double_win_rate:      0.10,
    total_improvement_draws:       0,
  };
}
