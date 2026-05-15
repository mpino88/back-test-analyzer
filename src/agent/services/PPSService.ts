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
// ─── EMA adaptivo (PATCH 2026-05-12) ───────────────────────────
// Antes: α=0.15 fijo → 20+ sorteos para que una señal nueva se refleje
// Ahora: α=0.30 mientras sample_count<30 (warmup rápido)
//        α=0.15 cuando sample_count≥30 (estabilidad madura)
const PPS_ALPHA_WARMUP = 0.30;  // hasta sample_count<30: aprendizaje rápido
const PPS_ALPHA_MATURE = 0.15;  // sample_count≥30: conservador como antes
const PPS_WARMUP_THRESHOLD = 30;
function adaptiveAlpha(sample_count: number): number {
  return sample_count < PPS_WARMUP_THRESHOLD ? PPS_ALPHA_WARMUP : PPS_ALPHA_MATURE;
}
const PPS_ALPHA = PPS_ALPHA_MATURE;  // legacy export — solo para compat
const PPS_INITIAL   = 50.0;  // punto neutro sin historial
const RANK_MISS     = 101;   // penalidad: par ganador no apareció en ranking del algo
const LOOKBACK_DAYS = 30;    // ventana por defecto para computeOptimalN

// ── MOTOR-Σ: función objetivo ─────────────────────────────────
const PAYOUT      = 50;    // Florida Pick 3 Front/Back Pair: $50 por $1 bet
const TARGET_ROI  = 0.01;  // 1% ROI mínimo por sorteo
// PATCH 2026-05-12: MAX_N 69 → 15 (corrección definitiva, no band-aid).
// Razón: sin borde estadístico, el algoritmo seleccionaba el N más grande
// con mejor hit_rate absoluto, ignorando que cubrir el 69% del espacio NO es predecir.
// Por encima de N=15 la apuesta deja de ser predicción y se vuelve cobertura ciega.
const MAX_N           = 15;  // límite duro de búsqueda (antes 69)
const MAX_N_NO_EDGE   = 10;  // límite cuando profitable=false (más conservador todavía)

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
  // SEED via REPLAY HISTÓRICO (PATCH 2026-05-12 — fix definitivo)
  // Caso de uso: combos nuevos sin backtest_results_v2.
  // Lee snapshots históricos de hitdash.algo_prediction_snapshot (si existen)
  // y aplica updateFromDraw() retroactivamente sobre los últimos N sorteos.
  // Si no hay snapshots → no hace nada (no inventa datos).
  // ════════════════════════════════════════════════════════════
  async seedPPSFromReplay(
    game_type: string,
    draw_type: string,
    half:      string,
    lookbackDraws: number = 60,
    force:     boolean = false   // ★ v2.5 (2026-05-15): bypass del guard maduro
  ): Promise<{ replayed: number; algos_updated: number }> {
    // ── Guard de madurez (skip si PPS ya tiene historia) ──
    // Por defecto NO re-replaya para no contaminar pps_state estable.
    // GenesisBootstrap pasa force=true para forzar replay completo del
    // periodo solicitado (populating algo_rank_history para Champion Mode).
    if (!force) {
      const { rows: existing } = await this.pool.query<{ max_sc: number }>(
        `SELECT COALESCE(MAX(sample_count), 0)::int AS max_sc FROM hitdash.pps_state
         WHERE game_type=$1 AND draw_type=$2 AND half=$3`,
        [game_type, draw_type, half]
      ).catch(() => ({ rows: [{ max_sc: 0 }] }));
      if ((existing[0]?.max_sc ?? 0) >= 10) {
        logger.info({ game_type, draw_type, half }, 'PPSService.seedReplay: PPS ya maduro, skip (use force=true para override)');
        return { replayed: 0, algos_updated: 0 };
      }
    } else {
      logger.warn({ game_type, draw_type, half }, '⚡ PPSService.seedReplay: FORCE mode — ignorando guard de madurez');
    }

    // Cargar snapshots históricos + resultados ganadores
    const { rows: draws } = await this.pool.query<{ draw_date: string; winning_pair: string }>(
      `SELECT draw_date::text, ${half === 'du' ? "(p2::text || p3::text)" : half === 'ab' ? "(p1::text || p2::text)" : "(p3::text || p4::text)"} AS winning_pair
       FROM hitdash.ingested_results
       WHERE game_type=$1 AND draw_type=$2
       ORDER BY draw_date DESC LIMIT $3`,
      [game_type, draw_type, lookbackDraws]
    ).catch(() => ({ rows: [] as Array<{ draw_date: string; winning_pair: string }> }));

    if (draws.length === 0) {
      logger.info({ game_type, draw_type, half }, 'PPSService.seedReplay: sin sorteos históricos');
      return { replayed: 0, algos_updated: 0 };
    }

    // Cronológico ASC
    const chronological = draws.reverse();
    let replayed = 0;
    const algosUpdated = new Set<string>();

    for (const d of chronological) {
      try {
        const records = await this.processPostDraw(
          game_type, draw_type, d.draw_date, half, d.winning_pair
        );
        if (records.length > 0) {
          replayed++;
          records.forEach(r => algosUpdated.add(r.algo_name));
        }
      } catch (err) {
        logger.debug({ err: String(err), draw_date: d.draw_date }, 'PPSService.seedReplay: sorteo sin snapshot, skip');
      }
    }

    logger.info(
      { game_type, draw_type, half, replayed, algos_updated: algosUpdated.size },
      '🌱 PPSService.seedReplay: PPS sembrado via replay histórico'
    );
    return { replayed, algos_updated: algosUpdated.size };
  }

  // ════════════════════════════════════════════════════════════
  // SEED: Sembrar PPS desde backtest_results_v2 (PATCH 2026-05-12)
  // Antes: combo nuevo → PPS=50 neutral por semanas
  // Ahora: si backtest_results_v2 tiene datos, sembrar PPS desde
  //        expected_rank y sample_count desde total_eval_pts.
  // Mapeo: pps_seed = max(10, min(95, 101 − expected_rank))
  //        sample_count_seed = ceil(total_eval_pts / 100)  (escalado)
  // ════════════════════════════════════════════════════════════
  async seedPPSFromBacktest(
    game_type: string,
    draw_type: string,
    half:      string
  ): Promise<{ seeded: number; skipped: number }> {
    // Si ya hay datos PPS, no sobrescribir
    const { rows: existing } = await this.pool.query<{ cnt: number }>(
      `SELECT COUNT(*)::int AS cnt FROM hitdash.pps_state
       WHERE game_type=$1 AND draw_type=$2 AND half=$3 AND sample_count >= 3`,
      [game_type, draw_type, half]
    ).catch(() => ({ rows: [{ cnt: 0 } as { cnt: number }] }));
    if ((existing[0]?.cnt ?? 0) > 0) {
      logger.info({ game_type, draw_type, half }, 'PPSService.seed: PPS ya tiene datos, skip');
      return { seeded: 0, skipped: 1 };
    }

    // Cargar backtest_results_v2
    const { rows: bt } = await this.pool.query<{
      strategy_name: string; expected_rank: number; total_eval_pts: number;
    }>(
      `SELECT strategy_name, expected_rank, total_eval_pts
       FROM hitdash.backtest_results_v2
       WHERE game_type=$1 AND half=$2
         AND expected_rank IS NOT NULL AND expected_rank > 0
         AND total_eval_pts >= 30`,
      [game_type, half]
    ).catch(() => ({ rows: [] as Array<{ strategy_name: string; expected_rank: number; total_eval_pts: number }> }));

    if (bt.length === 0) {
      logger.info({ game_type, draw_type, half }, 'PPSService.seed: backtest_results_v2 vacío, sin seed posible');
      return { seeded: 0, skipped: 0 };
    }

    let seeded = 0;
    for (const row of bt) {
      const expRank = Math.max(1, Math.min(101, Number(row.expected_rank)));
      const ppsSeed = Math.max(10, Math.min(95, +(101 - expRank).toFixed(2)));
      const sampleSeed = Math.max(3, Math.min(50, Math.ceil(Number(row.total_eval_pts) / 100)));

      await this.pool.query(
        `INSERT INTO hitdash.pps_state (algo_name, game_type, draw_type, half, pps, sample_count)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (algo_name, game_type, draw_type, half) DO NOTHING`,
        [row.strategy_name, game_type, draw_type, half, ppsSeed, sampleSeed]
      ).catch(err => logger.warn({ err: String(err), algo: row.strategy_name }, 'PPSService.seed: insert falló'));
      seeded++;
    }

    logger.info(
      { game_type, draw_type, half, seeded, source: 'backtest_results_v2' },
      'PPSService.seed: sembrado desde backtest histórico'
    );
    return { seeded, skipped: 0 };
  }

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

    // ── 2. Cargar PPS actuales + sample counts (para α adaptivo) ──
    const currentPPS = await this.loadPPS(game_type, draw_type, half);
    const sampleCounts = new Map<string, number>();
    try {
      const { rows: sc } = await this.pool.query<{ algo_name: string; sample_count: number }>(
        `SELECT algo_name, sample_count FROM hitdash.pps_state
         WHERE game_type=$1 AND draw_type=$2 AND half=$3`,
        [game_type, draw_type, half]
      );
      for (const r of sc) sampleCounts.set(r.algo_name, Number(r.sample_count));
    } catch { /* tabla podría no existir aún — ok */ }

    const records: AlgoRankRecord[] = [];

    for (const snap of snapshots) {
      const { algo_name, pair_scores } = snap;

      // Ordenar pares por score desc para determinar el ranking
      const sorted = Object.entries(pair_scores)
        .sort((a, b) => b[1] - a[1])
        .map(([pair]) => pair);

      const idx = sorted.indexOf(winning_pair);
      const rank_of_winner = idx >= 0 ? idx + 1 : RANK_MISS;

      // ── PPS update: EMA con α ADAPTIVO ─────────────────────────
      // α=0.30 mientras sample_count<30 (warmup rápido para nuevos combos)
      // α=0.15 cuando sample_count≥30 (estabilidad madura)
      // contribution: 100 si rank=1 (perfecto), 0 si miss total (rank=101)
      const sc          = sampleCounts.get(algo_name) ?? 0;
      const alpha       = adaptiveAlpha(sc);
      const contribution = RANK_MISS - rank_of_winner;  // 0–100
      const pps_before   = currentPPS.get(algo_name) ?? PPS_INITIAL;
      const pps_after    = +(alpha * contribution + (1 - alpha) * pps_before).toFixed(4);

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

      // BUG-FIX: DEFAULT usa sample_size=0 (señal explícita de "sin datos")
      // para que AnalysisEngine lo detecte y use el fallback cognitive_n.
      if (rows.length < 5) return DEFAULT;  // sample_size ya es 0 en DEFAULT

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

      if (effectiveRanks.length < 3) return DEFAULT; // sample_size=0 → fallback

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

        // PATCH 2026-05-12: cuando no hay borde, NO expandir N indefinidamente.
        // Antes: el "best ROI fallback" elegía N alto porque hit_rate↑ con N↑.
        // Ahora: limitamos el fallback a N ≤ MAX_N_NO_EDGE (10).
        // Filosofía: sin borde estadístico, mejor menos pares que más cobertura ciega.
        if (N <= MAX_N_NO_EDGE && roi > bestRoi) {
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
  // CHAMPION MODE: hit_rate reciente por algoritmo (ventana corta)
  //
  // Por qué existe: PPS usa toda la historia (α=0.15 sobre miles de samples)
  // → cambios de régimen recientes tardan en reflejarse.
  // Este método mira solo los últimos N sorteos para detectar algos
  // que están performando *AHORA* mejor que su promedio histórico.
  //
  // Devuelve: Map<algo_name, { hits, total, rate }>
  // - hits  = sorteos donde rank_of_winner ≤ 15
  // - total = sorteos evaluados en la ventana
  // - rate  = hits / total
  //
  // El algoritmo con rate ≥ 2× baseline (0.30) y total ≥ 20
  // se considera "champion" y domina el consenso.
  // ════════════════════════════════════════════════════════════
  async computeRecentHitRates(
    game_type:   string,
    draw_type:   string,
    half:        string,
    windowDraws: number = 30,
    topNCutoff:  number = 15
  ): Promise<Map<string, { hits: number; total: number; rate: number }>> {
    const map = new Map<string, { hits: number; total: number; rate: number }>();

    try {
      // Tomar últimos N sorteos por algoritmo y contar cuántas veces rank ≤ topNCutoff
      const { rows } = await this.pool.query<{
        algo_name: string;
        hits:      number;
        total:     number;
      }>(
        `WITH recent AS (
           SELECT algo_name, rank_of_winner,
                  ROW_NUMBER() OVER (PARTITION BY algo_name ORDER BY draw_date DESC) AS rn
           FROM hitdash.algo_rank_history
           WHERE game_type = $1 AND draw_type = $2 AND half = $3
         )
         SELECT algo_name,
                COUNT(*) FILTER (WHERE rank_of_winner <= $5)::int AS hits,
                COUNT(*)::int AS total
         FROM recent
         WHERE rn <= $4
         GROUP BY algo_name`,
        [game_type, draw_type, half, windowDraws, topNCutoff]
      );

      for (const r of rows) {
        const total = Number(r.total);
        const hits  = Number(r.hits);
        const rate  = total > 0 ? hits / total : 0;
        map.set(r.algo_name, { hits, total, rate });
      }
    } catch (err) {
      logger.debug(
        { error: err instanceof Error ? err.message : String(err) },
        'PPSService.computeRecentHitRates: tabla no disponible aún'
      );
    }

    return map;
  }

  // ════════════════════════════════════════════════════════════
  // CHAMPION MODE: detectar algoritmo dominante (si existe)
  //
  // Criterios (todos deben cumplirse):
  //   1. total ≥ 20 sorteos en la ventana (sample size mínimo)
  //   2. rate ≥ 0.30 (2× baseline aleatorio @ N=15)
  //   3. rate es el más alto entre todos los algoritmos
  //
  // Si nadie cumple → returns null (consenso normal opera)
  // Si hay champion → el consenso le da ~60% del peso total
  // ════════════════════════════════════════════════════════════
  async detectChampion(
    game_type:   string,
    draw_type:   string,
    half:        string,
    windowDraws: number = 30
  ): Promise<{ algo_name: string; hits: number; total: number; rate: number; edge: number } | null> {
    const BASELINE       = 0.15;       // baseline aleatorio @ N=15
    const CHAMPION_RATE  = 0.30;       // 2× baseline (1.5pp de edge mínimo)
    const MIN_SAMPLES    = 20;         // sample size mínimo para evidencia

    const hitRates = await this.computeRecentHitRates(game_type, draw_type, half, windowDraws, 15);
    if (hitRates.size === 0) return null;

    let bestAlgo: string | null = null;
    let bestRate = 0;
    let bestHits = 0;
    let bestTotal = 0;

    for (const [algo, m] of hitRates) {
      if (m.total < MIN_SAMPLES) continue;
      if (m.rate < CHAMPION_RATE) continue;
      if (m.rate > bestRate) {
        bestRate  = m.rate;
        bestAlgo  = algo;
        bestHits  = m.hits;
        bestTotal = m.total;
      }
    }

    if (!bestAlgo) return null;

    return {
      algo_name: bestAlgo,
      hits:      bestHits,
      total:     bestTotal,
      rate:      +bestRate.toFixed(4),
      edge:      +(bestRate - BASELINE).toFixed(4),
    };
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
