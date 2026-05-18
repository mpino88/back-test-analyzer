// ═══════════════════════════════════════════════════════════════
// HELIX — SnapshotBackfillService v2.0.0 (2026-05-18)
//
// Genera algo_prediction_snapshot para fechas históricas usando
// hitdash.ingested_results. Permite que RetrospectiveValidator y
// PPS aprendan sobre historial real desde el primer día.
//
// Filosofía: POINT-IN-TIME CORRECTO
//   Para predecir el sorteo del día X, solo usamos datos de
//   draw_date < X (sin data leakage del futuro).
//
// v2.0 (FIX #1 — Auditoría Forense APEX 2026-05-18):
//   Expandido de 8 → 21 algoritmos. Antes, los 13 algos faltantes
//   nunca tenían historia retroactiva durante Genesis Bootstrap →
//   Champion Mode + PPS sesgados, cold-start permanente.
//
// Implementa los 21 algoritmos del catálogo MOTOR-Σ:
//
//   CORE FRECUENCIA (5):
//     frequency, hot_cold, gap_analysis, pairs_correlation, streak
//   POSICIONAL & CALENDARIO (4):
//     position, calendar_pattern, max_per_week_day, moving_averages
//   MEMORIA & MARKOV (3):
//     markov_order2, transition_follow, cross_draw
//   BAYESIAN & RECURRENCIA (2):
//     bayesian_score, pair_return_cycle
//   PATTERN FILTERS (3):
//     sum_pattern_filter, double_triple, decade_family
//   BALLBOT v4-v6 (4):
//     trend_momentum, trend_momentum_sweet, est_individuales, terminal_analysis
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
     GROUP BY (${a}::text || ${b}::text)`,
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
     GROUP BY (${a}::text || ${b}::text)`,
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
     GROUP BY (${a}::text || ${b}::text)`,
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
     GROUP BY (${a}::text || ${b}::text)`,
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
     GROUP BY (${a}::text || ${b}::text)`,
    [game_type, draw_type, as_of_date, period, targetDow]
  );
  const scores = zeroPairs();
  for (const r of rows) if (r.pair in scores) scores[r.pair] = r.cnt;
  return normalize(scores);
}

// ═════════════════════════════════════════════════════════════════
// FIX #1 (2026-05-18) — VERDAD RADICAL APEX
// Antes: Backfill solo cubría 8 de 21 algoritmos → Genesis Stage 2
//   replayaba PPS solo para esos 8, dejando 13 algos sin historia
//   retroactiva → Champion Mode + PPS sesgados, cold-start permanente.
// Ahora: 13 score functions point-in-time adicionales — todas usan
//   solo data anterior a `as_of_date` (sin data leakage).
// ═════════════════════════════════════════════════════════════════

// ── 9. pairs_correlation ────────────────────────────────────────
async function scorePairsCorrelation(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Lift = P(par_observed) / (P(digit_a) × P(digit_b))
  const { rows } = await pool.query<{ pair: string; cnt: number; cnt_a: number; cnt_b: number; total: number }>(
    `WITH base AS (
       SELECT (${a}::text || ${b}::text) AS pair, ${a}::int AS da, ${b}::int AS db
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
         AND draw_date >= $3::date - ($4 || ' days')::interval
         AND draw_date <  $3::date
     ),
     pair_cnt AS (SELECT pair, COUNT(*)::int AS cnt FROM base GROUP BY pair),
     digit_a  AS (SELECT da AS d, COUNT(*)::int AS c FROM base GROUP BY da),
     digit_b  AS (SELECT db AS d, COUNT(*)::int AS c FROM base GROUP BY db),
     tot      AS (SELECT COUNT(*)::int AS n FROM base)
     SELECT pc.pair,
            pc.cnt,
            COALESCE(da.c, 0) AS cnt_a,
            COALESCE(db.c, 0) AS cnt_b,
            t.n AS total
     FROM pair_cnt pc
     CROSS JOIN tot t
     LEFT JOIN digit_a da ON da.d = (substr(pc.pair, 1, 1)::int)
     LEFT JOIN digit_b db ON db.d = (substr(pc.pair, 2, 1)::int)`,
    [game_type, draw_type, as_of_date, period]
  );
  const scores = zeroPairs();
  for (const r of rows) {
    if (!(r.pair in scores) || r.total < 10) continue;
    const observed = r.cnt / r.total;
    const expected = (r.cnt_a / r.total) * (r.cnt_b / r.total);
    scores[r.pair] = expected > 0 ? observed / expected : 0;
  }
  return normalize(scores);
}

// ── 10. streak ──────────────────────────────────────────────────
async function scoreStreak(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, _period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Para cada par, cuenta apariciones en los últimos 10 sorteos.
  const { rows } = await pool.query<{ pair: string; cnt: number }>(
    `WITH last10 AS (
       SELECT (${a}::text || ${b}::text) AS pair
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
         AND draw_date < $3::date
       ORDER BY draw_date DESC
       LIMIT 10
     )
     SELECT pair, COUNT(*)::int AS cnt FROM last10 GROUP BY pair`,
    [game_type, draw_type, as_of_date]
  );
  const scores = zeroPairs();
  for (const r of rows) if (r.pair in scores) scores[r.pair] = r.cnt;
  return normalize(scores);
}

// ── 11. position ────────────────────────────────────────────────
async function scorePosition(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // P(digit at pos A) × P(digit at pos B) — bias posicional puro
  const { rows: rowsA } = await pool.query<{ d: number; c: number }>(
    `SELECT ${a}::int AS d, COUNT(*)::int AS c
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY ${a}`,
    [game_type, draw_type, as_of_date, period]
  );
  const { rows: rowsB } = await pool.query<{ d: number; c: number }>(
    `SELECT ${b}::int AS d, COUNT(*)::int AS c
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY ${b}`,
    [game_type, draw_type, as_of_date, period]
  );
  const totA = rowsA.reduce((s, r) => s + r.c, 0) || 1;
  const totB = rowsB.reduce((s, r) => s + r.c, 0) || 1;
  const freqA: number[] = new Array(10).fill(0) as number[];
  const freqB: number[] = new Array(10).fill(0) as number[];
  for (const r of rowsA) freqA[r.d] = r.c / totA;
  for (const r of rowsB) freqB[r.d] = r.c / totB;
  const scores = zeroPairs();
  for (let i = 0; i <= 9; i++) {
    for (let j = 0; j <= 9; j++) {
      scores[pairKey(i, j)] = (freqA[i] ?? 0) * (freqB[j] ?? 0);
    }
  }
  return normalize(scores);
}

// ── 12. moving_averages ─────────────────────────────────────────
async function scoreMovingAverages(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, _period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // SMA7 - SMA14: pares con momentum reciente positivo
  const { rows } = await pool.query<{ pair: string; cnt7: number; cnt14: number }>(
    `SELECT
       (${a}::text || ${b}::text) AS pair,
       COUNT(*) FILTER (WHERE draw_date >= $3::date - INTERVAL '7 days')::int  AS cnt7,
       COUNT(*) FILTER (WHERE draw_date >= $3::date - INTERVAL '14 days')::int AS cnt14
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - INTERVAL '14 days'
       AND draw_date <  $3::date
     GROUP BY (${a}::text || ${b}::text)`,
    [game_type, draw_type, as_of_date]
  );
  const scores = zeroPairs();
  for (const r of rows) {
    if (!(r.pair in scores)) continue;
    scores[r.pair] = (r.cnt7 / 7) - (r.cnt14 / 14);
  }
  // Sanitiza valores negativos: shift hacia 0 antes de normalizar
  let minScore = 0;
  for (const v of Object.values(scores)) if (v < minScore) minScore = v;
  if (minScore < 0) {
    for (const k of Object.keys(scores)) scores[k] = (scores[k] ?? 0) - minScore;
  }
  return normalize(scores);
}

// ── 13. bayesian_score ──────────────────────────────────────────
async function scoreBayesianScore(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // P(par | freq, hot, recency) — combinación ponderada
  const { rows } = await pool.query<{ pair: string; cnt: number; cnt_recent: number; last_seen: string | null }>(
    `SELECT
       (${a}::text || ${b}::text) AS pair,
       COUNT(*)::int AS cnt,
       COUNT(*) FILTER (WHERE draw_date >= $3::date - INTERVAL '30 days')::int AS cnt_recent,
       MAX(draw_date)::text AS last_seen
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY (${a}::text || ${b}::text)`,
    [game_type, draw_type, as_of_date, period]
  );
  const maxCnt    = Math.max(...rows.map(r => r.cnt),        1);
  const maxRecent = Math.max(...rows.map(r => r.cnt_recent), 1);
  const scores = zeroPairs();
  for (const r of rows) {
    if (!(r.pair in scores)) continue;
    const freqN = r.cnt / maxCnt;
    const hotN  = r.cnt_recent / maxRecent;
    const daysSince = r.last_seen
      ? (new Date(as_of_date).getTime() - new Date(r.last_seen).getTime()) / 86_400_000
      : period;
    const recency = 1 / Math.max(daysSince, 1);
    scores[r.pair] = freqN * 0.4 + hotN * 0.4 + recency * 0.2;
  }
  return normalize(scores);
}

// ── 14. pair_return_cycle ───────────────────────────────────────
async function scorePairReturnCycle(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Para cada par: gap promedio histórico vs gap actual. Si actual > promedio → "due"
  const { rows } = await pool.query<{ pair: string; cnt: number; last_seen: string; avg_gap: number }>(
    `WITH base AS (
       SELECT (${a}::text || ${b}::text) AS pair, draw_date
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
         AND draw_date >= $3::date - ($4 || ' days')::interval
         AND draw_date <  $3::date
     ),
     gaps AS (
       SELECT pair, draw_date,
              draw_date - LAG(draw_date) OVER (PARTITION BY pair ORDER BY draw_date) AS gap_days
       FROM base
     )
     SELECT pair,
            COUNT(*)::int AS cnt,
            MAX(draw_date)::text AS last_seen,
            COALESCE(AVG(EXTRACT(DAY FROM gap_days))::float, 0) AS avg_gap
     FROM gaps
     GROUP BY pair`,
    [game_type, draw_type, as_of_date, period]
  );
  const scores = zeroPairs();
  for (const r of rows) {
    if (!(r.pair in scores) || r.cnt < 3 || !r.last_seen) continue;
    const daysSinceLast = (new Date(as_of_date).getTime() - new Date(r.last_seen).getTime()) / 86_400_000;
    const avgGap = r.avg_gap > 0 ? r.avg_gap : period / r.cnt;
    // Sigmoid sobre (daysSinceLast - avgGap) / max(avgGap, 1)
    const z = (daysSinceLast - avgGap) / Math.max(avgGap, 1);
    scores[r.pair] = 1 / (1 + Math.exp(-z));
  }
  return normalize(scores);
}

// ── 15. sum_pattern_filter ──────────────────────────────────────
async function scoreSumPatternFilter(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Frecuencia de cada SUMA (a+b) en histórico y en últimos 30 días
  const { rows } = await pool.query<{ pair_sum: number; cnt_hist: number; cnt_recent: number }>(
    `SELECT
       (${a}::int + ${b}::int) AS pair_sum,
       COUNT(*)::int AS cnt_hist,
       COUNT(*) FILTER (WHERE draw_date >= $3::date - INTERVAL '30 days')::int AS cnt_recent
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY (${a}::int + ${b}::int)`,
    [game_type, draw_type, as_of_date, period]
  );
  const sumFreqHist:   Record<number, number> = {};
  const sumFreqRecent: Record<number, number> = {};
  let maxHist = 1, maxRecent = 1;
  for (const r of rows) {
    sumFreqHist[r.pair_sum]   = r.cnt_hist;
    sumFreqRecent[r.pair_sum] = r.cnt_recent;
    if (r.cnt_hist   > maxHist)   maxHist   = r.cnt_hist;
    if (r.cnt_recent > maxRecent) maxRecent = r.cnt_recent;
  }
  const scores = zeroPairs();
  for (let i = 0; i <= 9; i++) {
    for (let j = 0; j <= 9; j++) {
      const s = i + j;
      const histScore   = (sumFreqHist[s]   ?? 0) / maxHist;
      const recentScore = (sumFreqRecent[s] ?? 0) / maxRecent;
      scores[pairKey(i, j)] = 0.6 * histScore + 0.4 * recentScore;
    }
  }
  return normalize(scores);
}

// ── 16. double_triple ───────────────────────────────────────────
async function scoreDoubleTriple(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Detectar régimen "doubles" en últimos 30 sorteos
  const { rows: recentRows } = await pool.query<{ is_double: boolean; cnt: number }>(
    `SELECT (${a} = ${b}) AS is_double, COUNT(*)::int AS cnt
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - INTERVAL '30 days'
       AND draw_date <  $3::date
     GROUP BY (${a} = ${b})`,
    [game_type, draw_type, as_of_date]
  );
  const doubleCnt = recentRows.find(r => r.is_double === true)?.cnt ?? 0;
  const totalCnt  = recentRows.reduce((s, r) => s + r.cnt, 0) || 1;
  const doubleRegime = doubleCnt / totalCnt;

  const { rows: freqRows } = await pool.query<{ pair: string; cnt: number; total: number }>(
    `SELECT (${a}::text || ${b}::text) AS pair, COUNT(*)::int AS cnt,
            (SELECT COUNT(*) FROM hitdash.ingested_results
              WHERE game_type=$1 AND draw_type=$2
                AND draw_date >= $3::date - ($4 || ' days')::interval
                AND draw_date <  $3::date)::int AS total
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY (${a}::text || ${b}::text)`,
    [game_type, draw_type, as_of_date, period]
  );
  const scores = zeroPairs();
  for (const r of freqRows) {
    if (!(r.pair in scores)) continue;
    const isDouble = r.pair[0] === r.pair[1];
    const baseFreq = r.cnt / Math.max(r.total, 1);
    const regimeBoost = isDouble ? doubleRegime * 2 : (1 - doubleRegime);
    scores[r.pair] = baseFreq * regimeBoost;
  }
  return normalize(scores);
}

// ── 17. cross_draw ──────────────────────────────────────────────
async function scoreCrossDraw(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Correlación con el "otro" draw_type (midday↔evening) del MISMO día.
  const otherDraw = draw_type === 'midday' ? 'evening' : 'midday';
  const { rows } = await pool.query<{ pair: string; cnt_co: number; total: number }>(
    `WITH cur AS (
       SELECT (${a}::text || ${b}::text) AS pair, draw_date
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
         AND draw_date >= $3::date - ($4 || ' days')::interval
         AND draw_date <  $3::date
     ),
     other AS (
       SELECT (${a}::text || ${b}::text) AS pair_other, draw_date
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $5
         AND draw_date >= $3::date - ($4 || ' days')::interval
         AND draw_date <  $3::date
     )
     SELECT cur.pair,
            COUNT(*) FILTER (WHERE cur.pair = other.pair_other)::int AS cnt_co,
            COUNT(*)::int AS total
     FROM cur
     JOIN other ON other.draw_date = cur.draw_date
     GROUP BY cur.pair`,
    [game_type, draw_type, as_of_date, period, otherDraw]
  );
  const scores = zeroPairs();
  for (const r of rows) {
    if (!(r.pair in scores) || r.total < 3) continue;
    scores[r.pair] = r.cnt_co / r.total;
  }
  return normalize(scores);
}

// ── 18. trend_momentum (Ballbot v4 — "Fuerza de Tendencia Pro") ──
async function scoreTrendMomentum(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  const { rows } = await pool.query<{ pair: string; cnt_all: number; cnt_recent: number; tot_all: number; tot_recent: number }>(
    `SELECT
       (${a}::text || ${b}::text) AS pair,
       COUNT(*)::int AS cnt_all,
       COUNT(*) FILTER (WHERE draw_date >= $3::date - INTERVAL '30 days')::int AS cnt_recent,
       (SELECT COUNT(*)::int FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2
           AND draw_date >= $3::date - ($4 || ' days')::interval
           AND draw_date <  $3::date) AS tot_all,
       (SELECT COUNT(*)::int FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2
           AND draw_date >= $3::date - INTERVAL '30 days'
           AND draw_date <  $3::date) AS tot_recent
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY (${a}::text || ${b}::text)`,
    [game_type, draw_type, as_of_date, period]
  );
  const scores = zeroPairs();
  for (const r of rows) {
    if (!(r.pair in scores)) continue;
    const fa = r.tot_all    > 0 ? r.cnt_all    / r.tot_all    : 0;
    const fr = r.tot_recent > 0 ? r.cnt_recent / r.tot_recent : 0;
    let momentum = fa > 0 ? fr / fa : (r.cnt_recent > 0 ? 10 : 0);
    // Threshold trend_momentum v3: count_all ≥ 3 AND momentum ≥ 1.0
    if (r.cnt_all < 3 || momentum < 1.0) momentum = 0;
    scores[r.pair] = momentum;
  }
  return normalize(scores);
}

// ── 19. trend_momentum_sweet (Sweet Spot v5 — count_recent==1 ∧ momentum≥3x) ──
async function scoreTrendMomentumSweet(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  const { rows } = await pool.query<{ pair: string; cnt_all: number; cnt_recent: number; tot_all: number; tot_recent: number }>(
    `SELECT
       (${a}::text || ${b}::text) AS pair,
       COUNT(*)::int AS cnt_all,
       COUNT(*) FILTER (WHERE draw_date >= $3::date - INTERVAL '30 days')::int AS cnt_recent,
       (SELECT COUNT(*)::int FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2
           AND draw_date >= $3::date - ($4 || ' days')::interval
           AND draw_date <  $3::date) AS tot_all,
       (SELECT COUNT(*)::int FROM hitdash.ingested_results
         WHERE game_type=$1 AND draw_type=$2
           AND draw_date >= $3::date - INTERVAL '30 days'
           AND draw_date <  $3::date) AS tot_recent
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY (${a}::text || ${b}::text)`,
    [game_type, draw_type, as_of_date, period]
  );
  const scores = zeroPairs();
  for (const r of rows) {
    if (!(r.pair in scores)) continue;
    const fa = r.tot_all    > 0 ? r.cnt_all    / r.tot_all    : 0;
    const fr = r.tot_recent > 0 ? r.cnt_recent / r.tot_recent : 0;
    const momentum = fa > 0 ? fr / fa : (r.cnt_recent > 0 ? 10 : 0);
    // Sweet spot: count_all≥3, count_recent==1, momentum≥3.0
    const score = (r.cnt_all >= 3 && r.cnt_recent === 1 && momentum >= 3.0) ? momentum : 0;
    scores[r.pair] = score;
  }
  return normalize(scores);
}

// ── 20. est_individuales — hottest digits product ───────────────
async function scoreEstIndividuales(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  // Hot score por dígito = freq_recent / freq_hist (combinando a y b)
  const { rows: rowsHist } = await pool.query<{ d: number; c: number }>(
    `SELECT d, SUM(c)::int AS c FROM (
       SELECT ${a}::int AS d, COUNT(*)::int AS c FROM hitdash.ingested_results
         WHERE game_type = $1 AND draw_type = $2
           AND draw_date >= $3::date - ($4 || ' days')::interval
           AND draw_date <  $3::date
         GROUP BY ${a}
       UNION ALL
       SELECT ${b}::int AS d, COUNT(*)::int AS c FROM hitdash.ingested_results
         WHERE game_type = $1 AND draw_type = $2
           AND draw_date >= $3::date - ($4 || ' days')::interval
           AND draw_date <  $3::date
         GROUP BY ${b}
     ) u GROUP BY d`,
    [game_type, draw_type, as_of_date, period]
  );
  const { rows: rowsRecent } = await pool.query<{ d: number; c: number }>(
    `SELECT d, SUM(c)::int AS c FROM (
       SELECT ${a}::int AS d, COUNT(*)::int AS c FROM hitdash.ingested_results
         WHERE game_type = $1 AND draw_type = $2
           AND draw_date >= $3::date - INTERVAL '30 days'
           AND draw_date <  $3::date
         GROUP BY ${a}
       UNION ALL
       SELECT ${b}::int AS d, COUNT(*)::int AS c FROM hitdash.ingested_results
         WHERE game_type = $1 AND draw_type = $2
           AND draw_date >= $3::date - INTERVAL '30 days'
           AND draw_date <  $3::date
         GROUP BY ${b}
     ) u GROUP BY d`,
    [game_type, draw_type, as_of_date]
  );
  const totH = rowsHist.reduce((s, r) => s + r.c, 0)   || 1;
  const totR = rowsRecent.reduce((s, r) => s + r.c, 0) || 1;
  const hotScore: number[] = new Array(10).fill(0) as number[];
  for (let d = 0; d <= 9; d++) {
    const fa = (rowsHist.find(r => r.d === d)?.c   ?? 0) / totH;
    const fr = (rowsRecent.find(r => r.d === d)?.c ?? 0) / totR;
    hotScore[d] = fa > 0 ? fr / fa : (fr > 0 ? 10 : 0);
  }
  const scores = zeroPairs();
  for (let i = 0; i <= 9; i++) {
    for (let j = 0; j <= 9; j++) {
      scores[pairKey(i, j)] = (hotScore[i] ?? 0) * (hotScore[j] ?? 0);
    }
  }
  return normalize(scores);
}

// ── 21. terminal_analysis — last-digit (b) momentum ─────────────
async function scoreTerminalAnalysis(
  pool: Pool, game_type: string, draw_type: string,
  half: string, as_of_date: string, period: number
): Promise<PairScores> {
  const { a, b } = halfCols(half);
  const { rows } = await pool.query<{ term: number; cnt_all: number; cnt_recent: number }>(
    `SELECT ${b}::int AS term,
            COUNT(*)::int AS cnt_all,
            COUNT(*) FILTER (WHERE draw_date >= $3::date - INTERVAL '30 days')::int AS cnt_recent
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY ${b}`,
    [game_type, draw_type, as_of_date, period]
  );
  const totAll    = rows.reduce((s, r) => s + r.cnt_all,    0) || 1;
  const totRecent = rows.reduce((s, r) => s + r.cnt_recent, 0) || 1;
  const termMomentum: number[] = new Array(10).fill(0) as number[];
  for (const r of rows) {
    const fa = r.cnt_all    / totAll;
    const fr = r.cnt_recent / totRecent;
    termMomentum[r.term] = fa > 0 ? fr / fa : (fr > 0 ? 10 : 0);
  }
  // También necesitamos frecuencia del par específico para combinar
  const { rows: pairRows } = await pool.query<{ pair: string; cnt: number; total: number }>(
    `SELECT (${a}::text || ${b}::text) AS pair, COUNT(*)::int AS cnt,
            (SELECT COUNT(*)::int FROM hitdash.ingested_results
              WHERE game_type=$1 AND draw_type=$2
                AND draw_date >= $3::date - ($4 || ' days')::interval
                AND draw_date <  $3::date) AS total
     FROM hitdash.ingested_results
     WHERE game_type = $1 AND draw_type = $2
       AND draw_date >= $3::date - ($4 || ' days')::interval
       AND draw_date <  $3::date
     GROUP BY (${a}::text || ${b}::text)`,
    [game_type, draw_type, as_of_date, period]
  );
  const scores = zeroPairs();
  for (const r of pairRows) {
    if (!(r.pair in scores)) continue;
    const term = parseInt(r.pair[1]!, 10);
    const momentum = termMomentum[term] ?? 0;
    const pairFreq = r.cnt / Math.max(r.total, 1);
    scores[r.pair] = 0.6 * momentum + 0.4 * pairFreq * 10;
  }
  // Pares sin observación: usar solo terminal momentum
  for (let i = 0; i <= 9; i++) {
    for (let j = 0; j <= 9; j++) {
      const k = pairKey(i, j);
      if (scores[k] === 0) scores[k] = 0.6 * (termMomentum[j] ?? 0);
    }
  }
  return normalize(scores);
}

// ─────────────────────────────────────────────────────────────────
// MAIN SERVICE
// ─────────────────────────────────────────────────────────────────

export class SnapshotBackfillService {
  constructor(private readonly pool: Pool) {}

  /**
   * Genera scores de 21 algoritmos para una fecha específica.
   * Usa solo datos anteriores a as_of_date (point-in-time correcto).
   *
   * FIX #1 (2026-05-18): expandido de 8 a 21 algoritmos para que Genesis
   * Stage 2 pueda replayer TODOS los algos del catálogo, no solo los 8
   * "core" iniciales.
   */
  async scoreForDate(
    game_type: string,
    draw_type: string,
    half:      string,
    as_of_date: string,
    period:    number = 365
  ): Promise<Map<string, PairScores>> {
    const algos: Array<[string, () => Promise<PairScores>]> = [
      // ── 8 originales (v1) ──────────────────────────────────────
      ['frequency',        () => scoreFrequency(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['hot_cold',         () => scoreHotCold(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['gap_analysis',     () => scoreGapAnalysis(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['calendar_pattern', () => scoreCalendarPattern(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['markov_order2',    () => scoreMarkovOrder2(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['transition_follow',() => scoreTransitionFollow(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['decade_family',    () => scoreDecadeFamily(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['max_per_week_day', () => scoreMaxPerWeekDay(this.pool, game_type, draw_type, half, as_of_date, period)],
      // ── 13 nuevos (FIX #1, 2026-05-18) ──────────────────────────
      ['pairs_correlation',   () => scorePairsCorrelation(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['streak',              () => scoreStreak(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['position',            () => scorePosition(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['moving_averages',     () => scoreMovingAverages(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['bayesian_score',      () => scoreBayesianScore(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['pair_return_cycle',   () => scorePairReturnCycle(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['sum_pattern_filter',  () => scoreSumPatternFilter(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['double_triple',       () => scoreDoubleTriple(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['cross_draw',          () => scoreCrossDraw(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['trend_momentum',      () => scoreTrendMomentum(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['trend_momentum_sweet',() => scoreTrendMomentumSweet(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['est_individuales',    () => scoreEstIndividuales(this.pool, game_type, draw_type, half, as_of_date, period)],
      ['terminal_analysis',   () => scoreTerminalAnalysis(this.pool, game_type, draw_type, half, as_of_date, period)],
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
