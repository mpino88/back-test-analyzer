// ═══════════════════════════════════════════════════════════════
// HELIX — StrategyLifecycleManager v1.0.0
//
// Gestiona el ciclo de vida de micro-estrategias dinámicas
// generadas desde hipótesis validadas.
//
// Estados:
//   MONITORING  → recién activada, < 5 draws de observación
//   ACTIVE      → operativa, influye en las recomendaciones
//   DEGRADING   → hit_rate cayendo / consecutive_misses >= 3
//   RETIRED     → descartada automáticamente
//   CONSOLIDATED→ 5+ hits en 10 draws → pasa a ser semi-permanente
//
// Transiciones:
//   MONITORING(< 5 draws) → ACTIVE
//   ACTIVE → DEGRADING   (consecutive_misses >= 3)
//   ACTIVE → CONSOLIDATED (hits >= 5 en últimos 10)
//   DEGRADING → RETIRED  (consecutive_misses >= 3 en DEGRADING)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../types/agent.types.js';
import type { Hypothesis } from '../analysis/HypothesisGenerator.js';
import type { ValidationResult } from '../analysis/HypothesisValidator.js';
import { KronosAutoLearningBridge }  from '../learning/KronosAutoLearningBridge.js';

// Re-export de ValidationResult para uso en AutoLearningLoop
export type { ValidationResult };

const logger = pino({ name: 'StrategyLifecycleManager' });

export type LifecycleStatus = 'monitoring' | 'active' | 'degrading' | 'retired' | 'consolidated';

export interface DynamicStrategy {
  id:              string;
  game_type:       GameType;
  draw_type:       DrawType;
  hypothesis_id?:  string;
  name:            string;
  description?:    string;
  strategy_type:   'pair_bias' | 'digit_bias' | 'temporal' | 'cross_draw' | 'family';
  target_pairs?:   string[];
  target_digits?:  { p1?: number[]; p2?: number[]; p3?: number[]; p4?: number[] };
  score_boost:     number;
  lifecycle_status: LifecycleStatus;
  draws_active:    number;
  hits_in_prod:    number;
  misses_in_prod:  number;
  consecutive_misses: number;
  activation_hit_rate?: number;
  min_expected_hit_rate?: number;
  contribution_count: number;
  created_at:      Date;
  activated_at?:   Date;
}

export interface LifecycleUpdate {
  strategy_id:      string;
  strategy_name:    string;
  previous_status:  LifecycleStatus;
  new_status:       LifecycleStatus;
  hit:              boolean | null;
  consecutive_misses: number;
}

export class StrategyLifecycleManager {
  private readonly kronosBridge: KronosAutoLearningBridge;

  constructor(private readonly pool: Pool) {
    this.kronosBridge = new KronosAutoLearningBridge(pool);
  }

  // ─── Activar estrategia desde hipótesis validada ──────────────
  async activateFromHypothesis(
    hypothesis: Hypothesis,
    valResult:  { hit_rate: number; lift: number }
  ): Promise<DynamicStrategy | null> {
    try {
      // Determinar tipo y targets
      const { strategy_type, target_pairs, target_digits, name, description } =
        this.buildStrategyFromHypothesis(hypothesis);

      const minExpected = valResult.hit_rate * 0.60; // 60% del hit rate de validación
      const boost       = Math.min(0.30, 0.10 + valResult.lift * 0.02);

      const { rows } = await this.pool.query<{ id: string }>(
        `INSERT INTO hitdash.dynamic_strategies
           (game_type, draw_type, hypothesis_id, name, description,
            strategy_type, target_pairs, target_digits, score_boost,
            lifecycle_status, activation_hit_rate, min_expected_hit_rate,
            activated_at)
         VALUES ($1,$2,$3::uuid,$4,$5,$6,$7,$8,$9,'monitoring',$10,$11,now())
         ON CONFLICT DO NOTHING
         RETURNING id::text`,
        [
          hypothesis.game_type, hypothesis.draw_type,
          hypothesis.id || null,
          name, description,
          strategy_type,
          target_pairs ? `{${target_pairs.map(p => `"${p}"`).join(',')}}` : null,
          target_digits ? JSON.stringify(target_digits) : null,
          boost,
          valResult.hit_rate,
          minExpected,
        ]
      );

      if (!rows[0]) return null;

      logger.info({
        strategy_id:   rows[0].id,
        name, strategy_type,
        game_type:     hypothesis.game_type,
        draw_type:     hypothesis.draw_type,
        boost, score_boost: boost,
        validation_hit_rate: valResult.hit_rate,
      }, 'StrategyLifecycleManager: estrategia ACTIVADA (MONITORING)');

      return this.loadById(rows[0].id);
    } catch (err) {
      logger.warn({ error: String(err) }, 'StrategyLifecycleManager: error activando estrategia');
      return null;
    }
  }

  // ─── Evaluar estado tras cada sorteo real ────────────────────
  async evaluateAfterDraw(
    draw_date:     string,
    game_type:     GameType,
    draw_type:     DrawType,
    actual_digits: LotteryDigits
  ): Promise<LifecycleUpdate[]> {
    const strategies = await this.getActive(game_type, draw_type);
    const updates: LifecycleUpdate[] = [];

    for (const strat of strategies) {
      const hit = this.checkHit(strat, actual_digits);
      const update = await this.applyUpdate(strat, hit);
      updates.push(update);
    }

    return updates;
  }

  // ─── Obtener estrategias activas para el consensus ────────────
  async getActiveStrategies(
    game_type: GameType,
    draw_type: DrawType
  ): Promise<DynamicStrategy[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id::text, game_type, draw_type, hypothesis_id::text,
                name, description, strategy_type,
                target_pairs, target_digits, score_boost,
                lifecycle_status, draws_active, hits_in_prod,
                misses_in_prod, consecutive_misses, activation_hit_rate,
                min_expected_hit_rate, contribution_count,
                created_at, activated_at
         FROM hitdash.dynamic_strategies
         WHERE game_type = $1 AND draw_type = $2
           AND lifecycle_status IN ('monitoring','active')
         ORDER BY score_boost DESC, hits_in_prod DESC`,
        [game_type, draw_type]
      );
      return rows.map(this.mapRow);
    } catch { return []; }
  }

  // ─── Estrategias activas + degrading (para evaluación) ────────
  private async getActive(
    game_type: GameType,
    draw_type: DrawType
  ): Promise<DynamicStrategy[]> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id::text, game_type, draw_type, hypothesis_id::text,
                name, description, strategy_type, target_pairs, target_digits,
                score_boost, lifecycle_status, draws_active, hits_in_prod,
                misses_in_prod, consecutive_misses, activation_hit_rate,
                min_expected_hit_rate, contribution_count, created_at, activated_at
         FROM hitdash.dynamic_strategies
         WHERE game_type = $1 AND draw_type = $2
           AND lifecycle_status IN ('monitoring','active','degrading')`,
        [game_type, draw_type]
      );
      return rows.map(this.mapRow);
    } catch { return []; }
  }

  // ─── Verificar si el sorteo real es un hit para la estrategia ─
  private checkHit(strat: DynamicStrategy, actual: LotteryDigits): boolean {
    // Hit en pares target
    if (strat.target_pairs?.length) {
      const actualPair = `${actual.p2}${actual.p3}`;
      const actualAB   = `${actual.p1}${actual.p2}`;
      const actualCD   = `${actual.p3}${actual.p4 ?? 0}`;
      return strat.target_pairs.some(p => p === actualPair || p === actualAB || p === actualCD);
    }

    // Hit en dígitos target
    if (strat.target_digits) {
      const td = strat.target_digits;
      if (td.p2?.includes(actual.p2)) return true;
      if (td.p3?.includes(actual.p3)) return true;
      if (td.p1?.includes(actual.p1)) return true;
      if (actual.p4 !== undefined && td.p4?.includes(actual.p4)) return true;
    }

    return false;
  }

  // ─── Aplicar actualización de estado ─────────────────────────
  private async applyUpdate(
    strat: DynamicStrategy,
    hit:   boolean
  ): Promise<LifecycleUpdate> {
    const prevStatus = strat.lifecycle_status;
    let newStatus    = prevStatus;

    const newHits    = strat.hits_in_prod    + (hit ? 1 : 0);
    const newMisses  = strat.misses_in_prod  + (hit ? 0 : 1);
    const newConsec  = hit ? 0 : strat.consecutive_misses + 1;
    const newDraws   = strat.draws_active + 1;

    // Transiciones de estado
    if (prevStatus === 'monitoring' && newDraws >= 5) {
      newStatus = 'active';
    }

    if (prevStatus === 'active' && newConsec >= 3) {
      newStatus = 'degrading';
    }

    if (prevStatus === 'degrading' && newConsec >= 3) {
      newStatus = 'retired';
    }

    // Consolidación: 5+ hits en últimos 10 draws
    const totalDraws = newHits + newMisses;
    if (prevStatus === 'active' && totalDraws >= 10) {
      const recentHitRate = newHits / totalDraws;
      if (recentHitRate >= 0.50) {
        newStatus = 'consolidated';
      }
    }

    // Actualizar DB
    try {
      await this.pool.query(
        `UPDATE hitdash.dynamic_strategies
         SET draws_active       = $1,
             hits_in_prod       = $2,
             misses_in_prod     = $3,
             consecutive_misses = $4,
             lifecycle_status   = $5,
             last_evaluated     = now(),
             retired_at         = CASE WHEN $5 = 'retired' THEN now() ELSE retired_at END
         WHERE id = $6::uuid`,
        [newDraws, newHits, newMisses, newConsec, newStatus, strat.id]
      );
    } catch (err) {
      logger.warn({ error: String(err), strategy_id: strat.id }, 'StrategyLifecycleManager: error actualizando');
    }

    if (newStatus !== prevStatus) {
      logger.info({
        strategy_id: strat.id,
        name:        strat.name,
        from:        prevStatus,
        to:          newStatus,
        hit,
        consecutive_misses: newConsec,
      }, `StrategyLifecycleManager: transición ${prevStatus} → ${newStatus}`);

      // ── KRONOS BRIDGE: ajustar PPS en transiciones significativas ───
      this.kronosBridge.onLifecycleTransition({
        game_type:       strat.game_type,
        draw_type:       strat.draw_type,
        half:            strat.game_type === 'pick3' ? 'du' : 'ab',
        new_status:      newStatus,
        previous_status: prevStatus,
      }).catch(() => undefined);
    }

    return {
      strategy_id:       strat.id,
      strategy_name:     strat.name,
      previous_status:   prevStatus,
      new_status:        newStatus,
      hit,
      consecutive_misses: newConsec,
    };
  }

  // ─── Construir estrategia desde hipótesis ────────────────────
  private buildStrategyFromHypothesis(hyp: Hypothesis): {
    strategy_type: DynamicStrategy['strategy_type'];
    target_pairs?:  string[];
    target_digits?: DynamicStrategy['target_digits'];
    name:           string;
    description:    string;
  } {
    switch (hyp.hypothesis_type) {
      case 'absence_streak':
        return {
          strategy_type: 'pair_bias',
          target_pairs:  hyp.predicted_pair ? [hyp.predicted_pair] : undefined,
          name:          `absence_${hyp.predicted_pair ?? 'unknown'}_${hyp.draw_type}`,
          description:   `Par ${hyp.predicted_pair} sobredebido (${hyp.confidence_basis})`,
        };
      case 'positional_bias': {
        const pos = hyp.predicted_position;
        const td: DynamicStrategy['target_digits'] = {};
        if (pos && hyp.predicted_digit !== undefined) {
          (td as any)[pos] = [hyp.predicted_digit];
        }
        return {
          strategy_type: 'digit_bias',
          target_digits:  td,
          name:          `digit_${hyp.predicted_digit}_${pos}_${hyp.draw_type}`,
          description:   `Dígito ${hyp.predicted_digit} en ${pos} (${hyp.confidence_basis})`,
        };
      }
      case 'temporal_pattern':
        return {
          strategy_type: 'temporal',
          target_pairs:  hyp.predicted_pair ? [hyp.predicted_pair] : undefined,
          name:          `temporal_${hyp.predicted_pair ?? 'unknown'}_${hyp.draw_type}`,
          description:   `Sesgo temporal: ${hyp.confidence_basis}`,
        };
      default:
        return {
          strategy_type: 'pair_bias',
          name:          `dynamic_${hyp.hypothesis_type}_${hyp.draw_type}`,
          description:   hyp.confidence_basis,
        };
    }
  }

  private async loadById(id: string): Promise<DynamicStrategy | null> {
    try {
      const { rows } = await this.pool.query(
        `SELECT id::text, game_type, draw_type, hypothesis_id::text,
                name, description, strategy_type, target_pairs, target_digits,
                score_boost, lifecycle_status, draws_active, hits_in_prod,
                misses_in_prod, consecutive_misses, activation_hit_rate,
                min_expected_hit_rate, contribution_count, created_at, activated_at
         FROM hitdash.dynamic_strategies WHERE id = $1::uuid`,
        [id]
      );
      return rows[0] ? this.mapRow(rows[0]) : null;
    } catch { return null; }
  }

  private mapRow = (r: any): DynamicStrategy => ({
    id:               r.id,
    game_type:        r.game_type,
    draw_type:        r.draw_type,
    hypothesis_id:    r.hypothesis_id,
    name:             r.name,
    description:      r.description,
    strategy_type:    r.strategy_type,
    target_pairs:     r.target_pairs ?? undefined,
    target_digits:    r.target_digits ?? undefined,
    score_boost:      Number(r.score_boost),
    lifecycle_status: r.lifecycle_status,
    draws_active:     Number(r.draws_active),
    hits_in_prod:     Number(r.hits_in_prod),
    misses_in_prod:   Number(r.misses_in_prod),
    consecutive_misses: Number(r.consecutive_misses),
    activation_hit_rate:    r.activation_hit_rate != null ? Number(r.activation_hit_rate) : undefined,
    min_expected_hit_rate:  r.min_expected_hit_rate != null ? Number(r.min_expected_hit_rate) : undefined,
    contribution_count: Number(r.contribution_count),
    created_at:       new Date(r.created_at),
    activated_at:     r.activated_at ? new Date(r.activated_at) : undefined,
  });
}
