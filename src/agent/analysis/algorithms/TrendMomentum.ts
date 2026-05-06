// ═══════════════════════════════════════════════════════════════
// HITDASH — TrendMomentum v1.0.0
//
// Fórmula exacta de Ballbot "Fuerza de Tendencia Pro":
//
//   momentum(pair) = freq_recent(30 draws) / freq_historical(all)
//
//   Criterios candidatos:
//     countAll >= 3  (mínimo histórico para señal válida)
//     momentum >= 1.0 (en alza o estable respecto a la media)
//
// Extracción de pares — idéntica a Ballbot:
//   pick3 du: p2*10 + p3  (decena + unidad)
//   pick4 ab: p1*10 + p2
//   pick4 cd: p3*10 + p4
//
// Score para el consensus:
//   Normalizado al rango [0,1] via min-max sobre momentum scores.
//   momentum=0 → 0.0  |  top momentum → 1.0
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import type { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';
import { DRAWS_CTE_ALL } from '../ballbotAdapter.js';

const logger = pino({ name: 'TrendMomentum' });

const RECENT_WINDOW = 30;   // ventana reciente — igual que Ballbot
const MIN_COUNT_ALL = 3;    // mínimo histórico para señal válida
const MOMENTUM_THRESHOLD = 1.0; // solo pares en alza o estables

export interface MomentumStat {
  pair:         string;
  count_all:    number;
  count_recent: number;
  freq_all:     number;
  freq_recent:  number;
  momentum:     number;
}

export class TrendMomentum {
  constructor(private readonly pool: Pool) {}

  // ── Computa momentum stats para todos los pares ────────────────
  // Usado tanto por runPairs() como por el endpoint de backtesting
  async computeStats(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf
  ): Promise<{ stats: MomentumStat[]; total_all: number; total_recent: number }> {

    const { rows: allRows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number;
    }>(
      `${DRAWS_CTE_ALL}
       SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
              (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4
       FROM lottery_results
       ORDER BY draw_date DESC`,
      [game_type, draw_type]
    );

    if (allRows.length === 0) return { stats: [], total_all: 0, total_recent: 0 };

    const total_all    = allRows.length;
    const recentRows   = allRows.slice(0, RECENT_WINDOW);
    const total_recent = recentRows.length;

    const extractPair = (row: { p1: number; p2: number; p3: number; p4: number }): number => {
      if (half === 'ab') return row.p1 * 10 + row.p2;
      if (half === 'cd') return row.p3 * 10 + row.p4;
      return row.p2 * 10 + row.p3; // 'du'
    };

    // Contar por par
    const countAll:    Record<number, number> = {};
    const countRecent: Record<number, number> = {};

    for (const row of allRows) {
      const p = extractPair(row);
      countAll[p] = (countAll[p] ?? 0) + 1;
    }
    for (const row of recentRows) {
      const p = extractPair(row);
      countRecent[p] = (countRecent[p] ?? 0) + 1;
    }

    // Construir stats para todos los pares 00-99
    const stats: MomentumStat[] = [];
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const n = x * 10 + y;
        const ca = countAll[n]    ?? 0;
        const cr = countRecent[n] ?? 0;

        const fa = total_all    > 0 ? ca / total_all    : 0;
        const fr = total_recent > 0 ? cr / total_recent : 0;

        // Fórmula Ballbot exacta
        let momentum: number;
        if (fa > 0) {
          momentum = fr / fa;
        } else {
          momentum = cr > 0 ? 10 : 0; // nuevo número emergente
        }

        stats.push({
          pair:         `${x}${y}`,
          count_all:    ca,
          count_recent: cr,
          freq_all:     +fa.toFixed(6),
          freq_recent:  +fr.toFixed(6),
          momentum:     +momentum.toFixed(4),
        });
      }
    }

    return { stats, total_all, total_recent };
  }

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    _period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const flat = (): Record<string, number> => {
      const r: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) r[`${x}${y}`] = 0.01;
      return r;
    };

    try {
      const { stats } = await this.computeStats(game_type, draw_type, half);
      if (!stats.length) return flat();

      // Filtrar: mínimo histórico + en alza
      const valid = stats.filter(s => s.count_all >= MIN_COUNT_ALL && s.momentum >= MOMENTUM_THRESHOLD);

      if (!valid.length) return flat();

      // Normalizar scores [0,1] por max momentum entre candidatos válidos
      const maxM = Math.max(...valid.map(s => s.momentum), 1e-9);
      const scores: Record<string, number> = {};

      for (const s of stats) {
        if (s.count_all >= MIN_COUNT_ALL && s.momentum >= MOMENTUM_THRESHOLD) {
          scores[s.pair] = s.momentum / maxM;
        } else {
          scores[s.pair] = 0.01; // no candidato — señal mínima
        }
      }

      logger.debug(
        { game_type, draw_type, half, candidates: valid.length },
        'TrendMomentum: runPairs completado'
      );

      return scores;
    } catch (err) {
      logger.error({ err, game_type, draw_type, half }, 'TrendMomentum: DB error — flat scores');
      return flat();
    }
  }
}
