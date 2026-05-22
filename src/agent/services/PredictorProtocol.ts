// ═══════════════════════════════════════════════════════════════
// HELIX — PredictorProtocol v1.0.0 (2026-05-21)
//
// FOUNDATION RUTA B: abstract interface para que el motor HELIX
// pueda predecir CUALQUIER time-series, no solo loterías.
//
// Implementaciones futuras planeadas:
//   • LotteryPredictor (current, pick3/pick4)
//   • SportsLinePredictor (líneas de spread, total points)
//   • CryptoMicrostructurePredictor (Hawkes order flow)
//   • InsuranceClaimPredictor (multivariate clustering)
//   • RetailDemandPredictor (long-tail SKUs)
//
// Cualquier dominio que cumpla este protocolo recibe AUTOMÁTICAMENTE:
//   • Bayesian Thompson Sampling
//   • Conformal coverage guarantees
//   • Walk-forward validation
//   • Edge Discovery testing
//   • Truth Certificates
//
// Esto convierte HELIX en una PLATAFORMA (no producto de loto).
// ═══════════════════════════════════════════════════════════════

/**
 * Generic observation: a timestamped data point.
 * For lottery: {timestamp, value: {p1,p2,p3,p4}, metadata: {draw_type}}
 * For sports:  {timestamp, value: {spread, total, score}, metadata: {teams}}
 * For crypto:  {timestamp, value: {price, volume}, metadata: {symbol}}
 */
export interface TimeSeriesObservation<TValue = unknown> {
  timestamp: string;     // ISO 8601
  value:     TValue;
  metadata?: Record<string, unknown>;
}

/**
 * Domain enumeration. Each domain has its own prediction semantics.
 */
export type PredictionDomain =
  | 'lottery'      // pick3/pick4 pairs
  | 'sports'       // line/spread/total
  | 'crypto'       // price/orderflow
  | 'insurance'    // claim clustering
  | 'retail';      // demand SKU

/**
 * Prediction target specification.
 */
export interface PredictionTarget {
  domain:             PredictionDomain;
  target_type:        string;                // 'pair' | 'line' | 'price' | 'cluster' | 'demand'
  cardinality:        number;                 // size of outcome space (100 for pick pairs, 2 for lines)
  prediction_window?: string;                 // e.g. '1d', '1h', '5m'
  context?:           Record<string, unknown>; // domain-specific
}

/**
 * Single prediction emitted by a predictor.
 * Always includes top-N ranking + per-outcome confidence.
 */
export interface Prediction {
  prediction_id:    string;
  target:           PredictionTarget;
  generated_at:     string;
  top_outcomes:     string[];                  // ranked, top-N
  outcome_scores:   Record<string, number>;    // outcome → consensus score
  confidence_interval?: {
    lo:    number;
    hi:    number;
    level: number;        // 0.95
  };
  conformal_set?: {
    set:              string[];
    coverage_target:  number;  // 0.80
    coverage_proven:  boolean; // true if calibrated
  };
  metadata?: Record<string, unknown>;
}

/**
 * Outcome (truth) used for feedback.
 */
export interface Outcome {
  prediction_id: string;
  timestamp:     string;
  actual:        string;
  metadata?:     Record<string, unknown>;
}

/**
 * Statistics accumulated by a predictor over its history.
 */
export interface PredictorStatistics {
  n_predictions:    number;
  n_outcomes:       number;
  hit_rate:         number | null;
  wilson_95_ci:     { lo: number; hi: number } | null;
  baseline_rate:    number;
  edge_multiplier:  number | null;
  conformal_empirical_coverage: number | null;
}

// ─────────────────────────────────────────────────────────────────
// THE PROTOCOL — every predictor implements this
// ─────────────────────────────────────────────────────────────────
export interface PredictorProtocol<TObservation = unknown, TPrediction extends Prediction = Prediction> {
  /** Domain this predictor handles (for routing). */
  readonly domain: PredictionDomain;

  /**
   * Ingest a batch of observations into the predictor's state.
   * Should be idempotent for the same observations.
   */
  ingest(observations: TimeSeriesObservation<TObservation>[]): Promise<{ ingested: number; skipped: number }>;

  /**
   * Generate a prediction for the given target using ALL data ingested so far.
   * Used for live predictions.
   */
  predict(target: PredictionTarget): Promise<TPrediction>;

  /**
   * Generate a prediction USING ONLY DATA UP TO a point in time.
   * Critical for walk-forward backtesting — must not leak future data.
   * This is what makes the predictor genuinely auditable.
   */
  predictAtPointInTime(target: PredictionTarget, as_of: string): Promise<TPrediction>;

  /**
   * Record the outcome of a previous prediction.
   * Triggers Bayesian update (Thompson α/β), drift detection, etc.
   */
  recordOutcome(outcome: Outcome): Promise<void>;

  /**
   * Get accumulated statistics — for transparency reporting.
   */
  getStatistics(target?: PredictionTarget): Promise<PredictorStatistics>;

  /**
   * Get conformal coverage guarantee (theorem-based, not estimated).
   * Returns null if not calibrated yet.
   */
  getConformalGuarantee(target: PredictionTarget): Promise<{
    threshold:        number;
    coverage_target:  number;
    n_calibration:    number;
  } | null>;
}

// ─────────────────────────────────────────────────────────────────
// Adapter — current LotteryPredictor wraps AnalysisEngine + retro
// ─────────────────────────────────────────────────────────────────
// Para mantener compatibilidad mientras se generaliza, definimos
// LotteryPredictor que adapta el código actual al protocolo.
// Implementación pendiente — esto es solo la INTERFACE foundation.
//
// Pseudo-código:
//
//   class LotteryPredictor implements PredictorProtocol<LotteryDraw, LotteryPrediction> {
//     readonly domain = 'lottery';
//     constructor(private analysisEngine, private retroSimulator, private conformal) {}
//
//     async predict(target) {
//       const r = await this.analysisEngine.analyzePairs(target.context.game_type, ...);
//       return { ...r, ... };
//     }
//
//     async predictAtPointInTime(target, as_of) {
//       return await this.retroSimulator.predictAtTime(client, opts, as_of);
//     }
//
//     async getStatistics(target) {
//       const r = await query('SELECT * FROM helix_retrospective_summary WHERE...');
//       return { hit_rate: r.hit_rate, wilson_95_ci: {lo, hi}, ... };
//     }
//
//     async getConformalGuarantee(target) {
//       const c = await query('SELECT * FROM conformal_calibration WHERE...');
//       return c ? { threshold: c.threshold_80, ... } : null;
//     }
//   }
//
// Implementación completa en próxima fase Ruta B.
// ─────────────────────────────────────────────────────────────────
