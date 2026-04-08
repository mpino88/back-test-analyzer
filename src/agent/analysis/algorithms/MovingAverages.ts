// ═══════════════════════════════════════════════════════════════
// HITDASH — MovingAverages v1.0.0
// SMA-7, SMA-14, SMA-30 + EMA — peso 0.7
// Signal bullish: SMA-7 > SMA-14 (golden cross)
// crossover_detected: SMA-7 cruzó SMA-14 en últimas 3 sesiones
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../ballbotAdapter.js';
import type {
  MAResult,
  MAEntry,
  MASignal,
  AnalysisPeriod,
  Position,
  PairHalf,
} from '../../types/analysis.types.js';

const logger = pino({ name: 'MovingAverages' });

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

function sma(series: number[], period: number): number {
  if (series.length === 0) return 0;
  const window = series.slice(-period);
  return window.reduce((a, b) => a + b, 0) / window.length;
}

function ema(series: number[], period: number): number {
  if (series.length === 0) return 0;
  const alpha = 2 / (period + 1);
  let value = series[0]!;
  for (let i = 1; i < series.length; i++) {
    value = alpha * series[i]! + (1 - alpha) * value;
  }
  return value;
}

export class MovingAverages {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<MAResult> {
    const start = Date.now();
    // Need at least 30 draws for SMA-30; fetch 90d minimum
    const periodDays = Math.max(period === 'all' ? 9999 : period, 60);
    const positions = POSITIONS[game_type];

    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results ORDER BY draw_date ASC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const by_position: Record<Position, MAEntry[]> = {} as Record<Position, MAEntry[]>;
    const signals_bullish: Array<{ digit: number; position: Position }> = [];
    const signals_bearish: Array<{ digit: number; position: Position }> = [];

    for (const pos of positions) {
      const entries: MAEntry[] = [];

      for (let d = 0; d <= 9; d++) {
        // Binary series: 1 if digit appeared at position in that draw, 0 otherwise
        const series = rows.map(r => (r.digits as Record<string, number>)[pos] === d ? 1 : 0);

        const sma7  = +sma(series, 7).toFixed(4);
        const sma14 = +sma(series, 14).toFixed(4);
        const sma30 = +sma(series, 30).toFixed(4);
        const emaVal = +ema(series, 14).toFixed(4);

        let signal: MASignal = 'neutral';
        if (sma7 > sma14) signal = 'bullish';
        else if (sma7 < sma14) signal = 'bearish';

        // crossover detection: check if SMA-7 crossed SMA-14 in last 3 draws
        let crossover_detected = false;
        if (series.length >= 17) {
          const prev3Series = series.slice(0, -3);
          const prevSma7  = sma(prev3Series, 7);
          const prevSma14 = sma(prev3Series, 14);
          const crossedUp   = prevSma7 <= prevSma14 && sma7 > sma14;
          const crossedDown = prevSma7 >= prevSma14 && sma7 < sma14;
          crossover_detected = crossedUp || crossedDown;
        }

        const entry: MAEntry = {
          digit: d,
          position: pos,
          sma_7:  sma7,
          sma_14: sma14,
          sma_30: sma30,
          ema:    emaVal,
          signal,
          crossover_detected,
        };

        entries.push(entry);

        if (signal === 'bullish') signals_bullish.push({ digit: d, position: pos });
        else if (signal === 'bearish') signals_bearish.push({ digit: d, position: pos });
      }

      entries.sort((a, b) => b.sma_7 - a.sma_7);
      by_position[pos] = entries;
    }

    const bullishSummary = signals_bullish
      .slice(0, 6)
      .map(s => `${s.position}-${s.digit}`)
      .join(',');

    logger.info(
      { game_type, draw_type, bullish: signals_bullish.length, bearish: signals_bearish.length },
      'MovingAverages completado'
    );

    return {
      algorithm_name: 'moving_averages',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type, period_days: periodDays, sma_short: 7, sma_long: 14 },
      output_data: { by_position, signals_bullish, signals_bearish },
      output_summary: `MA ${game_type} ${draw_type}: bullish=[${bullishSummary}] total_bull=${signals_bullish.length}`.slice(0, 500),
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
    const periodDays = Math.max(period === 'all' ? 9999 : period, 60);
    const [posA, posB] = half === 'du' ? ['p2', 'p3'] : half === 'ab' ? ['p1', 'p2'] : ['p3', 'p4'];

    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results ORDER BY draw_date ASC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const scores: Record<string, number> = {};
    const alpha = 2 / 15; // EMA-14 smoothing factor

    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        const series = rows.map(r => {
          const d = r.digits as Record<string, number | undefined>;
          return d[posA!] === x && d[posB!] === y ? 1 : 0;
        });

        const sma7  = series.length >= 7  ? (series.slice(-7)  as number[]).reduce((a, b) => a + b, 0) / 7  : 0;
        const sma14 = series.length >= 14 ? (series.slice(-14) as number[]).reduce((a, b) => a + b, 0) / 14 : 0;

        // EMA-14 across full series
        let emaVal = series[0] ?? 0;
        for (let i = 1; i < series.length; i++) {
          emaVal = alpha * series[i]! + (1 - alpha) * emaVal;
        }

        // Bullish crossover (sma7 > sma14) + EMA momentum — clamped ≥ 0
        scores[key] = Math.max(0, (sma7 - sma14) + emaVal);
      }
    }
    return scores;
  }
}
