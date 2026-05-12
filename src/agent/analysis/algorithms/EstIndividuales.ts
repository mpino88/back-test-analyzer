// ═══════════════════════════════════════════════════════════════
// HITDASH — EstIndividuales v1.0.0
// Port of Ballbot stats-p3 "est_individuales" + gap_due logic.
//
// Score = maxGapDays − currentGapDays (lower = hotter = closer to record)
// runPairs() returns dueFactor = currentGapDays / avgGapDays (Ballbot-style)
// Threshold: appearances ≥ 3, dueFactor ≥ 1.0
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../ballbotAdapter.js';
import type { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';

const logger = pino({ name: 'EstIndividuales' });

interface PairTrack {
  counter: number;       // current gap (days since last appearance)
  maxHistorical: number; // max gap ever seen between appearances
  everAppeared: boolean;
  appearances: number;
}

export class EstIndividuales {
  constructor(private readonly pool: Pool) {}

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod = 365
  ): Promise<Record<string, number>> {
    const periodDays = period === 'all' ? 9999 : period;
    const posMap: Record<PairHalf, [string, string]> = {
      du: ['p2', 'p3'],
      ab: ['p1', 'p2'],
      cd: ['p3', 'p4'],
    };
    const [posA, posB] = posMap[half] ?? ['p2', 'p3'];

    // Chronological order to compute day-gaps between consecutive draw dates
    const { rows } = await this.pool.query<{ draw_date: string | Date; digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT draw_date, digits FROM lottery_results ORDER BY draw_date ASC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    if (rows.length < 5) return {};

    const tracks: Record<string, PairTrack> = {};
    const getTrack = (k: string): PairTrack => {
      if (!tracks[k]) tracks[k] = { counter: 0, maxHistorical: 0, everAppeared: false, appearances: 0 };
      return tracks[k]!;
    };

    let prevDate: Date | null = null;

    for (const row of rows) {
      const currDate = new Date(row.draw_date);
      const daysSincePrev = prevDate
        ? Math.max(0, Math.floor((currDate.getTime() - prevDate.getTime()) / 86_400_000))
        : 0;

      const d = row.digits as Record<string, number | undefined>;
      const a = d[posA!], b = d[posB!];
      const todayPair = (a !== undefined && b !== undefined) ? `${a}${b}` : null;

      // Tick all 100 pairs
      for (let x = 0; x <= 9; x++) {
        for (let y = 0; y <= 9; y++) {
          const key = `${x}${y}`;
          const t = getTrack(key);
          const appeared = (key === todayPair);

          if (appeared) {
            if (t.counter > t.maxHistorical) t.maxHistorical = t.counter;
            t.counter = 0;
            t.everAppeared = true;
            t.appearances++;
          } else {
            t.counter += daysSincePrev;
          }
        }
      }

      prevDate = currDate;
    }

    // ─── Score each pair ─────────────────────────────────────────
    // dueFactor = currentGap / (maxHistorical / appearances) ≈ Ballbot avgGap
    // But we use maxHistorical deficit: smaller deficit → hotter
    // Normalize to 0-1: score = max(0, 1 - deficit/maxHistorical)
    const scores: Record<string, number> = {};
    for (const [key, t] of Object.entries(tracks)) {
      if (!t.everAppeared || t.appearances < 3) { scores[key] = 0; continue; }

      const currentGap = t.counter;
      const maxGap = t.maxHistorical;

      if (maxGap === 0) { scores[key] = 0; continue; }

      // deficit: days left before pair breaks its own record
      const deficit = Math.max(0, maxGap - currentGap);
      // score: close to 1 = very hot (almost at record), close to 0 = cold
      scores[key] = Math.min(1.0, currentGap / maxGap);
    }

    logger.debug({ game_type, draw_type, half, n: rows.length }, 'EstIndividuales scored');
    return scores;
  }
}
