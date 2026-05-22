// ═══════════════════════════════════════════════════════════════
// HELIX × Ballbot Mirror Service v1.0.0 (2026-05-22)
//
// Réplica espejo de las 18+ estrategias Ballbot dentro de HELIX.
//
// ARQUITECTURA:
//   • 14 estrategias canónicas → delegan a algoritmos HELIX existentes
//   • 4 estrategias mirror-only → implementación inline (cycle, mirror,
//     unodostres, unodostres-plus) — replicadas exactas de Ballbot
//
// FUENTE DE DATOS: hitdash.ingested_results (los mismos draws que Ballbot)
// FORMATO OUTPUT: candidates + scores normalizados (compatibles con bot)
// BACKTEST: aprovecha algo_rank_history existente para las canónicas
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

import { FrequencyAnalysis }     from '../analysis/algorithms/FrequencyAnalysis.js';
import { GapAnalysis }           from '../analysis/algorithms/GapAnalysis.js';
import { CalendarPattern }       from '../analysis/algorithms/CalendarPattern.js';
import { TransitionFollow }      from '../analysis/algorithms/TransitionFollow.js';
import { TrendMomentum }         from '../analysis/algorithms/TrendMomentum.js';
import { PositionAnalysis }      from '../analysis/algorithms/PositionAnalysis.js';
import { StreakDetection }       from '../analysis/algorithms/StreakDetection.js';
import { BayesianScore }         from '../analysis/algorithms/BayesianScore.js';
import { MarkovOrder2 }          from '../analysis/algorithms/MarkovOrder2.js';
import { DecadeFamily }          from '../analysis/algorithms/DecadeFamily.js';
import { TerminalAnalysis }      from '../analysis/algorithms/TerminalAnalysis.js';
import { MaxPerWeekDay }         from '../analysis/algorithms/MaxPerWeekDay.js';
import { EstIndividuales }       from '../analysis/algorithms/EstIndividuales.js';
import { PairCorrelation }       from '../analysis/algorithms/PairCorrelation.js';

import {
  BALLBOT_STRATEGIES,
  type BallbotStrategyMeta,
  type BallbotStrategyResult,
  type MirrorRunRequest,
  type MirrorRunResponse,
  type PairHalf,
} from './types.js';

const logger = pino({ name: 'BallbotMirrorService' });

// ═════════ Helpers estadísticos ═════════════════════════════════
function wilsonInterval(k: number, n: number, z = 1.96): { lo: number; hi: number } {
  if (n === 0) return { lo: 0, hi: 0 };
  const p     = k / n;
  const z2    = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((p * (1 - p) / n) + (z2 / (4 * n * n)))) / denom;
  return { lo: +center - margin > 0 ? +(center - margin).toFixed(4) : 0,
           hi: +(center + margin).toFixed(4) };
}

function pairFromRow(row: { p1: number; p2: number; p3: number; p4: number | null }, half: PairHalf): string {
  if (half === 'ab') return `${row.p1}${row.p2}`;
  if (half === 'cd') return `${row.p3}${row.p4 ?? 0}`;
  return `${row.p2}${row.p3}`;
}

function topNFromScores(scores: Record<string, number>, n: number): string[] {
  return Object.entries(scores)
    .sort(([, a], [, b]) => b - a)
    .slice(0, n)
    .map(([pair]) => pair);
}

// ═══════════════════════════════════════════════════════════════
// MAIN SERVICE
// ═══════════════════════════════════════════════════════════════
export class BallbotMirrorService {
  private freq:        FrequencyAnalysis;
  private gap:         GapAnalysis;
  private calendar:    CalendarPattern;
  private transition:  TransitionFollow;
  private momentum:    TrendMomentum;
  private position:    PositionAnalysis;
  private streak:      StreakDetection;
  private bayesian:    BayesianScore;
  private markov:      MarkovOrder2;
  private decade:      DecadeFamily;
  private terminal:    TerminalAnalysis;
  private maxDow:      MaxPerWeekDay;
  private estIndiv:    EstIndividuales;
  private pairsCorr:   PairCorrelation;

  constructor(private readonly pool: Pool) {
    this.freq       = new FrequencyAnalysis(pool);
    this.gap        = new GapAnalysis(pool);
    this.calendar   = new CalendarPattern(pool);
    this.transition = new TransitionFollow(pool);
    this.momentum   = new TrendMomentum(pool);
    this.position   = new PositionAnalysis(pool);
    this.streak     = new StreakDetection(pool);
    this.bayesian   = new BayesianScore(pool);
    this.markov     = new MarkovOrder2(pool);
    this.decade     = new DecadeFamily(pool);
    this.terminal   = new TerminalAnalysis(pool);
    this.maxDow     = new MaxPerWeekDay(pool);
    this.estIndiv   = new EstIndividuales(pool);
    this.pairsCorr  = new PairCorrelation(pool);
  }

  // ─────────────────────────────────────────────────────────────
  // MAIN ENTRY POINT
  // ─────────────────────────────────────────────────────────────
  async runAll(req: MirrorRunRequest): Promise<MirrorRunResponse> {
    const top_n = req.top_n ?? 15;
    const as_of = req.as_of ?? new Date().toISOString().slice(0, 10);

    // Total draws available for context
    const { rows: countRows } = await this.pool.query<{ n: string }>(
      `SELECT COUNT(*)::int AS n
       FROM hitdash.ingested_results
       WHERE game_type=$1 AND draw_type=$2 AND draw_date <= $3`,
      [req.game_type, req.draw_type, as_of],
    );
    const total_draws = Number(countRows[0]?.n ?? 0);

    // Run all strategies in parallel
    const strategyResults: BallbotStrategyResult[] = await Promise.all(
      BALLBOT_STRATEGIES.map(meta => this.runStrategy(meta, req, total_draws)),
    );

    // Load HELIX consensus for comparison
    const helix_consensus = await this.loadHelixConsensusComparison(req);

    return {
      game_type: req.game_type,
      draw_type: req.draw_type,
      half:      req.half,
      as_of,
      top_n,
      total_draws,
      generated_at: new Date().toISOString(),
      strategies: strategyResults,
      helix_consensus,
    };
  }

  // ─────────────────────────────────────────────────────────────
  // PER-STRATEGY EXECUTION
  // ─────────────────────────────────────────────────────────────
  private async runStrategy(
    meta:        BallbotStrategyMeta,
    req:         MirrorRunRequest,
    total_draws: number,
  ): Promise<BallbotStrategyResult> {
    const top_n = req.top_n ?? 15;
    let scores: Record<string, number> = {};

    try {
      if (meta.status === 'canonical' && meta.helix_id) {
        scores = await this.runCanonical(meta.helix_id, req);
      } else if (meta.status === 'mirror_only') {
        scores = await this.runMirrorOnly(meta.ballbot_id, req);
      }
    } catch (err) {
      logger.warn({ err, ballbot_id: meta.ballbot_id }, 'strategy failed — empty scores');
      scores = {};
    }

    const candidates = topNFromScores(scores, top_n);
    const retrospective = meta.helix_id
      ? await this.loadRetrospective(meta.helix_id, req)
      : null;

    return {
      ballbot_id:  meta.ballbot_id,
      helix_id:    meta.helix_id,
      status:      meta.status,
      bot_title:   meta.bot_title,
      emoji:       meta.emoji,
      candidates,
      scores,
      retrospective,
      generated_at: new Date().toISOString(),
      window_recent: 30,
      total_history: total_draws,
    };
  }

  /** Run a canonical HELIX algorithm by name. */
  private async runCanonical(helix_id: string, req: MirrorRunRequest): Promise<Record<string, number>> {
    const { game_type, draw_type, half } = req;
    switch (helix_id) {
      case 'frequency':         return this.freq.runPairs(game_type, draw_type, half);
      case 'gap_analysis':      return this.gap.runPairs(game_type, draw_type, half);
      case 'calendar_pattern':  return this.calendar.runPairs(game_type, draw_type, half);
      case 'transition_follow': return this.transition.runPairs(game_type, draw_type, half);
      case 'trend_momentum':    return this.momentum.runPairs(game_type, draw_type, half);
      case 'position':          return this.position.runPairs(game_type, draw_type, half);
      case 'streak':            return this.streak.runPairs(game_type, draw_type, half);
      case 'bayesian_score':    return this.bayesian.runPairs(game_type, draw_type, half);
      case 'markov_order2':     return this.markov.runPairs(game_type, draw_type, half);
      case 'decade_family':     return this.decade.runPairs(game_type, draw_type, half);
      case 'terminal_analysis': return this.terminal.runPairs(game_type, draw_type, half);
      case 'max_per_week_day':  return this.maxDow.runPairs(game_type, draw_type, half);
      case 'est_individuales':  return this.estIndiv.runPairs(game_type, draw_type, half);
      case 'pairs_correlation': return this.pairsCorr.runPairs(game_type, draw_type, half);
      default: return {};
    }
  }

  // ─────────────────────────────────────────────────────────────
  // MIRROR-ONLY STRATEGIES (replicadas exactas de Ballbot)
  // ─────────────────────────────────────────────────────────────
  private async runMirrorOnly(ballbot_id: string, req: MirrorRunRequest): Promise<Record<string, number>> {
    // BUG FIX (2026-05-22): unodostres_plus debe usar period combinado (m+e)
    // Antes: usaba mismo draws que unodostres → output idéntico.
    // Ahora: combined cuando plus=true.
    const draws = ballbot_id === 'unodostres_plus'
      ? await this.loadDrawsCombined(req)
      : await this.loadDraws(req);
    if (draws.length === 0) return {};

    switch (ballbot_id) {
      case 'cycle_detector':    return this.computeCycleDetector(draws, req.half);
      case 'mirror_complement': return this.computeMirrorComplement(draws, req.half);
      case 'unodostres':        return this.computeUnodostres(draws, req.half, false);
      case 'unodostres_plus':   return this.computeUnodostres(draws, req.half, true);
      default: return {};
    }
  }

  private async loadDraws(req: MirrorRunRequest): Promise<Array<{ p1: number; p2: number; p3: number; p4: number | null; draw_date: string }>> {
    const { rows } = await this.pool.query<{ p1: number; p2: number; p3: number; p4: number | null; draw_date: string }>(
      `SELECT p1, p2, p3, p4, draw_date::text AS draw_date
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
         AND p1 IS NOT NULL AND p2 IS NOT NULL AND p3 IS NOT NULL
         ${req.as_of ? 'AND draw_date <= $3' : ''}
       ORDER BY draw_date ASC, draw_key ASC`,
      req.as_of ? [req.game_type, req.draw_type, req.as_of] : [req.game_type, req.draw_type],
    );
    return rows;
  }

  /** BUG FIX: unodostres_plus usa midday + evening combinados (replica Ballbot). */
  private async loadDrawsCombined(req: MirrorRunRequest): Promise<Array<{ p1: number; p2: number; p3: number; p4: number | null; draw_date: string }>> {
    const { rows } = await this.pool.query<{ p1: number; p2: number; p3: number; p4: number | null; draw_date: string }>(
      `SELECT p1, p2, p3, p4, draw_date::text AS draw_date
       FROM hitdash.ingested_results
       WHERE game_type = $1
         AND draw_type IN ('midday', 'evening')
         AND p1 IS NOT NULL AND p2 IS NOT NULL AND p3 IS NOT NULL
         ${req.as_of ? 'AND draw_date <= $2' : ''}
       ORDER BY draw_date ASC, draw_key ASC`,
      req.as_of ? [req.game_type, req.as_of] : [req.game_type],
    );
    return rows;
  }

  // ─── CYCLE DETECTOR (Ballbot replica + bug fix tie-breaking) ──────
  // BUG FIX (2026-05-22): antes filtraba concentration < 0.22 → 99 pares
  // quedaban en score 0.01 → tie-break secuencial. Ahora score continuo
  // sin filtro binario: cada par tiene score único = phase * concentration.
  private computeCycleDetector(
    draws: Array<{ p1: number; p2: number; p3: number; p4: number | null }>,
    half: PairHalf,
  ): Record<string, number> {
    const BAND_TOLERANCE = 0.20;
    const scores: Record<string, number> = {};

    // Build appearance indices per pair
    const appearances = new Map<string, number[]>();
    for (let i = 0; i < draws.length; i++) {
      const p = pairFromRow(draws[i]!, half);
      const arr = appearances.get(p) ?? [];
      arr.push(i);
      appearances.set(p, arr);
    }

    const totalDraws = draws.length;
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const pair = `${x}${y}`;
        const idx = appearances.get(pair) ?? [];

        // FALLBACK: pares con <4 apariciones → score basado en marginal
        if (idx.length < 4) {
          scores[pair] = (idx.length / Math.max(1, totalDraws)) * 0.1;
          continue;
        }

        const gaps: number[] = [];
        for (let i = 1; i < idx.length; i++) gaps.push(idx[i]! - idx[i-1]!);
        const avgGap = gaps.reduce((s, g) => s + g, 0) / gaps.length;
        if (avgGap === 0) { scores[pair] = 0.01; continue; }

        const lo = avgGap * (1 - BAND_TOLERANCE);
        const hi = avgGap * (1 + BAND_TOLERANCE);
        const inBand = gaps.filter(g => g >= lo && g <= hi).length;
        const concentration = inBand / gaps.length;

        const lastIdx = idx[idx.length - 1]!;
        const sinceLast = totalDraws - 1 - lastIdx;
        const phase = avgGap > 0 ? sinceLast / avgGap : 0;

        // FIX: score continuo SIN filtro binario. Pares con baja concentration
        // o fase lejana reciben score bajo pero único, no 0.01 fijo.
        scores[pair] = Math.max(0.01, phase * concentration);
      }
    }
    return scores;
  }

  // ─── MIRROR-COMPLEMENT (Ballbot replica) ───────────────────────
  private computeMirrorComplement(
    draws: Array<{ p1: number; p2: number; p3: number; p4: number | null }>,
    half: PairHalf,
  ): Record<string, number> {
    const scores: Record<string, number> = {};
    const pairs = draws.map(d => pairFromRow(d, half));

    // For each pair, compute:
    // - mirror = reversed digits (47 ↔ 74)
    // - comp99 = 99 - n
    // - comp100 = (100 - n) % 100
    // Score = how often mirror/comp appeared within 1, 3, 7 draws after this pair
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const pair = `${x}${y}`;
        const n = x * 10 + y;
        scores[pair] = 0.01;

        const mirror   = `${y}${x}`;
        const comp99   = String(99 - n).padStart(2, '0');
        const comp100  = String((100 - n) % 100).padStart(2, '0');

        // Find all occurrences of this pair
        const occurrences: number[] = [];
        for (let i = 0; i < pairs.length; i++) {
          if (pairs[i] === pair) occurrences.push(i);
        }
        if (occurrences.length === 0) continue;

        // Count symmetric appearances within windows
        let count1 = 0, count3 = 0, count7 = 0;
        for (const i of occurrences) {
          for (let d = 1; d <= 7 && i + d < pairs.length; d++) {
            const p2 = pairs[i + d]!;
            const isSymmetric = p2 === mirror || p2 === comp99 || p2 === comp100;
            if (!isSymmetric) continue;
            if (d <= 1) count1++;
            if (d <= 3) count3++;
            if (d <= 7) count7++;
          }
        }

        const n_occ = occurrences.length;
        if (n_occ === 0) continue;
        const pct1 = count1 / n_occ;
        const pct3 = count3 / n_occ;
        const pct7 = count7 / n_occ;
        const rawScore = pct1 * 3 + pct3 * 2 + pct7;
        scores[pair] = Math.max(0.01, rawScore / 6); // normalize to [0,1]
      }
    }
    return scores;
  }

  // ─── UNODOSTRES (Fibonacci resonance, Ballbot replica) ─────────
  private computeUnodostres(
    draws: Array<{ p1: number; p2: number; p3: number; p4: number | null }>,
    half: PairHalf,
    plus: boolean,
  ): Record<string, number> {
    const FIBS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144];
    const SIGMA = 3.5;
    const W_FIB = 0.40;
    const W_HIST = 0.20;
    const BASELINE = 0.10;

    const scores: Record<string, number> = {};
    const pairs = draws.map(d => pairFromRow(d, half));
    const totalDraws = pairs.length;
    if (totalDraws === 0) return scores;

    // Historical freq per pair
    const histCount: Record<string, number> = {};
    pairs.forEach(p => { histCount[p] = (histCount[p] ?? 0) + 1; });
    const maxHist = Math.max(...Object.values(histCount), 1);

    // Last appearance index per pair
    const lastSeen: Record<string, number> = {};
    pairs.forEach((p, i) => { lastSeen[p] = i; });

    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const pair = `${x}${y}`;
        scores[pair] = 0.01;

        const lastIdx = lastSeen[pair];
        if (lastIdx === undefined) continue;

        const t = totalDraws - 1 - lastIdx; // draws since last
        // Fibonacci resonance: sum of W(F_n) where W = (F_n/144) * exp(-(t-F_n)²/(2σ²))
        let fibScore = 0;
        for (const F of FIBS) {
          const w = (F / 144) * Math.exp(-Math.pow(t - F, 2) / (2 * SIGMA * SIGMA));
          fibScore += w;
        }

        const histNorm = (histCount[pair] ?? 0) / maxHist;
        const score = BASELINE + W_FIB * fibScore + W_HIST * histNorm;
        scores[pair] = Math.max(0.01, Math.min(1, score));
      }
    }
    return scores;
  }

  // ─────────────────────────────────────────────────────────────
  // RETROSPECTIVE LOADER — desde algo_rank_history (5 años)
  // ─────────────────────────────────────────────────────────────
  private async loadRetrospective(
    helix_id: string,
    req:      MirrorRunRequest,
  ): Promise<BallbotStrategyResult['retrospective']> {
    try {
      const { rows } = await this.pool.query<{
        n_total: string;
        hits_15: string;
        hits_25: string;
      }>(
        `SELECT COUNT(*)::int AS n_total,
                SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::int AS hits_15,
                SUM(CASE WHEN rank_of_winner <= 25 THEN 1 ELSE 0 END)::int AS hits_25
         FROM hitdash.algo_rank_history
         WHERE algo_name=$1 AND game_type=$2 AND draw_type=$3 AND half=$4`,
        [helix_id, req.game_type, req.draw_type, req.half],
      );
      const r = rows[0];
      if (!r) return null;
      const n_total = Number(r.n_total);
      if (n_total === 0) return null;
      const hits_at_15 = Number(r.hits_15);
      const hits_at_25 = Number(r.hits_25);
      const hit_rate_15 = hits_at_15 / n_total;
      const hit_rate_25 = hits_at_25 / n_total;
      const wilson15 = wilsonInterval(hits_at_15, n_total);
      return {
        n_total,
        hits_at_15,
        hits_at_25,
        hit_rate_15: +hit_rate_15.toFixed(4),
        hit_rate_25: +hit_rate_25.toFixed(4),
        wilson_lo_15: wilson15.lo,
        wilson_hi_15: wilson15.hi,
        edge_15_pp:   +((hit_rate_15 - 0.15) * 100).toFixed(2),
        edge_25_pp:   +((hit_rate_25 - 0.25) * 100).toFixed(2),
      };
    } catch (err) {
      logger.warn({ err, helix_id }, 'loadRetrospective failed');
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // HELIX CONSENSUS COMPARISON
  // ─────────────────────────────────────────────────────────────
  private async loadHelixConsensusComparison(
    req: MirrorRunRequest,
  ): Promise<MirrorRunResponse['helix_consensus']> {
    try {
      const { rows } = await this.pool.query<{
        hit_rate: string;
        edge_multiplier: string;
        wilson_lo: string;
        wilson_hi: string;
        n_draws: string;
      }>(
        `SELECT hit_rate, edge_multiplier, wilson_lo, wilson_hi, n_draws
         FROM hitdash.helix_retrospective_summary
         WHERE game_type=$1 AND draw_type=$2 AND half=$3
         ORDER BY created_at DESC LIMIT 1`,
        [req.game_type, req.draw_type, req.half],
      );
      if (rows.length === 0) return null;
      const r = rows[0]!;
      const wlo = Number(r.wilson_lo);
      const whi = Number(r.wilson_hi);
      const includesBaseline = wlo <= 0.15 && whi >= 0.15;
      return {
        top_pairs:   [], // can be filled by separate call if needed
        algo_leader: null,
        edge_x:      Number(r.edge_multiplier),
        disclosure:  includesBaseline
          ? `HELIX consensus walk-forward: hit rate ${(Number(r.hit_rate)*100).toFixed(2)}% sobre ${r.n_draws} sorteos. Wilson 95% CI [${(wlo*100).toFixed(2)}%, ${(whi*100).toFixed(2)}%] INCLUYE baseline 15% — sin edge demostrable.`
          : `HELIX consensus walk-forward: hit rate ${(Number(r.hit_rate)*100).toFixed(2)}% sobre ${r.n_draws} sorteos. Wilson 95% CI [${(wlo*100).toFixed(2)}%, ${(whi*100).toFixed(2)}%].`,
      };
    } catch (err) {
      logger.warn({ err }, 'loadHelixConsensusComparison failed');
      return null;
    }
  }

  // ─────────────────────────────────────────────────────────────
  // META: lista de estrategias disponibles
  // ─────────────────────────────────────────────────────────────
  listStrategies(): BallbotStrategyMeta[] {
    return BALLBOT_STRATEGIES;
  }
}
