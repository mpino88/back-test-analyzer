// ═══════════════════════════════════════════════════════════════
// HELIX — KronosAutoLearningBridge v1.0.0
//
// Conecta el AutoLearningLoop con KRONOS (PPSService).
// Cuando una hipótesis es validada y activa una micro-estrategia,
// los algoritmos de HELIX que detectan ese tipo de patrón reciben
// un micro-refuerzo en su PPS (Predictive Power Score).
// Cuando una estrategia es RETIRED, esos mismos algoritmos
// reciben un micro-penalización.
//
// PRINCIPIO: si el AnomalyDetector detectó un patrón real
// (validado estadísticamente con lift > 1.5x), los algoritmos
// que capturan ese patrón merecen más peso en el consenso.
//
// Factores conservadores por diseño:
//   ACTIVATED  → pps * 1.04  (4% boost, capped a 95)
//   CONSOLIDATED → pps * 1.08 (8% boost, capped a 95)
//   DEGRADING  → pps * 0.98  (2% penalización)
//   RETIRED    → pps * 0.94  (6% penalización, floor en 20)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../types/agent.types.js';
import type { AnomalyType } from '../analysis/AnomalyDetector.js';
import type { HypothesisType } from '../analysis/HypothesisGenerator.js';
import type { LifecycleStatus } from '../services/StrategyLifecycleManager.js';

const logger = pino({ name: 'KronosAutoLearningBridge' });

// ─── Mapeo: AnomalyType → algoritmos HELIX que lo detectan ───────────────
// Cada tipo de anomalía se correlaciona con los algoritmos que capturan
// ese mismo patrón en sus ventanas de análisis.
const ANOMALY_TO_ALGOS: Record<AnomalyType, string[]> = {
  positional_digit_bias:   ['position_analysis', 'hot_cold', 'frequency_analysis'],
  pair_absence_streak:     ['gap_analysis', 'streak_detection', 'pair_return_cycle'],
  pair_overrepresentation: ['frequency_analysis', 'bayesian_score', 'hot_cold'],
  cross_position_coupling: ['pairs_correlation', 'markov_order2', 'cross_draw_correlation'],
  day_of_week_bias:        ['calendar_pattern', 'max_per_week_day'],
};

// ─── Mapeo: HypothesisType → AnomalyType base ────────────────────────────
const HYPO_TO_ANOMALY: Record<HypothesisType, AnomalyType> = {
  positional_bias:       'positional_digit_bias',
  absence_streak:        'pair_absence_streak',
  temporal_pattern:      'day_of_week_bias',
  cross_draw_dependency: 'cross_position_coupling',
  family_clustering:     'pair_overrepresentation',
};

// ─── Factores de ajuste PPS ───────────────────────────────────────────────
const FACTORS: Record<string, { factor: number; cap: number; floor: number }> = {
  activated:    { factor: 1.04, cap: 95, floor: 0  },
  consolidated: { factor: 1.08, cap: 95, floor: 0  },
  degrading:    { factor: 0.98, cap: 100, floor: 10 },
  retired:      { factor: 0.94, cap: 100, floor: 10 },
};

export class KronosAutoLearningBridge {
  constructor(private readonly pool: Pool) {}

  // ─── Llamar cuando una hipótesis es validada y la estrategia activada ──
  async onStrategyActivated(params: {
    hypothesis_type: HypothesisType;
    anomaly_type?:   AnomalyType;
    game_type:       GameType;
    draw_type:       DrawType;
    half:            string;
    lift:            number;
  }): Promise<void> {
    // Si el lift es muy alto (> 3x), el refuerzo es más fuerte
    const event    = params.lift >= 3 ? 'consolidated' : 'activated';
    const anomaly  = params.anomaly_type ?? HYPO_TO_ANOMALY[params.hypothesis_type];
    const algos    = anomaly ? ANOMALY_TO_ALGOS[anomaly] : [];

    if (algos.length === 0) return;

    await this.applyFactor(algos, params.game_type, params.draw_type, params.half, event);

    logger.info(
      { algos, event, game_type: params.game_type, draw_type: params.draw_type, lift: params.lift },
      'KronosAutoLearningBridge: PPS reforzado por hipótesis validada'
    );
  }

  // ─── Llamar en cada transición de lifecycle de una estrategia ────────────
  async onLifecycleTransition(params: {
    hypothesis_type?: HypothesisType;
    anomaly_type?:    AnomalyType;
    game_type:        GameType;
    draw_type:        DrawType;
    half:             string;
    new_status:       LifecycleStatus;
    previous_status:  LifecycleStatus;
  }): Promise<void> {
    const { new_status, previous_status } = params;

    // Solo actuar en transiciones significativas
    if (new_status === previous_status) return;

    const event = new_status === 'consolidated' ? 'consolidated'
                : new_status === 'degrading'    ? 'degrading'
                : new_status === 'retired'       ? 'retired'
                : null;

    if (!event) return;

    const anomaly = params.anomaly_type
      ?? (params.hypothesis_type ? HYPO_TO_ANOMALY[params.hypothesis_type] : undefined);
    const algos   = anomaly ? ANOMALY_TO_ALGOS[anomaly] : [];

    if (algos.length === 0) return;

    await this.applyFactor(algos, params.game_type, params.draw_type, params.half, event);

    logger.info(
      { algos, event, from: previous_status, to: new_status, game_type: params.game_type },
      `KronosAutoLearningBridge: PPS ajustado por transición ${previous_status} → ${new_status}`
    );
  }

  // ─── Aplicar factor PPS a lista de algoritmos ────────────────────────────
  private async applyFactor(
    algos:     string[],
    game_type: GameType,
    draw_type: DrawType,
    half:      string,
    event:     string
  ): Promise<void> {
    const cfg = FACTORS[event];
    if (!cfg) return;

    for (const algo_name of algos) {
      try {
        await this.pool.query(
          `UPDATE hitdash.pps_state
           SET pps        = LEAST($1, GREATEST($2, ROUND((pps * $3)::numeric, 2))),
               updated_at = now()
           WHERE algo_name  = $4
             AND game_type  = $5
             AND draw_type  = $6
             AND half       = $7`,
          [cfg.cap, cfg.floor, cfg.factor, algo_name, game_type, draw_type, half]
        );
      } catch (err) {
        // No bloquear — si pps_state no tiene ese algo todavía, es normal
        logger.debug({ algo_name, error: String(err) }, 'KronosAutoLearningBridge: pps_state row no encontrado (normal si no hay historial)');
      }
    }
  }
}
