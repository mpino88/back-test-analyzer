// ═══════════════════════════════════════════════════════════════
// HELIX — ThompsonSampler v1.0.0 (2026-05-19)
//
// Replaces EMA PPS with Bayesian Beta-distribution weights for
// algorithm consensus weighting (Thompson Sampling / MAB).
//
// CURRENT SYSTEM (EMA PPS):
//   pps = EMA(101 − rank_of_winner, α=0.15)
//   Drawbacks: arbitrary α, ignores uncertainty, no exploration.
//
// THOMPSON SAMPLING:
//   weight ~ Beta(α, β)
//   α = hits + 1      (uniform Bayesian prior = 1)
//   β = misses + 1
//   A "hit" at N=15 means rank_of_winner ≤ 15.
//   Provably optimal multi-armed bandit policy (Russo et al., 2018).
//
// UCB SCORE:
//   ucb = mean + 2·σ   (exploration bonus for uncertain algos)
//   This prevents premature exploitation of lucky early winners.
//
// RETROCOMPARE:
//   Computes implied hit_rate@N for EMA vs Thompson on holdout
//   by weighting each algo's rank and computing weighted-average
//   consensus rank per draw, then testing rank ≤ N.
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'ThompsonSampler' });

// ── Types ──────────────────────────────────────────────────────

export interface ThompsonState {
  algo_name:   string;
  game_type:   string;
  draw_type:   string;
  half:        string;
  alpha:       number;    // hits + 1 (Bayesian prior = 1)
  beta_param:  number;    // misses + 1
  mean:        number;    // alpha / (alpha + beta)
  variance:    number;    // alpha·beta / ((alpha+beta)^2·(alpha+beta+1))
  sample:      number;    // sampled value from Beta(α,β)
  credible_lo: number;    // 5th percentile (90% CI lower)
  credible_hi: number;    // 95th percentile (90% CI upper)
  n_total:     number;    // total observations
  ucb_score:   number;    // mean + 2·sqrt(variance)
}

export interface RetroCompareResult {
  game_type:               string;
  draw_type:               string;
  half:                    string;
  from_date:               string;
  to_date:                 string;
  n_draws:                 number;
  ema_hit_rate_n15:        number;
  thompson_hit_rate_n15:   number;
  thompson_ucb_hit_rate_n15: number;
  improvement_pp:          number;
  top_algos_ema:           Array<{ name: string; weight: number }>;
  top_algos_thompson:      Array<{ name: string; mean: number; ucb: number }>;
}

// ── Beta distribution helpers ──────────────────────────────────

/**
 * Box-Muller standard normal sample.
 */
function normalSample(): number {
  const u1 = Math.random();
  const u2 = Math.random();
  // Guard against log(0)
  const safe_u1 = Math.max(u1, 1e-10);
  return Math.sqrt(-2 * Math.log(safe_u1)) * Math.cos(2 * Math.PI * u2);
}

/**
 * Beta(a, b) sample — three paths for correctness at all parameter ranges:
 *
 * 1. a=1, b=1  → Uniform(0,1)                          (exact)
 * 2. a=1, b>1  → 1 - U^(1/b)                           (exact CDF inverse)
 * 3. a>1, b=1  → U^(1/a)                               (exact CDF inverse)
 * 4. a>1, b>1  → Normal approximation (Box-Muller)      (good for large a,b)
 *
 * Edge case fix (BSB 2026-05-21): the previous fallback `return a/(a+b)` returned
 * the MEAN — a deterministic constant, not a sample. New algorithms start with
 * alpha=1 (no hits), beta=N+1; the old code always returned 1/(N+2) = no exploration.
 * The CDF-inverse for Beta(1,b) = 1-(1-u)^(1/b) gives proper stochastic samples,
 * restoring the exploration bonus that Thompson Sampling requires for new algos.
 */
function sampleBeta(a: number, b: number): number {
  const u = Math.random();

  // ── Exact CDF-inverse for a=1 or b=1 ──────────────────────────
  if (a === 1 && b === 1) return u;                             // Uniform
  if (a === 1)            return 1 - Math.pow(Math.max(u, 1e-15), 1 / b); // Beta(1,b)
  if (b === 1)            return Math.pow(Math.max(u, 1e-15), 1 / a);     // Beta(a,1)

  // ── Normal approximation for a,b > 1 (Moivre-Laplace CLT for large n) ──
  const mean     = a / (a + b);
  const variance = (a * b) / ((a + b) ** 2 * (a + b + 1));
  const z        = normalSample();
  return Math.max(0.01, Math.min(0.99, mean + Math.sqrt(variance) * z));
}

// ── Main Service ───────────────────────────────────────────────

export class ThompsonSampler {
  constructor(private pool: Pool) {}

  // ------------------------------------------------------------------
  // buildState — compute Beta posteriors from algo_rank_history
  // ------------------------------------------------------------------
  async buildState(
    game_type:      string,
    draw_type:      string,
    half:           string,
    n_at:           number = 15,
    lookback_days:  number = 90,
  ): Promise<Map<string, ThompsonState>> {
    const sql = `
      WITH recent AS (
        SELECT
          algo_name,
          COUNT(*)                                                 AS n_total,
          SUM(CASE WHEN rank_of_winner <= $4 THEN 1 ELSE 0 END)  AS hits
        FROM hitdash.algo_rank_history
        WHERE game_type = $1
          AND draw_type = $2
          AND half      = $3
          AND draw_date >= CURRENT_DATE - $5::int
        GROUP BY algo_name
      )
      SELECT
        algo_name,
        n_total::int                    AS n_total,
        hits::int                       AS hits,
        (n_total - hits)::int           AS misses
      FROM recent
    `;

    const { rows } = await this.pool.query<{
      algo_name: string;
      n_total:   number;
      hits:      number;
      misses:    number;
    }>(sql, [game_type, draw_type, half, n_at, lookback_days]);

    const stateMap = new Map<string, ThompsonState>();

    for (const row of rows) {
      const alpha    = row.hits  + 1;   // uniform prior
      const beta_p   = row.misses + 1;
      const ab       = alpha + beta_p;
      const mean     = alpha / ab;
      const variance = (alpha * beta_p) / (ab ** 2 * (ab + 1));
      const stddev   = Math.sqrt(variance);
      const sample   = sampleBeta(alpha, beta_p);

      const credible_lo = Math.max(0, mean - 1.645 * stddev);
      const credible_hi = Math.min(1, mean + 1.645 * stddev);
      const ucb_score   = mean + 2 * stddev;

      const state: ThompsonState = {
        algo_name:   row.algo_name,
        game_type,
        draw_type,
        half,
        alpha,
        beta_param:  beta_p,
        mean,
        variance,
        sample,
        credible_lo,
        credible_hi,
        n_total:     row.n_total,
        ucb_score,
      };

      stateMap.set(row.algo_name, state);
    }

    logger.info(
      { game_type, draw_type, half, n_at, lookback_days, n_algos: stateMap.size },
      'Thompson state built',
    );

    return stateMap;
  }

  // ------------------------------------------------------------------
  // D1 (2026-05-20): persistState — escribir Beta(α,β) a thompson_state
  // Cierra el loop de aprendizaje: PostDrawProcessor llama esto después
  // de cada sorteo para que el dashboard lea O(1) sin recomputar.
  // ------------------------------------------------------------------
  async persistState(
    game_type: string,
    draw_type: string,
    half:      string,
    n_at:      number = 15,
  ): Promise<{ persisted: number }> {
    const state = await this.buildState(game_type, draw_type, half, n_at, 90);
    if (state.size === 0) return { persisted: 0 };

    let persisted = 0;
    for (const [algo, s] of state.entries()) {
      try {
        await this.pool.query(
          `INSERT INTO hitdash.thompson_state
             (algo_name, game_type, draw_type, half, n_at, alpha, beta_param, n_total, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, now())
           ON CONFLICT (algo_name, game_type, draw_type, half, n_at)
           DO UPDATE SET
             alpha       = $6,
             beta_param  = $7,
             n_total     = $8,
             updated_at  = now()`,
          [algo, game_type, draw_type, half, n_at, s.alpha, s.beta_param, s.n_total],
        );
        persisted++;
      } catch (err) {
        logger.warn(
          { algo, err: err instanceof Error ? err.message : String(err) },
          'persistState: failed to upsert algo',
        );
      }
    }

    logger.info(
      { game_type, draw_type, half, n_at, persisted },
      '🧠 Thompson state persistido a thompson_state',
    );
    return { persisted };
  }

  // ------------------------------------------------------------------
  // sampleWeights — draw from Beta posteriors for this round
  // Returns algo_name → sampled weight (used for consensus ranking)
  //
  // L79 FIX (2026-05-21): leer de thompson_state primero (O(1) — sin scan).
  // Si el cache está fresco (<2h) lo usa; si no, cae a buildState() (90-day scan).
  // persistState() escribe a thompson_state después de cada sorteo (PostDrawProcessor D1).
  // ------------------------------------------------------------------
  async sampleWeights(
    game_type: string,
    draw_type: string,
    half:      string,
    n_at:      number = 15,
  ): Promise<Map<string, number>> {
    // — Cache path: thompson_state fresco (<2h) ——————————————————————
    try {
      const { rows } = await this.pool.query<{
        algo_name:  string;
        alpha:      number;
        beta_param: number;
      }>(
        `SELECT algo_name, alpha, beta_param
         FROM hitdash.thompson_state
         WHERE game_type = $1 AND draw_type = $2 AND half = $3 AND n_at = $4
           AND updated_at > now() - interval '2 hours'`,
        [game_type, draw_type, half, n_at],
      );

      if (rows.length > 0) {
        const weights = new Map<string, number>();
        for (const r of rows) {
          weights.set(r.algo_name, sampleBeta(Number(r.alpha), Number(r.beta_param)));
        }
        logger.debug(
          { game_type, draw_type, half, n_at, n_algos: rows.length },
          'sampleWeights: served from thompson_state cache (O(1))',
        );
        return weights;
      }
    } catch (err) {
      // Cache miss (table not ready yet) → fall through to buildState
      logger.debug({ err: String(err) }, 'sampleWeights: thompson_state unavailable, fallback to buildState');
    }

    // — Fallback: recompute from algo_rank_history (slow path) ————————
    logger.debug({ game_type, draw_type, half }, 'sampleWeights: cache miss — recomputing from algo_rank_history');
    const state = await this.buildState(game_type, draw_type, half, n_at);
    const weights = new Map<string, number>();
    for (const [algo_name, s] of state.entries()) {
      weights.set(algo_name, sampleBeta(s.alpha, s.beta_param));
    }
    return weights;
  }

  // ------------------------------------------------------------------
  // retrocompare — compare Thompson vs EMA performance on holdout
  // ------------------------------------------------------------------
  async retrocompare(
    game_type: string,
    draw_type: string,
    half:      string,
    from_date: string,
    to_date:   string,
  ): Promise<RetroCompareResult> {
    const n_at = 15;

    // Pull all rank data for the date range
    const sql = `
      SELECT algo_name, draw_date::text AS draw_date, rank_of_winner
      FROM hitdash.algo_rank_history
      WHERE game_type = $1
        AND draw_type = $2
        AND half      = $3
        AND draw_date BETWEEN $4 AND $5
      ORDER BY algo_name, draw_date
    `;

    const { rows } = await this.pool.query<{
      algo_name:      string;
      draw_date:      string;
      rank_of_winner: number;
    }>(sql, [game_type, draw_type, half, from_date, to_date]);

    if (rows.length === 0) {
      logger.warn({ game_type, draw_type, half, from_date, to_date }, 'retrocompare: no data');
      return {
        game_type, draw_type, half, from_date, to_date,
        n_draws:                  0,
        ema_hit_rate_n15:         0,
        thompson_hit_rate_n15:    0,
        thompson_ucb_hit_rate_n15: 0,
        improvement_pp:           0,
        top_algos_ema:            [],
        top_algos_thompson:       [],
      };
    }

    // Pivot: draw_date → { algo_name → rank_of_winner }
    const byDate = new Map<string, Map<string, number>>();
    const algoSet = new Set<string>();

    for (const row of rows) {
      algoSet.add(row.algo_name);
      if (!byDate.has(row.draw_date)) byDate.set(row.draw_date, new Map());
      byDate.get(row.draw_date)!.set(row.algo_name, row.rank_of_winner);
    }

    const draws = Array.from(byDate.keys()).sort();
    const n_draws = draws.length;

    // Split 50/50: first half = training, second half = holdout
    const split   = Math.floor(n_draws / 2);
    const trainDates = draws.slice(0, split);
    const holdDates  = draws.slice(split);

    // Build weights from TRAINING half
    // ── EMA weights: pps = EMA(101 − rank, α=0.15), seed = 50
    const emaWeights = new Map<string, number>();
    for (const algo of algoSet) emaWeights.set(algo, 50.0);

    for (const d of trainDates) {
      const dm = byDate.get(d)!;
      for (const [algo, rank] of dm.entries()) {
        const prev  = emaWeights.get(algo) ?? 50.0;
        const score = 101 - rank;
        emaWeights.set(algo, 0.15 * score + 0.85 * prev);
      }
    }

    // ── Thompson weights: posterior mean from training data
    const thompsonHits   = new Map<string, number>();
    const thompsonMisses = new Map<string, number>();
    for (const algo of algoSet) { thompsonHits.set(algo, 0); thompsonMisses.set(algo, 0); }

    for (const d of trainDates) {
      const dm = byDate.get(d)!;
      for (const [algo, rank] of dm.entries()) {
        if (rank <= n_at) {
          thompsonHits.set(algo, (thompsonHits.get(algo) ?? 0) + 1);
        } else {
          thompsonMisses.set(algo, (thompsonMisses.get(algo) ?? 0) + 1);
        }
      }
    }

    // Compute Thompson posterior means and UCBs
    const thompsonMeans  = new Map<string, number>();
    const thompsonUCBs   = new Map<string, number>();

    for (const algo of algoSet) {
      const a   = (thompsonHits.get(algo) ?? 0) + 1;
      const b   = (thompsonMisses.get(algo) ?? 0) + 1;
      const ab  = a + b;
      const m   = a / ab;
      const v   = (a * b) / (ab ** 2 * (ab + 1));
      thompsonMeans.set(algo, m);
      thompsonUCBs.set(algo, m + 2 * Math.sqrt(v));
    }

    // Evaluate on HOLDOUT: compute weighted consensus rank per draw
    // Weighted rank = sum(weight_i * rank_i) / sum(weight_i)
    // If weighted_rank ≤ 15 → hit
    let ema_hits = 0, th_hits = 0, th_ucb_hits = 0;

    for (const d of holdDates) {
      const dm = byDate.get(d)!;
      if (dm.size === 0) continue;

      let ema_num = 0, ema_den = 0;
      let th_num  = 0, th_den  = 0;
      let ucb_num = 0, ucb_den = 0;

      for (const [algo, rank] of dm.entries()) {
        const ew  = emaWeights.get(algo) ?? 50.0;
        const tw  = (thompsonMeans.get(algo) ?? 0.5) * 100;  // scale to same magnitude
        const uw  = (thompsonUCBs.get(algo) ?? 0.5) * 100;

        ema_num += ew * rank;   ema_den += ew;
        th_num  += tw * rank;   th_den  += tw;
        ucb_num += uw * rank;   ucb_den += uw;
      }

      const ema_rank = ema_den > 0 ? ema_num / ema_den : 101;
      const th_rank  = th_den  > 0 ? th_num  / th_den  : 101;
      const ucb_rank = ucb_den > 0 ? ucb_num / ucb_den : 101;

      if (ema_rank <= n_at)  ema_hits++;
      if (th_rank  <= n_at)  th_hits++;
      if (ucb_rank <= n_at)  th_ucb_hits++;
    }

    const holdN = holdDates.length || 1;
    const ema_hit_rate_n15         = ema_hits    / holdN;
    const thompson_hit_rate_n15    = th_hits     / holdN;
    const thompson_ucb_hit_rate_n15 = th_ucb_hits / holdN;
    const improvement_pp           = (thompson_hit_rate_n15 - ema_hit_rate_n15) * 100;

    // Top algos by weight
    const top_algos_ema = Array.from(emaWeights.entries())
      .map(([name, weight]) => ({ name, weight }))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, 5);

    const top_algos_thompson = Array.from(thompsonMeans.entries())
      .map(([name, mean]) => ({ name, mean, ucb: thompsonUCBs.get(name) ?? mean }))
      .sort((a, b) => b.ucb - a.ucb)
      .slice(0, 5);

    logger.info(
      {
        game_type, draw_type, half,
        n_draws, holdout: holdN,
        ema_hit_rate_n15, thompson_hit_rate_n15, improvement_pp,
      },
      'retrocompare complete',
    );

    return {
      game_type, draw_type, half, from_date, to_date,
      n_draws,
      ema_hit_rate_n15,
      thompson_hit_rate_n15,
      thompson_ucb_hit_rate_n15,
      improvement_pp,
      top_algos_ema,
      top_algos_thompson,
    };
  }
}
