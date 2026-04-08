// ═══════════════════════════════════════════════════════════════
// HITDASH — StreakDetection v1.0.0
// Rachas de ausencia/presencia anomalas — peso 0.65
// alert: current_length > mean + 2*std → posible reversión
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../ballbotAdapter.js';
import type {
  StreakResult,
  StreakEntry,
  StreakType,
  AnalysisPeriod,
  Position,
  PairHalf,
} from '../../types/analysis.types.js';

const logger = pino({ name: 'StreakDetection' });

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

interface StreakStats {
  streaks: number[];      // historical streak lengths
  mean: number;
  std_dev: number;
}

function computeStreakStats(series: boolean[]): { presence: StreakStats; absence: StreakStats } {
  const presenceStreaks: number[] = [];
  const absenceStreaks: number[] = [];

  let currentType: boolean | null = null;
  let currentLen = 0;

  for (const val of series) {
    if (currentType === null) {
      currentType = val;
      currentLen = 1;
    } else if (val === currentType) {
      currentLen++;
    } else {
      if (currentType) presenceStreaks.push(currentLen);
      else absenceStreaks.push(currentLen);
      currentType = val;
      currentLen = 1;
    }
  }
  // Last streak (open)
  if (currentLen > 0 && currentType !== null) {
    if (currentType) presenceStreaks.push(currentLen);
    else absenceStreaks.push(currentLen);
  }

  function stats(arr: number[]): StreakStats {
    if (arr.length === 0) return { streaks: [], mean: 1, std_dev: 0 };
    const mean = arr.reduce((a, b) => a + b, 0) / arr.length;
    const variance = arr.reduce((a, b) => a + (b - mean) ** 2, 0) / arr.length;
    return { streaks: arr, mean: +mean.toFixed(2), std_dev: +Math.sqrt(variance).toFixed(2) };
  }

  return { presence: stats(presenceStreaks), absence: stats(absenceStreaks) };
}

export class StreakDetection {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<StreakResult> {
    const start = Date.now();
    const periodDays = period === 'all' ? 9999 : period;
    const positions = POSITIONS[game_type];

    // Ordered ASC for chronological series
    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results ORDER BY draw_date ASC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const active_streaks: StreakEntry[] = [];
    const anomalies: StreakEntry[] = [];

    for (const pos of positions) {
      for (let d = 0; d <= 9; d++) {
        // Binary series: true = digit appeared at position
        const series = rows.map(r => (r.digits as Record<string, number>)[pos] === d);

        const { presence, absence } = computeStreakStats(series);

        // Current streak = tail of series
        let streak_type: StreakType = 'presence';
        let current_length = 0;

        if (series.length > 0) {
          const lastVal = series[series.length - 1]!;
          streak_type = lastVal ? 'presence' : 'absence';
          current_length = 1;
          for (let i = series.length - 2; i >= 0; i--) {
            if (series[i] === lastVal) current_length++;
            else break;
          }
        }

        const stats = streak_type === 'presence' ? presence : absence;
        const threshold = stats.mean + 2 * stats.std_dev;

        const alert_level: StreakEntry['alert_level'] =
          current_length > threshold && threshold > 0 ? 'alert'
          : current_length > stats.mean + stats.std_dev ? 'watch'
          : 'none';

        const entry: StreakEntry = {
          digit: d,
          position: pos,
          streak_type,
          current_length,
          mean_length: stats.mean,
          std_dev_length: stats.std_dev,
          alert_level,
          is_anomaly: alert_level === 'alert',
        };

        if (alert_level !== 'none') active_streaks.push(entry);
        if (alert_level === 'alert') anomalies.push(entry);
      }
    }

    active_streaks.sort((a, b) => b.current_length - a.current_length);

    const anomalySummary = anomalies.length > 0
      ? anomalies
          .slice(0, 5)
          .map(e => `${e.position}-${e.digit}(${e.streak_type}:${e.current_length})`)
          .join(' ')
      : 'no anomalies';

    logger.info(
      { game_type, draw_type, anomalies: anomalies.length, watching: active_streaks.length },
      'StreakDetection completado'
    );

    return {
      algorithm_name: 'streak',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type, period_days: periodDays, std_multiplier: 2.0 },
      output_data: { active_streaks, anomalies },
      output_summary: `Streaks ${game_type} ${draw_type} (${periodDays}d): alerts=${anomalies.length} ${anomalySummary}`.slice(0, 500),
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
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results ORDER BY draw_date ASC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        const series = rows.map(r => {
          const d = r.digits as Record<string, number | undefined>;
          return d[posA!] === x && d[posB!] === y;
        });

        // Collect historical absence streak lengths
        const absenceStreaks: number[] = [];
        let runLen = 0;
        let inAbsence = false;
        for (const val of series) {
          if (!val) {
            runLen++;
            inAbsence = true;
          } else {
            if (inAbsence && runLen > 0) absenceStreaks.push(runLen);
            runLen = 0;
            inAbsence = false;
          }
        }

        // Current absence streak from the tail
        let currentAbsence = 0;
        for (let i = series.length - 1; i >= 0; i--) {
          if (!series[i]) currentAbsence++;
          else break;
        }

        const mean = absenceStreaks.length > 0
          ? absenceStreaks.reduce((a, b) => a + b, 0) / absenceStreaks.length
          : rows.length;
        const variance = absenceStreaks.length > 1
          ? absenceStreaks.reduce((a, b) => a + (b - mean) ** 2, 0) / absenceStreaks.length
          : 0;
        const std = Math.sqrt(variance);
        const threshold = mean + 2 * std;

        // Score = ratio of current absence to reversal threshold (>1 = anomaly, reversal likely)
        scores[key] = threshold > 0 ? Math.max(0, currentAbsence / threshold) : 0;
      }
    }
    return scores;
  }
}
