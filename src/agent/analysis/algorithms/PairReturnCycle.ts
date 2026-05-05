// ═══════════════════════════════════════════════════════════════
// HITDASH — PairReturnCycle v1.0.0
//
// Concept: each pair has a "return cycle" — the average number of
// draws between consecutive appearances. A pair absent longer than
// its historical mean cycle is scored higher via a sigmoid on the
// z-score of its current absence vs. the pair-specific distribution.
//
// Score semantics:
//   sigmoid(z) → 0.5 = on schedule, >0.5 = overdue, <0.5 = recent
//   Pairs with < 3 appearances → GapAnalysis-style overdue_score / 3.0
//   Pairs never appeared → 0.75 (overdue, no cycle data)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import { DRAWS_CTE_ALL } from '../ballbotAdapter.js';
import type { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';

const logger = pino({ name: 'PairReturnCycle' });

const ALGORITHM_NAME = 'pair_return_cycle';

/** Standard sigmoid function. */
function sigmoid(x: number): number {
  return 1 / (1 + Math.exp(-x));
}

/** Arithmetic mean of an array. Returns 0 for empty arrays. */
function mean(values: number[]): number {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

/** Population standard deviation of an array. Returns 0 for arrays with < 2 elements. */
function stdDev(values: number[], avg: number): number {
  if (values.length < 2) return 0;
  const variance =
    values.reduce((sum, v) => sum + (v - avg) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

export class PairReturnCycle {
  constructor(private readonly pool: Pool) {}

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const start = Date.now();

    // ── 1. Fetch all draws ordered chronologically (ASC) ──────────────────
    let allRows: Array<{ p1: number; p2: number; p3: number; p4: number }>;

    try {
      const { rows } = await this.pool.query<{
        p1: number;
        p2: number;
        p3: number;
        p4: number;
      }>(
        `${DRAWS_CTE_ALL}
         SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
                (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4
         FROM lottery_results
         ORDER BY draw_date ASC`,
        [game_type, draw_type]
      );
      allRows = rows;
    } catch (err) {
      logger.error({ err, game_type, draw_type, half }, `${ALGORITHM_NAME} DB error — returning flat scores`);
      const flat: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) {
        for (let y = 0; y <= 9; y++) flat[`${x}${y}`] = 0.01;
      }
      return flat;
    }

    const totalDraws = allRows.length;

    // ── 2. Determine position columns based on half ────────────────────────
    const [posA, posB] =
      half === 'ab' ? ['p1', 'p2'] : half === 'cd' ? ['p3', 'p4'] : ['p2', 'p3'];

    // ── 3. Build appearance-index lists for every pair ────────────────────
    // appearanceIndices[key] = sorted list of draw indices (0 = oldest)
    const appearanceIndices: Record<string, number[]> = {};

    for (let i = 0; i < totalDraws; i++) {
      const row = allRows[i]!;
      const a = (row as Record<string, number>)[posA!];
      const b = (row as Record<string, number>)[posB!];
      if (a !== undefined && b !== undefined) {
        const key = `${a}${b}`;
        if (!appearanceIndices[key]) appearanceIndices[key] = [];
        appearanceIndices[key]!.push(i);
      }
    }

    // ── 4. Compute scores for all 100 pairs ───────────────────────────────
    const scores: Record<string, number> = {};

    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        const indices = appearanceIndices[key];

        // Case A: pair never appeared
        if (!indices || indices.length === 0) {
          scores[key] = 0.75;
          continue;
        }

        const lastAppearanceIndex = indices[indices.length - 1]!;
        const drawsSinceLast = totalDraws - 1 - lastAppearanceIndex;

        // Case B: fewer than 3 appearances — use GapAnalysis-style score
        if (indices.length < 3) {
          // avg_gap = total / count (simplified Poisson)
          const avgGap = totalDraws / indices.length;
          const overdueScore = avgGap > 0 ? drawsSinceLast / avgGap : 0;
          scores[key] = Math.min(1, Math.max(0, overdueScore / 3.0));
          continue;
        }

        // Case C: ≥ 3 appearances — full cycle statistics
        // 4a. Build gap list between consecutive appearances
        const gaps: number[] = [];
        for (let i = 1; i < indices.length; i++) {
          gaps.push(indices[i]! - indices[i - 1]!);
        }

        // 4b. Compute mean & std of gaps
        const meanCycle = mean(gaps);
        const stdCycle = stdDev(gaps, meanCycle);

        // 4c. z-score of current absence vs. historical cycle
        const z = (drawsSinceLast - meanCycle) / Math.max(stdCycle, 1.0);

        // 4d. Sigmoid maps z → (0,1):  0.5=on schedule, >0.5=overdue
        scores[key] = sigmoid(z);
      }
    }

    const elapsed_ms = Date.now() - start;
    logger.debug(
      {
        game_type,
        draw_type,
        half,
        total_draws: totalDraws,
        elapsed_ms,
        algorithm: ALGORITHM_NAME,
      },
      `${ALGORITHM_NAME} runPairs done`
    );

    return scores;
  }
}
