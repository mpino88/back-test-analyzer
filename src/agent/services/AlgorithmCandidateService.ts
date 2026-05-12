// ═══════════════════════════════════════════════════════════════
// HELIX — AlgorithmCandidateService v1.0.0
//
// Extrae candidatos filtrados por algoritmo usando los mismos
// thresholds que Ballbot (getCandidates en cada estrategia).
//
// Diferencia vs AnalysisEngine:
//   AnalysisEngine → consensus ponderado de todos → N=69 (mucho ruido)
//   AlgorithmCandidateService → cada algo filtra con sus thresholds propios
//                                → top 15-20 candidatos reales por algo
//
// Flujo:
//   1. Pre-sorteo: HitdashAgent llama storeAll() → guarda candidatos en DB
//   2. Post-sorteo: PostDrawProcessor llama recordHits() → compara vs real
//   3. Dashboard Cognición → muestra historial de aciertos por algoritmo
//
// Threshold mapping de Ballbot:
//   trend_momentum:    countAll ≥ 3, momentum ≥ 1.0 → top 20
//   gap_due:           score > 0 → top 15
//   cycle_detector:    phase ≥ 0.8 → top 15
//   bayesian_score:    sort desc → top 15
//   streak_analysis:   score > 0.5 (anomaly zone) → top 15
//   frequency:         sort desc → top 15
//   todos los demás:   sort desc, score > 0.01 → top 15
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../types/agent.types.js';
import type { PairHalf, AnalysisPeriod } from '../types/analysis.types.js';

import { FrequencyAnalysis }      from '../analysis/algorithms/FrequencyAnalysis.js';
import { GapAnalysis }            from '../analysis/algorithms/GapAnalysis.js';
import { HotColdClassifier }      from '../analysis/algorithms/HotColdClassifier.js';
import { PairCorrelation }        from '../analysis/algorithms/PairCorrelation.js';
import { FibonacciPisano }        from '../analysis/algorithms/FibonacciPisano.js';
import { StreakDetection }        from '../analysis/algorithms/StreakDetection.js';
import { PositionAnalysis }       from '../analysis/algorithms/PositionAnalysis.js';
import { MovingAverages }         from '../analysis/algorithms/MovingAverages.js';
import { BayesianScore }         from '../analysis/algorithms/BayesianScore.js';
import { TransitionFollow }      from '../analysis/algorithms/TransitionFollow.js';
import { MarkovOrder2 }          from '../analysis/algorithms/MarkovOrder2.js';
import { CalendarPattern }       from '../analysis/algorithms/CalendarPattern.js';
import { DecadeFamily }          from '../analysis/algorithms/DecadeFamily.js';
import { MaxPerWeekDay }         from '../analysis/algorithms/MaxPerWeekDay.js';
import { PairReturnCycle }       from '../analysis/algorithms/PairReturnCycle.js';
import { SumPatternFilter }      from '../analysis/algorithms/SumPatternFilter.js';
import { DoubleTripleDetector }  from '../analysis/algorithms/DoubleTripleDetector.js';
import { CrossDrawCorrelation }  from '../analysis/algorithms/CrossDrawCorrelation.js';
import { TrendMomentum }         from '../analysis/algorithms/TrendMomentum.js';
import { CycleDetector }         from '../analysis/algorithms/CycleDetector.js';
import { TerminalAnalysis }      from '../analysis/algorithms/TerminalAnalysis.js';
import { MirrorComplement }      from '../analysis/algorithms/MirrorComplement.js';

const logger = pino({ name: 'AlgorithmCandidateService' });

export interface AlgoCandidates {
  algo_name:       string;
  candidates:      string[];   // pares "00"-"99" ordenados por score desc
  candidate_count: number;
}

export interface AlgoHitResult {
  algo_name:       string;
  hit:             boolean;
  hit_at_position: number | null;
  candidates:      string[];
}

// Candidatos por defecto cuando falla un algo
const TOP_N_DEFAULT = 15;

// ─── Extraer top-N de un mapa score manteniendo threshold ─────
function topFromScores(
  scores:    Record<string, number>,
  topN:      number,
  minScore:  number = 0.01
): string[] {
  return Object.entries(scores)
    .filter(([, s]) => s > minScore)
    .sort(([, a], [, b]) => b - a)
    .slice(0, topN)
    .map(([pair]) => pair);
}

export class AlgorithmCandidateService {
  private readonly algos: Record<string, {
    algo: { runPairs: (gt: GameType, dt: DrawType, half: PairHalf, period?: AnalysisPeriod) => Promise<Record<string, number>> };
    topN:     number;
    minScore: number;
  }>;

  private readonly trendMomentum:  TrendMomentum;
  private readonly cycleDetector:  CycleDetector;
  private readonly terminalAnalysis: TerminalAnalysis;
  private readonly mirrorComplement: MirrorComplement;

  constructor(
    private readonly pool:       Pool,
    private readonly ballbotPool?: Pool
  ) {
    // Inicializar todos los algoritmos
    this.trendMomentum   = new TrendMomentum(pool);
    this.cycleDetector   = new CycleDetector(pool);
    this.terminalAnalysis = new TerminalAnalysis(pool);
    this.mirrorComplement = new MirrorComplement(pool);

    const hitPool = pool;  // Todos usan el mismo agentPool

    this.algos = {
      frequency:          { algo: new FrequencyAnalysis(hitPool),     topN: TOP_N_DEFAULT, minScore: 0.01 },
      gap_analysis:       { algo: new GapAnalysis(hitPool),           topN: TOP_N_DEFAULT, minScore: 0.01 },
      hot_cold:           { algo: new HotColdClassifier(hitPool),     topN: TOP_N_DEFAULT, minScore: 0.01 },
      pairs_correlation:  { algo: new PairCorrelation(hitPool),       topN: TOP_N_DEFAULT, minScore: 0.01 },
      fibonacci_pisano:   { algo: new FibonacciPisano(hitPool),       topN: TOP_N_DEFAULT, minScore: 0.02 },
      streak_detection:   { algo: new StreakDetection(hitPool),       topN: TOP_N_DEFAULT, minScore: 0.50 },
      position_analysis:  { algo: new PositionAnalysis(hitPool),      topN: TOP_N_DEFAULT, minScore: 0.01 },
      moving_averages:    { algo: new MovingAverages(hitPool),        topN: TOP_N_DEFAULT, minScore: 0.01 },
      bayesian_score:     { algo: new BayesianScore(hitPool),         topN: TOP_N_DEFAULT, minScore: 0.01 },
      transition_follow:  { algo: new TransitionFollow(hitPool),      topN: TOP_N_DEFAULT, minScore: 0.01 },
      markov_order2:      { algo: new MarkovOrder2(hitPool),          topN: TOP_N_DEFAULT, minScore: 0.01 },
      calendar_pattern:   { algo: new CalendarPattern(hitPool),       topN: TOP_N_DEFAULT, minScore: 0.01 },
      decade_family:      { algo: new DecadeFamily(hitPool),          topN: TOP_N_DEFAULT, minScore: 0.01 },
      max_per_week_day:   { algo: new MaxPerWeekDay(hitPool),         topN: TOP_N_DEFAULT, minScore: 0.01 },
      pair_return_cycle:  { algo: new PairReturnCycle(hitPool),       topN: TOP_N_DEFAULT, minScore: 0.01 },
      sum_pattern_filter: { algo: new SumPatternFilter(hitPool),      topN: TOP_N_DEFAULT, minScore: 0.01 },
      double_triple:      { algo: new DoubleTripleDetector(hitPool),  topN: TOP_N_DEFAULT, minScore: 0.01 },
      cross_draw:         { algo: new CrossDrawCorrelation(hitPool),  topN: TOP_N_DEFAULT, minScore: 0.01 },
    };
  }

  // ─── Obtener candidatos de TODOS los algoritmos ───────────────
  async runAll(
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf
  ): Promise<AlgoCandidates[]> {
    const results: AlgoCandidates[] = [];

    // 1. Algoritmos estándar (via runPairs)
    const algoEntries = Object.entries(this.algos);
    await Promise.all(algoEntries.map(async ([name, cfg]) => {
      try {
        const scores     = await cfg.algo.runPairs(game_type, draw_type, half);
        const candidates = topFromScores(scores, cfg.topN, cfg.minScore);
        results.push({ algo_name: name, candidates, candidate_count: candidates.length });
      } catch (err) {
        logger.warn({ algo: name, error: String(err) }, 'AlgorithmCandidateService: algo falló — saltando');
      }
    }));

    // 2. TrendMomentum con threshold Ballbot (countAll ≥ 3, momentum ≥ 1.0 → top 20)
    try {
      const { stats } = await this.trendMomentum.computeStats(game_type, draw_type, half);
      const candidates = stats
        .filter(s => s.count_all >= 3 && s.momentum >= 1.0)
        .sort((a, b) => b.momentum - a.momentum)
        .slice(0, 20)
        .map(s => s.pair);
      results.push({ algo_name: 'trend_momentum', candidates, candidate_count: candidates.length });
    } catch (err) {
      logger.warn({ error: String(err) }, 'AlgorithmCandidateService: trend_momentum falló');
    }

    // 3. CycleDetector con threshold Ballbot (phase ≥ 0.8)
    try {
      const stats      = await this.cycleDetector.computeStats(game_type, draw_type, half);
      const candidates = this.cycleDetector.getCandidatesFromStats(stats, TOP_N_DEFAULT);
      results.push({ algo_name: 'cycle_detector', candidates, candidate_count: candidates.length });
    } catch (err) {
      logger.warn({ error: String(err) }, 'AlgorithmCandidateService: cycle_detector falló');
    }

    // 4. TerminalAnalysis (top 4 terminales × top 5 pares)
    try {
      const { terminals } = await this.terminalAnalysis.computeStats(game_type, draw_type, half);
      const candidates    = this.terminalAnalysis.getCandidatesFromStats(terminals, TOP_N_DEFAULT);
      results.push({ algo_name: 'terminal_analysis', candidates, candidate_count: candidates.length });
    } catch (err) {
      logger.warn({ error: String(err) }, 'AlgorithmCandidateService: terminal_analysis falló');
    }

    // 5. MirrorComplement (top N por score simétrico agregado)
    try {
      const relations  = await this.mirrorComplement.computeRelations(game_type, draw_type, half);
      const candidates = this.mirrorComplement.getCandidatesFromRelations(relations, TOP_N_DEFAULT);
      results.push({ algo_name: 'mirror_complement', candidates, candidate_count: candidates.length });
    } catch (err) {
      logger.warn({ error: String(err) }, 'AlgorithmCandidateService: mirror_complement falló');
    }

    logger.info({
      game_type, draw_type, half,
      algos_run: results.length,
    }, 'AlgorithmCandidateService: todos los candidatos extraídos');

    return results;
  }

  // ─── Persistir candidatos PRE-sorteo en DB ────────────────────
  async storeAll(
    game_type:  GameType,
    draw_type:  DrawType,
    half:       PairHalf,
    draw_date:  string,
    session_id: string
  ): Promise<void> {
    const candidates = await this.runAll(game_type, draw_type, half);

    for (const ac of candidates) {
      try {
        await this.pool.query(
          `INSERT INTO hitdash.algorithm_candidate_history
             (algo_name, game_type, draw_type, draw_date, half,
              candidates, candidate_count, session_id)
           VALUES ($1,$2,$3,$4::date,$5,$6,$7,$8)
           ON CONFLICT (algo_name, game_type, draw_type, draw_date, half)
           DO UPDATE SET
             candidates      = EXCLUDED.candidates,
             candidate_count = EXCLUDED.candidate_count,
             session_id      = EXCLUDED.session_id`,
          [
            ac.algo_name, game_type, draw_type, draw_date, half,
            `{${ac.candidates.map(p => `"${p}"`).join(',')}}`,
            ac.candidate_count,
            session_id,
          ]
        );
      } catch (err) {
        logger.warn({ algo: ac.algo_name, error: String(err) }, 'AlgorithmCandidateService: error guardando candidatos');
      }
    }

    logger.info({ game_type, draw_type, draw_date, algos_stored: candidates.length }, 'AlgorithmCandidateService: candidatos persistidos');
  }

  // ─── Registrar hits POST-sorteo ───────────────────────────────
  async recordHits(
    game_type:   GameType,
    draw_type:   DrawType,
    half:        PairHalf,
    draw_date:   string,
    actual_pair: string
  ): Promise<AlgoHitResult[]> {
    // Cargar candidatos guardados para esta predicción
    const { rows } = await this.pool.query<{
      algo_name: string; candidates: string[];
    }>(
      `SELECT algo_name, candidates
       FROM hitdash.algorithm_candidate_history
       WHERE game_type = $1 AND draw_type = $2 AND draw_date = $3::date AND half = $4
         AND hit IS NULL`,
      [game_type, draw_type, draw_date, half]
    ).catch(() => ({ rows: [] as Array<{ algo_name: string; candidates: string[] }> }));

    const results: AlgoHitResult[] = [];

    for (const row of rows) {
      const candidates = Array.isArray(row.candidates) ? row.candidates : [];
      const pos        = candidates.indexOf(actual_pair);
      const hit        = pos !== -1;
      const hitPos     = hit ? pos + 1 : null;

      await this.pool.query(
        `UPDATE hitdash.algorithm_candidate_history
         SET hit = $1, hit_at_position = $2, actual_pair = $3, evaluated_at = now()
         WHERE algo_name = $4 AND game_type = $5 AND draw_type = $6
           AND draw_date = $7::date AND half = $8`,
        [hit, hitPos, actual_pair, row.algo_name, game_type, draw_type, draw_date, half]
      ).catch(() => undefined);

      results.push({ algo_name: row.algo_name, hit, hit_at_position: hitPos, candidates });
    }

    const hits   = results.filter(r => r.hit).length;
    const misses = results.filter(r => !r.hit).length;

    logger.info({
      game_type, draw_type, draw_date, actual_pair, half,
      algos_evaluated: results.length, hits, misses,
    }, 'AlgorithmCandidateService: hits registrados');

    return results;
  }

  // ─── Obtener historial de comparativa (para API/Dashboard) ────
  async getHistory(
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf,
    limitDays: number = 30
  ): Promise<Array<{
    draw_date:   string;
    algo_name:   string;
    candidates:  string[];
    candidate_count: number;
    actual_pair: string | null;
    hit:         boolean | null;
    hit_at_position: number | null;
  }>> {
    const { rows } = await this.pool.query(
      `SELECT draw_date::text, algo_name, candidates, candidate_count,
              actual_pair, hit, hit_at_position
       FROM hitdash.algorithm_candidate_history
       WHERE game_type = $1 AND draw_type = $2 AND half = $3
         AND draw_date >= CURRENT_DATE - ($4 || ' days')::interval
       ORDER BY draw_date DESC, algo_name ASC`,
      [game_type, draw_type, half, limitDays]
    );
    return rows.map(r => ({
      ...r,
      candidates: Array.isArray(r.candidates) ? r.candidates : [],
    }));
  }

  // ─── Hit rate por algoritmo (para ranking) ────────────────────
  async getHitRates(
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf,
    limitDays: number = 30
  ): Promise<Array<{
    algo_name:        string;
    total_evaluated:  number;
    total_hits:       number;
    hit_rate:         number;
    avg_hit_position: number | null;
    avg_candidates:   number;
  }>> {
    const { rows } = await this.pool.query(
      `SELECT
         algo_name,
         COUNT(*) FILTER (WHERE hit IS NOT NULL)::int AS total_evaluated,
         COUNT(*) FILTER (WHERE hit = true)::int       AS total_hits,
         ROUND(AVG(CASE WHEN hit = true THEN 1.0 ELSE 0.0 END)::numeric, 4) AS hit_rate,
         ROUND(AVG(hit_at_position)::numeric, 1)                             AS avg_hit_position,
         ROUND(AVG(candidate_count)::numeric, 1)                             AS avg_candidates
       FROM hitdash.algorithm_candidate_history
       WHERE game_type = $1 AND draw_type = $2 AND half = $3
         AND draw_date >= CURRENT_DATE - ($4 || ' days')::interval
         AND hit IS NOT NULL
       GROUP BY algo_name
       ORDER BY hit_rate DESC, avg_hit_position ASC NULLS LAST`,
      [game_type, draw_type, half, limitDays]
    );
    return rows.map(r => ({
      ...r,
      hit_rate:         Number(r.hit_rate ?? 0),
      avg_hit_position: r.avg_hit_position != null ? Number(r.avg_hit_position) : null,
      avg_candidates:   Number(r.avg_candidates ?? 0),
    }));
  }
}
