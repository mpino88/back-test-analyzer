// ═══════════════════════════════════════════════════════════════
// HELIX — AlgorithmHealthMonitor v1.1.0
// v1.0 (2026-05-12): Killswitch con CTE particionado (fix previo)
// v1.1 (2026-05-18): T2-J — Grace period para algos recién backfilled
//
// Killswitch real: deshabilita algoritmos perdedores del consensus.
//
// Reglas (basadas en algo_rank_history existente):
//   GRACE PERIOD: si total_draws < GRACE_DRAWS_TOTAL (100), aplicar
//     penalización suave (no killswitch, degrade leve ×0.8 solo si hr<13%).
//     Razonamiento: algos nuevos/recién backfilled necesitan ~100 evaluaciones
//     reales para que su distribución de ranks converja. Matarlos antes de
//     ese umbral basado en 30 sorteos de simulación es sesgo de arranque.
//
//   NORMAL (total_draws ≥ GRACE_DRAWS_TOTAL):
//   hit_rate@15 < baseline*1.10 (0.165) ∧ samples≥30 → DISABLED
//   hit_rate@15 < baseline      (0.150) ∧ samples≥15 → DEGRADED (weight ×0.5)
//   else                                              → HEALTHY
//
// donde baseline = N_DEFAULT/100 = 0.15 (probabilidad si predijéramos al azar)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'AlgorithmHealthMonitor' });

const BASELINE_RATE       = 0.15;        // P(rank≤15 | random) = 15/100
// V1 FIX (2026-05-21): Post-F3 dedupe reveló hit_rates reales mucho más bajas
// (los duplicados inflaban artificialmente las hit_rates a >baseline×1.10).
// Threshold previo (1.10) mataba 13/21 algos → consensus frágil.
// Nuevo: solo killear si hit_rate < baseline×0.85 (verdaderamente harmful),
// degradar a baseline×1.05 (marginal pero no destruir consensus).
const KILLSWITCH_FACTOR   = 0.85;        // hit_rate debe estar 15% por DEBAJO del baseline para kill
const DEGRADE_FACTOR      = 1.05;        // bajo baseline×1.05 → degrade (no kill)
const ROLLING_WINDOW      = 30;          // últimos 30 evaluaciones
const MIN_SAMPLES_KILL    = 60;          // V1 FIX: subido de 30 → 60 (más data antes de matar)
const MIN_SAMPLES_DEGRADE = 30;          // V1 FIX: subido de 15 → 30
const DEGRADE_PENALTY     = 0.5;         // weight multiplier si DEGRADED
// T2-J (2026-05-18): Grace period para algos recién backfilled
const GRACE_DRAWS_TOTAL   = 100;         // si total histórico < 100, modo grace
const GRACE_DEGRADE_THRESHOLD = 0.10;   // solo degrada en grace si hr < 10% (muy malo)
const GRACE_DEGRADE_PENALTY   = 0.8;    // penalización suave en grace period

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
        algo_name:    string;
        samples:      number;
        hits_at_15:   number;
        total_draws:  number;   // T2-J: total histórico del combo
      }>(
        // T2-J FIX: añadir total_draws para detectar grace period
        `WITH recent AS (
           SELECT algo_name, rank_of_winner,
                  ROW_NUMBER() OVER (PARTITION BY algo_name ORDER BY draw_date DESC) AS rn,
                  COUNT(*) OVER (PARTITION BY algo_name)                             AS total_draws
           FROM hitdash.algo_rank_history
           WHERE game_type = $1 AND draw_type = $2 AND half = $3
         )
         SELECT
           algo_name,
           COUNT(*)::int                                               AS samples,
           SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::int AS hits_at_15,
           MAX(total_draws)::int                                       AS total_draws
         FROM recent
         WHERE rn <= $4
         GROUP BY algo_name`,
        [game_type, draw_type, half, ROLLING_WINDOW]
      );

      for (const r of rows) {
        const samples     = Number(r.samples);
        const hits        = Number(r.hits_at_15);
        const totalDraws  = Number(r.total_draws);
        const hitRate     = samples > 0 ? hits / samples : 0;
        const inGrace     = totalDraws < GRACE_DRAWS_TOTAL;  // T2-J

        let status:           AlgoHealthStatus = 'healthy';
        let weight_multiplier = 1.0;
        let reason            = `hit@15=${(hitRate*100).toFixed(1)}% (baseline ${(BASELINE_RATE*100).toFixed(0)}%)`;

        if (inGrace) {
          // T2-J: Grace period — solo penalización suave si hit_rate es muy bajo
          if (samples >= MIN_SAMPLES_DEGRADE && hitRate < GRACE_DEGRADE_THRESHOLD) {
            status            = 'degraded';
            weight_multiplier = GRACE_DEGRADE_PENALTY;
            reason            = `GRACE-DEGRADED: hit@15=${(hitRate*100).toFixed(1)}% < ${GRACE_DEGRADE_THRESHOLD*100}% (total=${totalDraws}, gracia <${GRACE_DRAWS_TOTAL})`;
          } else {
            reason = `GRACE: hit@15=${(hitRate*100).toFixed(1)}% (total=${totalDraws} draws, esperando ≥${GRACE_DRAWS_TOTAL} para evaluar)`;
          }
        } else if (samples >= MIN_SAMPLES_KILL && hitRate < BASELINE_RATE * KILLSWITCH_FACTOR) {
          // V1 FIX: Solo killear si hit_rate < baseline*0.85 (verdaderamente harmful)
          status            = 'disabled';
          weight_multiplier = 0;
          reason            = `KILLSWITCH: hit@15=${(hitRate*100).toFixed(1)}% < baseline×${KILLSWITCH_FACTOR}=${(BASELINE_RATE*KILLSWITCH_FACTOR*100).toFixed(1)}% (n=${samples})`;
        } else if (samples >= MIN_SAMPLES_DEGRADE && hitRate < BASELINE_RATE * DEGRADE_FACTOR) {
          // V1 FIX: Degradar si está cerca del baseline (entre 0.85x y 1.05x)
          status            = 'degraded';
          weight_multiplier = DEGRADE_PENALTY;
          reason            = `DEGRADED: hit@15=${(hitRate*100).toFixed(1)}% < baseline×${DEGRADE_FACTOR}=${(BASELINE_RATE*DEGRADE_FACTOR*100).toFixed(1)}% (n=${samples})`;
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
