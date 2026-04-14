// ═══════════════════════════════════════════════════════════════
// HITDASH — BayesianScore v1.0.0
// Clonación quirúrgica de ballbot/bayesian_score
//
// 6 señales ponderadas → score 0-100 por par ordenado "XY"
//   S1 Freq      W=0.15  frecuencia histórica normalizada
//   S2 Gap       W=0.20  due-factor = gapActual / gapPromedio
//   S3 Momentum  W=0.20  freqRecent30 / freqTotal clamped ≤5
//   S4 Cycle     W=0.15  concentración en gaps regulares (binario)
//   S5 Markov    W=0.20  max P(par|anterior) de la matriz de transición
//   S6 ColdStreak W=0.10 currentColdStreak / avgColdStreak clamped ≤4
//
// Fuente: hitdash.ingested_results (local DB — sin dependencia de ballbot)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import { DRAWS_CTE_ALL } from '../ballbotAdapter.js';
import type { AnalysisPeriod, PairHalf, BayesianScoreResult } from '../../types/analysis.types.js';

const logger = pino({ name: 'BayesianScore' });

const W_FREQ    = 0.15;
const W_GAP     = 0.20;
const W_MOM     = 0.20;
const W_CYCLE   = 0.15;
const W_MARKOV  = 0.20;
const W_STREAK  = 0.10;

function pairKey(a: number, b: number): string {
  return `${a}${b}`;
}

function extractPairDigits(p1: number, p2: number, p3: number, p4: number, half: PairHalf): [number, number] {
  if (half === 'ab') return [p1, p2];
  if (half === 'cd') return [p3, p4];
  return [p2, p3]; // 'du'
}

export class BayesianScore {
  constructor(private readonly pool: Pool) {}

  async run(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<BayesianScoreResult> {
    const start = Date.now();
    const result = await this.runPairs(game_type, draw_type, 'du', period);

    const vectors = Object.entries(result).map(([pair, score]) => ({
      pair,
      score: score * 100,
      freq:  0, gap: 0, momentum: 0, cycle: 0, markov: 0, cold_streak: 0,
    }));
    vectors.sort((a, b) => b.score - a.score);

    return {
      algorithm_name:    'bayesian_score',
      algorithm_version: '1.0.0',
      game_type,
      period,
      input_params: { game_type, draw_type },
      output_data:  { vectors },
      output_summary: `BayesianScore top-3: ${vectors.slice(0, 3).map(v => v.pair).join(', ')}`,
      execution_ms: Date.now() - start,
    };
  }

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const start = Date.now();
    const periodDays = period === 'all' ? 9999 : (period as number);

    // ── Fetch full ordered history (all time) and recent 30d ────────────────
    const { rows: allRows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number; draw_date: string;
    }>(
      `${DRAWS_CTE_ALL}
       SELECT (digits->>'p1')::int AS p1, (digits->>'p2')::int AS p2,
              (digits->>'p3')::int AS p3, (digits->>'p4')::int AS p4,
              draw_date::text
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
       WHERE draw_date >= CURRENT_DATE - ($3 || ' days')::interval`,
      [game_type, draw_type, Math.min(periodDays, 30)]
    );

    const total = allRows.length;
    if (total < 5) {
      // Not enough data — return flat scores
      const flat: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) flat[`${x}${y}`] = 0.01;
      return flat;
    }

    // Extract pairs from each row
    const allPairs   = allRows.map(r => pairKey(...extractPairDigits(r.p1, r.p2, r.p3, r.p4, half)));
    const recentPairs = recentRows.map(r => pairKey(...extractPairDigits(r.p1, r.p2, r.p3, r.p4, half)));

    // ── S1: Frequency ──────────────────────────────────────────────────────
    const freqCount: Record<string, number> = {};
    for (const p of allPairs) freqCount[p] = (freqCount[p] ?? 0) + 1;
    const maxFreq = Math.max(...Object.values(freqCount), 1);

    // ── S2: Gap (draws since last appearance) ──────────────────────────────
    const lastSeen: Record<string, number> = {};
    for (let i = 0; i < allPairs.length; i++) lastSeen[allPairs[i]!] = i;
    const currentGap: Record<string, number> = {};
    const gapTotal:   Record<string, number> = {};
    const gapCount:   Record<string, number> = {};
    let prev: Record<string, number> = {};
    for (let i = 0; i < allPairs.length; i++) {
      const p = allPairs[i]!;
      if (prev[p] !== undefined) {
        const g = i - prev[p];
        gapTotal[p] = (gapTotal[p] ?? 0) + g;
        gapCount[p] = (gapCount[p] ?? 0) + 1;
      }
      prev[p] = i;
    }
    for (const p of Object.keys(lastSeen)) {
      currentGap[p] = total - 1 - lastSeen[p]!;
    }

    // ── S3: Momentum (recent vs global) ────────────────────────────────────
    const recentCount: Record<string, number> = {};
    for (const p of recentPairs) recentCount[p] = (recentCount[p] ?? 0) + 1;
    const recentTotal = recentPairs.length || 1;

    // ── S5: Markov transition matrix ───────────────────────────────────────
    const transMatrix = new Map<string, Map<string, number>>();
    for (let i = 0; i + 1 < allPairs.length; i++) {
      const from = allPairs[i]!;
      const to   = allPairs[i + 1]!;
      if (!transMatrix.has(from)) transMatrix.set(from, new Map());
      const row = transMatrix.get(from)!;
      row.set(to, (row.get(to) ?? 0) + 1);
    }

    // For each pair: max P(pair | any predecessor that appeared in last 5 draws)
    const lastFivePairs = allPairs.slice(-5);
    const markovScore: Record<string, number> = {};
    for (const prev5 of lastFivePairs) {
      const row = transMatrix.get(prev5);
      if (!row) continue;
      const rowTotal = Array.from(row.values()).reduce((s, v) => s + v, 0);
      for (const [to, cnt] of row.entries()) {
        const prob = cnt / rowTotal;
        markovScore[to] = Math.max(markovScore[to] ?? 0, prob);
      }
    }
    const maxMarkov = Math.max(...Object.values(markovScore), 1e-9);

    // ── S6: Cold streak ────────────────────────────────────────────────────
    const streakLength: Record<string, number> = {};
    const currentStreak: Record<string, number> = {};
    {
      const curStreak: Record<string, number> = {};
      const allStreaks: Record<string, number[]> = {};
      for (const p of allPairs) {
        // reset streaks for all others
        for (const k of Object.keys(curStreak)) {
          if (k !== p) curStreak[k] = (curStreak[k] ?? 0) + 1;
          else {
            if (curStreak[k] > 0) {
              allStreaks[k] = allStreaks[k] ?? [];
              allStreaks[k]!.push(curStreak[k]);
            }
            curStreak[k] = 0;
          }
        }
        if (curStreak[p] === undefined) curStreak[p] = 0;
      }
      for (const p of Object.keys(curStreak)) {
        currentStreak[p] = curStreak[p] ?? 0;
        const streaks = allStreaks[p] ?? [];
        if (streaks.length > 0) {
          streakLength[p] = streaks.reduce((s, v) => s + v, 0) / streaks.length;
        } else {
          streakLength[p] = total; // never appeared
        }
      }
    }
    const maxColdRatio = 4;

    // ── S4: Cycle — check if gaps cluster (>= 22% in same gap mod) ─────────
    const cycleScore: Record<string, number> = {};
    {
      for (const p of Object.keys(freqCount)) {
        const gaps: number[] = [];
        let prevIdx = -1;
        for (let i = 0; i < allPairs.length; i++) {
          if (allPairs[i] === p) {
            if (prevIdx >= 0) gaps.push(i - prevIdx);
            prevIdx = i;
          }
        }
        if (gaps.length < 3) { cycleScore[p] = 0; continue; }
        const modCounts: Record<number, number> = {};
        for (const g of gaps) {
          const mod = g % 10;
          modCounts[mod] = (modCounts[mod] ?? 0) + 1;
        }
        const maxMod = Math.max(...Object.values(modCounts));
        cycleScore[p] = maxMod / gaps.length >= 0.22 ? 1 : 0;
      }
    }

    // ── Aggregate 6 signals → score per pair ──────────────────────────────
    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const p = pairKey(x, y);

        const s1 = (freqCount[p] ?? 0) / maxFreq;

        const avgGap = gapCount[p] ? (gapTotal[p]! / gapCount[p]!) : total;
        const due    = (currentGap[p] ?? total) / (avgGap || 1);
        const s2     = Math.min(1, due / 3);

        const globalRate = (freqCount[p] ?? 0) / total;
        const recentRate = (recentCount[p] ?? 0) / recentTotal;
        const momentum   = globalRate > 0 ? Math.min(5, recentRate / globalRate) / 5 : 0;
        const s3 = momentum;

        const s4 = cycleScore[p] ?? 0;

        const s5 = (markovScore[p] ?? 0) / maxMarkov;

        const avgCold = streakLength[p] ?? total;
        const curCold = currentStreak[p] ?? 0;
        const s6 = avgCold > 0 ? Math.min(maxColdRatio, curCold / avgCold) / maxColdRatio : 0;

        scores[p] = W_FREQ * s1 + W_GAP * s2 + W_MOM * s3 + W_CYCLE * s4 + W_MARKOV * s5 + W_STREAK * s6;
      }
    }

    logger.debug({ game_type, draw_type, half, total_draws: total, elapsed_ms: Date.now() - start }, 'BayesianScore.runPairs done');
    return scores;
  }
}
