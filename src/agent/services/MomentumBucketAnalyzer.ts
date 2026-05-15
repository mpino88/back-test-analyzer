// ═══════════════════════════════════════════════════════════════
// HELIX — MomentumBucketAnalyzer v1.0 (2026-05-14)
//
// PROPÓSITO:
//   Verificar empíricamente la hipótesis del usuario: "los pares con
//   Rec% = 3.3% (1 hit en los últimos 30) y momentum ≥ 3x son el bracket
//   más predictivo del top-15 de Fuerza de Tendencia Pro".
//
// METODOLOGÍA (walk-forward backtesting estricto):
//   Para cada sorteo histórico T en una ventana de N sorteos:
//     1. Computar momentum stats USANDO SOLO sorteos < T (no leak)
//     2. Tomar top-15 por momentum desc
//     3. Clasificar cada par del top-15 en su bucket de count_recent
//     4. Anotar a qué bucket pertenecía el par ganador (D+U) si estaba
//     5. Acumular hit_rate por bucket
//
//   Resultado: hit_rate empírico por bucket × turno × game_type.
//
// OUTPUT:
//   {
//     buckets: [
//       { rec_count: 0, candidates_avg: X, hits: Y, evaluations: Z, hit_rate: y/z },
//       { rec_count: 1, ... },  ← sweet spot del usuario
//       { rec_count: 2, ... },
//       { rec_count: 3+, ... },
//     ],
//     overall: { hit_rate_top15, baseline_random },
//     evaluations: total
//   }
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../types/agent.types.js';
import type { PairHalf } from '../types/analysis.types.js';

const logger = pino({ name: 'MomentumBucketAnalyzer' });

const RECENT_WINDOW = 30;        // ventana reciente para momentum
const TOP_N         = 15;        // top-N a evaluar (matching bot's TOP 15 EN ALZA)
const MIN_COUNT_ALL = 3;         // mínimo histórico

export interface BucketStat {
  rec_count:      number;        // 0, 1, 2, 3+ (recent appearances)
  candidates_avg: number;        // promedio de candidatos en este bucket por sorteo
  hits:           number;        // veces que el ganador estaba en este bucket
  evaluations:    number;        // sorteos donde había al menos 1 candidato en este bucket
  hit_rate:       number;        // hits / evaluations
  hit_rate_overall: number;      // hits / total_sorteos_evaluados (incluye sorteos sin candidates)
}

export interface BucketAnalysisReport {
  game_type:        string;
  draw_type:        string;
  half:             string;
  lookback:         number;
  total_evaluated:  number;
  baseline_random:  number;      // TOP_N / 100
  overall: {
    top15_hit_rate: number;      // hits en top-15 total / sorteos
    top15_hits:     number;
    candidates_per_draw_avg: number;
  };
  buckets:          BucketStat[];
  best_bucket: {
    rec_count: number;
    hit_rate:  number;
    edge_over_baseline: number;
  } | null;
  // Comparativa contra "filtrar solo momentum ≥ 3" vs "filtrar momentum ≥ 1"
  threshold_comparison: {
    momentum_ge_1: { hit_rate: number; candidates_avg: number };
    momentum_ge_3: { hit_rate: number; candidates_avg: number };
  };
}

interface DrawRow {
  draw_date: string;
  p1: number; p2: number; p3: number; p4: number;
}

export class MomentumBucketAnalyzer {
  constructor(private readonly pool: Pool) {}

  private extractPair(row: DrawRow, half: PairHalf): string {
    let a: number, b: number;
    if (half === 'ab')      { a = row.p1; b = row.p2; }
    else if (half === 'cd') { a = row.p3; b = row.p4; }
    else                    { a = row.p2; b = row.p3; }   // 'du'
    return `${a}${b}`;
  }

  // ════════════════════════════════════════════════════════════════
  // Walk-forward backtest. NO data leak — cada sorteo evaluado usa
  // únicamente datos PREVIOS a esa fecha.
  // ════════════════════════════════════════════════════════════════
  async analyze(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    lookback: number = 200
  ): Promise<BucketAnalysisReport> {
    // Cargar TODOS los sorteos de ese game/draw_type en orden cronológico
    const { rows: allRows } = await this.pool.query<DrawRow>(
      `SELECT draw_date::text, p1, p2, p3, p4
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
         AND draw_date IS NOT NULL
       ORDER BY draw_date ASC`,
      [game_type, draw_type]
    );

    const total = allRows.length;
    if (total < RECENT_WINDOW + 1) {
      logger.warn({ game_type, draw_type, total }, 'No hay suficientes sorteos para bucket analysis');
      return this.emptyReport(game_type, draw_type, half, lookback);
    }

    // Solo evaluar los últimos `lookback` sorteos (los más recientes)
    // El walk-forward usa la historia COMPLETA antes de cada sorteo evaluado
    const evalStartIdx = Math.max(RECENT_WINDOW, total - lookback);

    // Acumuladores por bucket
    const bucketStats = new Map<number, { hits: number; evaluations: number; total_candidates: number }>();
    for (const k of [0, 1, 2, 3]) bucketStats.set(k, { hits: 0, evaluations: 0, total_candidates: 0 });

    // Métricas globales
    let total_evaluated      = 0;
    let total_top15_hits     = 0;
    let total_candidates_sum = 0;

    // Comparativa de thresholds
    let m_ge_1_hits = 0, m_ge_1_evals = 0, m_ge_1_cand_sum = 0;
    let m_ge_3_hits = 0, m_ge_3_evals = 0, m_ge_3_cand_sum = 0;

    // ── WALK-FORWARD ───────────────────────────────────────────────
    for (let i = evalStartIdx; i < total; i++) {
      const targetDraw = allRows[i]!;
      const winningPair = this.extractPair(targetDraw, half);

      // History strictly BEFORE this draw (no leak)
      const history = allRows.slice(0, i);
      const recentHistory = history.slice(-RECENT_WINDOW);

      // Contar pares en histórico completo + ventana reciente
      const countAll: Record<string, number>    = {};
      const countRecent: Record<string, number> = {};
      for (const r of history) {
        const p = this.extractPair(r, half);
        countAll[p] = (countAll[p] ?? 0) + 1;
      }
      for (const r of recentHistory) {
        const p = this.extractPair(r, half);
        countRecent[p] = (countRecent[p] ?? 0) + 1;
      }

      // Calcular momentum para todos los 100 pares
      const total_hist   = history.length;
      const total_recent = recentHistory.length;
      const stats: Array<{ pair: string; momentum: number; count_all: number; count_recent: number }> = [];

      for (let x = 0; x <= 9; x++) {
        for (let y = 0; y <= 9; y++) {
          const p   = `${x}${y}`;
          const ca  = countAll[p]    ?? 0;
          const cr  = countRecent[p] ?? 0;
          const fa  = total_hist   > 0 ? ca / total_hist   : 0;
          const fr  = total_recent > 0 ? cr / total_recent : 0;
          const mom = fa > 0 ? fr / fa : (cr > 0 ? 10 : 0);
          stats.push({ pair: p, momentum: mom, count_all: ca, count_recent: cr });
        }
      }

      // ── TOP-15 según fórmula del bot (Fuerza de Tendencia Pro) ──
      // Bot solo considera count_all >= 3, después ordena por momentum DESC
      const top15 = stats
        .filter(s => s.count_all >= MIN_COUNT_ALL)
        .sort((a, b) => b.momentum - a.momentum)
        .slice(0, TOP_N);

      if (top15.length === 0) continue;

      total_evaluated++;
      total_candidates_sum += top15.length;
      const isTop15Hit = top15.some(s => s.pair === winningPair);
      if (isTop15Hit) total_top15_hits++;

      // ── CLASIFICAR cada par del top-15 por su bucket de count_recent ──
      // Bucket 0 = no hits recientes (emergente puro)
      // Bucket 1 = 1 hit reciente (SWEET SPOT según hipótesis del usuario)
      // Bucket 2 = 2 hits recientes
      // Bucket 3 = 3+ hits recientes (outliers ya calientes)
      const bucketsThisDraw = new Map<number, string[]>([[0, []], [1, []], [2, []], [3, []]]);
      for (const s of top15) {
        const bucket = s.count_recent >= 3 ? 3 : s.count_recent;
        bucketsThisDraw.get(bucket)!.push(s.pair);
      }

      // Acumular candidates + check si el ganador estaba en ese bucket
      for (const [bucket, pairs] of bucketsThisDraw) {
        const stat = bucketStats.get(bucket)!;
        stat.total_candidates += pairs.length;
        if (pairs.length > 0) {
          stat.evaluations += 1;
          if (pairs.includes(winningPair)) stat.hits += 1;
        }
      }

      // ── THRESHOLD COMPARISON (momentum >= 1 vs >= 3) ──
      const top15_m1 = stats
        .filter(s => s.count_all >= MIN_COUNT_ALL && s.momentum >= 1.0)
        .sort((a, b) => b.momentum - a.momentum)
        .slice(0, TOP_N);
      const top15_m3 = stats
        .filter(s => s.count_all >= MIN_COUNT_ALL && s.momentum >= 3.0)
        .sort((a, b) => b.momentum - a.momentum)
        .slice(0, TOP_N);

      if (top15_m1.length > 0) {
        m_ge_1_evals++;
        m_ge_1_cand_sum += top15_m1.length;
        if (top15_m1.some(s => s.pair === winningPair)) m_ge_1_hits++;
      }
      if (top15_m3.length > 0) {
        m_ge_3_evals++;
        m_ge_3_cand_sum += top15_m3.length;
        if (top15_m3.some(s => s.pair === winningPair)) m_ge_3_hits++;
      }
    }

    // ── Construir reporte ───────────────────────────────────────
    const buckets: BucketStat[] = [];
    for (const k of [0, 1, 2, 3]) {
      const s = bucketStats.get(k)!;
      buckets.push({
        rec_count:      k,
        candidates_avg: s.evaluations > 0 ? +(s.total_candidates / s.evaluations).toFixed(2) : 0,
        hits:           s.hits,
        evaluations:    s.evaluations,
        hit_rate:       s.evaluations > 0 ? +(s.hits / s.evaluations).toFixed(4) : 0,
        hit_rate_overall: total_evaluated > 0 ? +(s.hits / total_evaluated).toFixed(4) : 0,
      });
    }

    // Best bucket = el que tenga mayor hit_rate (entre los que tienen evaluations > 0)
    const eligibleBuckets = buckets.filter(b => b.evaluations >= Math.max(10, total_evaluated * 0.20));
    const sortedByRate = [...eligibleBuckets].sort((a, b) => b.hit_rate - a.hit_rate);
    const baseline_random = TOP_N / 100;
    const best = sortedByRate[0] && sortedByRate[0].hit_rate > baseline_random
      ? {
          rec_count: sortedByRate[0].rec_count,
          hit_rate:  sortedByRate[0].hit_rate,
          edge_over_baseline: +(sortedByRate[0].hit_rate - baseline_random).toFixed(4),
        }
      : null;

    return {
      game_type,
      draw_type,
      half,
      lookback,
      total_evaluated,
      baseline_random,
      overall: {
        top15_hit_rate: total_evaluated > 0 ? +(total_top15_hits / total_evaluated).toFixed(4) : 0,
        top15_hits:     total_top15_hits,
        candidates_per_draw_avg: total_evaluated > 0 ? +(total_candidates_sum / total_evaluated).toFixed(2) : 0,
      },
      buckets,
      best_bucket: best,
      threshold_comparison: {
        momentum_ge_1: {
          hit_rate:       m_ge_1_evals > 0 ? +(m_ge_1_hits / m_ge_1_evals).toFixed(4) : 0,
          candidates_avg: m_ge_1_evals > 0 ? +(m_ge_1_cand_sum / m_ge_1_evals).toFixed(2) : 0,
        },
        momentum_ge_3: {
          hit_rate:       m_ge_3_evals > 0 ? +(m_ge_3_hits / m_ge_3_evals).toFixed(4) : 0,
          candidates_avg: m_ge_3_evals > 0 ? +(m_ge_3_cand_sum / m_ge_3_evals).toFixed(2) : 0,
        },
      },
    };
  }

  private emptyReport(game_type: string, draw_type: string, half: string, lookback: number): BucketAnalysisReport {
    return {
      game_type, draw_type, half, lookback,
      total_evaluated: 0,
      baseline_random: TOP_N / 100,
      overall:  { top15_hit_rate: 0, top15_hits: 0, candidates_per_draw_avg: 0 },
      buckets:  [],
      best_bucket: null,
      threshold_comparison: {
        momentum_ge_1: { hit_rate: 0, candidates_avg: 0 },
        momentum_ge_3: { hit_rate: 0, candidates_avg: 0 },
      },
    };
  }
}
