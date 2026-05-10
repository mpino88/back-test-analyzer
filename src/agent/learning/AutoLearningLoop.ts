// ═══════════════════════════════════════════════════════════════
// HELIX — AutoLearningLoop v1.0.0
//
// Cierra el loop de aprendizaje autónomo después de cada sorteo real.
// Se integra en PostDrawProcessor como Fase G (última fase).
//
// Flujo por sorteo:
//   1. AnomalyDetector.detect()           → señales estadísticas
//   2. HypothesisGenerator.generate()     → hipótesis pendientes
//   3. HypothesisValidator.validate()     → validación walk-forward (async)
//   4. StrategyLifecycleManager.evaluate  → actualiza ciclos de vida
//   5. Registrar en anomaly_scan_log      → auditoría
//
// Principio: nada de esto bloquea el flujo principal del PostDrawProcessor.
// Todos los errores son silenciados con log — el sorteo ya fue procesado.
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../types/agent.types.js';
import { AnomalyDetector }           from '../analysis/AnomalyDetector.js';
import { HypothesisGenerator }       from '../analysis/HypothesisGenerator.js';
import { HypothesisValidator }        from '../analysis/HypothesisValidator.js';
import { StrategyLifecycleManager }  from '../services/StrategyLifecycleManager.js';
import { KronosAutoLearningBridge }  from './KronosAutoLearningBridge.js';

const logger = pino({ name: 'AutoLearningLoop' });

// Halves por juego
const HALVES: Record<GameType, Array<'du'|'ab'|'cd'>> = {
  pick3: ['du'],
  pick4: ['ab', 'cd'],
};

export interface AutoLearningResult {
  game_type:             GameType;
  draw_type:             DrawType;
  draw_date:             string;
  anomalies_detected:    number;
  hypotheses_generated:  number;
  hypotheses_validated:  number;
  hypotheses_rejected:   number;
  strategies_evaluated:  number;
  strategies_activated:  number;
  strategies_retired:    number;
  duration_ms:           number;
}

export class AutoLearningLoop {
  private readonly anomalyDetector:    AnomalyDetector;
  private readonly hypothesisGenerator: HypothesisGenerator;
  private readonly hypothesisValidator: HypothesisValidator;
  private readonly lifecycleManager:   StrategyLifecycleManager;
  private readonly kronosBridge:       KronosAutoLearningBridge;

  constructor(private readonly pool: Pool) {
    this.anomalyDetector     = new AnomalyDetector(pool);
    this.hypothesisGenerator = new HypothesisGenerator(pool);
    this.hypothesisValidator = new HypothesisValidator(pool);
    this.lifecycleManager    = new StrategyLifecycleManager(pool);
    this.kronosBridge        = new KronosAutoLearningBridge(pool);
  }

  // ─── Punto de entrada principal ───────────────────────────────
  async processDrawResult(
    game_type:     GameType,
    draw_type:     DrawType,
    draw_date:     string,
    actual_digits: LotteryDigits
  ): Promise<AutoLearningResult> {
    const t0 = Date.now();
    const result: AutoLearningResult = {
      game_type, draw_type, draw_date,
      anomalies_detected:   0,
      hypotheses_generated: 0,
      hypotheses_validated: 0,
      hypotheses_rejected:  0,
      strategies_evaluated: 0,
      strategies_activated: 0,
      strategies_retired:   0,
      duration_ms:          0,
    };

    try {
      const half = HALVES[game_type][0] ?? 'du';

      // ── PASO 1: Detectar anomalías ──────────────────────────
      const anomalyReport = await this.anomalyDetector.detect(game_type, draw_type, half);
      result.anomalies_detected = anomalyReport.signals.length;

      // ── PASO 2: Generar hipótesis desde señales ─────────────
      const newHypotheses = await this.hypothesisGenerator.generateFromSignals(
        anomalyReport.signals, game_type, draw_type
      );
      result.hypotheses_generated = newHypotheses.length;

      // ── PASO 3: Validar hipótesis en background (no bloqueante) ──
      // Se ejecuta con setImmediate para no retrasar el proceso principal
      if (newHypotheses.length > 0) {
        setImmediate(async () => {
          for (const hyp of newHypotheses) {
            try {
              const valResult = await this.hypothesisValidator.validate(hyp);
              if (valResult.passed) {
                const strat = await this.lifecycleManager.activateFromHypothesis(
                  hyp, { hit_rate: valResult.hit_rate, lift: valResult.lift }
                );
                if (strat) {
                  logger.info({
                    strategy_name: strat.name,
                    hit_rate:      valResult.hit_rate,
                    lift:          valResult.lift,
                  }, 'AutoLearningLoop: micro-estrategia ACTIVADA desde hipótesis validada');

                  // ── KRONOS BRIDGE: reforzar algoritmos asociados ──────
                  this.kronosBridge.onStrategyActivated({
                    hypothesis_type: hyp.hypothesis_type,
                    game_type:       game_type,
                    draw_type:       draw_type,
                    half:            HALVES[game_type][0] ?? 'du',
                    lift:            valResult.lift,
                  }).catch(() => undefined);
                }
              }
            } catch (err) {
              logger.warn({ error: String(err), hyp_id: hyp.id }, 'AutoLearningLoop: error validando hipótesis');
            }
          }
        });
      }

      // También validar hipótesis pendientes anteriores (hasta 3 por ciclo)
      const pending = await this.hypothesisGenerator.loadPending(game_type, draw_type);
      const toValidate = pending.slice(0, 3);
      for (const hyp of toValidate) {
        try {
          const valResult = await this.hypothesisValidator.validate(hyp);
          if (valResult.passed) {
            result.hypotheses_validated++;
            await this.lifecycleManager.activateFromHypothesis(
              hyp, { hit_rate: valResult.hit_rate, lift: valResult.lift }
            );
            result.strategies_activated++;
          } else {
            result.hypotheses_rejected++;
          }
        } catch (err) {
          logger.warn({ error: String(err) }, 'AutoLearningLoop: error validando hipótesis pendiente');
        }
      }

      // ── PASO 4: Actualizar ciclo de vida de estrategias activas ──
      const lifecycleUpdates = await this.lifecycleManager.evaluateAfterDraw(
        draw_date, game_type, draw_type, actual_digits
      );
      result.strategies_evaluated = lifecycleUpdates.length;
      result.strategies_retired   = lifecycleUpdates.filter(u => u.new_status === 'retired').length;

      // ── PASO 5: Registrar en anomaly_scan_log ──────────────
      const duration = Date.now() - t0;
      result.duration_ms = duration;

      await this.logScan(result, 'post_draw');

      logger.info({
        game_type, draw_type, draw_date,
        anomalies:      result.anomalies_detected,
        hypotheses:     result.hypotheses_generated,
        validated:      result.hypotheses_validated,
        rejected:       result.hypotheses_rejected,
        strategies_eval: result.strategies_evaluated,
        retired:        result.strategies_retired,
        duration_ms:    duration,
      }, 'AutoLearningLoop: ciclo completado');

    } catch (err) {
      logger.error({ error: String(err), game_type, draw_type, draw_date },
        'AutoLearningLoop: error en ciclo principal');
      result.duration_ms = Date.now() - t0;
    }

    return result;
  }

  // ─── Escaneo manual (desde API) ──────────────────────────────
  async manualScan(
    game_type: GameType,
    draw_type: DrawType
  ): Promise<{ signals: number; hypotheses: number }> {
    const half = HALVES[game_type][0] ?? 'du';
    const report = await this.anomalyDetector.detect(game_type, draw_type, half);
    const hyps   = await this.hypothesisGenerator.generateFromSignals(
      report.signals, game_type, draw_type
    );
    await this.logScan({
      game_type, draw_type, draw_date: new Date().toISOString().split('T')[0]!,
      anomalies_detected:   report.signals.length,
      hypotheses_generated: hyps.length,
      hypotheses_validated: 0, hypotheses_rejected: 0,
      strategies_evaluated: 0, strategies_activated: 0, strategies_retired: 0,
      duration_ms: report.scan_duration_ms,
    }, 'manual');
    return { signals: report.signals.length, hypotheses: hyps.length };
  }

  // ─── Obtener señales actuales (para API/dashboard) ────────────
  async getCurrentSignals(game_type: GameType, draw_type: DrawType) {
    const half = HALVES[game_type][0] ?? 'du';
    return this.anomalyDetector.detect(game_type, draw_type, half);
  }

  // ─── Registrar en anomaly_scan_log ───────────────────────────
  private async logScan(
    result:       AutoLearningResult,
    triggered_by: 'manual' | 'post_draw' | 'cron'
  ): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO hitdash.anomaly_scan_log
           (game_type, draw_type, signals_found, hypotheses_generated,
            hypotheses_validated, hypotheses_rejected, strategies_activated,
            strategies_retired, scan_duration_ms, triggered_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          result.game_type, result.draw_type,
          result.anomalies_detected,
          result.hypotheses_generated,
          result.hypotheses_validated,
          result.hypotheses_rejected,
          result.strategies_activated,
          result.strategies_retired,
          result.duration_ms,
          triggered_by,
        ]
      );
    } catch { /* no bloquear */ }
  }
}
