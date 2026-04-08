// ═══════════════════════════════════════════════════════════════
// HITDASH — FibonacciPisano v1.0.0
// Período de Pisano mod 10 = 60 — peso 0.3 (experimental)
// alignment_score = freq_en_fase_actual / freq_general
// Señal: dígitos con is_aligned = true (score > 1.1)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../ballbotAdapter.js';
import type {
  FibonacciResult,
  FibonacciEntry,
  AnalysisPeriod,
  Position,
  PairHalf,
} from '../../types/analysis.types.js';

const logger = pino({ name: 'FibonacciPisano' });

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

// Pisano period π(10) = 60 — precomputed
const PISANO_60: number[] = (() => {
  const seq: number[] = [0, 1];
  for (let i = 2; i < 60; i++) {
    seq.push((seq[i - 1]! + seq[i - 2]!) % 10);
  }
  return seq;
})();

export class FibonacciPisano {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 365
  ): Promise<FibonacciResult> {
    const start = Date.now();
    const periodDays = period === 'all' ? 9999 : period;
    const positions = POSITIONS[game_type];

    // Fetch ordered by draw_date ASC to get sequential index
    const { rows } = await this.pool.query<{ draw_date: Date; digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT draw_date, digits FROM lottery_results ORDER BY draw_date ASC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const total = rows.length;
    const current_index = total % 60; // current phase in Pisano sequence
    const current_pisano_digit = PISANO_60[current_index]!;

    const by_position: Record<Position, FibonacciEntry[]> = {} as Record<Position, FibonacciEntry[]>;

    for (const pos of positions) {
      const entries: FibonacciEntry[] = [];

      // General frequency per digit
      const generalCount: number[] = new Array(10).fill(0) as number[];
      for (const row of rows) {
        const val = (row.digits as Record<string, number>)[pos];
        if (val !== undefined) generalCount[val]! += 1;
      }

      // Phase-specific frequency: draws where index % 60 matches current Pisano digit
      // i.e., draws at positions 0, 60, 120, ... (same Pisano phase)
      const phaseCount: number[] = new Array(10).fill(0) as number[];
      let phaseTotal = 0;
      rows.forEach((row, idx) => {
        if (idx % 60 === current_index) {
          const val = (row.digits as Record<string, number>)[pos];
          if (val !== undefined) {
            phaseCount[val]! += 1;
            phaseTotal++;
          }
        }
      });

      for (let d = 0; d <= 9; d++) {
        const general_freq = total > 0 ? generalCount[d]! / total : 0;
        const phase_freq = phaseTotal > 0 ? phaseCount[d]! / phaseTotal : 0;
        const alignment_score = general_freq > 0 ? +(phase_freq / general_freq).toFixed(3) : 0;

        entries.push({
          digit: d,
          position: pos,
          current_pisano_index: current_index,
          alignment_score,
          is_aligned: alignment_score > 1.1,
        });
      }

      entries.sort((a, b) => b.alignment_score - a.alignment_score);
      by_position[pos] = entries;
    }

    const alignedSummary = positions
      .map(p => {
        const aligned = by_position[p]!.filter(e => e.is_aligned).map(e => e.digit).join(',');
        return aligned ? `${p.toUpperCase()}:[${aligned}]` : null;
      })
      .filter(Boolean)
      .join(' ');

    logger.info(
      { game_type, draw_type, current_index, current_pisano_digit, total },
      'FibonacciPisano completado'
    );

    return {
      algorithm_name: 'fibonacci_pisano',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type, period_days: periodDays },
      output_data: {
        pisano_sequence_mod10: PISANO_60,
        current_index,
        by_position,
      },
      output_summary: `Fibonacci Pisano(10) idx=${current_index} digit=${current_pisano_digit} (n=${total}): ${alignedSummary || 'none'}`.slice(0, 500),
      execution_ms: Date.now() - start,
    };
  }

  // ─── Pair mode (v2) ─────────────────────────────────────────────
  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod = 365
  ): Promise<Record<string, number>> {
    const periodDays = period === 'all' ? 9999 : period;
    const [posA, posB] = half === 'du' ? ['p2', 'p3'] : half === 'ab' ? ['p1', 'p2'] : ['p3', 'p4'];

    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results ORDER BY draw_date ASC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const total = rows.length;
    const current_index = total % 60;

    const generalCount: Record<string, number> = {};
    const phaseCount:   Record<string, number> = {};
    let phaseTotal = 0;

    rows.forEach((row, idx) => {
      const d = row.digits as Record<string, number | undefined>;
      const a = d[posA!], b = d[posB!];
      if (a !== undefined && b !== undefined) {
        const key = `${a}${b}`;
        generalCount[key] = (generalCount[key] ?? 0) + 1;
        if (idx % 60 === current_index) {
          phaseCount[key] = (phaseCount[key] ?? 0) + 1;
          phaseTotal++;
        }
      }
    });

    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        const general_freq = total      > 0 ? (generalCount[key] ?? 0) / total      : 0;
        const phase_freq   = phaseTotal > 0 ? (phaseCount[key]   ?? 0) / phaseTotal : 0;
        // alignment > 1.0 means pair appears more often at this Pisano phase
        scores[key] = general_freq > 0 ? phase_freq / general_freq : 0;
      }
    }
    return scores;
  }
}
