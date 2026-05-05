import { Pool } from 'pg';
import pino from 'pino';
import { GameType, DrawType } from '../../types/agent.types.js';
import { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';
import { DRAWS_CTE } from '../ballbotAdapter.js';

const logger = pino({ name: 'SumPatternFilter', level: 'debug' });

export class SumPatternFilter {
  constructor(private readonly pool: Pool) {}

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const allPairs: string[] = [];
    for (let i = 0; i <= 9; i++) {
      for (let j = 0; j <= 9; j++) {
        allPairs.push(`${i}${j}`);
      }
    }

    const flatScores = (): Record<string, number> =>
      Object.fromEntries(allPairs.map((p) => [p, 0.01]));

    try {
      const [posA, posB] =
        half === 'ab'
          ? ['p1', 'p2']
          : half === 'cd'
          ? ['p3', 'p4']
          : ['p2', 'p3'];

      const periodDays = typeof period === 'number' ? Math.min(period, 60) : 60;

      logger.debug(
        { game_type, draw_type, half, periodDays },
        'SumPatternFilter: querying draws'
      );

      const longResult = await this.pool.query<{ digits: Record<string, number> }>(
        `${DRAWS_CTE} SELECT digits FROM lottery_results ORDER BY draw_date DESC`,
        [game_type, draw_type, periodDays]
      );

      if (longResult.rows.length === 0) {
        logger.debug('SumPatternFilter: no rows returned, using flat scores');
        return flatScores();
      }

      // Build long-term sumFreq[s] for s in [0,18]
      const longSumFreq: number[] = new Array(19).fill(0);

      for (const row of longResult.rows) {
        const a = row.digits[posA as keyof typeof row.digits] as number;
        const b = row.digits[posB as keyof typeof row.digits] as number;
        if (a === undefined || a === null || b === undefined || b === null) continue;
        const s = a + b;
        if (s >= 0 && s <= 18) {
          longSumFreq[s]++;
        }
      }

      // Apply Laplace smoothing (+1 to each bucket)
      const smoothedLong = longSumFreq.map((v) => v + 1);
      const maxLong = Math.max(...smoothedLong);

      // Build short-term sumFreq from last 14 draws
      const shortRows = longResult.rows.slice(0, 14);
      const shortSumFreq: number[] = new Array(19).fill(0);

      for (const row of shortRows) {
        const a = row.digits[posA as keyof typeof row.digits] as number;
        const b = row.digits[posB as keyof typeof row.digits] as number;
        if (a === undefined || a === null || b === undefined || b === null) continue;
        const s = a + b;
        if (s >= 0 && s <= 18) {
          shortSumFreq[s]++;
        }
      }

      const smoothedShort = shortSumFreq.map((v) => v + 1);
      const maxShort = Math.max(...smoothedShort);

      logger.debug(
        { longSumFreq, shortSumFreq, totalLongDraws: longResult.rows.length, shortDraws: shortRows.length },
        'SumPatternFilter: sum frequency tables built'
      );

      // Score each of the 100 pairs
      const scores: Record<string, number> = {};

      for (const pair of allPairs) {
        const X = parseInt(pair[0], 10);
        const Y = parseInt(pair[1], 10);
        const s = X + Y;

        const longScore = smoothedLong[s] / maxLong;
        const shortScore = smoothedShort[s] / maxShort;

        let finalScore = 0.6 * longScore + 0.4 * shortScore;

        // Consecutive sum boost/penalty
        if (X === Y) {
          // Double pair — slight penalty
          finalScore *= 0.95;
        } else if (Math.abs(X - Y) === 1) {
          // Adjacent digits — slight boost
          finalScore *= 1.05;
        }

        scores[pair] = finalScore;
      }

      logger.debug('SumPatternFilter: scoring complete');
      return scores;
    } catch (err) {
      logger.debug({ err }, 'SumPatternFilter: error, returning flat scores');
      return flatScores();
    }
  }
}
