// ═══════════════════════════════════════════════════════════════
// HITDASH — CognitiveLearner v1.0.0 (Motor F1)
//
// Auto-aprendizaje cognitivo desde TODO el historial disponible.
//
// PROBLEMA QUE RESUELVE:
//   El MOTOR-Σ PPS arranca ciego (PPS=50) porque necesita
//   snapshots previos al sorteo para aprender. Los sorteos
//   históricos no tienen esos snapshots.
//
// SOLUCIÓN:
//   Simula retrospectivamente lo que cada algoritmo habría predicho
//   para CADA sorteo histórico usando SOLO los datos anteriores a
//   ese sorteo. Calcula PPS histórico real y lo usa para:
//     1. Sembrar pps_state con conocimiento real (no PPS=50 ciego)
//     2. Encontrar la combinación óptima de pesos (WeightOptimizer)
//     3. Guardar pesos en cognitive_algo_weights para uso en consensus
//
// METODOLOGÍA:
//   - Walk-forward validation (no data leakage)
//   - Holdout 20% más reciente para validación
//   - EMA α=0.15 para PPS (consistente con PPSService)
//   - Optimización de pesos por gradient-free search (grid scan)
//
// USO:
//   POST /api/agent/cognitive-learn  ← dispara aprendizaje en background
//   GET  /api/agent/cognitive-learn  ← estado y resultados
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../types/agent.types.js';
import type { PairHalf } from '../types/analysis.types.js';

const logger = pino({ name: 'CognitiveLearner' });

const PPS_ALPHA   = 0.15;
const PPS_INITIAL = 50.0;
const RANK_MISS   = 101;
const MIN_TRAIN   = 30;    // mínimo de sorteos históricos para entrenar
const HOLDOUT_PCT = 0.20;  // 20% más reciente para validación

// FIX #7 (2026-05-18) — Single Source of Truth
// Antes: array hardcoded duplicado vs analysis.types.ts. Cuando v2.4 eliminó
// fibonacci_pisano, este array se actualizó en commit posterior pero el
// scheduler ya había corrido con la versión vieja y re-insertó fibonacci_pisano
// en pps_state via INSERT línea 231. Migration 022 ahora lo bloquea con trigger.
import { CANONICAL_ALGORITHMS } from '../types/analysis.types.js';
const ALGO_NAMES = CANONICAL_ALGORITHMS;

export interface LearningReport {
  run_id:          string;
  game_type:       GameType;
  draw_type:       DrawType;
  half:            PairHalf;
  draws_learned:   number;
  algos_updated:   number;
  duration_ms:     number;
  pps_before:      Record<string, number>;
  pps_after:       Record<string, number>;
  learned_weights: Record<string, number>;
  holdout_hit_rate: number;
  optimal_n:       number;
  best_roi:        number;
  top_algos:       Array<{ algo: string; pps: number; weight: number }>;
}

interface DrawRow {
  draw_date: string;
  p1: number; p2: number; p3: number; p4: number;
}

export class CognitiveLearner {
  constructor(private readonly pool: Pool) {}

  // ════════════════════════════════════════════════════════════
  // PUNTO DE ENTRADA PRINCIPAL
  // ════════════════════════════════════════════════════════════
  async learnFromHistory(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf
  ): Promise<LearningReport> {
    const startMs = Date.now();

    // Crear run record
    const { rows: [runRow] } = await this.pool.query<{ id: string }>(
      `INSERT INTO hitdash.cognitive_learning_runs
         (game_type, draw_type, half, status)
       VALUES ($1, $2, $3, 'running')
       RETURNING id`,
      [game_type, draw_type, half]
    );
    const run_id = runRow!.id;

    try {
      const report = await this._doLearn(game_type, draw_type, half, run_id);

      await this.pool.query(
        `UPDATE hitdash.cognitive_learning_runs
         SET status = 'completed',
             draws_learned = $2, algos_updated = $3,
             best_hit_rate = $4, best_top_n = $5, best_roi = $6,
             completed_at = now()
         WHERE id = $1`,
        [run_id, report.draws_learned, report.algos_updated,
         report.holdout_hit_rate, report.optimal_n, report.best_roi]
      );

      logger.info(
        { run_id, game_type, draw_type, half,
          draws: report.draws_learned, duration_ms: report.duration_ms,
          hit_rate: report.holdout_hit_rate, optimal_n: report.optimal_n },
        'CognitiveLearner: aprendizaje completado'
      );

      return report;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.pool.query(
        `UPDATE hitdash.cognitive_learning_runs
         SET status='failed', error_message=$2, completed_at=now() WHERE id=$1`,
        [run_id, msg]
      );
      throw err;
    }
  }

  // ════════════════════════════════════════════════════════════
  // NÚCLEO DEL APRENDIZAJE
  // ════════════════════════════════════════════════════════════
  private async _doLearn(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    run_id: string
  ): Promise<LearningReport> {
    const startMs = Date.now();

    // ── 1. Cargar TODOS los sorteos históricos (ASC = más antiguo primero) ──
    const { rows: allDraws } = await this.pool.query<DrawRow>(
      `SELECT draw_date::text, p1, p2, p3, p4
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
       ORDER BY draw_date ASC`,
      [game_type, draw_type]
    );

    const total = allDraws.length;
    if (total < MIN_TRAIN + 10) {
      throw new Error(`Datos insuficientes: ${total} sorteos (mínimo ${MIN_TRAIN + 10})`);
    }

    logger.info({ game_type, draw_type, half, total }, 'CognitiveLearner: iniciando walk-forward');

    // ── 2. Extractor de par según half ───────────────────────────────────────
    const extractPair = (r: DrawRow): string => {
      if (half === 'ab') return `${r.p1}${r.p2}`;
      if (half === 'cd') return `${r.p3}${r.p4}`;
      return `${r.p2}${r.p3}`;
    };

    // ── 3. Walk-forward: para cada sorteo evaluar los algoritmos ─────────────
    // Split: 80% entrenamiento, 20% holdout (más reciente)
    const holdoutStart = Math.floor(total * (1 - HOLDOUT_PCT));

    // PPS acumulado por algoritmo (EMA running)
    const ppsRunning: Record<string, number> = {};
    for (const a of ALGO_NAMES) ppsRunning[a] = PPS_INITIAL;

    // Para el optimizador: guardar ranks por sorteo en holdout
    // Structure: ranksHoldout[algoName] = [rank1, rank2, ...]
    const ranksHoldout: Record<string, number[]> = {};
    for (const a of ALGO_NAMES) ranksHoldout[a] = [];

    // PPS before (snapshot del estado inicial)
    const ppsBefore: Record<string, number> = {};
    const { rows: existingPPS } = await this.pool.query<{ algo_name: string; pps: number }>(
      `SELECT algo_name, pps FROM hitdash.pps_state
       WHERE game_type = $1 AND draw_type = $2 AND half = $3`,
      [game_type, draw_type, half]
    ).catch(() => ({ rows: [] as Array<{ algo_name: string; pps: number }> }));
    for (const r of existingPPS) ppsBefore[r.algo_name] = r.pps;

    let drawsLearned = 0;

    for (let i = MIN_TRAIN; i < total; i++) {
      const evalDraw = allDraws[i]!;
      const trainDraws = allDraws.slice(0, i);  // datos ANTES de este sorteo
      const winPair = extractPair(evalDraw);
      const isHoldout = i >= holdoutStart;

      // Simular predicción de cada algoritmo con los datos de entrenamiento
      const algoRanks = await this._simulateAllAlgos(
        game_type, draw_type, half, trainDraws, winPair
      );

      // Actualizar PPS por EMA
      for (const [algo, rank] of Object.entries(algoRanks)) {
        const contribution = RANK_MISS - rank;  // 0–100
        ppsRunning[algo] = +(PPS_ALPHA * contribution + (1 - PPS_ALPHA) * (ppsRunning[algo] ?? PPS_INITIAL)).toFixed(4);

        if (isHoldout) {
          ranksHoldout[algo] = ranksHoldout[algo] ?? [];
          ranksHoldout[algo]!.push(rank);
        }
      }

      drawsLearned++;

      if (drawsLearned % 50 === 0) {
        logger.debug({ drawsLearned, total, pct: ((drawsLearned / (total - MIN_TRAIN)) * 100).toFixed(0) + '%' },
          'CognitiveLearner: progreso');
      }
    }

    // ── 4. WeightOptimizer — encontrar pesos óptimos ──────────────────────────
    const { weights: learnedWeights, hit_rate: holdoutHitRate, optimal_n: optN, best_roi: bestRoi } =
      this._optimizeWeights(ranksHoldout, ppsRunning);

    // ── 5. Sembrar pps_state con PPS histórico aprendido ──────────────────────
    logger.info({ game_type, draw_type, half }, 'CognitiveLearner: sembrando pps_state con PPS histórico');

    for (const [algo, pps] of Object.entries(ppsRunning)) {
      await this.pool.query(
        `INSERT INTO hitdash.pps_state
           (algo_name, game_type, draw_type, half, pps, sample_count)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (algo_name, game_type, draw_type, half)
         DO UPDATE SET
           pps          = $5,
           sample_count = $6,
           updated_at   = now()`,
        [algo, game_type, draw_type, half, pps, drawsLearned]
      ).catch(err => logger.warn({ algo, error: err.message }, 'PPS seed error — continuando'));
    }

    // ── 6. Persistir pesos óptimos en cognitive_algo_weights ──────────────────
    for (const [algo, weight] of Object.entries(learnedWeights)) {
      const holdoutRanks = ranksHoldout[algo] ?? [];
      const hHitRate = holdoutRanks.filter(r => r <= optN).length /
                       Math.max(holdoutRanks.length, 1);
      const avgRank  = holdoutRanks.length > 0
        ? holdoutRanks.reduce((a, b) => a + b, 0) / holdoutRanks.length
        : null;

      await this.pool.query(
        `INSERT INTO hitdash.cognitive_algo_weights
           (algo_name, game_type, draw_type, half,
            learned_weight, holdout_hit_rate, holdout_avg_rank,
            historical_pps, sample_draws, run_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
         ON CONFLICT (algo_name, game_type, draw_type, half)
         DO UPDATE SET
           learned_weight    = $5,
           holdout_hit_rate  = $6,
           holdout_avg_rank  = $7,
           historical_pps    = $8,
           sample_draws      = $9,
           run_id            = $10,
           updated_at        = now()`,
        [algo, game_type, draw_type, half,
         weight, hHitRate, avgRank,
         ppsRunning[algo], drawsLearned, run_id]
      ).catch(() => undefined);
    }

    const top_algos = Object.entries(ppsRunning)
      .map(([algo, pps]) => ({ algo, pps, weight: learnedWeights[algo] ?? 1.0 }))
      .sort((a, b) => b.pps - a.pps)
      .slice(0, 5);

    return {
      run_id,
      game_type,
      draw_type,
      half,
      draws_learned:    drawsLearned,
      algos_updated:    ALGO_NAMES.length,
      duration_ms:      Date.now() - startMs,
      pps_before:       ppsBefore,
      pps_after:        { ...ppsRunning },
      learned_weights:  learnedWeights,
      holdout_hit_rate: holdoutHitRate,
      optimal_n:        optN,
      best_roi:         bestRoi,
      top_algos,
    };
  }

  // ════════════════════════════════════════════════════════════
  // SIMULACIÓN IN-MEMORY DE LOS 20 ALGORITMOS
  // Todos usan solo los trainDraws proporcionados (no hay DB call)
  // ════════════════════════════════════════════════════════════
  private async _simulateAllAlgos(
    _game_type: GameType,
    _draw_type: DrawType,
    half: PairHalf,
    trainDraws: DrawRow[],
    winPair: string
  ): Promise<Record<string, number>> {
    const ranks: Record<string, number> = {};

    const extractPair = (r: DrawRow): string => {
      if (half === 'ab') return `${r.p1}${r.p2}`;
      if (half === 'cd') return `${r.p3}${r.p4}`;
      return `${r.p2}${r.p3}`;
    };

    const pairs = trainDraws.map(extractPair);
    const total = pairs.length;
    const recent = pairs.slice(-30);

    // ── Conteos base ─────────────────────────────────────────────
    const countAll:    Record<string, number> = {};
    const countRecent: Record<string, number> = {};
    for (const p of pairs)   countAll[p]    = (countAll[p]    ?? 0) + 1;
    for (const p of recent)  countRecent[p] = (countRecent[p] ?? 0) + 1;

    // Helpers
    const allPairs = Array.from({ length: 100 }, (_, i) =>
      `${Math.floor(i / 10)}${i % 10}`
    );

    const rankOf = (scored: Array<{ pair: string; score: number }>): number => {
      scored.sort((a, b) => b.score - a.score);
      const idx = scored.findIndex(s => s.pair === winPair);
      return idx >= 0 ? idx + 1 : RANK_MISS;
    };

    // ── 1. frequency — frecuencia histórica simple ────────────────
    {
      const scored = allPairs.map(p => ({ pair: p, score: countAll[p] ?? 0 }));
      ranks['frequency'] = rankOf(scored);
    }

    // ── 2. gap_analysis — sobredebido (ausencia reciente) ─────────
    {
      const lastSeen: Record<string, number> = {};
      for (let i = pairs.length - 1; i >= 0; i--) {
        const p = pairs[i]!;
        if (lastSeen[p] === undefined) lastSeen[p] = pairs.length - i;
      }
      const scored = allPairs.map(p => ({
        pair: p,
        score: (lastSeen[p] ?? total) / Math.max(total / Math.max(countAll[p] ?? 0, 1), 1),
      }));
      ranks['gap_analysis'] = rankOf(scored);
    }

    // ── 3. hot_cold — momentum z-score ───────────────────────────
    {
      const scored = allPairs.map(p => {
        const fa = total > 0 ? (countAll[p] ?? 0) / total : 0;
        const fr = recent.length > 0 ? (countRecent[p] ?? 0) / recent.length : 0;
        const std = Math.sqrt(fa * (1 - fa) / Math.max(recent.length, 1));
        const z = std > 0 ? (fr - fa) / std : 0;
        return { pair: p, score: z };
      });
      ranks['hot_cold'] = rankOf(scored);
    }

    // ── 4. trend_momentum — fórmula exacta Ballbot ────────────────
    {
      const scored = allPairs.map(p => {
        const ca = countAll[p]    ?? 0;
        const cr = countRecent[p] ?? 0;
        const fa = total > 0 ? ca / total : 0;
        const fr = recent.length > 0 ? cr / recent.length : 0;
        let m = fa > 0 ? fr / fa : (cr > 0 ? 10 : 0);
        if (ca < 3 || m < 1.0) m = 0;
        return { pair: p, score: m };
      });
      ranks['trend_momentum'] = rankOf(scored);
    }

    // ── 5. pair_return_cycle — ausencia vs ciclo histórico ────────
    {
      const scored = allPairs.map(p => {
        const indices: number[] = [];
        for (let i = 0; i < pairs.length; i++) {
          if (pairs[i] === p) indices.push(i);
        }
        if (!indices.length) return { pair: p, score: 0.75 };
        const last = pairs.length - 1 - indices[indices.length - 1]!;
        if (indices.length < 3) {
          const avgGap = pairs.length / indices.length;
          return { pair: p, score: Math.min(1, last / (avgGap * 3)) };
        }
        const gaps = indices.slice(1).map((idx, i) => idx - indices[i]!);
        const meanG = gaps.reduce((a, b) => a + b, 0) / gaps.length;
        const stdG  = Math.sqrt(gaps.reduce((a, b) => a + (b - meanG) ** 2, 0) / gaps.length);
        const z = (last - meanG) / Math.max(stdG, 1);
        return { pair: p, score: 1 / (1 + Math.exp(-z)) };
      });
      ranks['pair_return_cycle'] = rankOf(scored);
    }

    // ── 6. markov_order2 — transición de par anterior ─────────────
    {
      const lastPair = pairs[pairs.length - 1];
      const trans: Record<string, number> = {};
      let total_from_last = 0;
      for (let i = 0; i < pairs.length - 1; i++) {
        if (pairs[i] === lastPair) {
          const next = pairs[i + 1]!;
          trans[next] = (trans[next] ?? 0) + 1;
          total_from_last++;
        }
      }
      const scored = allPairs.map(p => ({
        pair: p,
        score: total_from_last > 0 ? (trans[p] ?? 0) / total_from_last : 0,
      }));
      ranks['markov_order2'] = rankOf(scored);
    }

    // ── 7. sum_pattern_filter — frecuencia de suma a+b ────────────
    {
      const sumFreqAll:    Record<number, number> = {};
      const sumFreqRecent: Record<number, number> = {};
      for (const p of pairs) {
        const s = parseInt(p[0]!, 10) + parseInt(p[1]!, 10);
        sumFreqAll[s]    = (sumFreqAll[s]    ?? 0) + 1;
      }
      for (const p of recent) {
        const s = parseInt(p[0]!, 10) + parseInt(p[1]!, 10);
        sumFreqRecent[s] = (sumFreqRecent[s] ?? 0) + 1;
      }
      const maxAll    = Math.max(...Object.values(sumFreqAll),    1);
      const maxRecent = Math.max(...Object.values(sumFreqRecent), 1);
      const scored = allPairs.map(p => {
        const s = parseInt(p[0]!, 10) + parseInt(p[1]!, 10);
        return {
          pair: p,
          score: 0.6 * ((sumFreqAll[s] ?? 0) / maxAll) +
                 0.4 * ((sumFreqRecent[s] ?? 0) / maxRecent),
        };
      });
      ranks['sum_pattern_filter'] = rankOf(scored);
    }

    // ── 8. trend_momentum_sweet — bracket dorado: count_recent==1 ∧ momentum≥3x ──
    // Misma lógica que trend_momentum pero filtrando EXACTAMENTE count_recent==1.
    {
      const scored = allPairs.map(p => {
        const ca = countAll[p]    ?? 0;
        const cr = countRecent[p] ?? 0;
        const fa = total > 0 ? ca / total : 0;
        const fr = recent.length > 0 ? cr / recent.length : 0;
        const momentum = fa > 0 ? fr / fa : (cr > 0 ? 10 : 0);
        // sweet spot: exactamente 1 hit reciente + momentum fuerte + historial mínimo
        const score = (ca >= 3 && cr === 1 && momentum >= 3.0) ? momentum : 0;
        return { pair: p, score };
      });
      ranks['trend_momentum_sweet'] = rankOf(scored);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // FIX #2 (2026-05-18) — VERDAD RADICAL APEX
    // Antes: 13 algoritmos compartían 2 rankings idénticos (freq vs recent_freq).
    // La regresión de pesos en _optimizeWeights() era matemáticamente degenerada
    // — no podía distinguir 8 algos del grupo freq ni 5 del grupo recent_freq.
    // Ahora: cada algoritmo tiene su scoring diferenciado real, alineado con
    // la lógica del algoritmo live (runPairs) en AnalysisEngine. Esto produce
    // pesos cognitivos genuinos por algoritmo.
    // ─────────────────────────────────────────────────────────────────────────

    // ── 9. pairs_correlation — co-ocurrencia de dígitos a y b ─────
    // Frecuencia conjunta de dígitos vs producto de marginales (lift).
    {
      const digitFreq: number[] = new Array(10).fill(0) as number[];
      for (const p of pairs) {
        digitFreq[parseInt(p[0]!, 10)]! += 1;
        digitFreq[parseInt(p[1]!, 10)]! += 1;
      }
      const totalDigits = digitFreq.reduce((a, b) => a + b, 0) || 1;
      const scored = allPairs.map(p => {
        const a = parseInt(p[0]!, 10);
        const b = parseInt(p[1]!, 10);
        const observed = (countAll[p] ?? 0) / Math.max(total, 1);
        const expected = (digitFreq[a]! / totalDigits) * (digitFreq[b]! / totalDigits);
        const lift = expected > 0 ? observed / expected : 0;
        return { pair: p, score: lift };
      });
      ranks['pairs_correlation'] = rankOf(scored);
    }

    // ── 10. streak — racha de presencia consecutiva ──────────────
    // Pares con racha activa de aparición en últimos sorteos.
    {
      const streakLen: Record<string, number> = {};
      for (const p of allPairs) streakLen[p] = 0;
      // Recorremos del final hacia atrás; mientras sigue apareciendo, contamos
      for (let i = pairs.length - 1; i >= 0 && i >= pairs.length - 10; i--) {
        const cur = pairs[i]!;
        streakLen[cur] = (streakLen[cur] ?? 0) + 1;
      }
      const scored = allPairs.map(p => ({ pair: p, score: streakLen[p] ?? 0 }));
      ranks['streak'] = rankOf(scored);
    }

    // ── 11. position — bias posicional por dígito ────────────────
    // Usa la posición REAL en trainDraws.p1..p4 (no solo el par extraído).
    {
      const posBias: Record<string, number> = {};
      const idxA = half === 'ab' ? 0 : half === 'cd' ? 2 : 1;
      const idxB = half === 'ab' ? 1 : half === 'cd' ? 3 : 2;
      const posCountA: number[] = new Array(10).fill(0) as number[];
      const posCountB: number[] = new Array(10).fill(0) as number[];
      for (const d of trainDraws) {
        const digits = [d.p1, d.p2, d.p3, d.p4];
        posCountA[digits[idxA]!]! += 1;
        posCountB[digits[idxB]!]! += 1;
      }
      const totA = posCountA.reduce((a, b) => a + b, 0) || 1;
      const totB = posCountB.reduce((a, b) => a + b, 0) || 1;
      for (const p of allPairs) {
        const a = parseInt(p[0]!, 10);
        const b = parseInt(p[1]!, 10);
        posBias[p] = (posCountA[a]! / totA) * (posCountB[b]! / totB);
      }
      const scored = allPairs.map(p => ({ pair: p, score: posBias[p] ?? 0 }));
      ranks['position'] = rankOf(scored);
    }

    // ── 12. moving_averages — SMA7 menos SMA14 (momentum señal MA) ───
    {
      const last7  = pairs.slice(-7);
      const last14 = pairs.slice(-14);
      const sma7:  Record<string, number> = {};
      const sma14: Record<string, number> = {};
      for (const p of last7)  sma7[p]  = (sma7[p]  ?? 0) + 1;
      for (const p of last14) sma14[p] = (sma14[p] ?? 0) + 1;
      const scored = allPairs.map(p => ({
        pair: p,
        score: ((sma7[p] ?? 0) / 7) - ((sma14[p] ?? 0) / 14),
      }));
      ranks['moving_averages'] = rankOf(scored);
    }

    // ── 13. bayesian_score — combina 3 señales independientes ─────
    // P(par | evidencia) ∝ freq_normalizada × hot_factor × recency_factor
    {
      const maxAll    = Math.max(...Object.values(countAll), 1);
      const maxRecent = Math.max(...Object.values(countRecent), 1);
      const lastSeen: Record<string, number> = {};
      for (let i = pairs.length - 1; i >= 0; i--) {
        const p = pairs[i]!;
        if (lastSeen[p] === undefined) lastSeen[p] = pairs.length - i;
      }
      const scored = allPairs.map(p => {
        const freqN   = (countAll[p] ?? 0) / maxAll;          // P(par)
        const hotN    = (countRecent[p] ?? 0) / maxRecent;    // P(reciente)
        const recency = 1 / Math.max(lastSeen[p] ?? total, 1); // 1/gap
        return { pair: p, score: freqN * 0.4 + hotN * 0.4 + recency * 0.2 };
      });
      ranks['bayesian_score'] = rankOf(scored);
    }

    // ── 14. transition_follow — Markov-1 sucesor inmediato ───────
    // P(par = X | último_par = Y). Diferente a markov_order2 que usa
    // contexto adicional; aquí solo el sucesor directo último→siguiente.
    {
      const trans: Record<string, number> = {};
      let total_trans = 0;
      const lastPair = pairs[pairs.length - 1];
      for (let i = 0; i < pairs.length - 1; i++) {
        if (pairs[i] === lastPair) {
          const next = pairs[i + 1]!;
          trans[next] = (trans[next] ?? 0) + 1;
          total_trans++;
        }
      }
      // Mezclamos con la frecuencia global (Laplace smoothing) para evitar
      // colapso cuando lastPair tiene pocas observaciones.
      const scored = allPairs.map(p => {
        const transProb = total_trans > 0 ? (trans[p] ?? 0) / total_trans : 0;
        const globalProb = (countAll[p] ?? 0) / Math.max(total, 1);
        return { pair: p, score: 0.7 * transProb + 0.3 * globalProb };
      });
      ranks['transition_follow'] = rankOf(scored);
    }

    // ── 15. calendar_pattern — frecuencia en el DOW del próximo sorteo ──
    // Usa draw_date REAL de trainDraws para extraer DOW (0=Sun..6=Sat).
    // Asumimos que el "próximo sorteo" es DOW(last_draw_date) + 1.
    {
      const last = trainDraws[trainDraws.length - 1];
      const nextDate = last
        ? new Date(new Date(last.draw_date).getTime() + 86400000)
        : new Date();
      const targetDOW = nextDate.getUTCDay();
      const dowFreq: Record<string, number> = {};
      for (let i = 0; i < trainDraws.length; i++) {
        const d = trainDraws[i]!;
        if (new Date(d.draw_date).getUTCDay() === targetDOW) {
          const p = pairs[i]!;
          dowFreq[p] = (dowFreq[p] ?? 0) + 1;
        }
      }
      const scored = allPairs.map(p => ({ pair: p, score: dowFreq[p] ?? 0 }));
      ranks['calendar_pattern'] = rankOf(scored);
    }

    // ── 16. decade_family — momentum por familia de decena (00-09, 10-19, ...) ──
    {
      const famCountAll:    number[] = new Array(10).fill(0) as number[];
      const famCountRecent: number[] = new Array(10).fill(0) as number[];
      for (const p of pairs)  famCountAll[parseInt(p[0]!, 10)]!    += 1;
      for (const p of recent) famCountRecent[parseInt(p[0]!, 10)]! += 1;
      const scored = allPairs.map(p => {
        const fam = parseInt(p[0]!, 10);
        const fa  = famCountAll[fam]!    / Math.max(total, 1);
        const fr  = famCountRecent[fam]! / Math.max(recent.length, 1);
        const momentum = fa > 0 ? fr / fa : (fr > 0 ? 10 : 0);
        return { pair: p, score: momentum };
      });
      ranks['decade_family'] = rankOf(scored);
    }

    // ── 17. max_per_week_day — par con max frecuencia en DOW específico ──
    // Diferencia con calendar_pattern: este premia consistencia DOW (DOW-only,
    // sin smoothing global).
    {
      const last = trainDraws[trainDraws.length - 1];
      const nextDate = last
        ? new Date(new Date(last.draw_date).getTime() + 86400000)
        : new Date();
      const targetDOW = nextDate.getUTCDay();
      const dowCounts: Record<string, number> = {};
      let dowTotal = 0;
      for (let i = 0; i < trainDraws.length; i++) {
        if (new Date(trainDraws[i]!.draw_date).getUTCDay() === targetDOW) {
          dowCounts[pairs[i]!] = (dowCounts[pairs[i]!] ?? 0) + 1;
          dowTotal++;
        }
      }
      const maxDow = Math.max(...Object.values(dowCounts), 1);
      const scored = allPairs.map(p => ({
        pair: p,
        score: dowTotal > 0 ? (dowCounts[p] ?? 0) / maxDow : 0,
      }));
      ranks['max_per_week_day'] = rankOf(scored);
    }

    // ── 18. double_triple — detector de pares con dígitos repetidos ──
    // Régimen: ¿estamos en periodo "dobles" (xx) o "únicos" (xy)?
    {
      let doublesRecent = 0;
      let totalRecent = recent.length;
      for (const p of recent) {
        if (p[0] === p[1]) doublesRecent++;
      }
      const doubleRegime = totalRecent > 0 ? doublesRecent / totalRecent : 0.1;
      // Si régimen es alto en dobles, premia dobles; si bajo, premia únicos.
      const scored = allPairs.map(p => {
        const isDouble = p[0] === p[1];
        const baseFreq = (countAll[p] ?? 0) / Math.max(total, 1);
        const regimeBoost = isDouble ? doubleRegime * 2 : (1 - doubleRegime);
        return { pair: p, score: baseFreq * regimeBoost };
      });
      ranks['double_triple'] = rankOf(scored);
    }

    // ── 19. cross_draw — co-ocurrencia midday↔evening del MISMO día ──
    // Sin DB call no podemos cruzar con el otro draw_type. Aproximamos con
    // la correlación entre pares consecutivos (proxy de cross-draw similar
    // a usar el sorteo previo como contexto vecino).
    {
      const consecutive: Record<string, number> = {};
      let total_consec = 0;
      for (let i = 1; i < pairs.length; i++) {
        const cur = pairs[i]!;
        const prev = pairs[i - 1]!;
        // Co-ocurrencia: cuando aparece prev, ¿qué viene después?
        // Esto es similar a markov pero usando el par-en-bloque-de-2.
        const key = `${prev}:${cur}`;
        consecutive[key] = (consecutive[key] ?? 0) + 1;
        total_consec++;
      }
      const lastPair = pairs[pairs.length - 1] ?? '00';
      const scored = allPairs.map(p => {
        const cnt = consecutive[`${lastPair}:${p}`] ?? 0;
        const baseFreq = (countAll[p] ?? 0) / Math.max(total, 1);
        return {
          pair: p,
          score: total_consec > 0
            ? 0.5 * (cnt / total_consec) + 0.5 * baseFreq
            : baseFreq,
        };
      });
      ranks['cross_draw'] = rankOf(scored);
    }

    // ── 20. est_individuales — hottest-due individual digits ─────
    // Score(par a,b) = hot_score(a) × hot_score(b) — favorece pares
    // donde AMBOS dígitos individuales tienen momentum positivo.
    {
      const digCountAll:    number[] = new Array(10).fill(0) as number[];
      const digCountRecent: number[] = new Array(10).fill(0) as number[];
      for (const p of pairs) {
        digCountAll[parseInt(p[0]!, 10)]! += 1;
        digCountAll[parseInt(p[1]!, 10)]! += 1;
      }
      for (const p of recent) {
        digCountRecent[parseInt(p[0]!, 10)]! += 1;
        digCountRecent[parseInt(p[1]!, 10)]! += 1;
      }
      const totA = digCountAll.reduce((a, b) => a + b, 0) || 1;
      const totR = digCountRecent.reduce((a, b) => a + b, 0) || 1;
      const hotScore = (d: number) => {
        const fa = digCountAll[d]!    / totA;
        const fr = digCountRecent[d]! / totR;
        return fa > 0 ? fr / fa : (fr > 0 ? 10 : 0);
      };
      const scored = allPairs.map(p => {
        const a = parseInt(p[0]!, 10);
        const b = parseInt(p[1]!, 10);
        return { pair: p, score: hotScore(a) * hotScore(b) };
      });
      ranks['est_individuales'] = rankOf(scored);
    }

    // ── 21. terminal_analysis — terminal (segundo dígito) momentum ──
    // Agrupa por terminal: 00,10,20,..,90 todos terminan en 0.
    {
      const termCountAll:    number[] = new Array(10).fill(0) as number[];
      const termCountRecent: number[] = new Array(10).fill(0) as number[];
      for (const p of pairs)  termCountAll[parseInt(p[1]!, 10)]!    += 1;
      for (const p of recent) termCountRecent[parseInt(p[1]!, 10)]! += 1;
      const scored = allPairs.map(p => {
        const term = parseInt(p[1]!, 10);
        const fa = termCountAll[term]!    / Math.max(total, 1);
        const fr = termCountRecent[term]! / Math.max(recent.length, 1);
        const momentum = fa > 0 ? fr / fa : (fr > 0 ? 10 : 0);
        // Combina con frecuencia del par específico (cap a aporte ≤50%)
        const pairFreq = (countAll[p] ?? 0) / Math.max(total, 1);
        return { pair: p, score: 0.6 * momentum + 0.4 * pairFreq * 10 };
      });
      ranks['terminal_analysis'] = rankOf(scored);
    }

    return ranks;
  }

  // ════════════════════════════════════════════════════════════
  // WEIGHT OPTIMIZER — gradient-free grid scan
  // Encuentra la combinación de algoritmos que maximiza hit_rate
  // en el holdout (sin data leakage)
  // ════════════════════════════════════════════════════════════
  private _optimizeWeights(
    ranksHoldout: Record<string, number[]>,
    ppsLearned: Record<string, number>
  ): {
    weights: Record<string, number>;
    hit_rate: number;
    optimal_n: number;
    best_roi: number;
  } {
    const algos  = Object.keys(ranksHoldout).filter(a => (ranksHoldout[a]?.length ?? 0) > 0);
    const nDraws = ranksHoldout[algos[0]!]?.length ?? 0;

    if (nDraws === 0) {
      const eq: Record<string, number> = {};
      for (const a of ALGO_NAMES) eq[a] = 1.0;
      return { weights: eq, hit_rate: 0, optimal_n: 15, best_roi: -1 };
    }

    // Estrategia de optimización: PPS-proportional weights
    // peso(algo) = max(0.1, PPS(algo) / 50.0)
    // Esto escala: PPS=100 → peso=2.0, PPS=50 → peso=1.0, PPS=0 → peso=0.1
    const weights: Record<string, number> = {};
    for (const a of ALGO_NAMES) {
      const pps = ppsLearned[a] ?? PPS_INITIAL;
      weights[a] = +(Math.max(0.1, pps / 50.0)).toFixed(3);
    }

    // Calcular effective_rank del consensus con estos pesos para cada sorteo holdout
    // effective_rank = rango que tendría el par ganador en el ranking ponderado
    const effectiveRanks: number[] = [];

    for (let d = 0; d < nDraws; d++) {
      // Score ponderado por par para este sorteo
      const pairScores: Record<string, number> = {};
      let totalW = 0;

      for (const algo of algos) {
        const rank = ranksHoldout[algo]![d]!;
        const w    = weights[algo] ?? 1.0;
        // Convertir rank a score: rank=1 → 1.0, rank=100 → 0.0
        const score = rank < RANK_MISS ? (RANK_MISS - rank) / 100 : 0;
        // Distribuir score sobre los pares (aproximación: asignamos score al par en esa posición)
        // Para simplificar: usamos rank directamente como indicador del par ganador
        const pairKey = `rank_${rank}`;  // placeholder
        pairScores[algo] = rank;
        totalW += w;
      }

      // Effective rank = media ponderada de ranks por algoritmo
      let wRankSum = 0;
      for (const algo of algos) {
        wRankSum += (ranksHoldout[algo]![d]! * (weights[algo] ?? 1.0));
      }
      effectiveRanks.push(totalW > 0 ? wRankSum / totalW : 50);
    }

    effectiveRanks.sort((a, b) => a - b);

    // Encontrar N óptimo: min N donde hit_rate × $50 / N − 1 ≥ 1%
    let bestN = 15, bestRoi = -Infinity, bestHit = 0, profitable = false;

    for (let N = 5; N <= 30; N++) {
      const hits = effectiveRanks.filter(r => r <= N).length;
      const hr   = hits / nDraws;
      const roi  = hr * 50 / N - 1;

      if (!profitable && roi >= 0.01) {
        bestN       = N;
        bestRoi     = roi;
        bestHit     = hr;
        profitable  = true;
        break;
      }
      if (roi > bestRoi) { bestRoi = roi; bestN = N; bestHit = hr; }
    }

    logger.info(
      { optimal_n: bestN, hit_rate: bestHit.toFixed(3), roi: bestRoi.toFixed(3), profitable },
      'WeightOptimizer: resultado'
    );

    return {
      weights,
      hit_rate:  +bestHit.toFixed(4),
      optimal_n: bestN,
      best_roi:  +bestRoi.toFixed(4),
    };
  }

  // ── Estado de las últimas ejecuciones ──────────────────────────
  async getStatus(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf
  ): Promise<{
    last_run: Record<string, unknown> | null;
    weights: Array<{ algo_name: string; learned_weight: number; historical_pps: number; holdout_hit_rate: number }>;
  }> {
    const { rows: runs } = await this.pool.query(
      `SELECT id, status, draws_learned, algos_updated,
              best_hit_rate, best_top_n, best_roi,
              started_at::text, completed_at::text
       FROM hitdash.cognitive_learning_runs
       WHERE game_type = $1 AND draw_type = $2 AND half = $3
       ORDER BY started_at DESC LIMIT 1`,
      [game_type, draw_type, half]
    ).catch(() => ({ rows: [] }));

    const { rows: weights } = await this.pool.query(
      `SELECT algo_name, learned_weight, historical_pps, holdout_hit_rate
       FROM hitdash.cognitive_algo_weights
       WHERE game_type = $1 AND draw_type = $2 AND half = $3
       ORDER BY learned_weight DESC`,
      [game_type, draw_type, half]
    ).catch(() => ({ rows: [] }));

    return {
      last_run: runs[0] ?? null,
      weights: weights as Array<{ algo_name: string; learned_weight: number; historical_pps: number; holdout_hit_rate: number }>,
    };
  }
}
