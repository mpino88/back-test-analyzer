// ═══════════════════════════════════════════════════════════════
// HITDASH — FibonacciResonancePro v1.0.0
// Multi-sequence Gaussian resonance: Fibonacci + Lucas + Tribonacci
// + Primes + Triangular. Adaptive σ. Fix ambos-mode collapse.
// Score = 0.05 + 0.30×W_composite + 0.20×momentum
//       + 0.15×hist_freq + 0.15×cycle_consistency
//       + 0.10×gap_alignment + 0.05×anti_recency
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../ballbotAdapter.js';
import type { AnalysisPeriod, PairHalf, FibonacciResult, FibonacciEntry, Position } from '../../types/analysis.types.js';
import type { LotteryDigits } from '../../types/agent.types.js';

const logger = pino({ name: 'FibonacciResonancePro' });

// ─── Mathematical sequences (capped at 200) ─────────────────────
const FIBONACCI: number[] = (() => {
  const s = [1, 1]; while (s[s.length - 1]! < 200) s.push(s[s.length - 1]! + s[s.length - 2]!);
  return s.filter(n => n <= 200);
})(); // [1,1,2,3,5,8,13,21,34,55,89,144]

const LUCAS: number[] = (() => {
  const s = [2, 1]; while (s[s.length - 1]! < 200) s.push(s[s.length - 1]! + s[s.length - 2]!);
  return s.filter(n => n <= 200);
})(); // [2,1,3,4,7,11,18,29,47,76,123,199]

const TRIBONACCI: number[] = (() => {
  const s = [1, 1, 2]; while (s[s.length - 1]! < 200) s.push(s[s.length - 1]! + s[s.length - 2]! + s[s.length - 3]!);
  return s.filter(n => n <= 200);
})(); // [1,1,2,4,7,13,24,44,81,149]

const PRIMES: number[] = [2,3,5,7,11,13,17,19,23,29,31,37,41,43,47,53,59,61,67,71,73,79,83,89,97,
  101,103,107,109,113,127,131,137,139,149,151,157,163,167,173,179,181,191,193,197,199];

const TRIANGULAR: number[] = (() => {
  const s: number[] = [];
  for (let n = 1; n * (n + 1) / 2 <= 200; n++) s.push(n * (n + 1) / 2);
  return s;
})(); // [1,3,6,10,15,21,28,36,45,55,66,78,91,105,120,136,153,171,190]

const SEQUENCES = [FIBONACCI, LUCAS, TRIBONACCI, PRIMES, TRIANGULAR];
const SEQ_WEIGHTS = [0.30, 0.20, 0.20, 0.15, 0.15]; // must sum to 1.0

// ─── Gaussian kernel ─────────────────────────────────────────────
function gaussianKernel(t: number, center: number, sigma: number): number {
  const d = t - center;
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}

// ─── Per-sequence resonance W(t) with adaptive σ ─────────────────
function resonance(t: number, seq: number[]): number {
  if (t <= 0) return 0;
  let W = 0;
  let totalWeight = 0;
  for (const F_n of seq) {
    if (F_n > t * 3) break; // negligible contribution far ahead
    const sigma = Math.max(1.0, F_n * 0.15);
    const w = gaussianKernel(t, F_n, sigma);
    W += w;
    totalWeight += 1;
  }
  return totalWeight > 0 ? Math.min(1.0, W / totalWeight * 3) : 0;
}

// ─── Composite W = weighted sum across all sequences ─────────────
function compositeResonance(t: number): number {
  let W = 0;
  for (let i = 0; i < SEQUENCES.length; i++) {
    W += SEQ_WEIGHTS[i]! * resonance(t, SEQUENCES[i]!);
  }
  return Math.min(1.0, W);
}

// ─── Cycle consistency: how stable is the pair's gap pattern ─────
function cycleConsistency(gaps: number[]): number {
  if (gaps.length < 3) return 0.5;
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const variance = gaps.reduce((acc, g) => acc + (g - mean) ** 2, 0) / gaps.length;
  const cv = mean > 0 ? Math.sqrt(variance) / mean : 1.0; // coefficient of variation
  return Math.max(0, Math.min(1.0, 1.0 - cv)); // low CV → high consistency
}

interface PairStats {
  pair: string;
  lastGap: number;       // draws since last appearance
  avgGap: number;        // historical mean gap
  gaps: number[];        // last N gaps for CV computation
  histFreq: number;      // appearances / total draws
  recentFreq: number;    // appearances in last 60 draws
  generalFreq: number;   // appearances in full window
}

const POSITIONS: Record<string, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

export class FibonacciResonancePro {
  constructor(private readonly pool: Pool) {}

  // ─── run(): digit-level resonance → FibonacciResult (AnalysisEngine.analyze) ──
  async run(
    game_type: string,
    draw_type: DrawType,
    period: AnalysisPeriod = 365
  ): Promise<FibonacciResult> {
    const start = Date.now();
    const periodDays = period === 'all' ? 9999 : period;
    const positions = POSITIONS[game_type] ?? ['p1', 'p2', 'p3'];

    const { rows } = await this.pool.query<{ digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT digits FROM lottery_results ORDER BY draw_date ASC`,
      [toDbGame(game_type as any), toDbPeriod(draw_type), periodDays]
    );

    const total = rows.length;
    const by_position: Record<Position, FibonacciEntry[]> = {} as Record<Position, FibonacciEntry[]>;

    for (const pos of positions) {
      const lastSeenIdx: Record<number, number> = {};
      const countAll: Record<number, number> = {};

      rows.forEach((row, idx) => {
        const d = row.digits as Record<string, number | undefined>;
        const val = d[pos];
        if (val === undefined) return;
        countAll[val] = (countAll[val] ?? 0) + 1;
        lastSeenIdx[val] = idx;
      });

      const entries: FibonacciEntry[] = [];
      for (let digit = 0; digit <= 9; digit++) {
        const lastIdx = lastSeenIdx[digit];
        const lastGap = lastIdx !== undefined ? total - 1 - lastIdx : total;
        const histFreq = (countAll[digit] ?? 0) / Math.max(1, total);
        // composite resonance at current gap — is this digit "due" per Fibonacci cycles?
        const W = compositeResonance(lastGap);
        const alignment_score = +(0.5 + W).toFixed(3); // 0.5 = neutral, >1.1 = aligned

        entries.push({
          digit,
          position: pos,
          current_pisano_index: lastGap,
          alignment_score,
          is_aligned: alignment_score > 1.1,
        });
      }
      entries.sort((a, b) => b.alignment_score - a.alignment_score);
      by_position[pos] = entries;
    }

    return {
      algorithm_name: 'fibonacci_resonance_pro',
      algorithm_version: '1.0.0',
      game_type: game_type as any,
      period,
      input_params: { game_type, draw_type, period_days: periodDays },
      output_data: {
        pisano_sequence_mod10: FIBONACCI,
        current_index: total % 60,
        by_position,
      },
      output_summary: `FibonacciResonancePro n=${total}`.slice(0, 500),
      execution_ms: Date.now() - start,
    };
  }

  // ─── Pair scoring (primary entry point used by AlgorithmCandidateService) ──
  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod = 365,
    mode: 'single' | 'ambos' = 'single'
  ): Promise<Record<string, number>> {
    if (mode === 'ambos') {
      // FIX: ambos-mode collapse → take MAX of both draw_types
      const [resM, resE] = await Promise.all([
        this._scorePairs(game_type, 'midday', half, period),
        this._scorePairs(game_type, 'evening', half, period),
      ]);
      const merged: Record<string, number> = {};
      const allKeys = new Set([...Object.keys(resM), ...Object.keys(resE)]);
      for (const k of allKeys) {
        merged[k] = Math.max(resM[k] ?? 0, resE[k] ?? 0);
      }
      return merged;
    }
    return this._scorePairs(game_type, draw_type, half, period);
  }

  private async _scorePairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    period: AnalysisPeriod
  ): Promise<Record<string, number>> {
    const periodDays = period === 'all' ? 9999 : period;

    const posMap: Record<PairHalf, [string, string]> = {
      du: ['p2', 'p3'],
      ab: ['p1', 'p2'],
      cd: ['p3', 'p4'],
    };
    const [posA, posB] = posMap[half] ?? ['p2', 'p3'];

    const { rows } = await this.pool.query<{ draw_date: string; digits: Record<string, number> }>(
      `${DRAWS_CTE}
       SELECT draw_date, digits FROM lottery_results ORDER BY draw_date ASC`,
      [toDbGame(game_type), toDbPeriod(draw_type), periodDays]
    );

    const total = rows.length;
    if (total < 10) return {};

    // ─── Build per-pair stats ────────────────────────────────────
    const lastSeenIdx: Record<string, number> = {};
    const gapHistory: Record<string, number[]> = {};
    const countGeneral: Record<string, number> = {};
    const countRecent: Record<string, number> = {};
    const RECENT_WINDOW = 60;
    const recentStart = Math.max(0, total - RECENT_WINDOW);

    rows.forEach((row, idx) => {
      const d = row.digits;
      const a = d[posA!], b = d[posB!];
      if (a === undefined || b === undefined) return;
      const key = `${a}${b}`;
      countGeneral[key] = (countGeneral[key] ?? 0) + 1;
      if (idx >= recentStart) countRecent[key] = (countRecent[key] ?? 0) + 1;

      if (lastSeenIdx[key] !== undefined) {
        const gap = idx - lastSeenIdx[key]!;
        if (!gapHistory[key]) gapHistory[key] = [];
        gapHistory[key]!.push(gap);
      }
      lastSeenIdx[key] = idx;
    });

    // ─── Score each pair ─────────────────────────────────────────
    const scores: Record<string, number> = {};
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        const seen = lastSeenIdx[key];
        if (seen === undefined) { scores[key] = 0.05; continue; }

        const gaps = gapHistory[key] ?? [];
        const lastGap = total - 1 - seen; // draws since last seen
        const avgGap = gaps.length > 0
          ? gaps.reduce((a, b) => a + b, 0) / gaps.length
          : total;

        const histFreq = (countGeneral[key] ?? 0) / total;
        const recentCount = countRecent[key] ?? 0;
        const recentFreq = recentCount / Math.min(RECENT_WINDOW, total);
        const generalFreq = histFreq;

        // W_composite: resonance at lastGap relative to avgGap
        const t = lastGap;
        const W = compositeResonance(t);

        // momentum: recent vs general relative freq
        const momentum = Math.min(1.0, Math.max(0, generalFreq > 0 ? recentFreq / generalFreq - 0.5 : 0));

        // cycle_consistency: regularity of return intervals
        const cc = cycleConsistency(gaps);

        // gap_alignment: how close lastGap is to avgGap (normalized)
        const gapRatio = avgGap > 0 ? lastGap / avgGap : 1.0;
        const gap_alignment = Math.max(0, 1.0 - Math.abs(gapRatio - 1.0));

        // anti_recency: penalize pairs that appeared in last 3 draws
        const anti_recency = lastGap >= 3 ? 1.0 : lastGap / 3;

        const score =
          0.05 +
          0.30 * W +
          0.20 * momentum +
          0.15 * Math.min(1.0, histFreq * 50) +
          0.15 * cc +
          0.10 * gap_alignment +
          0.05 * anti_recency;

        scores[key] = Math.max(0, Math.min(1.0, score));
      }
    }

    logger.debug(
      { game_type, draw_type, half, total, period },
      'FibonacciResonancePro scored'
    );

    return scores;
  }

  // ─── Top-N list (for AlgorithmCandidateService.runAll) ───────────
  async topPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    topN = 20,
    minScore = 0.40,
    period: AnalysisPeriod = 365
  ): Promise<string[]> {
    const scores = await this.runPairs(game_type, draw_type, half, period);
    return Object.entries(scores)
      .filter(([, s]) => s >= minScore)
      .sort(([, a], [, b]) => b - a)
      .slice(0, topN)
      .map(([k]) => k);
  }
}
