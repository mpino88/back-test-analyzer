// ═══════════════════════════════════════════════════════════════
// HITDASH — TransitionFollow v1.0.0
// Clonación quirúrgica de ballbot/transition_follow
//
// Markov-1: P(sucesor | anterior) — matriz de transición sobre pares
// Para cada par de los últimos 5 sorteos: suma votos de top-6 sucesores
// → diferente a PairCorrelation que mide P(A∩B)/P(A)P(B)
//
// Fuente: hitdash.ingested_results
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import { DRAWS_CTE_ALL } from '../ballbotAdapter.js';
import type { AnalysisPeriod, PairHalf, TransitionFollowResult } from '../../types/analysis.types.js';

const logger = pino({ name: 'TransitionFollow' });

const TOP_SUCCESSORS  = 6;  // cuántos sucesores votan por cada predecesor
const LOOKBACK_DRAWS  = 5;  // cuántos sorteos recientes generan votos

function pairKey(a: number, b: number): string {
  return `${a}${b}`;
}

function extractPair(
  p1: number, p2: number, p3: number, p4: number, half: PairHalf
): string {
  if (half === 'ab') return pairKey(p1, p2);
  if (half === 'cd') return pairKey(p3, p4);
  return pairKey(p2, p3); // 'du'
}

export class TransitionFollow {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<TransitionFollowResult> {
    const start = Date.now();
    const scores = await this.runPairs(game_type, draw_type, 'du', period);

    // Build top transitions for summary
    const topTransitions: Array<{ from: string; to: string; count: number; probability: number }> = [];
    const sortedPairs = Object.entries(scores).sort((a, b) => b[1] - a[1]).slice(0, 10);

    return {
      algorithm_name:    'transition_follow',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type },
      output_data:  { matrix_size: 100, top_transitions: topTransitions },
      output_summary: `TransitionFollow top-3: ${sortedPairs.slice(0, 3).map(([p]) => p).join(', ')}`,
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
    }>(
      `${DRAWS_CTE_ALL}
       SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
              (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4
       FROM lottery_results
       ORDER BY draw_date ASC`,
      [game_type, draw_type]
    );

    const total = rows.length;
    if (total < 3) {
      const flat: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) flat[`${x}${y}`] = 0;
      return flat;
    }

    const allPairs = rows.map(r => extractPair(r.p1, r.p2, r.p3, r.p4, half));

    // ── Build Markov-1 transition matrix ───────────────────────────────────
    const matrix = new Map<string, Map<string, number>>();
    for (let i = 0; i + 1 < allPairs.length; i++) {
      const from = allPairs[i]!;
      const to   = allPairs[i + 1]!;
      if (!matrix.has(from)) matrix.set(from, new Map());
      const row = matrix.get(from)!;
      row.set(to, (row.get(to) ?? 0) + 1);
    }

    // ── Score: for each of the last LOOKBACK_DRAWS predecessors ───────────
    // top TOP_SUCCESSORS successors each cast weighted votes (weight = probability)
    const votes: Record<string, number> = {};
    const recentPredecessors = allPairs.slice(-LOOKBACK_DRAWS);

    for (let lag = 0; lag < recentPredecessors.length; lag++) {
      const from = recentPredecessors[lag]!;
      const row  = matrix.get(from);
      if (!row) continue;

      const rowTotal = Array.from(row.values()).reduce((s, v) => s + v, 0);
      const sorted   = Array.from(row.entries()).sort((a, b) => b[1] - a[1]);

      // Recency weight: most recent predecessor gets weight 1.0, oldest gets 0.4
      const recencyWeight = 1.0 - (0.6 * lag) / LOOKBACK_DRAWS;

      for (const [to, cnt] of sorted.slice(0, TOP_SUCCESSORS)) {
        const prob = cnt / rowTotal;
        votes[to] = (votes[to] ?? 0) + prob * recencyWeight;
      }
    }

    // Normalize votes to [0,1]
    const maxVote = Math.max(...Object.values(votes), 1e-9);
    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const p = `${x}${y}`;
        scores[p] = (votes[p] ?? 0) / maxVote;
      }
    }

    logger.debug({ game_type, draw_type, half, total_draws: total, elapsed_ms: Date.now() - start }, 'TransitionFollow.runPairs done');
    return scores;
  }
}
