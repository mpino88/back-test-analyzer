// ═══════════════════════════════════════════════════════════════
// HITDASH — Tipos del motor analítico
// ═══════════════════════════════════════════════════════════════

import type { GameType } from './agent.types.js';

export type AnalysisPeriod = 7 | 30 | 90 | 365 | 'all';
export type Position = 'p1' | 'p2' | 'p3' | 'p4';
export type HotColdLabel = 'Hot' | 'Warm' | 'Neutral' | 'Cool' | 'Cold';

// ─── Resultado base de cualquier algoritmo ──────────────────────
export interface AnalysisResult {
  algorithm_name: string;
  algorithm_version: string;
  game_type: GameType;
  period: AnalysisPeriod;
  input_params: Record<string, unknown>;
  output_data: Record<string, unknown>;
  output_summary: string;    // ≤500 chars — para context window del LLM
  execution_ms: number;
}

// ─── Algoritmo 1: Frecuencia ─────────────────────────────────────
export interface FrequencyEntry {
  digit: number;
  count: number;
  freq_relative: number;
  deviation: number;         // freq_relative - 0.10
  rank: number;
}

export interface FrequencyResult extends AnalysisResult {
  output_data: {
    by_position: Record<Position, FrequencyEntry[]>;
    total_draws: number;
  };
}

// ─── Algoritmo 2: Gap Analysis ───────────────────────────────────
export interface GapEntry {
  digit: number;
  position: Position;
  gap_actual: number;        // días desde última aparición
  gap_promedio: number;      // gap promedio histórico
  overdue_score: number;     // gap_actual / gap_promedio
  is_overdue: boolean;       // overdue_score > 1.5
  is_recent: boolean;        // overdue_score < 0.5
}

export interface GapResult extends AnalysisResult {
  output_data: {
    by_position: Record<Position, GapEntry[]>;
  };
}

// ─── Algoritmo 3: Hot/Cold ───────────────────────────────────────
export interface HotColdEntry {
  digit: number;
  position: Position;
  z_score_7d: number;
  z_score_90d: number;
  label_7d: HotColdLabel;
  label_90d: HotColdLabel;
  trend_change: boolean;     // cambio de label entre 7d y 90d
}

export interface HotColdResult extends AnalysisResult {
  output_data: {
    by_position: Record<Position, HotColdEntry[]>;
  };
}

// ─── Algoritmo 4: Pair Correlation ──────────────────────────────
export interface PairEntry {
  positions: [Position, Position];
  digit_a: number;
  digit_b: number;
  observed_freq: number;
  expected_freq: number;
  correlation_ratio: number;
}

export interface PairResult extends AnalysisResult {
  output_data: {
    top_pairs: PairEntry[];
    total_draws: number;
  };
}

// ─── Algoritmo 5: Fibonacci/Pisano ──────────────────────────────
export interface FibonacciEntry {
  digit: number;
  position: Position;
  current_pisano_index: number;
  alignment_score: number;   // ratio freq-en-pisano vs freq-general
  is_aligned: boolean;       // alignment_score > 1.1
}

export interface FibonacciResult extends AnalysisResult {
  output_data: {
    pisano_sequence_mod10: number[];  // primeros 60 términos
    current_index: number;           // sorteo_secuencial mod 60
    by_position: Record<Position, FibonacciEntry[]>;
  };
}

// ─── Algoritmo 6: Streak Detection ──────────────────────────────
export type StreakType = 'presence' | 'absence';

export interface StreakEntry {
  digit: number;
  position: Position;
  streak_type: StreakType;
  current_length: number;
  mean_length: number;
  std_dev_length: number;
  alert_level: 'none' | 'watch' | 'alert';  // alert: > mean + 2*std
  is_anomaly: boolean;
}

export interface StreakResult extends AnalysisResult {
  output_data: {
    active_streaks: StreakEntry[];
    anomalies: StreakEntry[];
  };
}

// ─── Algoritmo 7: Position Analysis ─────────────────────────────
export interface PositionBias {
  position: Position;
  chi_square: number;
  p_value: number;
  degrees_of_freedom: number;
  bias_detected: boolean;    // p_value < 0.05
  top_digit: number;
  top_digit_freq: number;
}

export interface PositionResult extends AnalysisResult {
  output_data: {
    heatmap: Record<Position, Record<number, number>>;  // {p1: {0: 0.08, 1: 0.12, ...}}
    position_bias: PositionBias[];
  };
}

// ─── Algoritmo 8: Moving Averages ───────────────────────────────
export type MASignal = 'bullish' | 'bearish' | 'neutral';

export interface MAEntry {
  digit: number;
  position: Position;
  sma_7: number;
  sma_14: number;
  sma_30: number;
  ema: number;
  signal: MASignal;
  crossover_detected: boolean;
}

export interface MAResult extends AnalysisResult {
  output_data: {
    by_position: Record<Position, MAEntry[]>;
    signals_bullish: Array<{ digit: number; position: Position }>;
    signals_bearish: Array<{ digit: number; position: Position }>;
  };
}

// ─── Pesos de algoritmos (weighted consensus) ────────────────────
export const ALGORITHM_WEIGHTS: Record<string, number> = {
  frequency:         1.0,
  gap_analysis:      0.9,
  hot_cold:          0.85,
  position:          0.8,
  pairs_correlation: 0.75,
  moving_averages:   0.7,
  streak:            0.65,
  fibonacci_pisano:  0.3,   // experimental — penalizado
  // ─── Ballbot Clones (agentic strategies v2) ────────────────────
  bayesian_score:    1.1,   // multi-señal 6 componentes — peso máximo
  transition_follow: 0.85,  // Markov-1 secuencial sucesor
  markov_order2:     0.80,  // Markov-2 estado compuesto (X→Y)→Z
  calendar_pattern:  0.70,  // sesgo temporal DoW×mes diagonal
  decade_family:     0.75,  // familias 00-09...90-99 momentum
  max_per_week_day:  0.55,  // frecuencia por día de semana
};

// ─── Score por dígito/posición ───────────────────────────────────
export interface DigitSignal {
  digit: number;
  algorithm: string;
  score: number;             // 0.0-1.0 normalizado
  reason: string;
}

export interface ConsensusScore {
  digit: number;
  position: Position;
  consensus_score: number;   // promedio ponderado
  signals: DigitSignal[];
  algorithms_count: number;  // cuántos algoritmos lo señalaron
}

// ─── Par-based types (v2 redesign) ──────────────────────────────
// Objeto de predicción: par ordenado de 2 dígitos "00"–"99"
// Pick3 → half='du' (decena+unidad = p2+p3)
// Pick4 → half='ab' (p1+p2) o 'cd' (p3+p4), análisis independientes
export type PairHalf = 'du' | 'ab' | 'cd';

export interface RankedPair {
  pair:  string;   // "00"–"99", siempre 2 caracteres
  score: number;   // 0.0–∞, mayor = más probable
}

// Función base de todas las estrategias v2
// Import DrawEntry from BacktestEngine at runtime to avoid circular deps
export type PairRankFn = (draws: import('../backtest/BacktestEngine.js').DrawEntry[], half: PairHalf) => RankedPair[];

export interface PairEvalPoint {
  draw_index:        number;
  eval_date:         string;
  top_pairs:         string[];   // top-N pares recomendados para este punto
  centena_plus:      number;     // top-1 dígito p1 (bonus)
  actual_pair:       string;     // par real del sorteo (e.g. "37")
  hit_pair:          boolean;    // actual_pair ∈ top_pairs
  hit_centena_plus:  boolean;
  top_n_used:        number;     // N adaptativo usado en este punto
  // ── Precision fields (007) ──────────────────────────────────
  actual_pair_rank:  number;     // Posición (1–100) del par real en el ranking completo
  actual_pair_score: number;     // Score normalizado [0,1] asignado al par real
  reciprocal_rank:   number;     // 1 / actual_pair_rank
}

export interface PairPrecisionMetrics {
  // Calidad de ranking
  mrr:             number;   // Mean Reciprocal Rank [0,1] — cuán alto rankea el par real
  expected_rank:   number;   // Rank promedio del par real (1=perfecto, 100=peor)

  // Calibración
  brier_score:     number;   // Error cuadrático medio de probabilidades [0,1], lower=better

  // Precision@K — ¿en qué % el par real cae en top-K?
  precision_at_3:  number;
  precision_at_5:  number;
  precision_at_10: number;

  // Intervalo de confianza Wilson 95%
  wilson_lower:    number;
  wilson_upper:    number;

  // Significancia estadística vs baseline 10%
  cohens_h:        number;   // Effect size (>0.8 = large, 0.5–0.8 = medium, 0.2–0.5 = small)
  p_value:         number;   // Binomial p-value (< 0.05 = significativo)

  // Estabilidad de la señal
  cv_hit_rate:     number;   // Coeficiente de variación (std/mean): más bajo = más estable
  sharpe:          number;   // hit_rate / std_rolling — rendimiento ajustado por riesgo

  // Momentum y resistencia
  max_miss_streak: number;   // Mayor racha consecutiva de misses
  autocorr_lag1:   number;   // Autocorrelación de hit/miss en lag-1 (>0=momentum, <0=alternancia)

  // Fracción óptima de cobertura
  kelly_fraction:  number;   // Kelly criterion: fracción óptima del espacio a cubrir
}

export interface PairBacktestSummary {
  strategy_name:     string;
  game_type:         'pick3' | 'pick4';
  mode:              import('../backtest/BacktestEngine.js').BacktestMode;
  half:              PairHalf;
  total_eval_pts:    number;
  hits_pair:         number;
  centena_plus_hits: number;
  hit_rate:          number;
  centena_plus_acc:  number;
  avg_top_n:         number;
  final_top_n:       number;
  date_from:         string;
  date_to:           string;
  run_duration_ms:   number;
  points:            PairEvalPoint[];
  // ── Precision metrics (007) ──────────────────────────────────
  precision:         PairPrecisionMetrics;
}

export interface PairAnalysis {
  game_type:            import('../types/agent.types.js').GameType;
  half:                 PairHalf;
  draw_type:            import('../types/agent.types.js').DrawType;
  executed_at:          Date;
  ranked_pairs:         RankedPair[];  // 100 pares, ordenados desc por score
  top_n:                number;        // N adaptativo histórico (DB)
  // ── Cognitive N (auto-computed from own precision metrics) ───────
  optimal_n:                number;   // N cognitivo óptimo para esta predicción
  predicted_effectiveness:  number;   // Efectividad mínima estimada [0,1] (Wilson CI lower)
  cognitive_basis:          string;   // Traza del razonamiento: "kelly=0.12 p@5=18% rank_avg=41"
  // ────────────────────────────────────────────────────────────────
  centena_plus?:        number;        // solo para half='du' (pick3)
  algorithms_succeeded: string[];
  algorithms_failed:    Array<{ name: string; error: string }>;
  total_execution_ms:   number;
}

// ─── Algoritmos Ballbot Clonados (agentic v2) ───────────────────

export interface BayesianScoreResult extends AnalysisResult {
  output_data: {
    vectors: Array<{
      pair:         string;
      score:        number;   // 0-100 agregado
      freq:         number;   // S1 frecuencia normalizada
      gap:          number;   // S2 due-factor
      momentum:     number;   // S3 reciente vs global
      cycle:        number;   // S4 ciclo periódico
      markov:       number;   // S5 max P(par|anterior)
      cold_streak:  number;   // S6 racha fría normalizada
    }>;
  };
}

export interface TransitionFollowResult extends AnalysisResult {
  output_data: {
    matrix_size:      number;
    top_transitions:  Array<{ from: string; to: string; count: number; probability: number }>;
  };
}

export interface MarkovOrder2Result extends AnalysisResult {
  output_data: {
    state_count:      number;
    top_transitions:  Array<{ state: string; to: string; count: number; probability: number }>;
  };
}

export interface CalendarPatternResult extends AnalysisResult {
  output_data: {
    target_dow:   number;   // 0=Sunday…6=Saturday
    target_month: number;   // 1-12
    top_pairs:    Array<{ pair: string; score: number; dow_hits: number; month_hits: number }>;
  };
}

export interface DecadeFamilyResult extends AnalysisResult {
  output_data: {
    families: Array<{
      decade:    number;           // 0..9 → grupos 00-09, 10-19, …
      momentum:  number;
      top_pairs: string[];
    }>;
    top_pairs: Array<{ pair: string; score: number; family: number }>;
  };
}

export interface MaxPerWeekDayResult extends AnalysisResult {
  output_data: {
    target_dow: number;
    top_pairs:  Array<{ pair: string; count: number; freq: number }>;
  };
}

// ─── Resultado agregado del motor completo ───────────────────────
export interface ComprehensiveAnalysis {
  game_type: GameType;
  period: AnalysisPeriod;
  executed_at: Date;
  algorithms_succeeded: string[];
  algorithms_failed: Array<{ name: string; error: string }>;
  total_execution_ms: number;
  by_position: Record<Position, {
    consensus_scores: ConsensusScore[];
    top_digits: number[];      // top 3 dígitos por consensus_score
  }>;
  recommended_digits_per_position: Record<Position, number[]>;  // condensado para LLM
}
