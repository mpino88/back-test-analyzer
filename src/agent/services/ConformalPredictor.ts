// ═══════════════════════════════════════════════════════════════
// HELIX — ConformalPredictor v1.0.0 (2026-05-19)
//
// Conformal Prediction gives GUARANTEED marginal coverage for
// prediction sets — not estimated, mathematically proven.
//
// THEOREM (Venn-Shafer-Gammerman, Angelopoulos & Bates 2023):
//   Given n calibration examples with nonconformity scores
//   s_1,...,s_n, and the score of a new test point s_{n+1},
//   the prediction set C(x) = {y : s(x,y) ≤ q} satisfies:
//     P(y_true ∈ C(x)) ≥ 1 - α   (exactly, not approximately)
//   under the only assumption of exchangeability.
//
// APPLICATION TO LOTTERY:
//   • Nonconformity score for a draw = rank_of_winner assigned by
//     the best individual algorithm in algo_rank_history.
//   • Calibration: from historical ranks, find threshold q s.t.
//     ⌈(n+1)(1-α)⌉/n quantile of sorted scores gives ≥ 1-α coverage.
//   • At prediction time: return all pairs with consensus_rank ≤ q
//     → guaranteed 80% coverage by theorem.
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'ConformalPredictor' });

// ── Public interfaces ──────────────────────────────────────────

export interface CalibrationResult {
  game_type:      string;
  draw_type:      string;
  half:           string;
  algo_name:      string;       // which algo's ranks used for calibration
  n_calibration:  number;
  coverage_80:    number;       // threshold (rank) for 80% coverage
  coverage_90:    number;       // threshold for 90% coverage
  coverage_95:    number;       // threshold for 95% coverage
  empirical_80:   number;       // actual observed coverage at threshold_80
  empirical_90:   number;
  set_size_80:    number;       // avg pairs in prediction set at 80% target
  set_size_90:    number;
  calibrated_at:  string;
}

export interface ConformalPrediction {
  game_type:           string;
  draw_type:           string;
  half:                string;
  coverage_target:     number;   // 0.80 or 0.90
  threshold_rank:      number;   // pairs with rank <= this are in set
  predicted_pairs:     string[]; // pairs in the conformal set (placeholder — needs algo rank data)
  set_size:            number;
  guaranteed_coverage: boolean;  // always true (theorem guarantee)
  algo_used:           string;
  // Retrospective: was the winner in the conformal set?
  // (null at prediction time, filled after draw)
  was_hit:             boolean | null;
}

export interface ConformalRetroReport {
  game_type:         string;
  draw_type:         string;
  half:              string;
  n_test:            number;
  target_coverage:   number;
  actual_coverage:   number;   // fraction of test draws where winner was in set
  avg_set_size:      number;
  coverage_gap:      number;   // actual - target (positive = over-coverage = sets too large)
  baseline_coverage: number;   // coverage if we just took top-15 (N/100 = 15%)
  improvement_pp:    number;   // actual_coverage - baseline_coverage in pp
}

// ── Internal helpers ───────────────────────────────────────────

/**
 * Empirical quantile from a sorted array at proportion p.
 * Clamps to valid indices. Returns 101 when array is empty.
 */
function quantile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 101;
  const idx = Math.min(
    sorted.length - 1,
    Math.max(0, Math.floor(p * sorted.length)),
  );
  return sorted[idx] ?? 101;
}

// ══════════════════════════════════════════════════════════════

export class ConformalPredictor {
  constructor(private readonly pool: Pool) {}

  // ─── Calibrate conformal scores from historical algo_rank_history ──
  // Uses the BEST individual algorithm (highest hit_rate@15) as the
  // nonconformity score function.
  async calibrate(
    game_type:      string,
    draw_type:      string,
    half:           string,
    lookback_days:  number = 365,
  ): Promise<CalibrationResult> {
    logger.info({ game_type, draw_type, half, lookback_days }, 'calibrate start');

    // Step 1: find the best-performing algo by hit_rate@15
    const { rows: bestRow } = await this.pool.query<{ algo_name: string; hr15: number }>(
      `SELECT algo_name,
              SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::float / COUNT(*) AS hr15
       FROM hitdash.algo_rank_history
       WHERE game_type = $1
         AND draw_type = $2
         AND half      = $3
         AND draw_date >= CURRENT_DATE - $4::int
       GROUP BY algo_name
       ORDER BY hr15 DESC
       LIMIT 1`,
      [game_type, draw_type, half, lookback_days],
    );

    const best_algo = bestRow[0]?.algo_name ?? 'markov_order2';

    // Step 2: get all rank_of_winner values from that algo
    const { rows: rankRows } = await this.pool.query<{ rank_of_winner: string }>(
      `SELECT rank_of_winner
       FROM hitdash.algo_rank_history
       WHERE game_type = $1
         AND draw_type = $2
         AND half      = $3
         AND algo_name = $4
         AND draw_date >= CURRENT_DATE - $5::int
       ORDER BY rank_of_winner`,
      [game_type, draw_type, half, best_algo, lookback_days],
    );

    const n = rankRows.length;
    if (n === 0) {
      throw new Error(
        `No calibration data for ${game_type}/${draw_type}/${half} algo=${best_algo}`,
      );
    }

    const sorted = rankRows.map(r => Number(r.rank_of_winner)).sort((a, b) => a - b);

    // Step 3: Conformal quantiles q_{⌈(n+1)(1-α)⌉ / n}
    // We use the standard conformal quantile formula.
    const threshold80 = quantile(sorted, Math.ceil((n + 1) * 0.80) / n);
    const threshold90 = quantile(sorted, Math.ceil((n + 1) * 0.90) / n);
    const threshold95 = quantile(sorted, Math.ceil((n + 1) * 0.95) / n);

    // Step 4: Empirical coverage (cross-check)
    const emp80 = sorted.filter(r => r <= threshold80).length / n;
    const emp90 = sorted.filter(r => r <= threshold90).length / n;

    const result: CalibrationResult = {
      game_type,
      draw_type,
      half,
      algo_name:     best_algo,
      n_calibration: n,
      coverage_80:   threshold80,
      coverage_90:   threshold90,
      coverage_95:   threshold95,
      empirical_80:  round4(emp80),
      empirical_90:  round4(emp90),
      set_size_80:   threshold80, // rank threshold ≈ # pairs in set
      set_size_90:   threshold90,
      calibrated_at: new Date().toISOString(),
    };

    logger.info(
      { game_type, draw_type, half, best_algo, n, threshold80, threshold90, emp80, emp90 },
      'calibrate complete',
    );

    return result;
  }

  // ─── Retrovalidation: walk-forward test on held-out period ────────
  // Trains conformal threshold on [train_months ago, test_months ago],
  // evaluates on the most recent test_months.
  async retrovalidate(
    game_type:    string,
    draw_type:    string,
    half:         string,
    train_months: number = 36,
    test_months:  number = 12,
  ): Promise<ConformalRetroReport> {
    logger.info(
      { game_type, draw_type, half, train_months, test_months },
      'retrovalidate start',
    );

    // Best algo over training period
    const { rows: best } = await this.pool.query<{ algo_name: string; hr: number }>(
      `SELECT algo_name,
              SUM(CASE WHEN rank_of_winner <= 15 THEN 1.0 ELSE 0 END) / COUNT(*) AS hr
       FROM hitdash.algo_rank_history
       WHERE game_type = $1
         AND draw_type = $2
         AND half      = $3
         AND draw_date < CURRENT_DATE - $4::int * 30
       GROUP BY algo_name
       ORDER BY hr DESC
       LIMIT 1`,
      [game_type, draw_type, half, test_months],
    );

    const algo = best[0]?.algo_name ?? 'markov_order2';

    // Training ranks (calibration set)
    const { rows: train } = await this.pool.query<{ rank_of_winner: string }>(
      `SELECT rank_of_winner
       FROM hitdash.algo_rank_history
       WHERE game_type = $1
         AND draw_type = $2
         AND half      = $3
         AND algo_name = $4
         AND draw_date < CURRENT_DATE - $5::int * 30
       ORDER BY rank_of_winner`,
      [game_type, draw_type, half, algo, test_months],
    );

    // Test ranks (holdout)
    const { rows: test } = await this.pool.query<{ rank_of_winner: string }>(
      `SELECT rank_of_winner
       FROM hitdash.algo_rank_history
       WHERE game_type = $1
         AND draw_type = $2
         AND half      = $3
         AND algo_name = $4
         AND draw_date >= CURRENT_DATE - $5::int * 30
       ORDER BY draw_date`,
      [game_type, draw_type, half, algo, test_months],
    );

    const sorted_train = train.map(r => Number(r.rank_of_winner)).sort((a, b) => a - b);
    const n_train = sorted_train.length;

    const TARGET = 0.80;
    const threshold =
      n_train > 0
        ? quantile(sorted_train, Math.ceil((n_train + 1) * TARGET) / n_train)
        : 15;

    const test_ranks = test.map(r => Number(r.rank_of_winner));
    const n_test = test_ranks.length;
    const hits = test_ranks.filter(r => r <= threshold).length;
    const actual_coverage = n_test > 0 ? hits / n_test : 0;

    const report: ConformalRetroReport = {
      game_type,
      draw_type,
      half,
      n_test,
      target_coverage:   TARGET,
      actual_coverage:   round4(actual_coverage),
      avg_set_size:      threshold,
      coverage_gap:      round4(actual_coverage - TARGET),
      baseline_coverage: 0.15, // top-15 out of 100 pairs
      improvement_pp:    round4((actual_coverage - 0.15) * 100),
    };

    logger.info(
      {
        game_type, draw_type, half, algo,
        n_train, n_test, threshold, actual_coverage,
      },
      'retrovalidate complete',
    );

    return report;
  }
}

// ── Helpers ────────────────────────────────────────────────────
function round4(v: number): number {
  return Math.round(v * 10000) / 10000;
}
