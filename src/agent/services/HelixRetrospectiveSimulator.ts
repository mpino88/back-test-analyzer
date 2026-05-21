// ═══════════════════════════════════════════════════════════════
// HELIX — Walk-Forward Retrospective Simulator v1.0.0 (2026-05-21)
//
// CRÍTICA DE INVERSORES:
//   "No tienen historial retrospectivo de validación.
//    El autoaprendizaje debió hacerse retrospectivo.
//    Al día de hoy el sistema está completamente ciego."
//
// RESPUESTA — Walk-Forward Replay del pipeline HELIX v2 completo:
//   • Para cada draw histórico T desde 2021-05-16:
//       1) Usa solo data de [start, T-1] (NO future leakage)
//       2) Computa Thompson α/β desde algo_rank_history en ventana
//       3) Lee algo_prediction_snapshot[T] (pair_scores reales captados ese día)
//       4) Aplica consensus weighting (Thompson × ALGORITHM_WEIGHTS)
//       5) Computa conformal threshold (quantile de rank_of_winner en [T-180, T-1])
//       6) Predice top-N pares
//       7) Compara contra ganador real → hit/miss
//       8) Persiste fila en helix_retrospective_runs
//   • Al final agrega métricas en helix_retrospective_summary:
//       hit_rate, Wilson 95% CI, edge_pp, edge_multiplier, MRR, mediana_rank
//
// GARANTÍA: estricta validez walk-forward. Cada predicción es auditable.
// Inversores pueden re-ejecutar y verificar. Output reproducible bit-a-bit.
// ═══════════════════════════════════════════════════════════════

import type { Pool, PoolClient } from 'pg';
import pino from 'pino';
import { ALGORITHM_WEIGHTS } from '../types/analysis.types.js';

const logger = pino({ name: 'HelixRetrospectiveSimulator' });

// ── Configuración ───────────────────────────────────────────────
const THOMPSON_WINDOW_DAYS  = 90;    // ventana de algo_rank_history para Thompson posteriors
const CONFORMAL_WINDOW_DAYS = 180;   // ventana más amplia para quantile estable
const WARMUP_DAYS           = 90;    // mínimo de historia antes de empezar a predecir
const DEFAULT_TOP_N         = 15;
const CONFORMAL_ALPHA       = 0.20;  // target coverage = 1 - α = 80%

// ── Tipos ───────────────────────────────────────────────────────
export interface SimulateOpts {
  game_type:    'pick3' | 'pick4';
  draw_type:    'midday' | 'evening';
  half:         'du' | 'ab' | 'cd';
  top_n?:       number;           // default 15
  from_date?:   string;           // YYYY-MM-DD, default earliest
  to_date?:     string;           // YYYY-MM-DD, default latest
  run_id?:      string;           // default `helix-v2-{ts}`
}

export interface SimulateSummary {
  run_id:           string;
  game_type:        string;
  draw_type:        string;
  half:             string;
  n_draws:          number;
  n_hits:           number;
  hit_rate:         number;
  wilson_lo:        number;
  wilson_hi:        number;
  baseline_rate:    number;
  edge_pp:          number;
  edge_multiplier:  number;
  mrr:              number | null;
  median_rank:      number | null;
  conformal_emp_80: number | null;
  pct_normal:       number;
  pct_hawkes:       number;
  pct_evt:          number;
  date_from:        string;
  date_to:          string;
  duration_ms:      number;
}

interface DrawRow {
  draw_date:     string;
  winning_pair:  string;
}

interface SnapshotRow {
  algo_name:    string;
  pair_scores:  Record<string, number>;
}

interface ThompsonStateLite {
  algo_name: string;
  alpha:     number;
  beta:      number;
  n_total:   number;
}

// ── Helper SQL para extraer par según half ──────────────────────
const HALF_TO_PAIR_SQL: Record<string, string> = {
  du: '(p2::text || p3::text)',
  ab: '(p1::text || p2::text)',
  cd: '(p3::text || p4::text)',
};

// ─────────────────────────────────────────────────────────────────
// MAIN SERVICE
// ─────────────────────────────────────────────────────────────────
export class HelixRetrospectiveSimulator {
  constructor(private readonly pool: Pool) {}

  /**
   * Ejecuta walk-forward sobre [from_date, to_date].
   * Persiste filas + summary. Devuelve summary.
   */
  async simulate(opts: SimulateOpts): Promise<SimulateSummary> {
    const t_start  = Date.now();
    const run_id   = opts.run_id ?? `helix-v2-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}`;
    const top_n    = opts.top_n ?? DEFAULT_TOP_N;
    const { game_type, draw_type, half } = opts;

    logger.info({ run_id, game_type, draw_type, half, top_n }, 'simulate: start');

    // 1. Cargar todos los draws en orden cronológico
    const draws = await this.loadDraws(opts);
    if (draws.length < WARMUP_DAYS) {
      throw new Error(`Insufficient history: ${draws.length} draws < ${WARMUP_DAYS} warmup days required`);
    }

    logger.info({ n_draws: draws.length, from: draws[0]!.draw_date, to: draws[draws.length-1]!.draw_date }, 'draws loaded');

    // 2. Walk forward — predict + compare per draw
    let hits = 0;
    let seq  = 0;
    const ranks: number[] = [];
    const regimes = { NORMAL: 0, HAWKES: 0, EVT_HIGH: 0 };
    const client = await this.pool.connect();

    try {
      // Insert in batches for performance
      const BATCH_SIZE = 100;
      let batch: Array<Record<string, unknown>> = [];

      for (let i = WARMUP_DAYS; i < draws.length; i++) {
        const draw = draws[i]!;

        // Pipeline: predict @ T using only data [start, T-1]
        const prediction = await this.predictAtTime(client, opts, draw.draw_date, top_n);

        if (!prediction) continue; // no snapshot for this date (skip honestly)

        // FIX 2026-05-21: incrementar seq solo si predicción real ocurrió.
        // Antes seq contaba TODAS las iteraciones (incluso sin snapshot) inflando
        // el denominador → hit rate aparecía ~2% cuando real era ~15%.
        seq++;
        const hit = prediction.predicted_top.includes(draw.winning_pair);
        if (hit) hits++;

        // Find consensus rank of winner
        const winnerRank = prediction.consensus_ranking.indexOf(draw.winning_pair);
        if (winnerRank >= 0) ranks.push(winnerRank + 1);

        regimes[prediction.regime as keyof typeof regimes]++;

        batch.push({
          run_id, game_type, draw_type, half,
          draw_date: draw.draw_date, draw_seq: seq,
          predicted_top: prediction.predicted_top,
          predicted_n:   prediction.predicted_top.length,
          conformal_thr: prediction.conformal_threshold,
          regime:        prediction.regime,
          apex_algo:     prediction.apex_algo,
          actual_pair:   draw.winning_pair,
          hit,
          consensus_rank: winnerRank >= 0 ? winnerRank + 1 : null,
          thompson_window: THOMPSON_WINDOW_DAYS,
        });

        if (batch.length >= BATCH_SIZE) {
          await this.flushBatch(client, batch);
          batch = [];
        }

        // Progress log every 500 draws
        if (seq % 500 === 0) {
          const rate = hits / seq;
          logger.info({ seq, hits, hit_rate: rate.toFixed(4) }, 'walk-forward progress');
        }
      }

      // Flush remainder
      if (batch.length > 0) await this.flushBatch(client, batch);

      // 3. Compute aggregate summary
      const n_draws  = seq;
      const hit_rate = n_draws > 0 ? hits / n_draws : 0;
      const wilson   = this.wilsonInterval(hits, n_draws, 1.96);
      const baseline = top_n / 100;
      const median   = ranks.length > 0 ? this.median(ranks) : null;
      const mrr      = ranks.length > 0 ? ranks.reduce((s, r) => s + 1/r, 0) / ranks.length : null;
      const totalReg = regimes.NORMAL + regimes.HAWKES + regimes.EVT_HIGH || 1;

      const summary: SimulateSummary = {
        run_id, game_type, draw_type, half,
        n_draws, n_hits: hits,
        hit_rate,
        wilson_lo: wilson.lo,
        wilson_hi: wilson.hi,
        baseline_rate: baseline,
        edge_pp:        +(hit_rate - baseline).toFixed(4),
        edge_multiplier:+(baseline > 0 ? hit_rate / baseline : 0).toFixed(4),
        mrr:            mrr !== null ? +mrr.toFixed(4) : null,
        median_rank:    median,
        conformal_emp_80: null, // computed below via separate query if needed
        pct_normal:     +(regimes.NORMAL    / totalReg).toFixed(4),
        pct_hawkes:     +(regimes.HAWKES    / totalReg).toFixed(4),
        pct_evt:        +(regimes.EVT_HIGH  / totalReg).toFixed(4),
        date_from:      draws[WARMUP_DAYS]!.draw_date,
        date_to:        draws[draws.length-1]!.draw_date,
        duration_ms:    Date.now() - t_start,
      };

      // 4. Persist summary
      await this.persistSummary(client, summary, { top_n, thompson_window: THOMPSON_WINDOW_DAYS });

      logger.info(
        { run_id, n_draws, hits, hit_rate: hit_rate.toFixed(4), edge_mult: summary.edge_multiplier, duration_ms: summary.duration_ms },
        '🎯 simulate complete'
      );

      return summary;
    } finally {
      client.release();
    }
  }

  // ─────────────────────────────────────────────────────────────
  // Pipeline core: predict @ T using only history < T
  // ─────────────────────────────────────────────────────────────
  private async predictAtTime(
    client: PoolClient,
    opts:   SimulateOpts,
    T:      string,
    top_n:  number,
  ): Promise<{
    predicted_top:       string[];
    consensus_ranking:   string[];
    conformal_threshold: number;
    regime:              'NORMAL' | 'HAWKES' | 'EVT_HIGH';
    apex_algo:           string | null;
  } | null> {
    const { game_type, draw_type, half } = opts;

    // 1) Load snapshot at time T (captured in real-time by PPSService)
    const { rows: snapshots } = await client.query<SnapshotRow>(
      `SELECT algo_name, pair_scores
       FROM hitdash.algo_prediction_snapshot
       WHERE game_type = $1 AND draw_type = $2 AND half = $3 AND draw_date = $4`,
      [game_type, draw_type, half, T],
    );

    if (snapshots.length === 0) return null;

    // 2) Compute Thompson state from window [T-90d, T-1] (NO peeking at T)
    const thompson = await this.computeThompsonState(client, opts, T);

    // 3) Compute consensus pair_scores: weighted aggregate
    //    weight_algo = ALGORITHM_WEIGHTS[algo] × thompson.mean[algo]
    const consensus = new Map<string, number>();
    let bestAlgo:   string | null = null;
    let bestUCB    = -Infinity;

    for (const snap of snapshots) {
      const base   = ALGORITHM_WEIGHTS[snap.algo_name] ?? 0.5;
      const tState = thompson.get(snap.algo_name);
      const tmean  = tState ? tState.alpha / (tState.alpha + tState.beta) : 0.15;
      const tucb   = tState ? this.computeUCB(tState) : 0.15;
      const w      = base * tmean;

      if (tucb > bestUCB) {
        bestUCB  = tucb;
        bestAlgo = snap.algo_name;
      }

      // Normalize pair_scores within this algo (0-1) before weighting
      const scoresArr = Object.values(snap.pair_scores).map(Number);
      const maxScore  = Math.max(...scoresArr, 1e-9);
      for (const [pair, raw] of Object.entries(snap.pair_scores)) {
        const norm = Number(raw) / maxScore;
        consensus.set(pair, (consensus.get(pair) ?? 0) + w * norm);
      }
    }

    // 4) Sort pairs by consensus score desc
    const ranking = [...consensus.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([p]) => p);

    // 5) Conformal threshold from algo_rank_history in [T-180d, T-1]
    const conformalThr = await this.computeConformalThreshold(client, opts, T, bestAlgo);

    // 6) Predicted top: use min(top_n, conformal_thr) — both constraints honored
    const effective_n = Math.max(1, Math.min(top_n, Math.ceil(conformalThr)));
    const predicted   = ranking.slice(0, effective_n);

    // 7) Regime detection (simplificada — sin Hawkes/EVT en retrospectiva v1)
    const regime: 'NORMAL' | 'HAWKES' | 'EVT_HIGH' = 'NORMAL';

    return {
      predicted_top:       predicted,
      consensus_ranking:   ranking,
      conformal_threshold: conformalThr,
      regime,
      apex_algo:           bestAlgo,
    };
  }

  /**
   * Compute Thompson α/β from algo_rank_history in [T - window_days, T - 1].
   * NO peeking at T or later.
   */
  private async computeThompsonState(
    client: PoolClient,
    opts:   SimulateOpts,
    T:      string,
  ): Promise<Map<string, ThompsonStateLite>> {
    const { game_type, draw_type, half } = opts;
    const { rows } = await client.query<{
      algo_name: string;
      hits:      string;
      n_total:   string;
    }>(
      `SELECT
         algo_name,
         SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::int AS hits,
         COUNT(*)::int                                              AS n_total
       FROM hitdash.algo_rank_history
       WHERE game_type = $1 AND draw_type = $2 AND half = $3
         AND draw_date >= ($4::date - INTERVAL '${THOMPSON_WINDOW_DAYS} days')
         AND draw_date <  $4::date
       GROUP BY algo_name`,
      [game_type, draw_type, half, T],
    );

    const map = new Map<string, ThompsonStateLite>();
    for (const r of rows) {
      const hits    = Number(r.hits);
      const n_total = Number(r.n_total);
      const misses  = n_total - hits;
      map.set(r.algo_name, {
        algo_name: r.algo_name,
        alpha:     hits  + 1,    // uniform prior
        beta:      misses + 1,
        n_total,
      });
    }
    return map;
  }

  private computeUCB(s: ThompsonStateLite): number {
    const mean = s.alpha / (s.alpha + s.beta);
    const ab   = s.alpha + s.beta;
    const variance = (s.alpha * s.beta) / (ab * ab * (ab + 1));
    return mean + 2 * Math.sqrt(variance);
  }

  /**
   * Conformal threshold = quantile of historical rank_of_winner
   * such that ⌈(n+1)(1-α)⌉/n rank gives coverage ≥ 1-α.
   */
  private async computeConformalThreshold(
    client:    PoolClient,
    opts:      SimulateOpts,
    T:         string,
    algoName:  string | null,
  ): Promise<number> {
    const { game_type, draw_type, half } = opts;
    if (!algoName) return 30; // fallback wide

    const { rows } = await client.query<{ rank_of_winner: string }>(
      `SELECT rank_of_winner
       FROM hitdash.algo_rank_history
       WHERE game_type = $1 AND draw_type = $2 AND half = $3 AND algo_name = $4
         AND draw_date >= ($5::date - INTERVAL '${CONFORMAL_WINDOW_DAYS} days')
         AND draw_date <  $5::date
       ORDER BY rank_of_winner`,
      [game_type, draw_type, half, algoName, T],
    );

    if (rows.length === 0) return 30; // wide fallback

    const sorted = rows.map(r => Number(r.rank_of_winner)).sort((a, b) => a - b);
    const n      = sorted.length;
    const idx    = Math.min(n - 1, Math.ceil((n + 1) * (1 - CONFORMAL_ALPHA)) - 1);
    return sorted[Math.max(0, idx)] ?? 30;
  }

  // ─────────────────────────────────────────────────────────────
  // Persistence helpers
  // ─────────────────────────────────────────────────────────────
  private async flushBatch(client: PoolClient, batch: Array<Record<string, unknown>>): Promise<void> {
    if (batch.length === 0) return;
    const cols   = ['run_id','game_type','draw_type','half','draw_date','draw_seq',
                    'predicted_top','predicted_n','conformal_thr','regime','apex_algo',
                    'actual_pair','hit','consensus_rank','thompson_window'];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let p = 1;
    for (const row of batch) {
      const tokens = cols.map(() => `$${p++}`);
      placeholders.push(`(${tokens.join(',')})`);
      for (const c of cols) values.push(row[c]);
    }

    await client.query(
      `INSERT INTO hitdash.helix_retrospective_runs (${cols.join(',')})
       VALUES ${placeholders.join(',')}`,
      values,
    );
  }

  private async persistSummary(
    client: PoolClient,
    s:      SimulateSummary,
    meta:   Record<string, unknown>,
  ): Promise<void> {
    await client.query(
      `INSERT INTO hitdash.helix_retrospective_summary
         (run_id, game_type, draw_type, half,
          n_draws, n_hits, hit_rate, wilson_lo, wilson_hi,
          baseline_rate, edge_pp, edge_multiplier, mrr, median_rank,
          conformal_emp_80, pct_normal, pct_hawkes, pct_evt,
          date_from, date_to, duration_ms, metadata)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22::jsonb)
       ON CONFLICT (run_id, game_type, draw_type, half)
       DO UPDATE SET
         n_draws=$5, n_hits=$6, hit_rate=$7, wilson_lo=$8, wilson_hi=$9,
         baseline_rate=$10, edge_pp=$11, edge_multiplier=$12,
         mrr=$13, median_rank=$14, conformal_emp_80=$15,
         pct_normal=$16, pct_hawkes=$17, pct_evt=$18,
         date_from=$19, date_to=$20, duration_ms=$21, metadata=$22::jsonb,
         created_at = now()`,
      [
        s.run_id, s.game_type, s.draw_type, s.half,
        s.n_draws, s.n_hits, s.hit_rate, s.wilson_lo, s.wilson_hi,
        s.baseline_rate, s.edge_pp, s.edge_multiplier, s.mrr, s.median_rank,
        s.conformal_emp_80, s.pct_normal, s.pct_hawkes, s.pct_evt,
        s.date_from, s.date_to, s.duration_ms, JSON.stringify(meta),
      ],
    );
  }

  // ─────────────────────────────────────────────────────────────
  // Data loaders
  // ─────────────────────────────────────────────────────────────
  private async loadDraws(opts: SimulateOpts): Promise<DrawRow[]> {
    const { game_type, draw_type, half, from_date, to_date } = opts;
    const pairSql = HALF_TO_PAIR_SQL[half]!;
    const params: unknown[] = [game_type, draw_type];
    let extra = '';
    if (from_date) { params.push(from_date); extra += ` AND draw_date >= $${params.length}`; }
    if (to_date)   { params.push(to_date);   extra += ` AND draw_date <= $${params.length}`; }

    // FIX 2026-05-21: tabla real es ingested_results, no ballbot_draws.
    // Columnas: draw_key (PK), draw_date, p1, p2, p3, p4, game_type, draw_type.
    // OPTIMIZACIÓN: JOIN con algo_prediction_snapshot para procesar SOLO fechas
    // que tienen snapshot real (≈1831 dates vs 13k+ filas totales).
    const completeFilter = game_type === 'pick3'
      ? 'p2 IS NOT NULL AND p3 IS NOT NULL'
      : 'p1 IS NOT NULL AND p2 IS NOT NULL AND p3 IS NOT NULL AND p4 IS NOT NULL';

    const { rows } = await this.pool.query<DrawRow>(
      `SELECT DISTINCT ON (ir.draw_date)
              ir.draw_date::text AS draw_date,
              ${pairSql.replace(/p(\d)/g, 'ir.p$1')} AS winning_pair
       FROM hitdash.ingested_results ir
       WHERE ir.game_type = $1 AND ir.draw_type = $2
         AND ${completeFilter.replace(/p(\d)/g, 'ir.p$1')}
         AND EXISTS (
           SELECT 1 FROM hitdash.algo_prediction_snapshot s
           WHERE s.game_type = ir.game_type
             AND s.draw_type = ir.draw_type
             AND s.half      = $3
             AND s.draw_date = ir.draw_date
         )
         ${extra}
       ORDER BY ir.draw_date ASC, ir.draw_key ASC`,
      [game_type, draw_type, half, ...params.slice(2)],
    );
    return rows;
  }

  // ─────────────────────────────────────────────────────────────
  // Statistical helpers
  // ─────────────────────────────────────────────────────────────
  private wilsonInterval(hits: number, n: number, z: number = 1.96): { lo: number; hi: number } {
    if (n === 0) return { lo: 0, hi: 0 };
    const p     = hits / n;
    const z2    = z * z;
    const denom = 1 + z2 / n;
    const center = (p + z2 / (2 * n)) / denom;
    const margin = (z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)))) / denom;
    return { lo: +(center - margin).toFixed(4), hi: +(center + margin).toFixed(4) };
  }

  private median(arr: number[]): number {
    const sorted = [...arr].sort((a, b) => a - b);
    const m = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0
      ? (sorted[m - 1]! + sorted[m]!) / 2
      : sorted[m]!;
  }
}
