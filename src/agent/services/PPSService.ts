// ═══════════════════════════════════════════════════════════════
// HITDASH — PPSService v2.0.0  (MOTOR-Σ core)
//
// Predictive Power Score (PPS): señal de aprendizaje real por algoritmo.
//
//   PPS(algo, t) = EMA( 101 − rank_ganador(algo, t) , α=0.15 )
//
//   rank_of_winner = posición donde el par ganador apareció en el
//                    ranking de ese algoritmo ese día.
//   101            = penalidad máxima (par no estaba en la lista).
//
//   PPS range: 0 (siempre inútil) → 100 (siempre predice rank 1)
//   Valor inicial: 50.0 (neutral — sin historial)
//
// ── FUNCIÓN OBJETIVO: computeOptimalN() ────────────────────────
//
//   Encuentra el N mínimo < 70 donde la apuesta es rentable:
//
//     roi(N) = hit_rate(N) × PAYOUT / N  −  1  ≥  TARGET_ROI
//
//   hit_rate(N) = fracción de sorteos históricos donde el par
//                 ganador quedó en el top-N del consensus ponderado.
//   PAYOUT      = $50  (Florida Pick 3 Front/Back Pair por $1 bet)
//   TARGET_ROI  = 0.01 (1% ROI mínimo por sorteo)
//   MAX_N       = 69   (límite operacional: < 70 candidatos)
//
//   Si ningún N ∈ [1,69] alcanza 1% ROI, retorna el N con
//   mejor ROI disponible e is_profitable = false — el agente
//   sabe que la distribución es demasiado uniforme (i.i.d.).
//
// Ciclo:
//   Predicción  → persistSnapshot()  → guarda scores por par por algo
//   Post-sorteo → processPostDraw()  → calcula rank, actualiza PPS
//   Siguiente   → loadPPS()          → carga pesos para el consensus
//   N óptimo    → computeOptimalN()  → min N con ROI ≥ 1%
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'PPSService' });

// ─── Constantes ───────────────────────────────────────────────
const PPS_ALPHA     = 0.15;  // EMA decay — conservador para live
const PPS_INITIAL   = 50.0;  // punto neutro sin historial
const RANK_MISS     = 101;   // penalidad: par ganador no apareció en ranking del algo
const LOOKBACK_DAYS = 30;    // ventana por defecto para computeOptimalN

// ── MOTOR-Σ: función objetivo ─────────────────────────────────
const PAYOUT      = 50;    // Florida Pick 3 Front/Back Pair: $50 por $1 bet
const TARGET_ROI  = 0.01;  // 1% ROI mínimo por sorteo
const MAX_N       = 69;    // límite operacional: < 70 candidatos (usuario)

// ─── Tipos ───────────────────────────────────────────────────
export interface AlgoRankRecord {
  algo_name:      string;
  rank_of_winner: number;   // 1–101
  pps_before:     number;
  pps_after:      number;
}

export interface OptimalNResult {
  optimal_n:     number;   // N a usar en la predicción (min N rentable)
  p70_rank:      number;   // percentil 70 — compatibilidad con código existente
  hit_rate:      number;   // fracción histórica de sorteos donde ganador ≤ N
  expected_roi:  number;   // ROI esperado: hit_rate × PAYOUT / N − 1
  is_profitable: boolean;  // true si ROI ≥ TARGET_ROI (1%)
  sample_size:   number;
  basis:         string;   // texto explicativo para logs/dashboard
}

// ─── PPSService ───────────────────────────────────────────────
export class PPSService {
  constructor(private readonly pool: Pool) {}

  // ════════════════════════════════════════════════════════════
  // PREDICCIÓN: Guardar scores de cada algoritmo antes del sorteo
  // Llamado por AnalysisEngine.analyzePairs() al finalizar
  // ════════════════════════════════════════════════════════════
  async persistSnapshot(
    game_type: string,
    draw_type: string,
    draw_date: string,
    half:      string,
    // Map<algoName, {pair: normalizedScore}> — scores 0–1 por par
    algoScores: Map<string, Record<string, number>>
  ): Promise<void> {
    if (algoScores.size === 0) return;

    const inserts = [...algoScores.entries()].map(([algo_name, scores]) =>
      this.pool.query(
        `INSERT INTO hitdash.algo_prediction_snapshot
           (game_type, draw_type, draw_date, half, algo_name, pair_scores)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (game_type, draw_type, draw_date, half, algo_name) DO NOTHING`,
        [game_type, draw_type, draw_date, half, algo_name, JSON.stringify(scores)]
      ).catch(err => {
        logger.warn({ algo_name, error: err instanceof Error ? err.message : String(err) },
          'PPSService: error persistiendo snapshot — continuando');
      })
    );

    await Promise.allSettled(inserts);
    logger.debug(
      { game_type, draw_type, draw_date, half, algos: algoScores.size },
      'PPSService: snapshot persistido'
    );
  }

  // ════════════════════════════════════════════════════════════
  // PREDICCIÓN: Cargar PPS actuales como mapa algo→pps
  // Llamado por AnalysisEngine.analyzePairs() antes del consensus
  // ════════════════════════════════════════════════════════════
  async loadPPS(
    game_type: string,
    draw_type: string,
    half:      string
  ): Promise<Map<string, number>> {
    try {
      const { rows } = await this.pool.query<{ algo_name: string; pps: number }>(
        `SELECT algo_name, pps
         FROM hitdash.pps_state
         WHERE game_type = $1 AND draw_type = $2 AND half = $3`,
        [game_type, draw_type, half]
      );
      const map = new Map<string, number>();
      for (const r of rows) map.set(r.algo_name, +r.pps);
      return map;
    } catch {
      // Tabla puede no existir aún — retornar mapa vacío (fallback a pesos estáticos)
      return new Map();
    }
  }

  // ════════════════════════════════════════════════════════════
  // POST-SORTEO: Registrar rank del ganador y actualizar PPS
  // Llamado por PostDrawProcessor después de conocer el par real
  // ════════════════════════════════════════════════════════════
  async processPostDraw(
    game_type:    string,
    draw_type:    string,
    draw_date:    string,
    half:         string,
    winning_pair: string
  ): Promise<AlgoRankRecord[]> {

    // ── 1. Cargar snapshot de predicción de este sorteo ────────
    const { rows: snapshots } = await this.pool.query<{
      algo_name:   string;
      pair_scores: Record<string, number>;
    }>(
      `SELECT algo_name, pair_scores
       FROM hitdash.algo_prediction_snapshot
       WHERE game_type = $1 AND draw_type = $2 AND draw_date = $3 AND half = $4`,
      [game_type, draw_type, draw_date, half]
    ).catch(() => ({ rows: [] as Array<{ algo_name: string; pair_scores: Record<string, number> }> }));

    if (snapshots.length === 0) {
      logger.info(
        { game_type, draw_type, draw_date, half },
        'PPSService: sin snapshot para este sorteo — no se actualiza PPS'
      );
      return [];
    }

    // ── 2. Cargar PPS actuales ──────────────────────────────────
    const currentPPS = await this.loadPPS(game_type, draw_type, half);

    const records: AlgoRankRecord[] = [];

    for (const snap of snapshots) {
      const { algo_name, pair_scores } = snap;

      // Ordenar pares por score desc para determinar el ranking
      const sorted = Object.entries(pair_scores)
        .sort((a, b) => b[1] - a[1])
        .map(([pair]) => pair);

      const idx = sorted.indexOf(winning_pair);
      const rank_of_winner = idx >= 0 ? idx + 1 : RANK_MISS;

      // ── PPS update: EMA(α=0.15) ────────────────────────────────
      // contribution: 100 si rank=1 (perfecto), 0 si miss total (rank=101)
      const contribution = RANK_MISS - rank_of_winner;  // 0–100
      const pps_before   = currentPPS.get(algo_name) ?? PPS_INITIAL;
      const pps_after    = +(PPS_ALPHA * contribution + (1 - PPS_ALPHA) * pps_before).toFixed(4);

      records.push({ algo_name, rank_of_winner, pps_before, pps_after });

      // ── Upsert pps_state ───────────────────────────────────────
      await this.pool.query(
        `INSERT INTO hitdash.pps_state
           (algo_name, game_type, draw_type, half, pps, sample_count)
         VALUES ($1, $2, $3, $4, $5, 1)
         ON CONFLICT (algo_name, game_type, draw_type, half)
         DO UPDATE SET
           pps          = $5,
           sample_count = hitdash.pps_state.sample_count + 1,
           updated_at   = now()`,
        [algo_name, game_type, draw_type, half, pps_after]
      ).catch(err => logger.warn({ algo_name, error: err instanceof Error ? err.message : String(err) },
        'PPSService: error upserting pps_state'));

      // ── Insertar en historial ──────────────────────────────────
      await this.pool.query(
        `INSERT INTO hitdash.algo_rank_history
           (algo_name, game_type, draw_type, draw_date, half,
            winning_pair, rank_of_winner, pps_before, pps_after)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [algo_name, game_type, draw_type, draw_date, half,
         winning_pair, rank_of_winner, pps_before, pps_after]
      ).catch(err => logger.warn({ algo_name, error: err instanceof Error ? err.message : String(err) },
        'PPSService: error insertando rank_history'));
    }

    // ── 3. Log resumen ──────────────────────────────────────────
    const best  = records.reduce((a, b) => a.rank_of_winner < b.rank_of_winner ? a : b);
    const worst = records.reduce((a, b) => a.rank_of_winner > b.rank_of_winner ? a : b);

    logger.info(
      {
        game_type, draw_type, draw_date, half,
        winning_pair,
        algos_updated: records.length,
        best_algo:  `${best.algo_name}(rank=${best.rank_of_winner} pps=${best.pps_after.toFixed(1)})`,
        worst_algo: `${worst.algo_name}(rank=${worst.rank_of_winner} pps=${worst.pps_after.toFixed(1)})`,
      },
      'PPSService: PPS actualizado post-sorteo'
    );

    return records;
  }

  // ════════════════════════════════════════════════════════════
  // N ÓPTIMO: min N < 70 donde hit_rate(N) × PAYOUT / N ≥ TARGET_ROI
  //
  // FUNCIÓN OBJETIVO DEL MOTOR:
  //   Para cada N ∈ [1, 69]:
  //     hit_rate(N) = fracción de sorteos históricos donde
  //                   el effective_rank del ganador fue ≤ N
  //     roi(N)      = hit_rate(N) × $50 / N  −  1
  //
  //   Retorna el PRIMER N (el mínimo) donde roi(N) ≥ 1%.
  //   Si ninguno alcanza 1%, retorna el N con mejor ROI disponible
  //   e is_profitable = false (el agente honestamente reporta
  //   que no hay borde suficiente en los datos actuales).
  //
  //   Cada sorteo que pasa actualiza los ranks → el N converge
  //   automáticamente hacia el valor que históricamente da borde.
  // ════════════════════════════════════════════════════════════
  async computeOptimalN(
    game_type:   string,
    draw_type:   string,
    half:        string,
    lookback:    number = LOOKBACK_DAYS
  ): Promise<OptimalNResult> {
    const DEFAULT: OptimalNResult = {
      optimal_n: 15, p70_rank: 15,
      hit_rate: 0, expected_roi: 0, is_profitable: false,
      sample_size: 0,
      basis: 'default(sin historial)',
    };

    try {
      // ── 1. Traer historial de ranks ponderado por PPS ──────────
      const { rows } = await this.pool.query<{
        draw_date:      string;
        algo_name:      string;
        rank_of_winner: number;
        pps_after:      number;
      }>(
        `SELECT draw_date::text, algo_name, rank_of_winner, pps_after
         FROM hitdash.algo_rank_history
         WHERE game_type = $1 AND draw_type = $2 AND half = $3
           AND draw_date >= current_date - ($4 || ' days')::interval
           AND rank_of_winner < 101
         ORDER BY draw_date DESC`,
        [game_type, draw_type, half, lookback]
      );

      if (rows.length < 5) return { ...DEFAULT, sample_size: rows.length };

      // ── 2. Calcular effective_rank por sorteo (promedio ponderado por PPS) ──
      // effective_rank(sorteo) = Σ(rank × pps) / Σ(pps)
      // Representa "dónde aterrizaría el ganador en el consensus real"
      const byDate = new Map<string, { ranks: number[]; weights: number[] }>();
      for (const r of rows) {
        const entry = byDate.get(r.draw_date) ?? { ranks: [], weights: [] };
        entry.ranks.push(r.rank_of_winner);
        entry.weights.push(r.pps_after);
        byDate.set(r.draw_date, entry);
      }

      const effectiveRanks: number[] = [];
      for (const { ranks, weights } of byDate.values()) {
        const totalW = weights.reduce((a, b) => a + b, 0);
        if (totalW === 0) continue;
        const wRank = ranks.reduce((sum, r, i) => sum + r * weights[i]!, 0) / totalW;
        effectiveRanks.push(wRank);
      }

      if (effectiveRanks.length < 3) return { ...DEFAULT, sample_size: rows.length };

      effectiveRanks.sort((a, b) => a - b);
      const totalDraws = effectiveRanks.length;

      // p70_rank — compatibilidad con código existente
      const p70idx   = Math.floor(totalDraws * 0.70);
      const p70_rank = effectiveRanks[p70idx] ?? 15;

      // ── 3. FUNCIÓN OBJETIVO: min N ∈ [1, MAX_N] donde roi(N) ≥ TARGET_ROI ──
      // Recorre N de 1 a 69.  El primero que cumple la condición es el óptimo
      // (mínimo N rentable = mínimo riesgo con máximo borde comprobado).
      // Si ninguno cumple, se queda con el N de mejor ROI disponible.
      let bestN       = 15;
      let bestRoi     = -Infinity;
      let bestHitRate = 0;
      let profitable  = false;

      for (let N = 1; N <= MAX_N; N++) {
        // hit_rate(N): conteo de ranks ≤ N (efectivos ya ordenados → binary-search-like)
        let hits = 0;
        for (const r of effectiveRanks) {
          if (r <= N) hits++;
          else break; // ordenados ascendentemente → podemos salir temprano
        }
        const hitRate = hits / totalDraws;
        const roi     = hitRate * PAYOUT / N - 1;

        if (!profitable && roi >= TARGET_ROI) {
          // Primer N con ROI ≥ 1% → ÓPTIMO ENCONTRADO
          bestN       = N;
          bestRoi     = roi;
          bestHitRate = hitRate;
          profitable  = true;
          break;
        }

        // Guardar mejor ROI aunque no llegue al target (fallback honesto)
        if (roi > bestRoi) {
          bestRoi     = roi;
          bestN       = N;
          bestHitRate = hitRate;
        }
      }

      const basisLabel = profitable
        ? `roi=${(bestRoi * 100).toFixed(1)}% hit=${(bestHitRate * 100).toFixed(0)}% N=${bestN} draws=${totalDraws}`
        : `best_roi=${(bestRoi * 100).toFixed(1)}% N=${bestN} draws=${totalDraws} [sin borde ≥1%]`;

      logger.info(
        {
          game_type, draw_type, half,
          optimal_n: bestN, hit_rate: bestHitRate,
          expected_roi: bestRoi, is_profitable: profitable,
          p70_rank, sample_size: totalDraws,
        },
        profitable
          ? 'PPSService: N óptimo encontrado con ROI ≥ 1%'
          : 'PPSService: sin borde ≥1% — retornando mejor N disponible'
      );

      return {
        optimal_n:     bestN,
        p70_rank:      +p70_rank.toFixed(1),
        hit_rate:      +bestHitRate.toFixed(4),
        expected_roi:  +bestRoi.toFixed(4),
        is_profitable: profitable,
        sample_size:   totalDraws,
        basis:         basisLabel,
      };

    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) },
        'PPSService: error computando optimal_n — retornando default');
      return DEFAULT;
    }
  }

  // ════════════════════════════════════════════════════════════
  // DASHBOARD: Obtener ranking de algoritmos por PPS
  // ════════════════════════════════════════════════════════════
  async getPPSRanking(
    game_type: string,
    draw_type: string,
    half:      string
  ): Promise<Array<{ algo_name: string; pps: number; sample_count: number }>> {
    const { rows } = await this.pool.query<{
      algo_name: string; pps: number; sample_count: number;
    }>(
      `SELECT algo_name, pps, sample_count
       FROM hitdash.pps_state
       WHERE game_type = $1 AND draw_type = $2 AND half = $3
       ORDER BY pps DESC`,
      [game_type, draw_type, half]
    ).catch(() => ({ rows: [] as Array<{ algo_name: string; pps: number; sample_count: number }> }));
    return rows;
  }
}
