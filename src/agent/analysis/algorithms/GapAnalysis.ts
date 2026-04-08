// ═══════════════════════════════════════════════════════════════
// HITDASH — GapAnalysis v1.0.0
// Overdue score: gap_actual / gap_promedio — peso 0.9
// Señal: dígitos con overdue_score > 1.5 (muy atrasados)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../ballbotAdapter.js';
import type {
  GapResult,
  GapEntry,
  AnalysisPeriod,
  Position,
  PairHalf,
} from '../../types/analysis.types.js';

const logger = pino({ name: 'GapAnalysis' });

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

interface DrawRow {
  draw_date: Date;
  digits: LotteryDigits;
}

export class GapAnalysis {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<GapResult> {
    const start = Date.now();
    const periodDays = period === 'all' ? 9999 : period;
    const positions = POSITIONS[game_type];
    const today = new Date();

    const { rows } = await this.pool.query<DrawRow>(
      `${DRAWS_CTE}
       SELECT draw_date, digits FROM lottery_results ORDER BY draw_date DESC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const by_position: Record<Position, GapEntry[]> = {} as Record<Position, GapEntry[]>;

    for (const pos of positions) {
      const entries: GapEntry[] = [];

      for (let d = 0; d <= 9; d++) {
        // Collect all draw dates where this digit appeared at this position
        const appearances: Date[] = rows
          .filter(r => (r.digits as Record<string, number>)[pos] === d)
          .map(r => new Date(r.draw_date));

        // gap_actual = days since last appearance (from today)
        let gap_actual = periodDays; // default: never appeared = max period
        if (appearances.length > 0) {
          const lastSeen = appearances[0]!; // already sorted DESC
          gap_actual = Math.floor((today.getTime() - lastSeen.getTime()) / 86_400_000);
        }

        // gap_promedio = average gap between consecutive appearances
        // = period_days / appearances_count (simplified Poisson estimate)
        const gap_promedio = appearances.length > 0
          ? periodDays / appearances.length
          : periodDays;

        const overdue_score = gap_promedio > 0
          ? +(gap_actual / gap_promedio).toFixed(3)
          : 0;

        entries.push({
          digit: d,
          position: pos,
          gap_actual,
          gap_promedio: +gap_promedio.toFixed(1),
          overdue_score,
          is_overdue: overdue_score > 1.5,
          is_recent: overdue_score < 0.5,
        });
      }

      // Sort by overdue_score DESC (most overdue first)
      entries.sort((a, b) => b.overdue_score - a.overdue_score);
      by_position[pos] = entries;
    }

    const overdueDigits = positions
      .map(p => {
        const top = by_position[p]!.filter(e => e.is_overdue).map(e => e.digit).join(',');
        return top ? `${p.toUpperCase()}:[${top}]` : null;
      })
      .filter(Boolean)
      .join(' ');

    logger.info({ game_type, draw_type, period }, 'GapAnalysis completado');

    return {
      algorithm_name: 'gap_analysis',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type, period_days: periodDays },
      output_data: { by_position },
      output_summary: `Gap ${game_type} ${draw_type} (${periodDays}d): Overdue: ${overdueDigits || 'none'}`.slice(0, 500),
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

    // Ordered DESC: index 0 = most recent draw
    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results ORDER BY draw_date DESC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const total = rows.length;
    const lastSeen: Record<string, number> = {};
    const occurrences: Record<string, number> = {};

    rows.forEach((row, idx) => {
      const d = row.digits as Record<string, number | undefined>;
      const a = d[posA!], b = d[posB!];
      if (a !== undefined && b !== undefined) {
        const key = `${a}${b}`;
        if (!(key in lastSeen)) lastSeen[key] = idx; // draws since last seen (0 = appeared in latest draw)
        occurrences[key] = (occurrences[key] ?? 0) + 1;
      }
    });

    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        const gap_actual = lastSeen[key] ?? total;
        const count = occurrences[key] ?? 0;
        const avg_gap = count > 0 ? total / count : total;
        // overdue_score > 1.0 means pair is overdue → higher priority (gap reversal)
        scores[key] = avg_gap > 0 ? gap_actual / avg_gap : 0;
      }
    }
    return scores;
  }
}
