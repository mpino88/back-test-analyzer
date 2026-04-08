// ═══════════════════════════════════════════════════════════════
// HITDASH — PositionAnalysis v1.0.0
// Chi-square test de sesgo por posición — peso 0.8
// Dígitos discretos (0-9) → chi-square EXCLUSIVAMENTE (no KS)
// bias_detected = p_value < 0.05
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../ballbotAdapter.js';
import type {
  PositionResult,
  PositionBias,
  AnalysisPeriod,
  Position,
  PairHalf,
} from '../../types/analysis.types.js';

const logger = pino({ name: 'PositionAnalysis' });

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

// ─── Incomplete gamma via series expansion ──────────────────────
// Regularized lower incomplete gamma P(a, x)
function gammaLn(x: number): number {
  const p = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let sum = 0.99999999999980993;
  for (let i = 0; i < p.length; i++) sum += p[i]! / (x + i + 1);
  const t = x + p.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

function regularizedGammaLower(a: number, x: number): number {
  if (x <= 0) return 0;
  // Series expansion: converges for x < a + 1
  let term = 1.0 / a;
  let sum = term;
  for (let n = 1; n <= 300; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < 1e-12 * Math.abs(sum)) break;
  }
  return Math.exp(-x + a * Math.log(x) - gammaLn(a)) * sum;
}

// p-value = 1 - P(df/2, chi2/2) for chi-square distribution
function chiSquarePValue(chi2: number, df: number): number {
  if (chi2 <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - regularizedGammaLower(df / 2, chi2 / 2)));
}

export class PositionAnalysis {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 365
  ): Promise<PositionResult> {
    const start = Date.now();
    const periodDays = period === 'all' ? 9999 : period;
    const positions = POSITIONS[game_type];

    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const total_draws = rows.length;
    const heatmap: Record<Position, Record<number, number>> = {} as Record<Position, Record<number, number>>;
    const position_bias: PositionBias[] = [];

    for (const pos of positions) {
      const counts: number[] = new Array(10).fill(0) as number[];

      for (const row of rows) {
        const val = (row.digits as Record<string, number>)[pos];
        if (val !== undefined) counts[val]! += 1;
      }

      // Heatmap: relative frequencies
      const freqMap: Record<number, number> = {};
      for (let d = 0; d <= 9; d++) {
        freqMap[d] = total_draws > 0 ? +(counts[d]! / total_draws).toFixed(4) : 0;
      }
      heatmap[pos] = freqMap;

      // Chi-square vs uniform distribution (expected = total_draws / 10)
      const expected = total_draws / 10;
      const df = 9; // 10 digits - 1

      let chi2 = 0;
      if (expected > 0) {
        for (let d = 0; d <= 9; d++) {
          const diff = counts[d]! - expected;
          chi2 += (diff * diff) / expected;
        }
      }

      const p_value = +chiSquarePValue(chi2, df).toFixed(4);

      // Top digit at this position
      let topDigit = 0;
      let topCount = 0;
      for (let d = 0; d <= 9; d++) {
        if (counts[d]! > topCount) { topCount = counts[d]!; topDigit = d; }
      }

      position_bias.push({
        position: pos,
        chi_square: +chi2.toFixed(4),
        p_value,
        degrees_of_freedom: df,
        bias_detected: p_value < 0.05,
        top_digit: topDigit,
        top_digit_freq: total_draws > 0 ? +(topCount / total_draws).toFixed(4) : 0,
      });
    }

    const biasedPositions = position_bias
      .filter(b => b.bias_detected)
      .map(b => `${b.position}(p=${b.p_value},top=${b.top_digit})`)
      .join(' ');

    logger.info({ game_type, draw_type, total_draws, biased: position_bias.filter(b => b.bias_detected).length }, 'PositionAnalysis completado');

    return {
      algorithm_name: 'position',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type, period_days: periodDays, p_value_threshold: 0.05 },
      output_data: { heatmap, position_bias },
      output_summary: `Position ${game_type} ${draw_type} (${periodDays}d n=${total_draws}): bias_detected=${biasedPositions || 'none'}`.slice(0, 500),
      execution_ms: Date.now() - start,
    };
  }

  // ─── Pair mode (v2) ─────────────────────────────────────────────
  // Score = empirical joint frequency f(XY). Deviation from 0.01 uniform baseline
  // captures position bias: pairs whose positions systematically favor certain digits.
  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod = 365
  ): Promise<Record<string, number>> {
    const periodDays = period === 'all' ? 9999 : period;
    const [posA, posB] = half === 'du' ? ['p2', 'p3'] : half === 'ab' ? ['p1', 'p2'] : ['p3', 'p4'];

    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE} SELECT digits FROM lottery_results`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const total = rows.length;
    const pairCounts: Record<string, number> = {};

    for (const row of rows) {
      const d = row.digits as Record<string, number | undefined>;
      const a = d[posA!], b = d[posB!];
      if (a !== undefined && b !== undefined) {
        const key = `${a}${b}`;
        pairCounts[key] = (pairCounts[key] ?? 0) + 1;
      }
    }

    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        scores[key] = total > 0 ? (pairCounts[key] ?? 0) / total : 0;
      }
    }
    return scores;
  }
}
