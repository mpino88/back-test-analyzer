// ═══════════════════════════════════════════════════════════════
// HITDASH — StrategyEvaluator v1.0.0
// Actualiza win_rate + total_tests en strategy_registry
// win_rate = EMA(hit_rate, α=0.1) — suavizado exponencial
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { ComparisonResult } from './ResultComparator.js';

const logger = pino({ name: 'StrategyEvaluator' });

// EMA smoothing: new_rate = α * current_hit + (1-α) * prev_win_rate
// ═══ ANO-02 FIX: α=0.20 (antes 0.1 era demasiado conservador)
// Con α=0.1 se necesitaban ~22 sorteos para reflejar el 90% del rendimiento real.
// Con α=0.20 se necesitan ~10 sorteos — más reactivo a la realidad del mercado.
// Coherente con PostDrawProcessor.updateLiveAdaptiveWeights que usa α=0.15.
const EMA_ALPHA = 0.20;

interface StrategyRow {
  id: string;
  name: string;
  win_rate: number;
  total_tests: number;
}

export class StrategyEvaluator {
  constructor(private readonly agentPool: Pool) {}

  // ─── Evaluar y actualizar estrategia desde resultados ────────
  async evaluate(
    strategyId: string,
    results: ComparisonResult[]
  ): Promise<{ win_rate: number; total_tests: number }> {
    if (results.length === 0) return { win_rate: 0, total_tests: 0 };

    // Obtener estado actual de la estrategia
    const row = await this.agentPool.query<StrategyRow>(
      `SELECT id, name, win_rate, total_tests
       FROM hitdash.strategy_registry
       WHERE id = $1`,
      [strategyId]
    );

    if (row.rows.length === 0) {
      logger.warn({ strategyId }, 'StrategyEvaluator: estrategia no encontrada');
      return { win_rate: 0, total_tests: 0 };
    }

    const strategy = row.rows[0]!;

    // current batch hit rate: fraction of cartones with at least 1 exact hit
    const batchHits = results.filter(r => r.hits_exact > 0).length;
    const batchHitRate = batchHits / results.length;

    // EMA update: suaviza para evitar fluctuaciones bruscas
    const newWinRate = +(
      EMA_ALPHA * batchHitRate + (1 - EMA_ALPHA) * strategy.win_rate
    ).toFixed(4);

    const newTotalTests = strategy.total_tests + results.length;

    await this.agentPool.query(
      `UPDATE hitdash.strategy_registry
       SET win_rate       = $2,
           total_tests    = $3,
           last_evaluated = now(),
           updated_at     = now()
       WHERE id = $1`,
      [strategyId, newWinRate, newTotalTests]
    );

    logger.info(
      {
        strategy: strategy.name,
        prev_win_rate: strategy.win_rate,
        new_win_rate: newWinRate,
        batch_hits: batchHits,
        total_tests: newTotalTests,
      },
      'StrategyEvaluator: win_rate actualizado'
    );

    return { win_rate: newWinRate, total_tests: newTotalTests };
  }

  // ─── Promover/retirar estrategias según win_rate ──────────────
  async rebalanceStatuses(): Promise<void> {
    // ═══ ANO-NEW-02 FIX: Sincronizar umbral con PairBacktestEngine (era 0.15, PairEngine usa 0.12)
    // Con 0.15 de umbral, una estrategia promovida por el backtest (0.12) podía ser retirada
    // por live evaluation en la siguiente ronda, creando un loop de flip-flop inestable.
    // Umbral 0.12: estadisticamente validado por el backtest de mayor volumen muestral.
    await this.agentPool.query(
      `UPDATE hitdash.strategy_registry
       SET status = 'active', updated_at = now()
       WHERE status = 'testing'
         AND win_rate >= 0.12
         AND total_tests >= 20`
    );

    // Retirar si win_rate < 0.05 y total_tests >= 30
    await this.agentPool.query(
      `UPDATE hitdash.strategy_registry
       SET status = 'retired', updated_at = now()
       WHERE status IN ('testing', 'active')
         AND win_rate < 0.05
         AND total_tests >= 30`
    );

    logger.info('StrategyEvaluator: rebalance de estados completado');
  }

  // ─── Obtener ranking de estrategias ──────────────────────────
  async getRanking(): Promise<StrategyRow[]> {
    const result = await this.agentPool.query<StrategyRow>(
      `SELECT id, name, win_rate, total_tests
       FROM hitdash.strategy_registry
       WHERE status != 'retired'
       ORDER BY win_rate DESC`
    );
    return result.rows;
  }
}
