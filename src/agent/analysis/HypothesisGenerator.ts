// ═══════════════════════════════════════════════════════════════
// HELIX — HypothesisGenerator v1.0.0
//
// Convierte señales de anomalía (AnomalySignal) en hipótesis
// testables con predicciones específicas y umbrales de validación.
//
// Reglas de generación:
//   • Solo genera si signal.confidence >= 0.80 (p_value <= 0.20)
//   • No regenera hipótesis rechazadas en últimos 90 días
//     (UNIQUE constraint en DB por condition_json)
//   • Cada hipótesis tiene predicted_hit_rate calculado según z_score
//   • Persiste con validation_status = 'pending'
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../types/agent.types.js';
import type { AnomalySignal, AnomalyType } from './AnomalyDetector.js';

const logger = pino({ name: 'HypothesisGenerator' });

const MIN_CONFIDENCE = 0.80;   // p < 0.20
const REJECT_COOLDOWN_DAYS = 90; // no regenerar rechazadas antes de 90 días

// ─── Tipos exportados ─────────────────────────────────────────
export type HypothesisType =
  | 'positional_bias'
  | 'temporal_pattern'
  | 'absence_streak'
  | 'cross_draw_dependency'
  | 'family_clustering';

export interface HypothesisCondition {
  type:       AnomalyType;
  position?:  string;
  value:      string;
  direction:  'over' | 'under';
  window:     number;
  z_score:    number;
}

export interface Hypothesis {
  id:               string;
  game_type:        GameType;
  draw_type:        DrawType;
  hypothesis_type:  HypothesisType;
  condition:        HypothesisCondition;
  predicted_pair?:       string;
  predicted_digit?:      number;
  predicted_position?:   string;
  predicted_hit_rate:    number;
  confidence_basis:      string;
  minimum_sample:        number;
  validation_window:     number;
  anomaly_signal_id?:    string;
  validation_status:     'pending' | 'validated' | 'rejected';
  validation_hit_rate?:  number;
  validation_lift?:      number;
  validation_p_value?:   number;
  validation_draws?:     number;
  created_at:       Date;
  validated_at?:    Date;
}

export class HypothesisGenerator {
  constructor(private readonly pool: Pool) {}

  async generateFromSignals(
    signals:   AnomalySignal[],
    game_type: GameType,
    draw_type: DrawType
  ): Promise<Hypothesis[]> {
    // Filtrar solo señales con confianza suficiente
    const strong = signals.filter(s => s.confidence >= MIN_CONFIDENCE);
    if (strong.length === 0) return [];

    // Cargar hipótesis rechazadas recientes (para no regenerar)
    const recentRejected = await this.loadRejectedConditions(game_type, draw_type);

    const generated: Hypothesis[] = [];

    for (const signal of strong) {
      const hyp = this.buildHypothesis(signal, game_type, draw_type);
      if (!hyp) continue;

      // Verificar si ya fue rechazada recientemente
      const conditionKey = JSON.stringify(hyp.condition);
      if (recentRejected.has(conditionKey)) {
        logger.debug({ signal: signal.value, type: signal.type }, 'HypothesisGenerator: skip — rechazada recientemente');
        continue;
      }

      // Persistir (ON CONFLICT DO NOTHING por UNIQUE constraint)
      const saved = await this.persist(hyp);
      if (saved) generated.push({ ...hyp, id: '', created_at: new Date() } as Hypothesis);
    }

    logger.info({
      game_type, draw_type,
      signals_input:      strong.length,
      hypotheses_created: generated.length,
    }, 'HypothesisGenerator: generación completada');

    return generated;
  }

  // ─── Construcción de hipótesis desde señal ───────────────────
  private buildHypothesis(
    signal:    AnomalySignal,
    game_type: GameType,
    draw_type: DrawType
  ): Omit<Hypothesis, 'id' | 'created_at'> | null {

    const condition: HypothesisCondition = {
      type:      signal.type,
      position:  signal.position,
      value:     signal.value,
      direction: signal.direction,
      window:    signal.window,
      z_score:   signal.z_score,
    };

    const absZ = Math.abs(signal.z_score);

    switch (signal.type) {
      case 'pair_absence_streak': {
        // Par sobredebido → alta probabilidad de aparecer pronto
        const predicted_hit_rate = Math.min(0.45, 0.01 * (1 + absZ * 0.08));
        return {
          game_type, draw_type,
          hypothesis_type:    'absence_streak',
          condition,
          predicted_pair:     signal.value,
          predicted_hit_rate: +predicted_hit_rate.toFixed(4),
          confidence_basis:   `z=${signal.z_score} window=${signal.window} p=${signal.p_value}`,
          minimum_sample:     20,
          validation_window:  60,
          anomaly_signal_id:  signal.id,
          validation_status:  'pending',
        };
      }

      case 'pair_overrepresentation': {
        // Par sobre-frecuente → esperar regresión a la media
        // La hipótesis es: este par NO aparecerá en los próximos N draws
        // (señal contraria — usada para reducir score en consensus)
        const predicted_hit_rate = Math.max(0.005, 0.01 * (1 - absZ * 0.03));
        return {
          game_type, draw_type,
          hypothesis_type:    'absence_streak',  // mismo bucket, dirección 'under'
          condition,
          predicted_pair:     signal.value,
          predicted_hit_rate: +predicted_hit_rate.toFixed(4),
          confidence_basis:   `over-rep z=${signal.z_score} window=${signal.window}`,
          minimum_sample:     20,
          validation_window:  60,
          anomaly_signal_id:  signal.id,
          validation_status:  'pending',
        };
      }

      case 'positional_digit_bias': {
        // Dígito anómalo en posición → recomienda o penaliza ese dígito
        const predicted_hit_rate = signal.direction === 'over'
          ? Math.min(0.40, 0.10 * (1 + absZ * 0.05))
          : Math.max(0.02, 0.10 * (1 - absZ * 0.03));

        return {
          game_type, draw_type,
          hypothesis_type:     'positional_bias',
          condition,
          predicted_digit:     parseInt(signal.value, 10),
          predicted_position:  signal.position,
          predicted_hit_rate:  +predicted_hit_rate.toFixed(4),
          confidence_basis:    `z=${signal.z_score} pos=${signal.position} window=${signal.window}`,
          minimum_sample:      15,
          validation_window:   60,
          anomaly_signal_id:   signal.id,
          validation_status:   'pending',
        };
      }

      case 'day_of_week_bias': {
        // Sesgo por día de semana — hipótesis temporal
        // signal.value = "MON:37" → lunes el par 37 aparece más
        const [dow, pair] = signal.value.split(':');
        if (!dow || !pair) return null;

        return {
          game_type, draw_type,
          hypothesis_type:    'temporal_pattern',
          condition,
          predicted_pair:     pair,
          predicted_hit_rate: Math.min(0.35, 0.01 * (1 + absZ * 0.06)),
          confidence_basis:   `DoW=${dow} pair=${pair} p=${signal.p_value}`,
          minimum_sample:     15,
          validation_window:  90,  // más largo: necesita varios ejemplos por día
          anomaly_signal_id:  signal.id,
          validation_status:  'pending',
        };
      }

      case 'cross_position_coupling': {
        // Co-ocurrencia anómala entre posiciones (Pick4)
        // signal.value = "3-7" → p1=3 y p3=7 co-ocurren más
        return {
          game_type, draw_type,
          hypothesis_type:    'cross_draw_dependency',
          condition,
          predicted_hit_rate: Math.min(0.30, 0.01 * (1 + absZ * 0.05)),
          confidence_basis:   `cross=${signal.value} pos=${signal.position} z=${signal.z_score}`,
          minimum_sample:     20,
          validation_window:  60,
          anomaly_signal_id:  signal.id,
          validation_status:  'pending',
        };
      }

      default:
        return null;
    }
  }

  // ─── Persistir en DB (ON CONFLICT DO NOTHING) ─────────────────
  private async persist(hyp: Omit<Hypothesis, 'id' | 'created_at'>): Promise<boolean> {
    try {
      const { rowCount } = await this.pool.query(
        `INSERT INTO hitdash.hypotheses
           (game_type, draw_type, hypothesis_type, condition_json,
            predicted_pair, predicted_digit, predicted_position,
            predicted_hit_rate, confidence_basis, anomaly_signal_id,
            minimum_sample, validation_window, validation_status)
         VALUES ($1,$2,$3,$4::jsonb,$5,$6,$7,$8,$9,$10,$11,$12,'pending')
         ON CONFLICT (game_type, draw_type, hypothesis_type, condition_json)
         DO NOTHING`,
        [
          hyp.game_type, hyp.draw_type, hyp.hypothesis_type,
          JSON.stringify(hyp.condition),
          hyp.predicted_pair     ?? null,
          hyp.predicted_digit    ?? null,
          hyp.predicted_position ?? null,
          hyp.predicted_hit_rate,
          hyp.confidence_basis,
          hyp.anomaly_signal_id  ?? null,
          hyp.minimum_sample,
          hyp.validation_window,
        ]
      );
      return (rowCount ?? 0) > 0;
    } catch (err) {
      logger.warn({ error: String(err) }, 'HypothesisGenerator: error persistiendo hipótesis');
      return false;
    }
  }

  // ─── Cargar condiciones rechazadas (para no regenerar) ────────
  private async loadRejectedConditions(
    game_type: GameType,
    draw_type: DrawType
  ): Promise<Set<string>> {
    try {
      const { rows } = await this.pool.query(
        `SELECT condition_json::text FROM hitdash.hypotheses
         WHERE game_type = $1 AND draw_type = $2
           AND validation_status = 'rejected'
           AND created_at >= now() - interval '${REJECT_COOLDOWN_DAYS} days'`,
        [game_type, draw_type]
      );
      return new Set(rows.map(r => r.condition_json));
    } catch {
      return new Set();
    }
  }

  // ─── Cargar hipótesis pendientes para validación ──────────────
  async loadPending(
    game_type: GameType,
    draw_type: DrawType
  ): Promise<Hypothesis[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id::text, game_type, draw_type, hypothesis_type,
                condition_json, predicted_pair, predicted_digit,
                predicted_position, predicted_hit_rate, confidence_basis,
                anomaly_signal_id, minimum_sample, validation_window,
                validation_status, created_at
         FROM hitdash.hypotheses
         WHERE game_type = $1 AND draw_type = $2
           AND validation_status = 'pending'
         ORDER BY created_at DESC LIMIT 20`,
        [game_type, draw_type]
      );
      return rows.map(r => ({
        ...r,
        condition: r.condition_json as HypothesisCondition,
        created_at: new Date(r.created_at),
      }));
    } catch {
      return [];
    }
  }
}
