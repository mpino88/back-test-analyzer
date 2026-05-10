// ═══════════════════════════════════════════════════════════════
// HELIX — HelixSentinel v1.0.0
//
// Proactividad real: HELIX detecta condiciones críticas y alerta
// por Telegram SIN que nadie se lo pida.
//
// Se ejecuta como Fase H en PostDrawProcessor (setImmediate).
// Anti-spam: cooldown de 6h por tipo de evento en DB.
//
// Condiciones monitoreadas:
//   1. Señal crítica nueva        z ≥ 3.5  → alerta roja
//   2. Estrategia CONSOLIDATED    (10+ draws, hit_rate ≥ 50%) → info
//   3. Estrategia RETIRED         (3+ misses consecutivos)    → warning
//   4. Algoritmo PPS degradado    drop > 20% en últimas 5     → warning
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../types/agent.types.js';
import type { AutoLearningResult } from '../learning/AutoLearningLoop.js';
import { TelegramNotifier }        from '../services/TelegramNotifier.js';
import { AnomalyDetector }         from '../analysis/AnomalyDetector.js';

const logger = pino({ name: 'HelixSentinel' });

const COOLDOWN_HOURS = 6;
const Z_CRITICAL     = 3.5;
const PPS_DROP_PCT   = 0.20;   // 20% caída en PPS → alerta

export class HelixSentinel {
  private readonly notifier:        TelegramNotifier;
  private readonly anomalyDetector: AnomalyDetector;

  constructor(private readonly pool: Pool, notifier?: TelegramNotifier) {
    this.notifier        = notifier ?? new TelegramNotifier();
    this.anomalyDetector = new AnomalyDetector(pool);
  }

  // ─── Punto de entrada: evaluar después de cada sorteo ────────────────────
  async evaluate(
    game_type:         GameType,
    draw_type:         DrawType,
    autoLearningResult: AutoLearningResult
  ): Promise<void> {
    try {
      await Promise.all([
        this.checkCriticalSignals(game_type, draw_type),
        this.checkStrategyConsolidations(game_type, draw_type, autoLearningResult),
        this.checkStrategyRetirements(game_type, draw_type, autoLearningResult),
        this.checkAlgoDegradation(game_type, draw_type),
      ]);
    } catch (err) {
      logger.warn({ error: String(err) }, 'HelixSentinel: error en evaluación (non-fatal)');
    }
  }

  // ─── 1. Señales estadísticas críticas (z ≥ 3.5) ─────────────────────────
  private async checkCriticalSignals(game_type: GameType, draw_type: DrawType): Promise<void> {
    const half   = game_type === 'pick3' ? 'du' : 'ab';
    const report = await this.anomalyDetector.detect(game_type, draw_type, half);
    const critical = report.signals.filter(s => Math.abs(s.z_score) >= Z_CRITICAL);

    for (const sig of critical.slice(0, 2)) { // máximo 2 alertas por ciclo
      const key = `sentinel:critical_signal:${game_type}:${draw_type}:${sig.value}:${sig.type}`;
      if (await this.isOnCooldown(key)) continue;

      const typeLabel = {
        positional_digit_bias:   'Sesgo posicional extremo',
        pair_absence_streak:     'Racha de ausencia extrema',
        pair_overrepresentation: 'Sobre-representación extrema',
        cross_position_coupling: 'Acoplamiento posicional extremo',
        day_of_week_bias:        'Sesgo día-semana extremo',
      }[sig.type] ?? sig.type;

      await this.notifier.notifySentinelAlert({
        event_type: 'critical_signal',
        game_type, draw_type,
        urgency: 'critical',
        title: `📡 Señal Crítica Detectada`,
        body: [
          `• Tipo: ${typeLabel}`,
          `• Valor: \`${sig.value}\`${sig.position ? ` pos:${sig.position}` : ''}`,
          `• z-score: \`${sig.z_score.toFixed(2)}\` (umbral: ${Z_CRITICAL})`,
          `• Ventana: ${sig.window} sorteos`,
          `• Confianza: ${(sig.confidence * 100).toFixed(0)}%`,
          `→ Hipótesis generada y en validación walk-forward`,
        ].join('\n'),
      });

      await this.setCooldown(key);
      logger.info({ sig, game_type, draw_type }, 'HelixSentinel: alerta crítica enviada');
    }
  }

  // ─── 2. Estrategias consolidadas ────────────────────────────────────────
  private async checkStrategyConsolidations(
    game_type: GameType,
    draw_type: DrawType,
    result:    AutoLearningResult
  ): Promise<void> {
    if (result.strategies_evaluated === 0) return;

    const { rows } = await this.pool.query<{
      name: string; hits_in_prod: number; draws_active: number;
      activation_hit_rate: number;
    }>(
      `SELECT name, hits_in_prod, draws_active, activation_hit_rate
       FROM hitdash.dynamic_strategies
       WHERE game_type = $1 AND draw_type = $2
         AND lifecycle_status = 'consolidated'
         AND last_evaluated >= now() - interval '2 hours'`,
      [game_type, draw_type]
    ).catch(() => ({ rows: [] as any[] }));

    for (const strat of rows) {
      const key = `sentinel:consolidated:${game_type}:${draw_type}:${strat.name}`;
      if (await this.isOnCooldown(key)) continue;

      const hitRate = strat.draws_active > 0
        ? ((strat.hits_in_prod / strat.draws_active) * 100).toFixed(1) : '?';

      await this.notifier.notifySentinelAlert({
        event_type: 'strategy_consolidated',
        game_type, draw_type,
        urgency: 'info',
        title: `⭐ Micro-estrategia CONSOLIDADA`,
        body: [
          `• Nombre: \`${strat.name}\``,
          `• Draws activa: ${strat.draws_active}`,
          `• Hit rate producción: ${hitRate}%`,
          `• Hit rate validación: ${strat.activation_hit_rate != null ? (Number(strat.activation_hit_rate) * 100).toFixed(1) + '%' : '?'}`,
          `→ Esta estrategia influye en las predicciones con mayor peso`,
        ].join('\n'),
      });

      await this.setCooldown(key);
      logger.info({ strat, game_type, draw_type }, 'HelixSentinel: alerta consolidación enviada');
    }
  }

  // ─── 3. Estrategias retiradas ────────────────────────────────────────────
  private async checkStrategyRetirements(
    game_type: GameType,
    draw_type: DrawType,
    result:    AutoLearningResult
  ): Promise<void> {
    if (result.strategies_retired === 0) return;

    const { rows } = await this.pool.query<{
      name: string; hits_in_prod: number; misses_in_prod: number;
    }>(
      `SELECT name, hits_in_prod, misses_in_prod
       FROM hitdash.dynamic_strategies
       WHERE game_type = $1 AND draw_type = $2
         AND lifecycle_status = 'retired'
         AND retired_at >= now() - interval '2 hours'`,
      [game_type, draw_type]
    ).catch(() => ({ rows: [] as any[] }));

    for (const strat of rows) {
      const key = `sentinel:retired:${game_type}:${draw_type}:${strat.name}`;
      if (await this.isOnCooldown(key)) continue;

      await this.notifier.notifySentinelAlert({
        event_type: 'strategy_retired',
        game_type, draw_type,
        urgency: 'warning',
        title: `📉 Micro-estrategia RETIRADA`,
        body: [
          `• Nombre: \`${strat.name}\``,
          `• Hits: ${strat.hits_in_prod} | Misses: ${strat.misses_in_prod}`,
          `→ El agente la descartó por rendimiento insuficiente`,
          `→ Los algoritmos asociados recibieron penalización PPS`,
        ].join('\n'),
      });

      await this.setCooldown(key);
    }
  }

  // ─── 4. Algoritmos con PPS cayendo > 20% ────────────────────────────────
  private async checkAlgoDegradation(game_type: GameType, draw_type: DrawType): Promise<void> {
    const half = game_type === 'pick3' ? 'du' : 'ab';

    const { rows } = await this.pool.query<{
      algo_name: string; pps: number; pps_5_draws_ago: number;
    }>(
      `SELECT
         ps.algo_name,
         ps.pps::float AS pps,
         COALESCE(
           (SELECT h.pps_after
            FROM hitdash.algo_rank_history h
            WHERE h.algo_name = ps.algo_name
              AND h.game_type = ps.game_type
              AND h.draw_type = ps.draw_type
              AND h.half      = ps.half
            ORDER BY h.created_at DESC
            OFFSET 4 LIMIT 1
           ), ps.pps
         )::float AS pps_5_draws_ago
       FROM hitdash.pps_state ps
       WHERE ps.game_type = $1 AND ps.draw_type = $2 AND ps.half = $3
         AND ps.sample_count >= 5`,
      [game_type, draw_type, half]
    ).catch(() => ({ rows: [] as any[] }));

    for (const row of rows) {
      const drop = (row.pps_5_draws_ago - row.pps) / Math.max(row.pps_5_draws_ago, 1);
      if (drop < PPS_DROP_PCT) continue;

      const key = `sentinel:algo_degraded:${game_type}:${draw_type}:${row.algo_name}`;
      if (await this.isOnCooldown(key)) continue;

      await this.notifier.notifySentinelAlert({
        event_type: 'algo_degraded',
        game_type, draw_type,
        urgency: 'warning',
        title: `⚠️ Algoritmo perdiendo poder predictivo`,
        body: [
          `• Algoritmo: \`${row.algo_name}\``,
          `• PPS actual: ${row.pps.toFixed(1)} → hace 5 sorteos: ${row.pps_5_draws_ago.toFixed(1)}`,
          `• Caída: ${(drop * 100).toFixed(1)}% (umbral: ${PPS_DROP_PCT * 100}%)`,
          `→ KRONOS reducirá su peso en el consenso automáticamente`,
        ].join('\n'),
      });

      await this.setCooldown(key);
      logger.info({ row, drop, game_type, draw_type }, 'HelixSentinel: alerta degradación PPS enviada');
    }
  }

  // ─── Anti-spam: cooldown en DB ────────────────────────────────────────────
  private async isOnCooldown(key: string): Promise<boolean> {
    try {
      const { rows } = await this.pool.query(
        `SELECT 1 FROM hitdash.sentinel_cooldowns
         WHERE event_key = $1 AND fired_at > now() - interval '${COOLDOWN_HOURS} hours'`,
        [key]
      );
      return rows.length > 0;
    } catch {
      // Si la tabla no existe aún → no hay cooldown
      return false;
    }
  }

  private async setCooldown(key: string): Promise<void> {
    try {
      await this.pool.query(
        `INSERT INTO hitdash.sentinel_cooldowns (event_key, fired_at)
         VALUES ($1, now())
         ON CONFLICT (event_key) DO UPDATE SET fired_at = now()`,
        [key]
      );
    } catch { /* non-fatal */ }
  }
}
