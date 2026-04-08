// ═══════════════════════════════════════════════════════════════
// HITDASH — FrequencyAnalysis v1.0.0
// Frecuencia relativa por posición — peso 1.0 (mayor confianza)
// Señal: dígitos con mayor desviación positiva sobre 0.10
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../ballbotAdapter.js';
import type {
  FrequencyResult,
  FrequencyEntry,
  AnalysisPeriod,
  Position,
  PairHalf,
} from '../../types/analysis.types.js';

const logger = pino({ name: 'FrequencyAnalysis' });

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

export class FrequencyAnalysis {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<FrequencyResult> {
    const start = Date.now();
    const periodDays = period === 'all' ? 9999 : period;
    const positions = POSITIONS[game_type];

    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const total_draws = rows.length;

    // Initialize counts
    const counts: Record<Position, number[]> = {} as Record<Position, number[]>;
    for (const pos of positions) {
      counts[pos] = new Array(10).fill(0) as number[];
    }

    for (const row of rows) {
      for (const pos of positions) {
        const val = (row.digits as Record<string, number>)[pos];
        if (val !== undefined && val !== null) {
          counts[pos]![val] = (counts[pos]![val] ?? 0) + 1;
        }
      }
    }

    const by_position: Record<Position, FrequencyEntry[]> = {} as Record<Position, FrequencyEntry[]>;

    for (const pos of positions) {
      const entries: FrequencyEntry[] = [];
      for (let d = 0; d <= 9; d++) {
        const count = counts[pos]![d] ?? 0;
        const freq_relative = total_draws > 0 ? count / total_draws : 0;
        entries.push({
          digit: d,
          count,
          freq_relative: +freq_relative.toFixed(4),
          deviation: +(freq_relative - 0.1).toFixed(4),
          rank: 0,
        });
      }
      entries.sort((a, b) => b.freq_relative - a.freq_relative);
      entries.forEach((e, i) => { e.rank = i + 1; });
      by_position[pos] = entries;
    }

    const topSummary = positions
      .map(p => `${p.toUpperCase()}:[${by_position[p]!.slice(0, 3).map(e => e.digit).join(',')}]`)
      .join(' ');

    logger.info({ game_type, draw_type, period, total_draws }, 'FrequencyAnalysis completado');

    return {
      algorithm_name: 'frequency',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type, period_days: periodDays },
      output_data: { by_position, total_draws },
      output_summary: `Frequency ${game_type} ${draw_type} (${periodDays}d n=${total_draws}): ${topSummary}`.slice(0, 500),
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
    const counts: Record<string, number> = {};

    for (const row of rows) {
      const d = row.digits as Record<string, number | undefined>;
      const a = d[posA!], b = d[posB!];
      if (a !== undefined && b !== undefined) {
        const key = `${a}${b}`;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }

    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        scores[key] = total > 0 ? (counts[key] ?? 0) / total : 0;
      }
    }
    return scores;
  }
}
