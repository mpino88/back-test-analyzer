// ═══════════════════════════════════════════════════════════════
// HELIX — AlgorithmHealthMonitor v1.0.0 (ROUND 2 FIX 2026-05-12)
//
// Killswitch real: deshabilita algoritmos perdedores del consensus.
//
// Reglas (basadas en algo_rank_history existente):
//   hit_rate@15 < baseline*1.10 (0.165) ∧ samples≥30 → DISABLED
//   hit_rate@15 < baseline      (0.150) ∧ samples≥15 → DEGRADED (weight ×0.5)
//   else                                              → HEALTHY
//
// donde baseline = N_DEFAULT/100 = 0.15 (probabilidad si predijéramos al azar)
//
// AnalysisEngine consulta antes del Promise.allSettled y:
//   - DISABLED → skip (no corre)
//   - DEGRADED → corre pero weight ÷ 2
//   - HEALTHY  → corre normal
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'AlgorithmHealthMonitor' });

const BASELINE_RATE      = 0.15;         // P(rank≤15 | random) = 15/100
const KILLSWITCH_FACTOR  = 1.10;         // hit_rate debe superar baseline×1.10
const ROLLING_WINDOW     = 30;           // últimos 30 evaluaciones
const MIN_SAMPLES_KILL   = 30;           // bajo este sample_size, no killeamos
const MIN_SAMPLES_DEGRADE = 15;          // bajo este sample_size, no degradamos
const DEGRADE_PENALTY    = 0.5;          // weight multiplier si DEGRADED

export type AlgoHealthStatus = 'healthy' | 'degraded' | 'disabled';

export interface AlgoHealth {
  algo_name:        string;
  status:           AlgoHealthStatus;
  hit_rate_at_15:   number;     // últimas N evaluaciones, fracción rank≤15
  samples:          number;     // cuántas evaluaciones cuentan
  weight_multiplier: number;    // 1.0 healthy, 0.5 degraded, 0 disabled
  reason:           string;
}

export class AlgorithmHealthMonitor {
  constructor(private readonly pool: Pool) {}

  /**
   * Computa el status de cada algoritmo basándose en algo_rank_history.
   * Retorna Map<algo_name, AlgoHealth>.
   */
  async getHealth(
    game_type: string,
    draw_type: string,
    half:      string
  ): Promise<Map<string, AlgoHealth>> {
    const result = new Map<string, AlgoHealth>();

    try {
      // FIX 2026-05-15: query anterior usaba LIMIT global sin particionar por algo_name.
      // Con Genesis 5 años en BD (1825+ filas por algo), LIMIT 900 tomaba ~112 filas de
      // los algos más recientes mezclados → distribución aleatoria, no ventana per-algo.
      // FIX: CTE con ROW_NUMBER() PARTITION BY algo_name, igual que computeRecentHitRates().
      const { rows } = await this.pool.query<{
        algo_name: string;
        samples:   number;
        hits_at_15: number;
      }>(
        `WITH recent AS (
           SELECT algo_name, rank_of_winner,
                  ROW_NUMBER() OVER (PARTITION BY algo_name ORDER BY draw_date DESC) AS rn
           FROM hitdash.algo_rank_history
           WHERE game_type = $1 AND draw_type = $2 AND half = $3
         )
         SELECT
           algo_name,
           COUNT(*)::int                                               AS samples,
           SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::int AS hits_at_15
         FROM recent
         WHERE rn <= $4
         GROUP BY algo_name`,
        [game_type, draw_type, half, ROLLING_WINDOW]
      );

      for (const r of rows) {
        const samples = Number(r.samples);
        const hits    = Number(r.hits_at_15);
        const hitRate = samples > 0 ? hits / samples : 0;

        let status:           AlgoHealthStatus = 'healthy';
        let weight_multiplier = 1.0;
        let reason            = `hit@15=${(hitRate*100).toFixed(1)}% (baseline ${(BASELINE_RATE*100).toFixed(0)}%)`;

        if (samples >= MIN_SAMPLES_KILL && hitRate < BASELINE_RATE * KILLSWITCH_FACTOR) {
          status            = 'disabled';
          weight_multiplier = 0;
          reason            = `KILLSWITCH: hit@15=${(hitRate*100).toFixed(1)}% < baseline×1.10=${(BASELINE_RATE*KILLSWITCH_FACTOR*100).toFixed(1)}% (n=${samples})`;
        } else if (samples >= MIN_SAMPLES_DEGRADE && hitRate < BASELINE_RATE) {
          status            = 'degraded';
          weight_multiplier = DEGRADE_PENALTY;
          reason            = `DEGRADED: hit@15=${(hitRate*100).toFixed(1)}% < baseline=${(BASELINE_RATE*100).toFixed(0)}% (n=${samples})`;
        }

        result.set(r.algo_name, {
          algo_name: r.algo_name,
          status,
          hit_rate_at_15:    +hitRate.toFixed(4),
          samples,
          weight_multiplier,
          reason,
        });
      }

      const disabled = Array.from(result.values()).filter(h => h.status === 'disabled');
      const degraded = Array.from(result.values()).filter(h => h.status === 'degraded');
      if (disabled.length > 0 || degraded.length > 0) {
        logger.info(
          {
            game_type, draw_type, half,
            disabled: disabled.map(d => d.algo_name),
            degraded: degraded.map(d => d.algo_name),
            total_evaluated: rows.length,
          },
          '🔪 AlgorithmHealthMonitor: killswitch/degrade aplicado'
        );
      }
    } catch (err) {
      logger.debug({ error: String(err) }, 'AlgorithmHealthMonitor: tabla aún no tiene datos suficientes, skip');
    }

    return result;
  }

  /**
   * Para endpoint /api/agent/algorithm-health → dashboard.
   */
  async getHealthSummary(
    game_type: string,
    draw_type: string,
    half:      string
  ): Promise<AlgoHealth[]> {
    const map = await this.getHealth(game_type, draw_type, half);
    return Array.from(map.values()).sort((a, b) => b.hit_rate_at_15 - a.hit_rate_at_15);
  }
}
