// ═══════════════════════════════════════════════════════════════
// HITDASH — MaxPerWeekDay v1.0.0
// Clonación quirúrgica de ballbot/max_per_week_day
//
// Top-N por día-de-semana: frecuencia histórica de cada par
// para el día de semana del próximo sorteo estimado.
// target_dow = DayOfWeek(MAX(draw_date) + 1 día)
//
// Fuente: hitdash.ingested_results
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import { DRAWS_CTE_ALL } from '../ballbotAdapter.js';
import type { AnalysisPeriod, PairHalf, MaxPerWeekDayResult } from '../../types/analysis.types.js';

const logger = pino({ name: 'MaxPerWeekDay' });

function extractPair(
  p1: number, p2: number, p3: number, p4: number, half: PairHalf
): string {
  if (half === 'ab') return `${p1}${p2}`;
  if (half === 'cd') return `${p3}${p4}`;
  return `${p2}${p3}`; // 'du'
}

export class MaxPerWeekDay {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<MaxPerWeekDayResult> {
    const start  = Date.now();
    const scores = await this.runPairs(game_type, draw_type, 'du', period);
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

    return {
      algorithm_name:    'max_per_week_day',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type },
      output_data:  {
        target_dow: 0,
        top_pairs:  sorted.slice(0, 15).map(([pair, freq]) => ({ pair, count: 0, freq })),
      },
      output_summary: `MaxPerWeekDay top-3: ${sorted.slice(0, 3).map(([p]) => p).join(', ')}`,
      execution_ms: Date.now() - start,
    };
  }

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    _period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const start = Date.now();

    const { rows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number;
      draw_date: string;
    }>(
      `${DRAWS_CTE_ALL}
       SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
              (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4,
              draw_date::text
       FROM lottery_results
       ORDER BY draw_date ASC`,
      [game_type, draw_type]
    );

    const total = rows.length;
    if (total < 5) {
      const flat: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) flat[`${x}${y}`] = 0;
      return flat;
    }

    // Estimate next draw date = last date + 1 day
    const lastDateStr = rows[rows.length - 1]!.draw_date.substring(0, 10);
    const nextDate    = new Date(lastDateStr);
    nextDate.setDate(nextDate.getDate() + 1);
    const targetDow   = nextDate.getDay(); // 0=Sun…6=Sat

    // ── Count pair appearances by DoW ─────────────────────────────────
    // dowCounts[dow][pair] = count
    const dowCounts: Array<Record<string, number>> = Array.from({ length: 7 }, () => ({}));
    const dowTotals: number[] = new Array(7).fill(0) as number[];

    for (const r of rows) {
      const d    = new Date(r.draw_date.substring(0, 10));
      const dow  = d.getDay();
      const pair = extractPair(r.p1, r.p2, r.p3, r.p4, half);
      dowCounts[dow]![pair] = (dowCounts[dow]![pair] ?? 0) + 1;
      dowTotals[dow]!++;
    }

    // ── Scores for target DoW ──────────────────────────────────────────
    const bucket     = dowCounts[targetDow] ?? {};
    const bucketTotal = dowTotals[targetDow] ?? 1;

    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const p = `${x}${y}`;
        scores[p] = (bucket[p] ?? 0) / bucketTotal;
      }
    }

    // Normalize to [0,1]
    const maxScore = Math.max(...Object.values(scores), 1e-9);
    for (const k of Object.keys(scores)) scores[k] = scores[k]! / maxScore;

    logger.debug({ game_type, draw_type, half, target_dow: targetDow, total_draws: total, elapsed_ms: Date.now() - start }, 'MaxPerWeekDay.runPairs done');
    return scores;
  }
}
