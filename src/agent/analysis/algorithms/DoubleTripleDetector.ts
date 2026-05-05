import { Pool } from 'pg';
import pino from 'pino';
import { GameType, DrawType } from '../../types/agent.types.js';
import { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';
import { DRAWS_CTE, DRAWS_CTE_ALL } from '../ballbotAdapter.js';

const logger = pino({ name: 'DoubleTripleDetector' });

function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

interface DrawRow {
  p1: number;
  p2: number;
  p3: number;
  p4: number | null;
  draw_date: string;
}

export class DoubleTripleDetector {
  constructor(private readonly pool: Pool) {}

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod = 90,
  ): Promise<Record<string, number>> {
    const flatScores = (): Record<string, number> => {
      const result: Record<string, number> = {};
      for (let i = 0; i <= 9; i++) {
        for (let j = 0; j <= 9; j++) {
          result[`${i}${j}`] = 0.01;
        }
      }
      return result;
    };

    try {
      const [posA, posB] =
        half === 'ab'
          ? (['p1', 'p2'] as const)
          : half === 'cd'
            ? (['p3', 'p4'] as const)
            : (['p2', 'p3'] as const);

      // --- Query 1: Historical (last 1095 days via DRAWS_CTE_ALL) ---
      const historicalQuery = `
        ${DRAWS_CTE_ALL}
        SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
               (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4,
               draw_date
        FROM lottery_results
        ORDER BY draw_date DESC
      `;

      const historicalResult = await this.pool.query<DrawRow>(historicalQuery, [
        game_type,
        draw_type,
      ]);

      const historicalRows = historicalResult.rows;

      let historicalDoubleCount = 0;
      const historicalTotal = historicalRows.length;

      for (const row of historicalRows) {
        const digitA = row[posA as keyof DrawRow] as number | null;
        const digitB = row[posB as keyof DrawRow] as number | null;
        if (digitA !== null && digitB !== null && digitA === digitB) {
          historicalDoubleCount++;
        }
      }

      const historicalDoubleRate =
        historicalTotal > 0
          ? historicalDoubleCount / historicalTotal
          : 0.281;

      // --- Query 2: Recent regime (last 30 days via DRAWS_CTE) ---
      const recentQuery = `
        ${DRAWS_CTE}
        SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
               (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4,
               draw_date
        FROM lottery_results
        ORDER BY draw_date DESC
      `;

      const recentResult = await this.pool.query<DrawRow>(recentQuery, [
        game_type,
        draw_type,
        30,
      ]);

      const recentRows = recentResult.rows;

      // Take only the last 14 draws
      const last14Rows = recentRows.slice(0, 14);
      // Take only the last 5 draws
      const last5Rows = recentRows.slice(0, 5);

      let recentDoubleCount = 0;
      const recentTotal = last14Rows.length;

      // CUSUM accumulator
      let cusum = 0;

      for (const row of last14Rows) {
        const digitA = row[posA as keyof DrawRow] as number | null;
        const digitB = row[posB as keyof DrawRow] as number | null;
        if (digitA !== null && digitB !== null) {
          const isDouble = digitA === digitB ? 1 : 0;
          recentDoubleCount += isDouble;
          cusum += isDouble - historicalDoubleRate;
        }
      }

      const recentDoubleRate =
        recentTotal > 0 ? recentDoubleCount / recentTotal : historicalDoubleRate;

      // Compute regime factor and strength
      let regimeFactor =
        (recentDoubleRate - historicalDoubleRate) /
        Math.max(historicalDoubleRate, 0.01);

      logger.debug(
        {
          regime_factor: regimeFactor,
          recent_double_rate: recentDoubleRate,
          historical_double_rate: historicalDoubleRate,
          cusum,
          game_type,
          draw_type,
          half,
        },
        'DoubleTripleDetector regime analysis',
      );

      // CUSUM scaling
      let cusumScale = 1.0;
      if (cusum > 2.0) {
        cusumScale = 1.3; // strong_double
      } else if (cusum < -2.0) {
        cusumScale = 1.3; // strong_single — still scale, direction handled by sign of regimeFactor
      }

      regimeFactor *= cusumScale;

      // Clamp regime strength
      const regimeStrength = Math.min(1.5, Math.max(-1.5, regimeFactor));

      // Collect pairs that appeared in the last 5 draws
      const last5Doubles = new Set<string>();
      for (const row of last5Rows) {
        const digitA = row[posA as keyof DrawRow] as number | null;
        const digitB = row[posB as keyof DrawRow] as number | null;
        if (digitA !== null && digitB !== null && digitA === digitB) {
          const pair = `${digitA}${digitB}`;
          last5Doubles.add(pair);
        }
      }

      // --- Score all 100 pairs ---
      const scores: Record<string, number> = {};

      for (let i = 0; i <= 9; i++) {
        for (let j = 0; j <= 9; j++) {
          const pair = `${i}${j}`;
          const isDouble = i === j;

          let score: number;

          if (isDouble) {
            score = 0.5 + 0.5 * sigmoid(regimeStrength * 2.0);
          } else {
            score = 0.5 - 0.3 * sigmoid(regimeStrength * 1.5);
          }

          // Recency boost: if double appeared in last 5 draws
          if (isDouble && last5Doubles.has(pair)) {
            score *= 1.1;
          }

          // Clamp to [0.05, 0.95]
          score = Math.min(0.95, Math.max(0.05, score));

          scores[pair] = score;
        }
      }

      return scores;
    } catch (error) {
      logger.error({ error }, 'DoubleTripleDetector failed, returning flat scores');
      return (() => {
        const result: Record<string, number> = {};
        for (let i = 0; i <= 9; i++) {
          for (let j = 0; j <= 9; j++) {
            result[`${i}${j}`] = 0.01;
          }
        }
        return result;
      })();
    }
  }
}
