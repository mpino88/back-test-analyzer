// ═══════════════════════════════════════════════════════════════
// HITDASH — MarkovOrder2 v1.0.0
// Clonación quirúrgica de ballbot/markov_order2
//
// Markov-2: estado compuesto (parAnterior_parActual) → siguiente par
// Para cada combo (prev, last) de los últimos 2 sorteos: top-5 sucesores → votos
//
// Fuente: hitdash.ingested_results
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import { DRAWS_CTE_ALL } from '../ballbotAdapter.js';
import type { AnalysisPeriod, PairHalf, MarkovOrder2Result } from '../../types/analysis.types.js';

const logger = pino({ name: 'MarkovOrder2' });

const TOP_SUCCESSORS = 5;

function extractPair(
  p1: number, p2: number, p3: number, p4: number, half: PairHalf
): string {
  if (half === 'ab') return `${p1}${p2}`;
  if (half === 'cd') return `${p3}${p4}`;
  return `${p2}${p3}`; // 'du'
}

export class MarkovOrder2 {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<MarkovOrder2Result> {
    const start  = Date.now();
    const scores = await this.runPairs(game_type, draw_type, 'du', period);
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

    return {
      algorithm_name:    'markov_order2',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type },
      output_data:  { state_count: 0, top_transitions: [] },
      output_summary: `MarkovOrder2 top-3: ${sorted.slice(0, 3).map(([p]) => p).join(', ')}`,
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
    if (total < 4) {
      const flat: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) flat[`${x}${y}`] = 0;
      return flat;
    }

    const allPairs = rows.map(r => extractPair(r.p1, r.p2, r.p3, r.p4, half));

    // ── Build Markov-2 transition table: state → Map<to, count> ──────────
    // State = "${pair[i-1]}_${pair[i]}" → pair[i+1]
    const table = new Map<string, Map<string, number>>();
    for (let i = 1; i + 1 < allPairs.length; i++) {
      const state = `${allPairs[i - 1]}_${allPairs[i]}`;
      const to    = allPairs[i + 1]!;
      if (!table.has(state)) table.set(state, new Map());
      const row = table.get(state)!;
      row.set(to, (row.get(to) ?? 0) + 1);
    }

    // ── Score: current state = last 2 pairs ───────────────────────────────
    const votes: Record<string, number> = {};

    // We also consider the last 3 states (order-2 windows ending at current)
    const states: string[] = [];
    if (allPairs.length >= 2) {
      states.push(`${allPairs[allPairs.length - 2]}_${allPairs[allPairs.length - 1]}`);
    }
    if (allPairs.length >= 3) {
      states.push(`${allPairs[allPairs.length - 3]}_${allPairs[allPairs.length - 2]}`);
    }

    for (let si = 0; si < states.length; si++) {
      const state = states[si]!;
      const row   = table.get(state);
      if (!row) continue;

      const rowTotal    = Array.from(row.values()).reduce((s, v) => s + v, 0);
      const sorted      = Array.from(row.entries()).sort((a, b) => b[1] - a[1]);
      const recencyW    = si === 0 ? 1.0 : 0.5; // current state weighs more

      for (const [to, cnt] of sorted.slice(0, TOP_SUCCESSORS)) {
        const prob = cnt / rowTotal;
        votes[to] = (votes[to] ?? 0) + prob * recencyW;
      }
    }

    // Normalize
    const maxVote = Math.max(...Object.values(votes), 1e-9);
    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const p = `${x}${y}`;
        scores[p] = (votes[p] ?? 0) / maxVote;
      }
    }

    logger.debug({ game_type, draw_type, half, total_draws: total, state_count: table.size, elapsed_ms: Date.now() - start }, 'MarkovOrder2.runPairs done');
    return scores;
  }
}
