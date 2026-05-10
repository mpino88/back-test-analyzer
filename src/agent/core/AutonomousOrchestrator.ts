// ═══════════════════════════════════════════════════════════════
// HELIX — AutonomousOrchestrator v1.0.0
//
// Síntesis autónoma: combina los top-N algoritmos por PPS con las
// micro-estrategias dinámicas activas para generar recomendaciones
// de alta confianza.
//
// Diferencia vs AnalysisEngine:
//   • AnalysisEngine usa los 20 algoritmos (consenso amplio, mucho ruido)
//   • AutonomousOrchestrator usa solo top-5 PPS + estrategias dinámicas
//     validadas estadísticamente → señal más limpia
//
// Flujo:
//   1. PPSService.getRanking() → top-5 algoritmos por hit_rate
//   2. StrategyLifecycleManager.getActiveStrategies() → micro-estrategias
//   3. AnalysisEngine.runSelectedAlgorithms() → puntajes base
//   4. Aplicar score_boost de estrategias dinámicas
//   5. DigitAnalyzer (solo Pick3) → combinar con análisis posicional
//   6. Retornar recomendaciones enriquecidas con trazabilidad
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../types/agent.types.js';
import { PPSService }              from '../services/PPSService.js';
import { StrategyLifecycleManager } from '../services/StrategyLifecycleManager.js';
import { DigitAnalyzer }           from '../analysis/DigitAnalyzer.js';
import { AutoLearningLoop }        from '../learning/AutoLearningLoop.js';

const logger = pino({ name: 'AutonomousOrchestrator' });

// ─── Tipos ────────────────────────────────────────────────────
export interface AutonomousRecommendation {
  pair:                string;
  score:               number;           // score combinado [0,100]
  algorithm_score:     number;           // contribución de algoritmos PPS
  dynamic_boost:       number;           // boost de estrategias dinámicas
  strategies_applied:  string[];         // nombres de estrategias que contribuyeron
  confidence:          'high' | 'medium' | 'low';
}

export interface AutonomousResult {
  game_type:           GameType;
  draw_type:           DrawType;
  generated_at:        Date;
  optimal_n:           number;
  recommendations:     AutonomousRecommendation[];
  digit_analysis?:     {
    top_decenas:       number[];
    top_unidades:      number[];
    combined_pairs:    string[];
    anomaly_signals:   string[];
  };
  active_strategies:   number;
  pps_algorithms_used: number;
  cognitive_basis:     string;
}

export class AutonomousOrchestrator {
  private readonly ppsService:       PPSService;
  private readonly lifecycleManager: StrategyLifecycleManager;
  private readonly digitAnalyzer:    DigitAnalyzer;
  private readonly autoLearning:     AutoLearningLoop;

  constructor(private readonly pool: Pool) {
    this.ppsService       = new PPSService(pool);
    this.lifecycleManager = new StrategyLifecycleManager(pool);
    this.digitAnalyzer    = new DigitAnalyzer(pool);
    this.autoLearning     = new AutoLearningLoop(pool);
  }

  // ─── Generación autónoma de recomendaciones ─────────────────
  async generateRecommendations(
    game_type: GameType,
    draw_type: DrawType
  ): Promise<AutonomousResult> {
    const t0 = Date.now();

    // Determinar half según juego (Pick3 → 'du', Pick4 → 'ab' por defecto)
    const half = game_type === 'pick3' ? 'du' : 'ab';

    // ── PASO 1: PPS — optimal N y top algoritmos ──────────────
    const [ppsN, ppsRanking, dynamicStrategies, anomalyReport] = await Promise.all([
      this.ppsService.computeOptimalN(game_type, draw_type, half),
      this.ppsService.getPPSRanking(game_type, draw_type, half),
      this.lifecycleManager.getActiveStrategies(game_type, draw_type),
      this.autoLearning.getCurrentSignals(game_type, draw_type),
    ]);

    const optimal_n = ppsN.optimal_n || 15;
    const topAlgos  = ppsRanking.slice(0, 5); // top-5 por PPS

    logger.info({
      game_type, draw_type,
      optimal_n,
      top_algos:        topAlgos.map(a => a.algo_name),
      dynamic_strategies: dynamicStrategies.length,
      anomalies:        anomalyReport.signals.length,
    }, 'AutonomousOrchestrator: iniciando síntesis');

    // ── PASO 2: Cargar puntajes de algoritmos top-5 ──────────
    const pairScores = await this.loadTopAlgorithmScores(
      game_type, draw_type, topAlgos.map((a: { algo_name: string }) => a.algo_name)
    );

    // ── PASO 3: Aplicar boosts de estrategias dinámicas ──────
    const boostedScores = this.applyDynamicBoosts(pairScores, dynamicStrategies);

    // ── PASO 4: Ordenar y tomar top-N ────────────────────────
    type ScoreEntry = [string, { total: number; algo: number; boost: number; strategies: string[] }];

    const sorted: ScoreEntry[] = [...boostedScores.entries()]
      .sort((a: ScoreEntry, b: ScoreEntry) => b[1].total - a[1].total)
      .slice(0, optimal_n);

    const maxScore = sorted[0]?.[1]?.total ?? 1;

    const recommendations: AutonomousRecommendation[] = sorted.map(([pair, data]: ScoreEntry) => {
      const score = Math.round((data.total / maxScore) * 100);
      const confidence: AutonomousRecommendation['confidence'] =
        score >= 70 ? 'high' : score >= 40 ? 'medium' : 'low';

      return {
        pair,
        score,
        algorithm_score: Math.round((data.algo / maxScore) * 100),
        dynamic_boost:   Math.round((data.boost / maxScore) * 100),
        strategies_applied: data.strategies,
        confidence,
      };
    });

    // ── PASO 5: DigitAnalyzer (Pick3 only) ───────────────────
    let digit_analysis: AutonomousResult['digit_analysis'] | undefined;
    if (game_type === 'pick3') {
      try {
        const da = await this.digitAnalyzer.analyzeDigits(draw_type, anomalyReport.signals);
        digit_analysis = {
          top_decenas:    da.top_decenas,
          top_unidades:   da.top_unidades,
          combined_pairs: da.combined_pairs,
          anomaly_signals: da.anomaly_signals_applied,
        };
      } catch (err) {
        logger.warn({ error: String(err) }, 'AutonomousOrchestrator: DigitAnalyzer falló — continuando sin él');
      }
    }

    const duration = Date.now() - t0;

    logger.info({
      game_type, draw_type,
      recommendations_count: recommendations.length,
      duration_ms:           duration,
      strategies_applied:    dynamicStrategies.length,
    }, 'AutonomousOrchestrator: síntesis completada');

    return {
      game_type,
      draw_type,
      generated_at:        new Date(),
      optimal_n,
      recommendations,
      digit_analysis,
      active_strategies:   dynamicStrategies.length,
      pps_algorithms_used: topAlgos.length,
      cognitive_basis:     ppsN.sample_size >= 3
        ? `motor_sigma:${ppsN.basis}` : 'fallback:pps_ranking',
    };
  }

  // ─── Cargar scores de los top-N algoritmos ──────────────────
  private async loadTopAlgorithmScores(
    game_type:    GameType,
    draw_type:    DrawType,
    algoNames:    string[]
  ): Promise<Map<string, number>> {
    if (algoNames.length === 0) return new Map();

    try {
      // Pesos normalizados por posición (rank 1 = mayor peso)
      const algoWeights = Object.fromEntries(
        algoNames.map((name, i) => [name, 1 - (i * 0.15)])
      );

      const { rows } = await this.pool.query<{ pair: string; total_score: number }>(
        `SELECT pair,
                SUM(score * weights.w) AS total_score
         FROM hitdash.algorithm_scores AS scores
         JOIN (
           SELECT UNNEST($3::text[]) AS algo_name,
                  UNNEST($4::float[]) AS w
         ) AS weights ON scores.algorithm_name = weights.algo_name
         WHERE scores.game_type = $1
           AND scores.draw_type = $2
           AND scores.scored_at >= now() - interval '3 hours'
         GROUP BY pair
         ORDER BY total_score DESC`,
        [
          game_type, draw_type,
          algoNames,
          algoNames.map((_, i) => 1 - (i * 0.15)),
        ]
      );

      return new Map(rows.map(r => [r.pair, Number(r.total_score)]));
    } catch (err) {
      logger.warn({ error: String(err) }, 'AutonomousOrchestrator: error cargando algorithm_scores — usando pares vacíos');
      return new Map();
    }
  }

  // ─── Aplicar boosts de estrategias dinámicas ─────────────────
  private applyDynamicBoosts(
    baseScores:    Map<string, number>,
    strategies:    Awaited<ReturnType<StrategyLifecycleManager['getActiveStrategies']>>
  ): Map<string, { total: number; algo: number; boost: number; strategies: string[] }> {
    const result = new Map<string, { total: number; algo: number; boost: number; strategies: string[] }>();

    // Inicializar con scores base
    for (const [pair, score] of baseScores) {
      result.set(pair, { total: score, algo: score, boost: 0, strategies: [] });
    }

    // Aplicar boost por estrategias dinámicas
    for (const strat of strategies) {
      if (!strat.target_pairs?.length) continue;

      const boostAmount = strat.score_boost * 100; // normalizar al mismo espacio

      for (const targetPair of strat.target_pairs) {
        const existing = result.get(targetPair);
        if (existing) {
          existing.boost   += boostAmount;
          existing.total   += boostAmount;
          existing.strategies.push(strat.name);
        } else {
          // Par nuevo introducido por estrategia dinámica
          result.set(targetPair, {
            total:      boostAmount,
            algo:       0,
            boost:      boostAmount,
            strategies: [strat.name],
          });
        }
      }
    }

    return result;
  }

  // ─── Verificar hit de recomendaciones vs resultado real ──────
  async evaluateAgainstResult(
    game_type:     GameType,
    draw_type:     DrawType,
    actual_digits: LotteryDigits,
    recommendations: AutonomousRecommendation[]
  ): Promise<{ hit: boolean; winning_pair: string; hit_rank: number | null }> {
    const actualPair = `${actual_digits.p2}${actual_digits.p3}`;
    const ranked_pairs = recommendations.map(r => r.pair);
    const hitRank = ranked_pairs.indexOf(actualPair);

    logger.info({
      game_type, draw_type,
      actual_pair:    actualPair,
      hit:            hitRank !== -1,
      hit_rank:       hitRank !== -1 ? hitRank + 1 : null,
      top_5_pairs:    ranked_pairs.slice(0, 5),
    }, `AutonomousOrchestrator: evaluación vs resultado real`);

    return {
      hit:         hitRank !== -1,
      winning_pair: actualPair,
      hit_rank:    hitRank !== -1 ? hitRank + 1 : null,
    };
  }
}
