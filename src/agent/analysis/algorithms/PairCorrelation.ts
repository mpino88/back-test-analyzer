// ═══════════════════════════════════════════════════════════════
// HITDASH — PairCorrelation v1.0.0
// Correlación cruzada entre posiciones — peso 0.75
// correlation_ratio = observed / expected (independence baseline)
// Top pares: ratio > 1.3
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../ballbotAdapter.js';
import type {
  PairResult,
  PairEntry,
  AnalysisPeriod,
  Position,
  PairHalf,
} from '../../types/analysis.types.js';

const logger = pino({ name: 'PairCorrelation' });

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

// Generate all pairs of positions
function positionPairs(positions: Position[]): [Position, Position][] {
  const pairs: [Position, Position][] = [];
  for (let i = 0; i < positions.length; i++) {
    for (let j = i + 1; j < positions.length; j++) {
      pairs.push([positions[i]!, positions[j]!]);
    }
  }
  return pairs;
}

export class PairCorrelation {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<PairResult> {
    const start = Date.now();
    const periodDays = period === 'all' ? 9999 : period;
    const positions = POSITIONS[game_type];

    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const total_draws = rows.length;
    if (total_draws === 0) {
      return this.emptyResult(game_type, period, periodDays);
    }

    // Marginal frequency per position-digit
    const marginal: Record<Position, number[]> = {} as Record<Position, number[]>;
    for (const pos of positions) {
      marginal[pos] = new Array(10).fill(0) as number[];
    }

    for (const row of rows) {
      for (const pos of positions) {
        const val = (row.digits as Record<string, number>)[pos];
        if (val !== undefined) marginal[pos]![val]! += 1;
      }
    }

    // Joint frequency for each pair of positions
    const pairs = positionPairs(positions);
    const topPairs: PairEntry[] = [];

    for (const [posA, posB] of pairs) {
      // Count joint occurrences
      const joint: Map<string, number> = new Map();
      for (const row of rows) {
        const dA = (row.digits as Record<string, number>)[posA];
        const dB = (row.digits as Record<string, number>)[posB];
        if (dA !== undefined && dB !== undefined) {
          const key = `${dA}-${dB}`;
          joint.set(key, (joint.get(key) ?? 0) + 1);
        }
      }

      for (let dA = 0; dA <= 9; dA++) {
        for (let dB = 0; dB <= 9; dB++) {
          const observed_freq = (joint.get(`${dA}-${dB}`) ?? 0) / total_draws;
          const freq_a = (marginal[posA]![dA] ?? 0) / total_draws;
          const freq_b = (marginal[posB]![dB] ?? 0) / total_draws;
          const expected_freq = freq_a * freq_b;

          if (expected_freq === 0) continue;

          const correlation_ratio = +(observed_freq / expected_freq).toFixed(3);

          if (correlation_ratio >= 1.3) {
            topPairs.push({
              positions: [posA, posB],
              digit_a: dA,
              digit_b: dB,
              observed_freq: +observed_freq.toFixed(4),
              expected_freq: +expected_freq.toFixed(4),
              correlation_ratio,
            });
          }
        }
      }
    }

    // Sort by correlation_ratio DESC, keep top 30
    topPairs.sort((a, b) => b.correlation_ratio - a.correlation_ratio);
    const top30 = topPairs.slice(0, 30);

    const summary = top30.length > 0
      ? top30.slice(0, 5)
          .map(p => `${p.positions[0]}-${p.digit_a}/${p.positions[1]}-${p.digit_b}(r=${p.correlation_ratio})`)
          .join(' ')
      : 'no strong pairs';

    logger.info({ game_type, draw_type, total_pairs: topPairs.length }, 'PairCorrelation completado');

    return {
      algorithm_name: 'pairs_correlation',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type, period_days: periodDays, min_ratio: 1.3 },
      output_data: { top_pairs: top30, total_draws },
      output_summary: `Pairs ${game_type} ${draw_type} (${periodDays}d n=${total_draws}): ${summary}`.slice(0, 500),
      execution_ms: Date.now() - start,
    };
  }

  // ─── Pair mode (v2) ─────────────────────────────────────────────
  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const periodDays = period === 'all' ? 9999 : period;
    const [posA, posB] = half === 'du' ? ['p2', 'p3'] : half === 'ab' ? ['p1', 'p2'] : ['p3', 'p4'];

    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE} SELECT digits FROM lottery_results`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const total = rows.length;
    if (total === 0) {
      const s: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) s[`${x}${y}`] = 0;
      return s;
    }

    const margA: number[] = new Array(10).fill(0) as number[];
    const margB: number[] = new Array(10).fill(0) as number[];
    const joint: Record<string, number> = {};

    for (const row of rows) {
      const d = row.digits as Record<string, number | undefined>;
      const a = d[posA!], b = d[posB!];
      if (a !== undefined && b !== undefined) {
        margA[a]! += 1;
        margB[b]! += 1;
        const key = `${a}${b}`;
        joint[key] = (joint[key] ?? 0) + 1;
      }
    }

    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        const pXY      = (joint[key] ?? 0) / total;
        const pX       = (margA[x]! ) / total;
        const pY       = (margB[y]! ) / total;
        const expected = pX * pY;
        // pXY / expected - 1: positive = co-occurs more than by chance
        scores[key] = expected > 0 ? Math.max(0, pXY / expected - 1) : 0;
      }
    }
    return scores;
  }

  private emptyResult(game_type: GameType, period: AnalysisPeriod, periodDays: number): PairResult {
    return {
      algorithm_name: 'pairs_correlation',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { period_days: periodDays },
      output_data: { top_pairs: [], total_draws: 0 },
      output_summary: 'Pairs: sin datos',
      execution_ms: 0,
    };
  }
}
