// ═══════════════════════════════════════════════════════════════
// HELIX — SnapshotBackfillService v1.0.0
//
// Genera algo_prediction_snapshot para fechas históricas usando
// hitdash.ingested_results. Permite que RetrospectiveValidator y
// PPS aprendan sobre historial real desde el primer día.
//
// Filosofía: POINT-IN-TIME CORRECTO
//   Para predecir el sorteo del día X, solo usamos datos de
//   draw_date < X (sin data leakage del futuro).
//
// Implementa 8 algoritmos clave directamente en SQL:
//   1. frequency          — frecuencia de par en ventana histórica
//   2. hot_cold           — ratio reciente/histórico
//   3. gap_analysis       — días desde última aparición (cap 3×)
//   4. calendar_pattern   — frecuencia del par en el DOW de X
//   5. markov_order2      — P(pair | last_pair_observed)
//   6. transition_follow  — Markov-1 sucesor inmediato
//   7. decade_family      — momentum por familia de décadas
//   8. max_per_week_day   — frecuencia histórica en ese día de semana
//
// Output: popula hitdash.algo_prediction_snapshot con ON CONFLICT DO NOTHING
//   (no sobreescribe snapshots reales del motor en producción).
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'SnapshotBackfillService' });

type PairScores = Record<string, number>;

interface BackfillResult {
  draw_date:       string;
  algos_generated: number;
  pairs_scored:    number;
  skipped:         boolean;  // true si ya existía snapshot
}

export interface BackfillSummary {
  game_type:      string;
  draw_type:      string;
  half:           string;
  dates_processed: number;
  dates_skipped:  number;
  total_snapshots: number;
  duration_ms:    number;
  errors:         number;
}

// ── Helpers ──────────────────────────────────────────────────────
function pairKey(a: number, b: number): string {
  return `${a}${b}`;
}

function halfCols(half: string): { a: string; b: string } {
  if (half === 'ab') return { a: 'p1', b: 'p2' };
  if (half === 'cd') return { a: 'p3', b: 'p4' };
  return { a: 'p2', b: 'p3' }; // du (default pick3)
}

function normalize(scores: PairScores): PairScores {
  const vals = Object.values(scores);
  if (vals.length === 0) return scores;
  const max = Math.max(...vals, 1e-9);
  const out: PairScores = {};
  for (const [k, v] of Object.entries(scores)) out[k] = +(v / max).toFixed(4);
  return out;
}

/** All 100 pairs initialized to 0 */
function zeroPairs(): PairScores {
  const r: PairScores = {};
  for (let i = 0; i <= 9; i++) for (let j = 0; j <= 9; j++) r[pairKey(i, j)] = 0;
  return r;
}

// ─────────────────────────────────────────────────────────────────
// ALGORITHM IMPLEMENTATIONS — point-in-time SQL
// Each function receives (pool, game_type, draw_type, half, as_of_date, period_days)
// and returns PairScores normalized [0,1].
// ─────────────────────────────────────────────────────────────────

async function scoreFrequency(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  const { rows } = await pool.query<{ pair: string; cnt: number }>(
    `SELECT (${a}::text || ${b}::text) AS pair, COUNT(*)::int AS cnt
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY pair`,
    [game_type, draw_type, as_of_date, period]
  );
  const scores = zeroPairs();
  for (const r of rows) if (r.pair in scores) scores[r.pair] = r.cnt;
  return normalize(scores);
}

async function scoreHotCold(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  const shortPeriod = Math.min(30, Math.floor(period / 3));
  const { rows } = await pool.query<{ pair: string; cnt_recent: number; cnt_hist: number }>(
    `SELECT
       (${a}::text || ${b}::text) AS pair,
       COUNT(*) FILTER (WHERE draw_date >= $3::date - ($5 || ' days')::interval)::int AS cnt_recent,
       COUNT(*)::int AS cnt_hist
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY pair`,
    [game_type, draw_type, as_of_date, period, shortPeriod]
  );
  const scores = zeroPairs();
  const totalHist   = rows.reduce((s, r) => s + r.cnt_hist,   0) || 1;
  const totalRecent = rows.reduce((s, r) => s + r.cnt_recent, 0) || 1;
  for (const r of rows) {
    if (!(r.pair in scores)) continue;
    const freqHist   = r.cnt_hist   / totalHist;
    const freqRecent = r.cnt_recent / totalRecent;
    scores[r.pair] = freqHist > 0 ? freqRecent / freqHist : freqRecent;
  }
  return normalize(scores);
}

async function scoreGapAnalysis(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  const GAMBLER_CAP = 3.0;
  const { rows } = await pool.query<{
    pair: string; last_seen: string; cnt: number;
  }>(
    `SELECT
       (${a}::text || ${b}::text) AS pair,
       MAX(draw_date)::text AS last_seen,
       COUNT(*)::int AS cnt
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY pair`,
    [game_type, draw_type, as_of_date, period]
  );
  const scores = zeroPairs();
  for (const r of rows) {
    if (!(r.pair in scores) || r.cnt < 5) continue;
    const daysSinceLast = Math.floor(
      (new Date(as_of_date).getTime() - new Date(r.last_seen).getTime()) / 86_400_000
    );
    const avgGap = period / r.cnt;
    const dueFactor = avgGap > 0 ? daysSinceLast / avgGap : 0;
    scores[r.pair] = Math.min(dueFactor, GAMBLER_CAP);
  }
  return normalize(scores);
}

async function scoreCalendarPattern(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  const targetDow = new Date(as_of_date).getDay(); // 0=Sun...6=Sat
  const { rows } = await pool.query<{ pair: string; dow_cnt: number; total_cnt: number }>(
    `SELECT
       (${a}::text || ${b}::text) AS pair,
       COUNT(*) FILTER (WHERE EXTRACT(DOW FROM draw_date) = $5)::int AS dow_cnt,
       COUNT(*)::int AS total_cnt
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY pair`,
    [game_type, draw_type, as_of_date, period, targetDow]
  );
  const scores = zeroPairs();
  for (const r of rows) {
    if (!(r.pair in scores)) continue;
    // Lift vs expected frequency on that DOW
    const baseline = r.total_cnt > 0 ? r.total_cnt / 7 : 0;
    scores[r.pair] = baseline > 0 ? r.dow_cnt / baseline : r.dow_cnt;
  }
  return normalize(scores);
}

async function scoreMarkovOrder2(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Get the last pair seen before as_of_date
  const { rows: lastRow } = await pool.query<{ pair: string }>(
    `SELECT (${a}::text || ${b}::text) AS pair
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2 AND draw_date < $3::date
     ORDER BY draw_date DESC LIMIT 1`,
    [game_type, draw_type, as_of_date]
  );
  if (!lastRow.length) return zeroPairs();
  const lastPair = lastRow[0]!.pair;

  // P(next_pair | last_pair) from historical transitions
  const { rows } = await pool.query<{ next_pair: string; cnt: number }>(
    `WITH ordered AS (
       SELECT draw_date,
              (${a}::text || ${b}::text) AS pair
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
         AND draw_date >= $3::date - ($4 || ' days')::interval
         AND draw_date <  $3::date
       ORDER BY draw_date ASC
     ),
     transitions AS (
       SELECT pair AS prev_pair,
              LEAD(pair) OVER (ORDER BY draw_date) AS next_pair
       FROM ordered
     )
     SELECT next_pair, COUNT(*)::int AS cnt
     FROM transitions
     WHERE prev_pair = $5 AND next_pair IS NOT NULL
     GROUP BY next_pair`,
    [game_type, draw_type, as_of_date, period, lastPair]
  );
  const scores = zeroPairs();
  for (const r of rows) if (r.next_pair in scores) scores[r.next_pair] = r.cnt;
  return normalize(scores);
}

async function scoreTransitionFollow(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Same as markov_order2 but use 2 prev pairs (compound state)
  const { rows: lastRow } = await pool.query<{ pair: string }>(
    `SELECT (${a}::text || ${b}::text) AS pair
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2 AND draw_date < $3::date
     ORDER BY draw_date DESC LIMIT 2`,
    [game_type, draw_type, as_of_date]
  );
  if (lastRow.length < 2) return scoreMarkovOrder2(pool, game_type, draw_type, half, as_of_date, period);
  const state = `${lastRow[1]!.pair}→${lastRow[0]!.pair}`;

  const { rows } = await pool.query<{ next_pair: string; cnt: number }>(
    `WITH ordered AS (
       SELECT draw_date,
              (${a}::text || ${b}::text) AS pair
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
         AND draw_date >= $3::date - ($4 || ' days')::interval
         AND draw_date <  $3::date
       ORDER BY draw_date ASC
     ),
     tri AS (
       SELECT pair AS p1,
              LEAD(pair,1) OVER (ORDER BY draw_date) AS p2,
              LEAD(pair,2) OVER (ORDER BY draw_date) AS p3
       FROM ordered
     )
     SELECT p3 AS next_pair, COUNT(*)::int AS cnt
     FROM tri
     WHERE p1 || '→' || p2 = $5 AND p3 IS NOT NULL
     GROUP BY p3`,
    [game_type, draw_type, as_of_date, period, state]
  );
  const scores = zeroPairs();
  for (const r of rows) if (r.next_pair in scores) scores[r.next_pair] = r.cnt;
  return normalize(scores);
}

async function scoreDecadeFamily(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Decade = floor(pair / 10). Score decade momentum then distribute to pairs within it.
  const { rows } = await pool.query<{ decade: number; recent_cnt: number; hist_cnt: number }>(
    `SELECT
       floor((${a}::int * 10 + ${b}::int) / 10)::int AS decade,
       COUNT(*) FILTER (WHERE draw_date >= $3::date - INTERVAL '30 days')::int AS recent_cnt,
       COUNT(*)::int AS hist_cnt
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY decade`,
    [game_type, draw_type, as_of_date, period]
  );
  const decadeScore: Record<number, number> = {};
  const totalHist = rows.reduce((s, r) => s + r.hist_cnt, 0) || 1;
  for (const r of rows) {
    decadeScore[r.decade] = r.hist_cnt > 0 ? r.recent_cnt / (r.hist_cnt / totalHist * totalHist) : 0;
  }
  const scores = zeroPairs();
  for (let i = 0; i <= 9; i++) {
    for (let j = 0; j <= 9; j++) {
      const dec = Math.floor((i * 10 + j) / 10);
      scores[pairKey(i, j)] = decadeScore[dec] ?? 0;
    }
  }
  return normalize(scores);
}

async function scoreMaxPerWeekDay(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  const targetDow = new Date(as_of_date).getDay();
  const { rows } = await pool.query<{ pair: string; cnt: number }>(
    `SELECT (${a}::text || ${b}::text) AS pair, COUNT(*)::int AS cnt
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
       AND EXTRACT(DOW FROM draw_date) = $5
     GROUP BY pair`,
    [game_type, draw_type, as_of_date, period, targetDow]
  );
  const scores = zeroPairs();
  for (const r of rows) if (r.pair in scores) scores[r.pair] = r.cnt;
  return normalize(scores);
}

// ─────────────────────────────────────────────────────────────────
// MAIN SERVICE
// ─────────────────────────────────────────────────────────────────

export class SnapshotBackfillService {
  constructor(private readonly pool: Pool) {}

  /**
   * Genera scores de 8 algoritmos para una fecha específica.
   * Usa solo datos anteriores a as_of_date (point-in-time correcto).
   */
  async scoreForDate(
    game_type: string,
    draw_type: string,
    half:      string,
    as_of_date: string,
    period:    number = 365
  ): Promise<Map<string, PairScores>> {
    const algos: Array<[string, () => Promise<PairScores>]> = [
      ['frequency',        () => scoreFrequency(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['hot_cold',         () => scoreHotCold(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['gap_analysis',     () => scoreGapAnalysis(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['calendar_pattern', () => scoreCalendarPattern(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['markov_order2',    () => scoreMarkovOrder2(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['transition_follow',() => scoreTransitionFollow(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['decade_family',    () => scoreDecadeFamily(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['max_per_week_day', () => scoreMaxPerWeekDay(this.pool, game_type, draw_type, half, as_of_date, period)],
    ];

    const results = new Map<string, PairScores>();
    const settled = await Promise.allSettled(algos.map(([, fn]) => fn()));

    for (let i = 0; i < algos.length; i++) {
      const [name] = algos[i]!;
      const r = settled[i]!;
      if (r.status === 'fulfilled') {
        results.set(name, r.value);
      } else {
        logger.warn({ algo: name, as_of_date, error: String(r.reason) }, 'Backfill: algo falló — continuando');
      }
    }
    return results;
  }

  /**
   * Backfill completo para un rango de fechas.
   * Solo procesa fechas que tengan resultado real en ingested_results.
   * ON CONFLICT DO NOTHING — nunca sobreescribe snapshots reales del motor.
   */
  async backfillRange(
    game_type:  string,
    draw_type:  string,
    half:       string,
    days_back:  number = 365,
    period:     number = 365,
    onProgress?: (done: number, total: number, date: string) => void
  ): Promise<BackfillSummary> {
    const t0 = Date.now();

    // 1. Obtener todas las fechas con resultados reales en ese rango
    const { rows: drawDates } = await this.pool.query<{ draw_date: string }>(
      `SELECT DISTINCT draw_date::text
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
         AND draw_date >= CURRENT_DATE - ($3 || ' days')::interval
       ORDER BY draw_date ASC`,
      [game_type, draw_type, days_back]
    );

    if (drawDates.length === 0) {
      logger.warn({ game_type, draw_type, half }, 'Backfill: sin sorteos en ingested_results');
      return { game_type, draw_type, half, dates_processed: 0, dates_skipped: 0, total_snapshots: 0, duration_ms: Date.now() - t0, errors: 0 };
    }

    // 2. Verificar cuáles ya tienen snapshot (para saltarlos)
    const { rows: existingRows } = await this.pool.query<{ draw_date: string }>(
      `SELECT DISTINCT draw_date::text
       FROM hitdash.algo_prediction_snapshot
       WHERE game_type = $1 AND draw_type = $2 AND half = $3
         AND draw_date >= CURRENT_DATE - ($4 || ' days')::interval`,
      [game_type, draw_type, half, days_back]
    );
    const existingDates = new Set(existingRows.map(r => r.draw_date));

    let processed = 0, skipped = 0, totalSnaps = 0, errors = 0;
    const total = drawDates.length;

    for (const { draw_date } of drawDates) {
      // Skip if all algos already have a snapshot for this date
      if (existingDates.has(draw_date)) {
        skipped++;
        onProgress?.(processed + skipped, total, draw_date);
        continue;
      }

      try {
        const algoScores = await this.scoreForDate(game_type, draw_type, half, draw_date, period);

        // 3. Persistir en algo_prediction_snapshot
        const inserts = [...algoScores.entries()].map(([algo_name, scores]) =>
          this.pool.query(
            `INSERT INTO hitdash.algo_prediction_snapshot
               (game_type, draw_type, draw_date, half, algo_name, pair_scores)
             VALUES ($1, $2, $3::date, $4, $5, $6)
             ON CONFLICT (game_type, draw_type, draw_date, half, algo_name) DO NOTHING`,
            [game_type, draw_type, draw_date, half, algo_name, JSON.stringify(scores)]
          ).catch(err => {
            logger.warn({ algo_name, draw_date, error: String(err) }, 'Backfill: insert error — continuando');
          })
        );
        await Promise.allSettled(inserts);
        totalSnaps += algoScores.size;
        processed++;
      } catch (err) {
        logger.error({ draw_date, error: String(err) }, 'Backfill: error en fecha — saltando');
        errors++;
      }

      onProgress?.(processed + skipped, total, draw_date);
    }

    const summary: BackfillSummary = {
      game_type, draw_type, half,
      dates_processed: processed,
      dates_skipped:   skipped,
      total_snapshots: totalSnaps,
      duration_ms:     Date.now() - t0,
      errors,
    };

    logger.info(summary, '✅ SnapshotBackfill completado');
    return summary;
  }
}
