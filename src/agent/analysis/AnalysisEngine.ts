// ═══════════════════════════════════════════════════════════════
// HITDASH — AnalysisEngine v1.0.0
// Orquestador de los 8 algoritmos con consensus score ponderado
// Todos los algoritmos se ejecutan en paralelo (Promise.allSettled)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

import { FrequencyAnalysis }  from './algorithms/FrequencyAnalysis.js';
import { GapAnalysis }        from './algorithms/GapAnalysis.js';
import { HotColdClassifier }  from './algorithms/HotColdClassifier.js';
import { PairCorrelation }    from './algorithms/PairCorrelation.js';
import { FibonacciPisano }    from './algorithms/FibonacciPisano.js';
import { StreakDetection }    from './algorithms/StreakDetection.js';
import { PositionAnalysis }   from './algorithms/PositionAnalysis.js';
import { MovingAverages }     from './algorithms/MovingAverages.js';
// ─── Ballbot Clones (agentic strategies v2) ────────────────────────────────
import { BayesianScore }     from './algorithms/BayesianScore.js';
import { TransitionFollow }  from './algorithms/TransitionFollow.js';
import { MarkovOrder2 }      from './algorithms/MarkovOrder2.js';
import { CalendarPattern }   from './algorithms/CalendarPattern.js';
import { DecadeFamily }      from './algorithms/DecadeFamily.js';
import { MaxPerWeekDay }     from './algorithms/MaxPerWeekDay.js';

import type { GameType, DrawType }           from '../types/agent.types.js';
import type {
  ComprehensiveAnalysis,
  ConsensusScore,
  DigitSignal,
  AnalysisPeriod,
  Position,
  FrequencyResult,
  GapResult,
  HotColdResult,
  PairResult,
  FibonacciResult,
  StreakResult,
  PositionResult,
  MAResult,
  PairHalf,
  PairAnalysis,
  RankedPair,
} from '../types/analysis.types.js';
import { ALGORITHM_WEIGHTS } from '../types/analysis.types.js';

const logger = pino({ name: 'AnalysisEngine' });

// ─── Mapeo: nombre AnalysisEngine → strategy name en adaptive_weights ──────
// Este mapeo es crítico para que los pesos aprendidos por el backtest
// se apliquen en la ruta live del agente.
const ALG_TO_STRATEGY: Record<string, string> = {
  frequency:         'frequency_rank',
  gap_analysis:      'gap_overdue_focus',
  hot_cold:          'hot_cold_weighted',
  pairs_correlation: 'pair_correlation',
  fibonacci_pisano:  'fibonacci_pisano',
  streak:            'streak_reversal',
  position:          'position_bias',
  // MovingAverages.runPairs() computa (sma7-sma14)+ema → blend de moving_avg_signal + momentum_ema
  // Se promedian ambos pesos adaptativos para el efectivo
  moving_averages:   'moving_avg_signal',
  // Ballbot Clones — strategy names match strategy_registry.name
  bayesian_score:    'bayesian_score',
  transition_follow: 'transition_follow',
  markov_order2:     'markov_order2',
  calendar_pattern:  'calendar_pattern',
  decade_family:     'decade_family',
  max_per_week_day:  'max_per_weekday',
};

// Default top_n si la estrategia aún no tiene historial adaptativo
const DEFAULT_TOP_N_MAP: Record<string, number> = {
  frequency_rank:    15,
  gap_overdue_focus: 12,
  hot_cold_weighted: 15,
  pair_correlation:  20,
  fibonacci_pisano:  25,
  streak_reversal:   10,
  position_bias:     22,
  moving_avg_signal: 15,
  momentum_ema:      14,
  apex_adaptive:     15,
  // Ballbot Clones
  bayesian_score:    15,
  transition_follow: 15,
  markov_order2:     15,
  calendar_pattern:  15,
  decade_family:     15,
  max_per_weekday:   15,
};

// ─── Cognitive N — auto-determines optimal pair count from precision metrics ──
interface PrecisionSnapshot {
  kelly_fraction: number;
  wilson_lower:   number;
  precision_at_3: number;
  precision_at_5: number;
  precision_at_10: number;
  expected_rank:  number;
  sharpe:         number;
  mrr:            number;
}

function computeCognitiveN(m: PrecisionSnapshot): {
  optimal_n: number;
  predicted_effectiveness: number;
  cognitive_basis: string;
} {
  // ── Primary: Kelly Criterion → optimal fraction of 100-pair space ─────────
  // f* > 0 means the agent has measurable edge. optimal_n = f* × 100 pairs.
  const n_kelly = m.kelly_fraction > 0 ? Math.round(m.kelly_fraction * 100) : 0;

  // ── Secondary: Precision@K ladder ────────────────────────────────────────
  // Find smallest K where hit-rate clears a meaningful threshold.
  let n_precision: number;
  if      (m.precision_at_3  >= 0.12) n_precision = 3;
  else if (m.precision_at_5  >= 0.10) n_precision = 5;
  else if (m.precision_at_10 >= 0.10) n_precision = 10;
  else    n_precision = Math.min(50, Math.ceil(m.expected_rank / 2));

  // ── Tertiary: Expected rank (where does the real pair usually land?) ───────
  // If the real pair lands at rank ~25 on average, top-17 covers it ~70% of time.
  const n_rank = Math.max(3, Math.min(50, Math.ceil(m.expected_rank * 0.70)));

  // ── Blend: Kelly dominates when positive, otherwise precision+rank ─────────
  let optimal_n: number;
  let kelly_str: string;
  if (n_kelly >= 3) {
    optimal_n = Math.round(0.50 * n_kelly + 0.30 * n_precision + 0.20 * n_rank);
    kelly_str = `f*=${m.kelly_fraction.toFixed(3)}`;
  } else {
    optimal_n = Math.round(0.55 * n_precision + 0.45 * n_rank);
    kelly_str = 'f*=0.000';
    // A2: cap at 20 when no measurable edge — expanding coverage without edge is counterproductive
    optimal_n = Math.min(20, optimal_n);
  }
  optimal_n = Math.max(3, Math.min(50, optimal_n));

  // ── Predicted effectiveness: Wilson lower bound + stability bonus ──────────
  // Sharpe > 1 implies hit_rate > baseline with low variance → small bonus.
  const sharpe_bonus = m.sharpe > 1 ? Math.min(0.03, (m.sharpe - 1) * 0.01) : 0;
  const predicted_effectiveness = Math.max(0, Math.min(1, m.wilson_lower + sharpe_bonus));

  const cognitive_basis = [
    kelly_str,
    `p@5=${(m.precision_at_5 * 100).toFixed(1)}%`,
    `rank_avg=${m.expected_rank.toFixed(1)}`,
    `mrr=${m.mrr.toFixed(3)}`,
    `sharpe=${m.sharpe.toFixed(2)}`,
  ].join(' ');

  return { optimal_n, predicted_effectiveness, cognitive_basis };
}

const ALL_POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

// Clamp value to [0, 1]
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

export class AnalysisEngine {
  private readonly freq:  FrequencyAnalysis;
  private readonly gap:   GapAnalysis;
  private readonly hc:    HotColdClassifier;
  private readonly pairs: PairCorrelation;
  private readonly fib:   FibonacciPisano;
  private readonly streak: StreakDetection;
  private readonly pos:   PositionAnalysis;
  private readonly ma:    MovingAverages;
  // ─── Ballbot Clones ───────────────────────────────────────────
  private readonly bayesian:    BayesianScore;
  private readonly transition:  TransitionFollow;
  private readonly markov2:     MarkovOrder2;
  private readonly calendar:    CalendarPattern;
  private readonly decade:      DecadeFamily;
  private readonly maxDow:      MaxPerWeekDay;

  constructor(
    private readonly ballbotPool: Pool,
    private readonly agentPool:   Pool,
  ) {
    // ═══ x10 PRO OPTIMIZATION ═══
    // Los algoritmos ahora corren contra hitdash.ingested_results (LOCAL)
    // para eliminar latencia de red externa.
    const analysisPool = agentPool; 

    this.freq   = new FrequencyAnalysis(analysisPool);
    this.gap    = new GapAnalysis(analysisPool);
    this.hc     = new HotColdClassifier(analysisPool);
    this.pairs  = new PairCorrelation(analysisPool);
    this.fib    = new FibonacciPisano(analysisPool);
    this.streak = new StreakDetection(analysisPool);
    this.pos    = new PositionAnalysis(analysisPool);
    this.ma     = new MovingAverages(analysisPool);
    // ─── Ballbot Clones — use agentPool (local hitdash.ingested_results) ──
    this.bayesian   = new BayesianScore(agentPool);
    this.transition = new TransitionFollow(agentPool);
    this.markov2    = new MarkovOrder2(agentPool);
    this.calendar   = new CalendarPattern(agentPool);
    this.decade     = new DecadeFamily(agentPool);
    this.maxDow     = new MaxPerWeekDay(agentPool);
  }

  async analyze(
    game_type: GameType,
    draw_type: DrawType,
    period: AnalysisPeriod = 90
  ): Promise<ComprehensiveAnalysis> {
    const globalStart = Date.now();
    const positions = ALL_POSITIONS[game_type];

    logger.info({ game_type, draw_type, period }, 'AnalysisEngine: iniciando análisis completo');

    // ─── Ejecutar los 8 algoritmos en paralelo ──────────────────
    const [rFreq, rGap, rHC, rPairs, rFib, rStreak, rPos, rMA] = await Promise.allSettled([
      this.freq.run(game_type, draw_type, period),
      this.gap.run(game_type, draw_type, period),
      this.hc.run(game_type, draw_type, period),
      this.pairs.run(game_type, draw_type, period),
      this.fib.run(game_type, draw_type, 365),   // Pisano needs more history
      this.streak.run(game_type, draw_type, period),
      this.pos.run(game_type, draw_type, 365),   // Chi-square needs more history
      this.ma.run(game_type, draw_type, period),
    ]);

    const algorithms_succeeded: string[] = [];
    const algorithms_failed: Array<{ name: string; error: string }> = [];

    function unwrap<T>(result: PromiseSettledResult<T>, name: string): T | null {
      if (result.status === 'fulfilled') {
        algorithms_succeeded.push(name);
        return result.value;
      }
      algorithms_failed.push({ name, error: result.reason instanceof Error ? result.reason.message : String(result.reason) });
      logger.warn({ algorithm: name, error: result.reason }, 'Algoritmo fallido — excluido del consensus');
      return null;
    }

    const freqResult   = unwrap(rFreq,   'frequency');
    const gapResult    = unwrap(rGap,    'gap_analysis');
    const hcResult     = unwrap(rHC,     'hot_cold');
    const pairsResult  = unwrap(rPairs,  'pairs_correlation');
    const fibResult    = unwrap(rFib,    'fibonacci_pisano');
    const streakResult = unwrap(rStreak, 'streak');
    const posResult    = unwrap(rPos,    'position');
    const maResult     = unwrap(rMA,     'moving_averages');

    // ─── Acumular señales por (position, digit) ─────────────────
    // Key: `${position}:${digit}`
    const signalMap = new Map<string, DigitSignal[]>();

    function addSignal(pos: Position, digit: number, signal: DigitSignal): void {
      const key = `${pos}:${digit}`;
      const existing = signalMap.get(key) ?? [];
      existing.push(signal);
      signalMap.set(key, existing);
    }

    // 1. Frequency signals — score = freq_relative / 0.20 (20% = max expected in hot digits)
    if (freqResult) {
      const data = (freqResult as FrequencyResult).output_data;
      for (const pos of positions) {
        for (const entry of data.by_position[pos] ?? []) {
          addSignal(pos, entry.digit, {
            digit: entry.digit,
            algorithm: 'frequency',
            score: clamp01(entry.freq_relative / 0.20),
            reason: `freq=${(entry.freq_relative * 100).toFixed(1)}% dev=${(entry.deviation * 100).toFixed(1)}%`,
          });
        }
      }
    }

    // 2. Gap signals — score = overdue_score / 3.0 (capped at 3x overdue)
    if (gapResult) {
      const data = (gapResult as GapResult).output_data;
      for (const pos of positions) {
        for (const entry of data.by_position[pos] ?? []) {
          addSignal(pos, entry.digit, {
            digit: entry.digit,
            algorithm: 'gap_analysis',
            score: clamp01(entry.overdue_score / 3.0),
            reason: `overdue=${entry.overdue_score} gap=${entry.gap_actual}d avg=${entry.gap_promedio}d`,
          });
        }
      }
    }

    // 3. Hot/Cold signals — score = sigmoid(z_score_7d) using clamp trick
    if (hcResult) {
      const data = (hcResult as HotColdResult).output_data;
      for (const pos of positions) {
        for (const entry of data.by_position[pos] ?? []) {
          // Sigmoid: map z [-3,+3] → [0.05,0.95]
          const sigmoid = 1 / (1 + Math.exp(-entry.z_score_7d));
          addSignal(pos, entry.digit, {
            digit: entry.digit,
            algorithm: 'hot_cold',
            score: clamp01(sigmoid),
            reason: `z7d=${entry.z_score_7d} label=${entry.label_7d}`,
          });
        }
      }
    }

    // 4. Pair signals — each digit in a strong pair gets a boost
    // score = (avg correlation_ratio of pairs containing this digit - 1) / 1.5
    if (pairsResult) {
      const data = (pairsResult as PairResult).output_data;
      const pairBoost = new Map<string, number[]>();

      for (const pair of data.top_pairs) {
        const boost = pair.correlation_ratio - 1; // excess over independence baseline
        const keyA = `${pair.positions[0]}:${pair.digit_a}`;
        const keyB = `${pair.positions[1]}:${pair.digit_b}`;
        const existingA = pairBoost.get(keyA) ?? [];
        const existingB = pairBoost.get(keyB) ?? [];
        existingA.push(boost);
        existingB.push(boost);
        pairBoost.set(keyA, existingA);
        pairBoost.set(keyB, existingB);
      }

      for (const pos of positions) {
        for (let d = 0; d <= 9; d++) {
          const boosts = pairBoost.get(`${pos}:${d}`) ?? [];
          if (boosts.length > 0) {
            const avgBoost = boosts.reduce((a, b) => a + b, 0) / boosts.length;
            addSignal(pos, d, {
              digit: d,
              algorithm: 'pairs_correlation',
              score: clamp01(avgBoost / 1.5),
              reason: `pair_boost=${avgBoost.toFixed(2)} from ${boosts.length} pairs`,
            });
          }
        }
      }
    }

    // 5. Fibonacci signals — score = alignment_score / 2.0
    if (fibResult) {
      const data = (fibResult as FibonacciResult).output_data;
      for (const pos of positions) {
        for (const entry of data.by_position[pos] ?? []) {
          if (entry.alignment_score > 0) {
            addSignal(pos, entry.digit, {
              digit: entry.digit,
              algorithm: 'fibonacci_pisano',
              score: clamp01(entry.alignment_score / 2.0),
              reason: `pisano_idx=${entry.current_pisano_index} align=${entry.alignment_score}`,
            });
          }
        }
      }
    }

    // 6. Streak signals — absence streaks nearing anomaly = buy signal
    if (streakResult) {
      const data = (streakResult as StreakResult).output_data;
      for (const entry of data.active_streaks) {
        if (entry.streak_type === 'absence' && entry.mean_length > 0) {
          const score = clamp01(entry.current_length / (entry.mean_length + 2 * entry.std_dev_length));
          addSignal(entry.position, entry.digit, {
            digit: entry.digit,
            algorithm: 'streak',
            score,
            reason: `absence_streak=${entry.current_length} mean=${entry.mean_length} alert=${entry.alert_level}`,
          });
        }
      }
    }

    // 7. Position bias signals — top digit in biased positions gets higher score
    if (posResult) {
      const data = (posResult as PositionResult).output_data;
      for (const pos of positions) {
        const heatmapPos = data.heatmap[pos];
        const bias = data.position_bias.find(b => b.position === pos);
        for (let d = 0; d <= 9; d++) {
          const freq = heatmapPos?.[d] ?? 0;
          // Score is elevated only if bias detected at this position
          const biasMultiplier = bias?.bias_detected ? 1.5 : 1.0;
          addSignal(pos, d, {
            digit: d,
            algorithm: 'position',
            score: clamp01((freq / 0.20) * biasMultiplier),
            reason: `freq=${(freq * 100).toFixed(1)}% bias=${bias?.bias_detected ? 'YES' : 'no'} p=${bias?.p_value}`,
          });
        }
      }
    }

    // 8. Moving average signals
    if (maResult) {
      const data = (maResult as MAResult).output_data;
      for (const pos of positions) {
        for (const entry of data.by_position[pos] ?? []) {
          const baseScore =
            entry.signal === 'bullish' ? (entry.crossover_detected ? 0.9 : 0.7)
            : entry.signal === 'neutral' ? 0.4
            : 0.1; // bearish
          addSignal(pos, entry.digit, {
            digit: entry.digit,
            algorithm: 'moving_averages',
            score: baseScore,
            reason: `sma7=${entry.sma_7} sma14=${entry.sma_14} signal=${entry.signal} crossover=${entry.crossover_detected}`,
          });
        }
      }
    }

    // ─── Construir ConsensusScore por posición ───────────────────
    const by_position: ComprehensiveAnalysis['by_position'] = {} as ComprehensiveAnalysis['by_position'];
    const recommended: ComprehensiveAnalysis['recommended_digits_per_position'] = {} as ComprehensiveAnalysis['recommended_digits_per_position'];

    for (const pos of positions) {
      const posConsensus: ConsensusScore[] = [];

      for (let d = 0; d <= 9; d++) {
        const signals = signalMap.get(`${pos}:${d}`) ?? [];

        if (signals.length === 0) {
          posConsensus.push({ digit: d, position: pos, consensus_score: 0, signals: [], algorithms_count: 0 });
          continue;
        }

        // Weighted average: Σ(score * weight) / Σ(weight)
        let weightedSum = 0;
        let weightTotal = 0;
        for (const sig of signals) {
          const w = ALGORITHM_WEIGHTS[sig.algorithm] ?? 0.5;
          weightedSum += sig.score * w;
          weightTotal += w;
        }
        const consensus_score = weightTotal > 0 ? +(weightedSum / weightTotal).toFixed(4) : 0;

        posConsensus.push({
          digit: d,
          position: pos,
          consensus_score,
          signals,
          algorithms_count: signals.length,
        });
      }

      // Sort by consensus_score DESC
      posConsensus.sort((a, b) => b.consensus_score - a.consensus_score);

      by_position[pos] = {
        consensus_scores: posConsensus,
        top_digits: posConsensus.slice(0, 3).map(c => c.digit),
      };

      recommended[pos] = posConsensus.slice(0, 3).map(c => c.digit);
    }

    const totalMs = Date.now() - globalStart;

    logger.info(
      {
        game_type, draw_type,
        succeeded: algorithms_succeeded.length,
        failed: algorithms_failed.length,
        duration_ms: totalMs,
      },
      'AnalysisEngine: análisis completo terminado'
    );

    return {
      game_type,
      period,
      executed_at: new Date(),
      algorithms_succeeded,
      algorithms_failed,
      total_execution_ms: totalMs,
      by_position,
      recommended_digits_per_position: recommended,
    };
  }

  // ─── Pair mode (v2) ─────────────────────────────────────────────
  // Runs all 8 runPairs() in parallel, aggregates with ALGORITHM_WEIGHTS,
  // returns PairAnalysis with 100 ranked pairs and adaptive top_n.
  async analyzePairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf = 'du',
    period: AnalysisPeriod = 90
  ): Promise<PairAnalysis> {
    const globalStart = Date.now();

    logger.info({ game_type, draw_type, half, period }, 'AnalysisEngine: analyzePairs iniciado');

    // C2: Multi-window temporal — run base algorithms at primary period, PLUS
    // short-term (30d) frequency + hot_cold for momentum detection.
    // Blend: primary consensus + 25% momentum overlay captures both stability and trend.
    const SHORT_PERIOD: AnalysisPeriod = 30;
    const [rFreq, rGap, rHC, rPairs, rFib, rStreak, rPos, rMA,
           rFreqShort, rHCShort,
           rBayesian, rTransition, rMarkov2, rCalendar, rDecade, rMaxDow,
    ] = await Promise.allSettled([
      this.freq.runPairs(game_type, draw_type, half, period),
      this.gap.runPairs(game_type, draw_type, half, period),
      this.hc.runPairs(game_type, draw_type, half, period),
      this.pairs.runPairs(game_type, draw_type, half, period),
      this.fib.runPairs(game_type, draw_type, half, 365),
      this.streak.runPairs(game_type, draw_type, half, period),
      this.pos.runPairs(game_type, draw_type, half, 365),
      this.ma.runPairs(game_type, draw_type, half, period),
      // Short-term momentum windows (only when primary period > 30d)
      (typeof period === 'number' && period > SHORT_PERIOD)
        ? this.freq.runPairs(game_type, draw_type, half, SHORT_PERIOD)
        : Promise.reject(new Error('same_period')),
      (typeof period === 'number' && period > SHORT_PERIOD)
        ? this.hc.runPairs(game_type, draw_type, half, SHORT_PERIOD)
        : Promise.reject(new Error('same_period')),
      // ─── Ballbot Clones ──────────────────────────────────────────────────
      this.bayesian.runPairs(game_type, draw_type, half, period),
      this.transition.runPairs(game_type, draw_type, half, period),
      this.markov2.runPairs(game_type, draw_type, half, period),
      this.calendar.runPairs(game_type, draw_type, half, period),
      this.decade.runPairs(game_type, draw_type, half, period),
      this.maxDow.runPairs(game_type, draw_type, half, period),
    ]);

    const algorithms_succeeded: string[] = [];
    const algorithms_failed: Array<{ name: string; error: string }> = [];

    // ── Cargar pesos adaptativos y top_n por estrategia desde DB ──────────────
    // Esto conecta el ciclo de aprendizaje (backtest+EMA) con la ruta live del agente.
    // Si no hay datos aún, se degradan a ALGORITHM_WEIGHTS estáticos.
    const hitdashPool = this.agentPool ?? this.ballbotPool;
    let dbWeights: Record<string, number> = {};
    let dbTopN:    Record<string, number> = {};

    try {
      const { rows: awRows } = await hitdashPool.query<{ strategy: string; weight: number; top_n: number }>(
        `SELECT strategy, weight, top_n FROM hitdash.adaptive_weights
         WHERE game_type = $1
           AND mode IN ($2, 'combined')
         ORDER BY CASE mode WHEN $2 THEN 0 ELSE 1 END`,  // prefer draw_type-specific over combined
        [game_type, draw_type]
      );
      for (const r of awRows) {
        if (dbWeights[r.strategy] === undefined) dbWeights[r.strategy] = Number(r.weight);
        if (dbTopN[r.strategy]    === undefined) dbTopN[r.strategy]    = r.top_n;
      }
      if (Object.keys(dbWeights).length > 0) {
        logger.info({ strategies: Object.keys(dbWeights).length }, 'AnalysisEngine: pesos adaptativos cargados desde DB');
      }
    } catch {
      // adaptive_weights table may not exist yet — fallback to static weights
    }

    // ── Construir pesos efectivos: adaptive × precision_bonus (= DEFAULT_TOP_N / learned_top_n)
    // Replica exactamente la lógica de createPairApexAdaptive en PairBacktestEngine.ts.
    // Estrategia con top_n=10 aprendido → bonus=1.5× (más precisa → más influencia).
    // Estrategia sin datos → fallback a ALGORITHM_WEIGHTS estático.
    const GLOBAL_DEFAULT_N = 15;
    function effectiveWeight(algName: string): number {
      const stratName = ALG_TO_STRATEGY[algName] ?? algName;
      const baseW     = ALGORITHM_WEIGHTS[algName] ?? 0.5;

      // Si no hay peso adaptativo aún, usar el estático sin bonus
      const adaptiveFactor = dbWeights[stratName] ?? 1.0;
      const hasAdaptive    = dbWeights[stratName] !== undefined;

      const learnedTopN   = dbTopN[stratName] ?? DEFAULT_TOP_N_MAP[stratName] ?? GLOBAL_DEFAULT_N;
      const precisionBonus = Math.min(2.0, GLOBAL_DEFAULT_N / learnedTopN);

      return hasAdaptive
        ? baseW * adaptiveFactor * precisionBonus  // aprendido: adaptive × precision
        : baseW;                                   // sin datos: peso estático base
    }

    // momentum_ema comparte el runPairs de MovingAverages (blend de sma+ema)
    // Se le aplica su propio peso adaptativo aprendido como factor adicional al moving_averages
    const momentumExtraFactor = (() => {
      const stratName = 'momentum_ema';
      if (dbWeights[stratName] === undefined) return 1.0;
      const learnedTopN    = dbTopN[stratName] ?? DEFAULT_TOP_N_MAP[stratName] ?? GLOBAL_DEFAULT_N;
      const precisionBonus = Math.min(2.0, GLOBAL_DEFAULT_N / learnedTopN);
      return dbWeights[stratName]! * precisionBonus;
    })();

    type AlgResult = [string, number, PromiseSettledResult<Record<string, number>>];
    const algResults: AlgResult[] = [
      ['frequency',         effectiveWeight('frequency'),         rFreq],
      ['gap_analysis',      effectiveWeight('gap_analysis'),      rGap],
      ['hot_cold',          effectiveWeight('hot_cold'),          rHC],
      ['pairs_correlation', effectiveWeight('pairs_correlation'), rPairs],
      ['fibonacci_pisano',  effectiveWeight('fibonacci_pisano'),  rFib],
      ['streak',            effectiveWeight('streak'),            rStreak],
      ['position',          effectiveWeight('position'),          rPos],
      // moving_averages recibe su propio peso + el factor de momentum_ema (blend)
      ['moving_averages',   effectiveWeight('moving_averages') * momentumExtraFactor, rMA],
      // ─── Ballbot Clones ───────────────────────────────────────────────────
      ['bayesian_score',    effectiveWeight('bayesian_score'),    rBayesian],
      ['transition_follow', effectiveWeight('transition_follow'), rTransition],
      ['markov_order2',     effectiveWeight('markov_order2'),     rMarkov2],
      ['calendar_pattern',  effectiveWeight('calendar_pattern'),  rCalendar],
      ['decade_family',     effectiveWeight('decade_family'),     rDecade],
      ['max_per_week_day',  effectiveWeight('max_per_week_day'),  rMaxDow],
    ];

    // Accumulate weighted scores per pair "00"-"99"
    const accumulated: Record<string, number> = {};
    let totalWeight = 0;

    for (const [name, weight, result] of algResults) {
      if (result.status === 'fulfilled') {
        algorithms_succeeded.push(name);
        const scores = result.value;
        // Normalizar por max score de la estrategia antes de ponderar (= comparable entre estrategias)
        const maxScore = Math.max(...Object.values(scores), 1e-9);
        for (const [key, score] of Object.entries(scores)) {
          accumulated[key] = (accumulated[key] ?? 0) + (score / maxScore) * weight;
        }
        totalWeight += weight;
      } else {
        algorithms_failed.push({
          name,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        });
        logger.warn({ algorithm: name, error: result.reason }, 'runPairs fallido — excluido del consensus');
      }
    }

    // C2: Momentum overlay — blend short-term (30d) frequency + hot_cold into consensus
    // Weight = 25% of the primary frequency weight → recent trends influence but don't dominate
    const MOMENTUM_OVERLAY = effectiveWeight('frequency') * 0.25;
    for (const [shortResult, label] of [[rFreqShort, 'freq_30d'], [rHCShort, 'hc_30d']] as const) {
      if (shortResult.status === 'fulfilled') {
        const scores = shortResult.value;
        const maxScore = Math.max(...Object.values(scores), 1e-9);
        for (const [key, score] of Object.entries(scores)) {
          accumulated[key] = (accumulated[key] ?? 0) + (score / maxScore) * MOMENTUM_OVERLAY;
        }
        totalWeight += MOMENTUM_OVERLAY;
        logger.debug({ window: label, weight: MOMENTUM_OVERLAY }, 'C2: ventana de momentum aplicada');
      }
    }

    logger.info(
      {
        adaptive_loaded: Object.keys(dbWeights).length > 0,
        weights_sample: Object.fromEntries(
          Object.entries(ALG_TO_STRATEGY).map(([alg, strat]) => [alg, dbWeights[strat]?.toFixed(3) ?? 'static'])
        ),
      },
      'AnalysisEngine: aggregation con pesos adaptativos'
    );

    // Normalize and rank 100 pairs
    const ranked_pairs: RankedPair[] = [];
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const key = `${x}${y}`;
        ranked_pairs.push({ pair: key, score: totalWeight > 0 ? (accumulated[key] ?? 0) / totalWeight : 0 });
      }
    }
    ranked_pairs.sort((a, b) => b.score - a.score);

    // A1 FIX: When all consensus scores are degenerate (≤ 0.001), the sort preserves
    // iteration order (00→99), producing a useless sequential recommendation.
    // Fall back to pure FrequencyAnalysis ranking — historical pair frequency is always
    // a meaningful signal even with zero backtest data.
    const maxRankedScore = ranked_pairs[0]?.score ?? 0;
    if (maxRankedScore <= 0.001 && rFreq.status === 'fulfilled') {
      const freqScores = rFreq.value;
      const maxFreq = Math.max(...Object.values(freqScores), 1e-9);
      for (const rp of ranked_pairs) {
        rp.score = (freqScores[rp.pair] ?? 0) / maxFreq;
      }
      ranked_pairs.sort((a, b) => {
        if (Math.abs(a.score - b.score) > 1e-9) return b.score - a.score;
        // Deterministic fallback to avoid sequential output
        const hashA = (parseInt(a.pair, 10) * 1103515245 + 12345) % 997;
        const hashB = (parseInt(b.pair, 10) * 1103515245 + 12345) % 997;
        return hashB - hashA;
      });
      logger.info(
        { maxRankedScore, fallback: 'frequency' },
        'AnalysisEngine: scores degenerados — fallback a FrequencyAnalysis para ranking de pares'
      );
    }

    // Load adaptive top_n — preferir apex_adaptive, fallback a la media de todas las estrategias
    let top_n = dbTopN['apex_adaptive'] ?? 15;
    if (!dbTopN['apex_adaptive']) {
      // Si apex no tiene top_n propio aún, estimar desde las estrategias base con mayor peso
      try {
        const topNValues = Object.entries(dbTopN)
          .filter(([s]) => s !== 'apex_adaptive' && s !== 'consensus_top')
          .map(([, v]) => v);
        if (topNValues.length > 0) {
          top_n = Math.round(topNValues.reduce((a, b) => a + b, 0) / topNValues.length);
        }
      } catch { /* keep default */ }
    }

    // ── Cognitive N: load precision metrics from backtest_results_v2 ─────────
    // The agent reads its own accumulated metrics to autonomously determine
    // the mathematically optimal number of pairs to recommend right now.
    let optimal_n = top_n;
    let predicted_effectiveness = 0;
    let cognitive_basis = 'base:adaptive_top_n';

    try {
      // ── Preferir métricas de apex_adaptive (la meta-estrategia que ya integra todos los pesos)
      // Si apex no tiene datos propios, usar la fila con mejor MRR (estrategia más rankeable).
      const { rows: pRows } = await hitdashPool.query<PrecisionSnapshot>(
        `SELECT kelly_fraction, wilson_lower,
                precision_at_3, precision_at_5, precision_at_10,
                expected_rank, sharpe, mrr
         FROM hitdash.backtest_results_v2
         WHERE game_type = $1 AND half = $2
         ORDER BY
           CASE WHEN strategy_name = 'apex_adaptive' THEN 0 ELSE 1 END,
           mrr DESC, hit_rate DESC
         LIMIT 1`,
        [game_type, half]
      );
      if (pRows[0]) {
        const cog = computeCognitiveN(pRows[0]);
        optimal_n              = cog.optimal_n;
        predicted_effectiveness = cog.predicted_effectiveness;
        cognitive_basis        = cog.cognitive_basis;
        logger.info(
          { optimal_n, predicted_effectiveness, cognitive_basis },
          'AnalysisEngine: cognitive N determinado'
        );
      }
    } catch {
      // backtest_results_v2 may be empty — degrade gracefully
    }

    // Centena Plus: top digit at p1 for half='du' (pick3 only)
    let centena_plus: number | undefined;
    if (half === 'du') {
      try {
        const { rows } = await this.ballbotPool.query<{ p1: number }>(
          `SELECT split_part(numbers, ',', 1)::int AS p1
           FROM public.draws
           WHERE game = $1 AND period = $2
             AND created_at >= now() - interval '90 days'
           ORDER BY created_at DESC`,
          [game_type === 'pick3' ? 'p3' : 'p4', draw_type === 'midday' ? 'm' : 'e']
        );
        const p1Counts: number[] = new Array(10).fill(0) as number[];
        for (const r of rows) p1Counts[r.p1]! += 1;
        centena_plus = p1Counts.indexOf(Math.max(...p1Counts));
      } catch {
        // optional — skip silently
      }
    }

    const totalMs = Date.now() - globalStart;
    logger.info(
      { game_type, draw_type, half, succeeded: algorithms_succeeded.length, top_n, duration_ms: totalMs },
      'AnalysisEngine: analyzePairs completado'
    );

    return {
      game_type,
      half,
      draw_type,
      executed_at: new Date(),
      ranked_pairs,
      top_n,
      optimal_n,
      predicted_effectiveness,
      cognitive_basis,
      centena_plus,
      algorithms_succeeded,
      algorithms_failed,
      total_execution_ms: totalMs,
    };
  }
}
