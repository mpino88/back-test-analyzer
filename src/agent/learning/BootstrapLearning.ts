// ═══════════════════════════════════════════════════════════════
// HELIX — BootstrapLearning v1.0.0
//
// Retroalimenta HELIX con el historial COMPLETO de sorteos.
// Ejecutar una sola vez (o cuando se quiera reinicializar el sistema).
//
// PROBLEMA QUE RESUELVE:
//   El AutoLearningLoop solo corre después de sorteos NUEVOS.
//   Con 39,744 sorteos históricos en DB, el sistema podría nacer
//   con estrategias ya validadas estadísticamente en lugar de
//   empezar desde cero y esperar semanas.
//
// FLUJO POR COMBO (pick3/pick4 × midday/evening):
//   1. AnomalyDetector.detect()        → señales actuales (sobre historial completo)
//   2. HypothesisGenerator             → hipótesis desde señales + pending en DB
//   3. HypothesisValidator.validate()  → walk-forward sobre TODOS los históricos
//   4. StrategyLifecycleManager.activate → crear estrategias validadas
//   5. Replay últimos N draws           → popula hits/misses/lifecycle real
//      → Estrategias que no sobreviven el replay son retiradas automáticamente
//      → Las que sobreviven entran con historial real, no desde 0
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../types/agent.types.js';
import { AnomalyDetector }           from '../analysis/AnomalyDetector.js';
import { HypothesisGenerator }       from '../analysis/HypothesisGenerator.js';
import { HypothesisValidator }       from '../analysis/HypothesisValidator.js';
import { StrategyLifecycleManager }  from '../services/StrategyLifecycleManager.js';

const logger = pino({ name: 'BootstrapLearning' });

// Los 4 combos que HELIX cubre
const COMBOS: Array<{ game_type: GameType; draw_type: DrawType; half: 'du'|'ab' }> = [
  { game_type: 'pick3', draw_type: 'evening', half: 'du' },
  { game_type: 'pick3', draw_type: 'midday',  half: 'du' },
  { game_type: 'pick4', draw_type: 'evening', half: 'ab' },
  { game_type: 'pick4', draw_type: 'midday',  half: 'ab' },
];

export interface BootstrapComboResult {
  combo:                   string;
  signals_detected:        number;
  hypotheses_generated:    number;
  hypotheses_already_in_db: number;
  hypotheses_validated:    number;
  hypotheses_rejected:     number;
  strategies_created:      number;
  draws_replayed:          number;
  strategies_survived:     number;
  strategies_retired:      number;
  duration_ms:             number;
}

export interface BootstrapResult {
  total_strategies_active: number;
  total_hypotheses_validated: number;
  total_draws_replayed: number;
  combos: BootstrapComboResult[];
  duration_ms: number;
}

export class BootstrapLearning {
  private readonly anomalyDetector:    AnomalyDetector;
  private readonly hypothesisGenerator: HypothesisGenerator;
  private readonly hypothesisValidator: HypothesisValidator;
  private readonly lifecycleManager:   StrategyLifecycleManager;

  constructor(private readonly pool: Pool) {
    this.anomalyDetector     = new AnomalyDetector(pool);
    this.hypothesisGenerator = new HypothesisGenerator(pool);
    this.hypothesisValidator = new HypothesisValidator(pool);
    this.lifecycleManager    = new StrategyLifecycleManager(pool);
  }

  // ─── Punto de entrada: bootstrap de todos los combos ─────────────
  async runFullBootstrap(replayDraws: number = 90): Promise<BootstrapResult> {
    const t0 = Date.now();
    logger.info({ replayDraws }, 'BootstrapLearning: iniciando bootstrap completo');

    const combos: BootstrapComboResult[] = [];
    for (const combo of COMBOS) {
      const result = await this.bootstrapCombo(
        combo.game_type, combo.draw_type, combo.half, replayDraws
      );
      combos.push(result);
    }

    const total: BootstrapResult = {
      total_strategies_active:    combos.reduce((s, c) => s + c.strategies_survived, 0),
      total_hypotheses_validated: combos.reduce((s, c) => s + c.hypotheses_validated, 0),
      total_draws_replayed:       combos.reduce((s, c) => s + c.draws_replayed, 0),
      combos,
      duration_ms: Date.now() - t0,
    };

    logger.info(total, 'BootstrapLearning: bootstrap completo finalizado');
    return total;
  }

  // ─── Bootstrap de un combo individual ───────────────────────────
  async bootstrapCombo(
    game_type:   GameType,
    draw_type:   DrawType,
    half:        'du' | 'ab',
    replayDraws: number
  ): Promise<BootstrapComboResult> {
    const t0    = Date.now();
    const combo = `${game_type}:${draw_type}`;
    logger.info({ combo, replayDraws }, 'BootstrapLearning: iniciando combo');

    // ── PASO 1: Detectar señales sobre el historial completo ──────
    const report = await this.anomalyDetector.detect(game_type, draw_type, half);
    logger.info({ combo, signals: report.signals.length }, 'BootstrapLearning: señales detectadas');

    // ── PASO 2: Generar hipótesis desde señales nuevas ────────────
    const newHyps = await this.hypothesisGenerator.generateFromSignals(
      report.signals, game_type, draw_type
    );

    // ── PASO 3: Cargar TODAS las hipótesis pendientes en DB ───────
    // Incluye las recién creadas + las que existían previamente
    const allPending = await this.hypothesisGenerator.loadPending(game_type, draw_type);
    // Deduplicar: evitar procesar las mismas dos veces
    const toValidate = allPending;

    logger.info(
      { combo, new: newHyps.length, pending_total: toValidate.length },
      'BootstrapLearning: hipótesis listas para validación walk-forward'
    );

    // ── PASO 4: Validar TODAS con walk-forward histórico ──────────
    // HypothesisValidator ya usa hitdash.ingested_results completo
    // (validation_window + 60 draws por defecto = hasta 150 draws de historial)
    let validated        = 0;
    let rejected         = 0;
    const activatedIds: string[] = [];

    for (const hyp of toValidate) {
      try {
        const valResult = await this.hypothesisValidator.validate(hyp);
        if (valResult.passed) {
          validated++;
          const strat = await this.lifecycleManager.activateFromHypothesis(hyp, {
            hit_rate: valResult.hit_rate,
            lift:     valResult.lift,
          });
          if (strat) {
            activatedIds.push(strat.id);
            logger.info(
              { combo, strategy: strat.name, hit_rate: valResult.hit_rate, lift: valResult.lift },
              'BootstrapLearning: ✅ estrategia activada desde historial'
            );
          }
        } else {
          rejected++;
        }
      } catch (err) {
        logger.warn({ error: String(err), hyp_id: hyp.id }, 'BootstrapLearning: error validando hipótesis');
      }
    }

    // ── PASO 5: Replay histórico ──────────────────────────────────
    // Carga los últimos N sorteos reales en orden cronológico y los
    // pasa por evaluateAfterDraw para poblar hits_in_prod/misses_in_prod.
    // Estrategias que no sobreviven el replay → RETIRED automáticamente.
    let drawsReplayed    = 0;
    let strategiesRetired = 0;

    if (activatedIds.length > 0) {
      const { rows: historicalDraws } = await this.pool.query<{
        draw_date: string; p1: number; p2: number; p3: number; p4: number | null;
      }>(
        `SELECT draw_date::text, p1, p2, p3, COALESCE(p4, 0) AS p4
         FROM hitdash.ingested_results
         WHERE game_type = $1 AND draw_type = $2
         ORDER BY draw_date DESC
         LIMIT $3`,
        [game_type, draw_type, replayDraws]
      ).catch(() => ({ rows: [] as Array<{ draw_date: string; p1: number; p2: number; p3: number; p4: number | null }> }));

      // Cronológico (ASC): el más antiguo primero para simular evolución real
      const chronological = [...historicalDraws].reverse();

      for (const draw of chronological) {
        const digits: LotteryDigits = {
          p1:  Number(draw.p1),
          p2:  Number(draw.p2),
          p3:  Number(draw.p3),
          p4:  draw.p4 != null ? Number(draw.p4) : undefined,
        };

        try {
          const updates = await this.lifecycleManager.evaluateAfterDraw(
            draw.draw_date, game_type, draw_type, digits
          );
          drawsReplayed++;
          strategiesRetired += updates.filter(u => u.new_status === 'retired').length;
        } catch (err) {
          logger.warn({ error: String(err), draw_date: draw.draw_date }, 'BootstrapLearning: error en replay');
        }
      }
    }

    // Estrategias que sobrevivieron el replay
    const survivors = await this.lifecycleManager.getActiveStrategies(game_type, draw_type);

    const duration = Date.now() - t0;
    const result: BootstrapComboResult = {
      combo,
      signals_detected:         report.signals.length,
      hypotheses_generated:     newHyps.length,
      hypotheses_already_in_db: toValidate.length - newHyps.length,
      hypotheses_validated:     validated,
      hypotheses_rejected:      rejected,
      strategies_created:       activatedIds.length,
      draws_replayed:           drawsReplayed,
      strategies_survived:      survivors.length,
      strategies_retired:       strategiesRetired,
      duration_ms:              duration,
    };

    logger.info(result, 'BootstrapLearning: combo finalizado');
    return result;
  }
}
