// ═══════════════════════════════════════════════════════════════
// HITDASH — DecadeFamily v1.0.0
// Clonación quirúrgica de ballbot/decade_family
//
// Grupos de décadas: D0(00-09), D1(10-19), …, D9(90-99)
// Calcula momentum de cada familia (freqRecent30 / freqTotal)
// Selecciona top familias con momentum ≥ 1.0
// score_par = family_momentum × member_freq_within_family
//
// Fuente: hitdash.ingested_results
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import { DRAWS_CTE_ALL } from '../ballbotAdapter.js';
import type { AnalysisPeriod, PairHalf, DecadeFamilyResult } from '../../types/analysis.types.js';

const logger = pino({ name: 'DecadeFamily' });

const TOP_FAMILIES  = 4;
const RECENT_WINDOW = 30; // días para el cálculo de momentum

function extractPair(
  p1: number, p2: number, p3: number, p4: number, half: PairHalf
): string {
  if (half === 'ab') return `${p1}${p2}`;
  if (half === 'cd') return `${p3}${p4}`;
  return `${p2}${p3}`; // 'du'
}

export class DecadeFamily {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<DecadeFamilyResult> {
    const start  = Date.now();
    const scores = await this.runPairs(game_type, draw_type, 'du', period);
    const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);

    return {
      algorithm_name:    'decade_family',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type },
      output_data:  {
        families: [],
        top_pairs: sorted.slice(0, 10).map(([pair, score]) => ({ pair, score, family: parseInt(pair[0]!) })),
      },
      output_summary: `DecadeFamily top-3: ${sorted.slice(0, 3).map(([p]) => p).join(', ')}`,
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

    const { rows: allRows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number;
    }>(
      `${DRAWS_CTE_ALL}
       SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
              (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4
       FROM lottery_results
       ORDER BY draw_date ASC`,
      [game_type, draw_type]
    );

    const { rows: recentRows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number;
    }>(
      `${DRAWS_CTE_ALL}
       SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
              (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4
       FROM lottery_results
       WHERE draw_date >= CURRENT_DATE - '${RECENT_WINDOW} days'::interval`,
      [game_type, draw_type]
    );

    const total = allRows.length;
    if (total < 5) {
      const flat: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) flat[`${x}${y}`] = 0;
      return flat;
    }

    const allPairs    = allRows.map(r => extractPair(r.p1, r.p2, r.p3, r.p4, half));
    const recentPairs = recentRows.map(r => extractPair(r.p1, r.p2, r.p3, r.p4, half));
    const recentTotal = recentPairs.length || 1;

    // ── Count by decade family ──────────────────────────────────────────
    // familyOf("37") = 3 (the tens digit)
    const famTotal:  number[] = new Array(10).fill(0) as number[];
    const famRecent: number[] = new Array(10).fill(0) as number[];

    // Also count per-pair within family for member frequency
    const pairTotal:  Record<string, number> = {};
    const pairRecent: Record<string, number> = {};

    for (const p of allPairs) {
      const fam = parseInt(p[0]!);
      famTotal[fam]++;
      pairTotal[p] = (pairTotal[p] ?? 0) + 1;
    }
    for (const p of recentPairs) {
      const fam = parseInt(p[0]!);
      famRecent[fam]++;
      pairRecent[p] = (pairRecent[p] ?? 0) + 1;
    }

    // ── Compute momentum per family ────────────────────────────────────
    const globalFamRate = famTotal.map(cnt => cnt / total);
    const recentFamRate = famRecent.map(cnt => cnt / recentTotal);
    const momentum = globalFamRate.map((g, i) =>
      g > 0 ? (recentFamRate[i]! / g) : 0
    );

    // Select top families with momentum ≥ 1.0 (or just top TOP_FAMILIES if none)
    const hotFamilies = momentum
      .map((m, i) => ({ fam: i, momentum: m }))
      .filter(f => f.momentum >= 1.0)
      .sort((a, b) => b.momentum - a.momentum)
      .slice(0, TOP_FAMILIES)
      .map(f => f.fam);

    const activeFamilies = hotFamilies.length > 0
      ? hotFamilies
      : momentum.map((m, i) => ({ m, i })).sort((a, b) => b.m - a.m).slice(0, TOP_FAMILIES).map(o => o.i);

    // ── Score per pair = family_momentum × member_freq_within_family ──
    const raw: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const p   = `${x}${y}`;
        const fam = x;
        if (!activeFamilies.includes(fam)) { raw[p] = 0; continue; }

        const famMom   = momentum[fam] ?? 0;
        const famCnt   = famTotal[fam] ?? 1;
        const pairCnt  = pairTotal[p] ?? 0;
        const memberFreq = famCnt > 0 ? pairCnt / famCnt : 0;

        raw[p] = famMom * memberFreq;
      }
    }

    // Normalize to [0,1]
    const maxRaw = Math.max(...Object.values(raw), 1e-9);
    const scores: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw)) scores[k] = v / maxRaw;

    logger.debug({ game_type, draw_type, half, total_draws: total, active_families: activeFamilies, elapsed_ms: Date.now() - start }, 'DecadeFamily.runPairs done');
    return scores;
  }
}
