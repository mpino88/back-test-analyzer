// ═══════════════════════════════════════════════════════════════
// HITDASH — HitdashAgent v1.0.0
// Ciclo completo: trigger → analyze → LLM → generate → persist → notify
// Guarda reasoning_chain en agent_sessions para trazabilidad
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';

import { AnalysisEngine }    from '../analysis/AnalysisEngine.js';
import { CartonGenerator }   from '../services/CartonGenerator.js';
import { PairRecommender }   from '../services/PairRecommender.js';
import { LLMRouter }         from '../services/LLMRouter.js';
import { TelegramNotifier }  from '../services/TelegramNotifier.js';
import { RAGService }        from '../services/RAGService.js';
import { PairBacktestEngine } from '../backtest/PairBacktestEngine.js';
import { runBacktestJob, STRATEGY_CATALOG } from '../backtest/backtestJobRunner.js';

import type {
  GameType, DrawType, TriggerType, Carton, CartonSize, AgentAlert,
} from '../types/agent.types.js';
import type { ComprehensiveAnalysis, Position } from '../types/analysis.types.js';

const logger = pino({ name: 'HitdashAgent' });

// ─── Feature flag: flip to false to instantly revert to carton mode ──
const USE_PAIR_MODE = true;

// ─── Fallback static sizes (only used if optimal_n unavailable) ──────
const CARTON_SIZES_PICK3: CartonSize[] = [9, 16];
const CARTON_SIZES_PICK4: CartonSize[] = [10, 16];

// ─── Cognitive N → CartonSize mapping ────────────────────────────────
// Converts the pair-mode optimal_n (number of pairs recommended) into
// the carton ticket size. Pairs represent 2-digit combos, so carton slots
// = ceil(optimal_n * 0.75) clamped to valid CartonSize values.
function cognitiveNToCartonSize(optimal_n: number): CartonSize {
  const raw = Math.ceil(optimal_n * 0.75);
  // Snap to nearest valid CartonSize: [9, 10, 16, 20, 25]
  const valid: CartonSize[] = [9, 10, 16, 20, 25];
  return valid.reduce((prev, curr) =>
    Math.abs(curr - raw) < Math.abs(prev - raw) ? curr : prev
  );
}

interface AgentRunParams {
  trigger_type: TriggerType;
  game_type: GameType;
  draw_type: DrawType;
  draw_date: string; // YYYY-MM-DD
}

// Structure returned by LLM validation step
interface LLMValidation {
  validated_digits: Record<Position, number[]>;
  reasoning: string;
  confidence: number;
}

// ─── Proactive backtest thresholds ────────────────────────────────
const PROACTIVE_BACKTEST_MIN_DRAWS_SINCE_LAST = 30; // triggers if ≥30 new draws without backtest
const PROACTIVE_BACKTEST_MAX_DAYS_WITHOUT     = 7;  // triggers if >7 days without backtest

export class HitdashAgent {
  private readonly analysisEngine:    AnalysisEngine;
  private readonly cartonGenerator:   CartonGenerator;
  private readonly pairRecommender:   PairRecommender;
  private readonly llmRouter:         LLMRouter;
  private readonly notifier:          TelegramNotifier;
  private readonly ragService:        RAGService;
  private readonly pairBacktestEngine: PairBacktestEngine;

  constructor(
    private readonly ballbotPool: Pool,
    private readonly agentPool: Pool,
    ragService: RAGService,
    notifier?: TelegramNotifier          // Injectable — avoids duplicate singleton
  ) {
    this.analysisEngine      = new AnalysisEngine(ballbotPool, agentPool);
    this.cartonGenerator     = new CartonGenerator();
    this.pairRecommender     = new PairRecommender();
    this.llmRouter           = new LLMRouter();
    this.notifier            = notifier ?? new TelegramNotifier();
    this.ragService          = ragService;
    this.pairBacktestEngine  = new PairBacktestEngine(ballbotPool, agentPool);
  }

  // ─── Proactive backtest check ─────────────────────────────────────
  // Called by AgentScheduler after each draw cycle.
  // Triggers a full PairBacktest autonomously when:
  //   a) >7 days have passed without a backtest, OR
  //   b) ≥30 new draws exist since the last backtest run
  async checkAndTriggerProactiveBacktest(
    game_type: GameType,
    draw_type: DrawType
  ): Promise<{ triggered: boolean; reason?: string; job_id?: string }> {
    try {
      const mode = draw_type === 'midday' ? 'midday' : 'evening';

      // Get last backtest timestamp from backtest_results_v2
      const { rows: lastRun } = await this.agentPool.query<{ created_at: string; total_eval_pts: number }>(
        `SELECT created_at::text, total_eval_pts
         FROM hitdash.backtest_results_v2
         WHERE game_type = $1 AND mode = $2
         ORDER BY created_at DESC LIMIT 1`,
        [game_type, mode]
      );

      // Count draws since last backtest (or all draws if no backtest yet)
      const sinceDate = lastRun[0]?.created_at?.slice(0, 10) ?? '2000-01-01';
      const { rows: newDraws } = await this.ballbotPool.query<{ count: string }>(
        `SELECT COUNT(*)::text AS count FROM public.draws
         WHERE game = $1
           AND ($2::text IS NULL OR period = $3)
           AND created_at::date > $4::date`,
        [game_type === 'pick3' ? 'p3' : 'p4', mode, mode === 'midday' ? 'm' : 'e', sinceDate]
      );

      const drawsSinceLastRun = parseInt(newDraws[0]?.count ?? '0', 10);

      // Check days since last run
      const daysSinceLastRun = lastRun[0]
        ? Math.floor((Date.now() - new Date(lastRun[0].created_at).getTime()) / 86_400_000)
        : 999;

      const shouldTrigger =
        daysSinceLastRun > PROACTIVE_BACKTEST_MAX_DAYS_WITHOUT ||
        drawsSinceLastRun >= PROACTIVE_BACKTEST_MIN_DRAWS_SINCE_LAST;

      if (!shouldTrigger) {
        logger.info(
          { game_type, draw_type, daysSinceLastRun, drawsSinceLastRun },
          'HitdashAgent: proactive backtest no necesario aún'
        );
        return { triggered: false };
      }

      const reason = daysSinceLastRun > PROACTIVE_BACKTEST_MAX_DAYS_WITHOUT
        ? `${daysSinceLastRun} días sin backtest`
        : `${drawsSinceLastRun} sorteos nuevos desde último backtest`;

      logger.info({ game_type, draw_type, reason }, 'HitdashAgent: disparando backtest proactivo');

      // Run all default strategies
      const defaultStrategies = STRATEGY_CATALOG
        .filter(s => s.default_selected)
        .map(s => s.id);

      const jobId = await runBacktestJob(this.pairBacktestEngine, {
        game_type,
        mode,
        strategies:   defaultStrategies,
        top_n:        15,
        triggered_by: 'agent_proactive',
      });

      // Log proactive alert to DB for visibility in dashboard
      await this.agentPool.query(
        `INSERT INTO hitdash.proactive_alerts
           (alert_type, priority, game_type, message, data)
         VALUES ('backtest_triggered', 'medium', $1, $2, $3)`,
        [
          game_type,
          `Backtest proactivo iniciado: ${reason}`,
          JSON.stringify({ job_id: jobId, draw_type, reason, draw_count: drawsSinceLastRun }),
        ]
      ).catch(() => undefined);

      return { triggered: true, reason, job_id: jobId };
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) },
        'HitdashAgent: error en checkAndTriggerProactiveBacktest');
      return { triggered: false };
    }
  }

  async run(params: AgentRunParams): Promise<string> {
    const { trigger_type, game_type, draw_type, draw_date } = params;
    const globalStart = Date.now();
    const reasoning_chain: unknown[] = [];

    logger.info(params, 'HitdashAgent: iniciando ciclo');

    // ─── 1. Crear sesión en DB ───────────────────────────────────
    const sessionId = await this.createSession(trigger_type, game_type, draw_type);

    try {
      // ─── PAIR MODE PATH (USE_PAIR_MODE = true) ───────────────────
      if (USE_PAIR_MODE) {
        return await this.runPairMode(params, sessionId, globalStart, reasoning_chain);
      }

      // ─── 2. AnalysisEngine (8 algoritmos en paralelo) ────────────
      reasoning_chain.push({ step: 'analysis_start', ts: new Date().toISOString() });

      const analysis = await this.analysisEngine.analyze(game_type, draw_type, 90);
      reasoning_chain.push({
        step: 'analysis_complete',
        algorithms_ok:   analysis.algorithms_succeeded.length,
        algorithms_fail: analysis.algorithms_failed.length,
        recommended:     analysis.recommended_digits_per_position,
        ts: new Date().toISOString(),
      });

      logger.info(
        { ok: analysis.algorithms_succeeded, fail: analysis.algorithms_failed },
        'HitdashAgent: análisis completado'
      );

      // ─── 3. Validación LLM ───────────────────────────────────────
      const llmResponse = await this.validateWithLLMRaw(analysis, game_type, draw_type, draw_date);
      const llmValidation = llmResponse.validation;
      const sessionCostUsd = llmResponse.cost_usd;
      reasoning_chain.push({
        step: 'llm_validation',
        model: this.llmRouter.getCircuitState(),
        validated_digits: llmValidation.validated_digits,
        confidence: llmValidation.confidence,
        cost_usd: sessionCostUsd,
        ts: new Date().toISOString(),
      });

      // ─── 4. Generar cartones ─────────────────────────────────────
      const sizes = game_type === 'pick3' ? CARTON_SIZES_PICK3 : CARTON_SIZES_PICK4;
      const cartones: Carton[] = this.cartonGenerator.generateMultiple(
        analysis,
        sizes,
        draw_type,
        llmValidation.validated_digits
      );

      reasoning_chain.push({
        step: 'cartones_generated',
        count: cartones.length,
        sizes: cartones.map(c => c.size),
        ts: new Date().toISOString(),
      });

      // ─── 5. Persistir cartones en carton_generations ─────────────
      const strategyId = await this.resolveStrategyId('consensus_top');
      const cartonIds = await this.persistCartones(cartones, game_type, draw_type, draw_date, sessionId, strategyId);

      reasoning_chain.push({
        step: 'cartones_persisted',
        carton_ids: cartonIds,
        ts: new Date().toISOString(),
      });

      // ─── 6. Detectar y persistir alertas proactivas ──────────────
      const alerts = this.detectAlerts(analysis);
      if (alerts.length > 0) {
        await this.persistAlerts(alerts, game_type);
        reasoning_chain.push({ step: 'alerts_generated', count: alerts.length, ts: new Date().toISOString() });
      }

      // ─── 7. Notificar por Telegram ───────────────────────────────
      await this.notifier.notifyCartones(cartones, game_type, draw_type, draw_date, llmValidation.reasoning);

      for (const alert of alerts.filter(a => a.severity === 'high')) {
        await this.notifier.notifyAlert(alert);
      }

      // ─── 8. Cerrar sesión como completed ─────────────────────────
      const duration_ms = Date.now() - globalStart;
      const modelUsed = this.llmRouter.getCircuitState().state === 'CLOSED'
        ? 'gemini-2.5-flash' : 'claude-sonnet-4-6';

      await this.closeSession(sessionId, 'completed', {
        reasoning_chain,
        output_data: {
          cartones: cartones.length,
          carton_ids: cartonIds,
          recommended_digits: analysis.recommended_digits_per_position,
          llm_confidence: llmValidation.confidence,
        },
        duration_ms,
        cost_usd: sessionCostUsd,   // ═══ BN-09 FIX: costo real del LLM
        model_used: modelUsed,
      });

      await this.notifier.notifySessionSummary({
        session_id: sessionId,
        game_type,
        draw_type,
        algorithms_ok:   analysis.algorithms_succeeded.length,
        algorithms_fail: analysis.algorithms_failed.length,
        duration_ms,
        cost_usd: sessionCostUsd,   // ═══ BN-09 FIX: costo real
        model_used: modelUsed,
      });

      logger.info({ session_id: sessionId, duration_ms }, 'HitdashAgent: ciclo completado');
      return sessionId;

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ session_id: sessionId, error: msg }, 'HitdashAgent: ciclo fallido');
      await this.closeSession(sessionId, 'failed', {
        reasoning_chain,
        error_message: msg,
        duration_ms: Date.now() - globalStart,
      });
      throw err;
    }
  }

  // ─── Pair mode execution path ────────────────────────────────────
  async runPairMode(
    params: AgentRunParams,
    sessionId: string,
    globalStart: number,
    reasoning_chain: any[]
  ): Promise<string> {
    const { game_type, draw_type, draw_date } = params;

    reasoning_chain.push({ step: 'pair_mode_start', ts: new Date().toISOString() });

    // ═══ BN-02 OPTIMIZATION: Generar embedding una sola vez por ciclo ═══
    const query = `${game_type.toUpperCase()} ${draw_type} análisis predictivo ${draw_date}`;
    const queryVector = await this.ragService.embedText(query);

    let allRecs: import('../types/agent.types.js').PairRecommendation[] = [];

    if (game_type === 'pick3') {
      const pairAnalysis = await this.analysisEngine.analyzePairs(game_type, draw_type, 'du', 90);
      reasoning_chain.push({
        step: 'pair_analysis_complete',
        half: 'du',
        top_n: pairAnalysis.top_n,
        optimal_n: pairAnalysis.optimal_n,
        top3_pairs: pairAnalysis.ranked_pairs.slice(0, 3).map(r => r.pair),
        ts: new Date().toISOString(),
      });

      // ═══ BN-02: Consultar RAG con vector pre-calculado ═══
      const ragContext = await this.queryRAGContextWithVector(queryVector);

      // LLM pair validation
      const llmResult = await this.validateWithLLMPairs(
        pairAnalysis.ranked_pairs.slice(0, 20), game_type, draw_type, draw_date,
        pairAnalysis.centena_plus, ragContext
      );

      // ═══ COG-10 LLM OVERRIDE: Integrar votos del LLM ═══
      const rec = this.pairRecommender.recommend(pairAnalysis, undefined, llmResult.validated_pairs);
      allRecs = [rec];

      await this.notifier.notifyPairs([rec], game_type, draw_type, draw_date, llmResult.reasoning);
      await this.persistPairRecommendations([rec], game_type, draw_type, draw_date, sessionId);

      // ═══ RESTAURACIÓN COG-N: Generar cartones desde optimal_n ════════
      // El tamaño del cartón NO es estático [9,16] — lo dicta el Cognitive N
      // del PairRecommender, preservando la intención matemática original.
      await this.generateAndPersistCartonesFromPairs(
        [rec], game_type, draw_type, draw_date, sessionId
      );

    } else {
      // pick4: analyze AB and CD independently
      const [abAnalysis, cdAnalysis] = await Promise.all([
        this.analysisEngine.analyzePairs(game_type, draw_type, 'ab', 90),
        this.analysisEngine.analyzePairs(game_type, draw_type, 'cd', 90),
      ]);

      // ═══ BN-02: Consultar RAG con vector pre-calculado (Pick 4) ═══
      const ragContext = await this.queryRAGContextWithVector(queryVector);

      const llmResult = await this.validateWithLLMPairs(
        [...abAnalysis.ranked_pairs.slice(0, 10), ...cdAnalysis.ranked_pairs.slice(0, 10)],
        game_type, draw_type, draw_date, undefined, ragContext
      );

      // ═══ COG-10: Aplicar validación LLM a ambos mitades ═══
      const recs = this.pairRecommender.recommendPick4(
        abAnalysis, cdAnalysis, undefined,
        llmResult.validated_pairs, llmResult.validated_pairs
      );
      allRecs = recs;

      await this.notifier.notifyPairs(recs, game_type, draw_type, draw_date, llmResult.reasoning);
      await this.persistPairRecommendations(recs, game_type, draw_type, draw_date, sessionId);

      // ═══ RESTAURACIÓN COG-N: Generar cartones Pick 4 ════════════════
      await this.generateAndPersistCartonesFromPairs(
        recs, game_type, draw_type, draw_date, sessionId
      );
    }

    // ═══ RESTAURACIÓN ALERTA PRESCRIPTIVA ════════════════════════════
    // Analiza el momentum actual para recomendar una estrategia sostenida.
    // Era parte del diseño original — perdida en las refactorizaciones anteriores.
    await this.fireProactivePrescriptiveAlert(allRecs, game_type, draw_type);

    const duration_ms = Date.now() - globalStart;
    await this.closeSession(sessionId, 'completed', {
      reasoning_chain,
      output_data: {
        mode: 'pair_v2',
        game_type,
        draw_type,
        recs_count: allRecs.length,
        optimal_n: allRecs[0]?.optimal_n ?? null,
      },
      duration_ms,
      model_used: 'apex_consensus_v2',
    });

    logger.info({ session_id: sessionId, duration_ms, mode: 'pair_v2' }, 'HitdashAgent: ciclo pair-mode completado');
    return sessionId;
  }

  // ─── Genera y persiste cartones dimensionados por Cognitive N ────────
  // RESTAURACIÓN: Esta función existía conceptualmente en el diseño original.
  // El tamaño del cartón es orgánico: lo determina el optimal_n del PairRecommender,
  // NO los arrays estáticos [9,16] que mutilaron el flujo previo.
  private async generateAndPersistCartonesFromPairs(
    recs: import('../types/agent.types.js').PairRecommendation[],
    game_type: GameType,
    draw_type: DrawType,
    draw_date: string,
    sessionId: string
  ): Promise<void> {
    try {
      const strategyId = await this.resolveStrategyId('apex_consensus_v2');
      const cartonNumbers: Array<{ value: string }> = [];

      for (const rec of recs) {
        // Tomar los top pares del rec y construir combinaciones jugables
        for (const pair of rec.pairs) {
          cartonNumbers.push({ value: pair });
        }
      }

      if (cartonNumbers.length === 0) return;

      // ═══ COG-N: Tamaño del cartón dictado por optimal_n ═══
      // Usar el optimal_n de la primera rec como base (es el matemáticamente
      // determinado por el PairBacktestEngine con Cognitive N)
      const primaryRec = recs[0]!;
      const cognitiveSize = cognitiveNToCartonSize(primaryRec.optimal_n);

      // Seleccionar los mejores `cognitiveSize` pares por score
      const topPairs = recs
        .flatMap(r => r.pairs)
        .slice(0, cognitiveSize)
        .map(p => ({ value: p }));

      const confidence = primaryRec.confidence;

      await this.agentPool.query(
        `INSERT INTO hitdash.carton_generations
           (game_type, draw_type, carton_size, numbers, strategy_id,
            confidence_score, draw_date, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          game_type,
          draw_type,
          cognitiveSize,
          JSON.stringify(topPairs),
          strategyId,
          confidence,
          draw_date,
          sessionId,
        ]
      );

      logger.info(
        { game_type, draw_type, cognitiveSize, pairs: topPairs.length },
        'HitdashAgent: cartón cognitivo generado desde optimal_n'
      );
    } catch (err) {
      // Non-fatal — the pair recommendations were already persisted
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'HitdashAgent: error generando cartón cognitivo — continuando'
      );
    }
  }

  // ─── Alerta prescriptiva proactiva ───────────────────────────────────
  // RESTAURACIÓN: La función original del agente debía analizar el momentum
  // y recomendar activamente "juega X estrategia por Y sorteos".
  // Esto se perdió en refactorizaciones sucesivas. Se restaura aquí.
  private async fireProactivePrescriptiveAlert(
    recs: import('../types/agent.types.js').PairRecommendation[],
    game_type: GameType,
    draw_type: DrawType
  ): Promise<void> {
    try {
      if (recs.length === 0) return;

      const primaryRec = recs[0]!;
      const effectiveness = primaryRec.predicted_effectiveness;
      const optimal_n = primaryRec.optimal_n;
      const confidence = primaryRec.confidence;

      // Solo disparar si hay suficiente señal (efectividad > 10% o confianza alta)
      const hasSignal = effectiveness > 0.10 || confidence > 0.65;
      if (!hasSignal) return;

      // Estimar cuántos sorteos quedan de ventana (heurística: 3-5 basado en momentum)
      const forwardDraws = effectiveness > 0.25 ? 5 : effectiveness > 0.15 ? 4 : 3;
      const drawLabel   = draw_type === 'midday' ? 'Midday' : 'Evening';
      const gameLabel   = game_type === 'pick3' ? 'Pick 3' : 'Pick 4';

      const message = [
        `🚀 *HITDASH — Oportunidad Estratégica Detectada*`,
        `🎮 ${gameLabel} ${drawLabel}`,
        `🧠 El agente recomienda mantener *apex_consensus_v2* los próximos *${forwardDraws} sorteos*`,
        `📊 N óptimo actual: *${optimal_n} pares* | Efectividad estimada: *${(effectiveness * 100).toFixed(1)}%*`,
        `💡 Pares top: \`${primaryRec.pairs.slice(0, 5).join('  ')}\`${primaryRec.pairs.length > 5 ? ` +${primaryRec.pairs.length - 5} más` : ''}`,
        `⚠️ _Solo estadística. Sin garantía de resultados._`,
      ].join('\n');

      // ═══ FIX IDEMPOTENCIA ═══
      // Prevenir alertas duplicadas exactas dentro de las últimas 12 horas
      // (ocurre si corre un backtest manual + cron de agente en paralelo)
      const res = await this.agentPool.query(
        `INSERT INTO hitdash.proactive_alerts
           (alert_type, priority, game_type, message, data)
         SELECT 'strategy_opportunity', 'medium', $1, $2, $3
         WHERE NOT EXISTS (
           SELECT 1 FROM hitdash.proactive_alerts
           WHERE alert_type = 'strategy_opportunity'
             AND game_type = $1
             AND message = $2
             AND created_at > now() - interval '12 hours'
         ) RETURNING id`,
        [
          game_type,
          `Mantener apex_consensus_v2 los próximos ${forwardDraws} sorteos ${drawLabel} (N=${optimal_n}, efect.=${(effectiveness * 100).toFixed(1)}%)`,
          JSON.stringify({
            strategy: 'apex_consensus_v2',
            forward_draws: forwardDraws,
            optimal_n,
            predicted_effectiveness: effectiveness,
            confidence,
            draw_type,
          }),
        ]
      );

      // Si no se insertó (fue filtrada por el debounce), abortamos envío a Telegram
      if ((res.rowCount ?? 0) === 0) {
        logger.debug('Alerta prescriptiva suprimida (duplicado en < 12h)');
        return;
      }

      // Enviar por Telegram solo si fue nueva
      if (this.notifier) {
        await this.notifier.sendAdminLog(message);
      }

      logger.info(
        { game_type, draw_type, forwardDraws, optimal_n, effectiveness },
        'HitdashAgent: alerta prescriptiva disparada'
      );
    } catch (err) {
      // Non-fatal — never block the main flow
      logger.warn(
        { error: err instanceof Error ? err.message : String(err) },
        'HitdashAgent: error en alerta prescriptiva — continuando'
      );
    }
  }

  // ═══ BN-02: Consultar memoria RAG con vector reutilizado ═══════════
  private async queryRAGContextWithVector(
    vector: number[]
  ): Promise<{ patterns: string[]; learnings: string[] }> {
    try {
      const [patternResults, learningResults] = await Promise.all([
        this.ragService.searchWithVector(vector, 5, 'pattern', 0.50),
        this.ragService.searchWithVector(vector, 5, 'learning', 0.50),
      ]);

      return {
        patterns: patternResults.map(r => r.content),
        learnings: learningResults.map(r => r.content)
      };
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'RAG vector query falló');
      return { patterns: [], learnings: [] };
    }
  }

  // ─── LLM validation (pair mode) ──────────────────────────────────
  // ─── LLM validation (pair mode) ──────────────────────────────────
  private async validateWithLLMPairs(
    topRanked: Array<{ pair: string; score: number }>,
    game_type: GameType,
    draw_type: DrawType,
    draw_date: string,
    centena_plus?: number,
    ragContext?: { patterns: string[]; learnings: string[] }
  ): Promise<{ validated_pairs: string[]; reasoning: string; centena_plus?: number }> {
    const pairList = topRanked.map((r, i) => `${i + 1}. ${r.pair} (score=${r.score.toFixed(4)})`).join('\n');
    const centenaNote = centena_plus !== undefined ? `\nCentena Plus sugerida: ${centena_plus}` : '';

    // ═══ BN-02: Construir bloque de memoria RAG ═══
    let memoryBlock = '';
    if (ragContext && (ragContext.patterns.length > 0 || ragContext.learnings.length > 0)) {
      const parts: string[] = [];
      if (ragContext.patterns.length > 0) {
        parts.push('Resultados recientes similares:\n' + ragContext.patterns.slice(0, 3).join('\n'));
      }
      if (ragContext.learnings.length > 0) {
        parts.push('Aprendizajes previos del agente:\n' + ragContext.learnings.slice(0, 3).join('\n'));
      }
      memoryBlock = `\n\nCONTEXTO HISTÓRICO (memoria RAG del agente):\n${parts.join('\n\n')}`;
    }

    const systemPrompt = `Eres un analista estadístico de lotería. Validas listas de pares ordenados (XY) para Florida Lottery ${game_type === 'pick3' ? 'Pick 3 (decena+unidad)' : 'Pick 4 (AB y CD)'}.
Consideras el contexto histórico para detectar patrones recurrentes o evitar errores pasados.
Responde SOLO con JSON válido. No uses markdown fuera del JSON.`;

    const userPrompt = `Sorteo: ${game_type.toUpperCase()} ${draw_type} del ${draw_date}${centenaNote}

Top pares por consensus score (100 pares analizados, ordenados por probabilidad):
${pairList}${memoryBlock}

Tarea: Revisa la lista, considera el contexto histórico, y provee razonamiento estadístico en ≤200 chars.

Responde:
{
  "validated_pairs": ["XY", ...],
  "centena_plus": ${centena_plus ?? 'null'},
  "reasoning": "texto ≤200 chars",
  "confidence": 0.0
}`;

    const defaultVal = {
      validated_pairs: [],
      reasoning: 'Análisis estadístico multi-algoritmo consensus v2.',
      centena_plus,
    };

    try {
      const response = await this.llmRouter.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ], { temperature: 0.3, maxTokens: 1024 });

      const jsonMatch = response.content.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]) as {
          validated_pairs?: string[];
          reasoning?: string;
          centena_plus?: number;
        };
        return {
          validated_pairs: parsed.validated_pairs ?? [],
          reasoning: (parsed.reasoning ?? '').slice(0, 300) || defaultVal.reasoning,
          centena_plus: parsed.centena_plus ?? centena_plus,
        };
      }
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'LLM pair validation fallida — usando valores default');
    }
    return defaultVal;
  }

  // ─── LLM validation: construir prompt conciso y parsear respuesta ─
  private async validateWithLLMRaw(
    analysis: ComprehensiveAnalysis,
    game_type: GameType,
    draw_type: DrawType,
    draw_date: string
  ): Promise<{ validation: LLMValidation; cost_usd: number }> {
    const positions = game_type === 'pick3'
      ? (['p1', 'p2', 'p3'] as Position[])
      : (['p1', 'p2', 'p3', 'p4'] as Position[]);

    // ─── Resumen compacto del análisis (≤2000 tokens) ────────────
    const analysisSummary = positions.map(pos => {
      const top5 = analysis.by_position[pos]?.consensus_scores
        .slice(0, 5)
        .map(c => `${c.digit}(${c.consensus_score.toFixed(2)})`)
        .join(', ') ?? '';
      return `  ${pos.toUpperCase()}: [${top5}]`;
    }).join('\n');

    const failedNote = analysis.algorithms_failed.length > 0
      ? `\nAlgoritmos fallidos: ${analysis.algorithms_failed.map(f => f.name).join(', ')}`
      : '';

    const systemPrompt = `Eres un analista estadístico de lotería. Tu rol es validar recomendaciones de dígitos
generadas por algoritmos estadísticos para Florida Lottery ${game_type === 'pick3' ? 'Pick 3' : 'Pick 4'}.
Responde SOLO con JSON válido. No uses markdown ni explicaciones fuera del JSON.`;

    const userPrompt = `Sorteo: ${game_type.toUpperCase()} ${draw_type} del ${draw_date}
Algoritmos ejecutados: ${analysis.algorithms_succeeded.join(', ')}${failedNote}

Top 5 dígitos por posición (consensus_score ponderado):
${analysisSummary}

Tarea: Valida o ajusta los top 3 dígitos recomendados por posición considerando:
1. Diversidad (evitar concentrar todos en dígitos similares)
2. Señales contradictorias entre algoritmos
3. Coherencia estadística general

Responde con este JSON exacto:
{
  "validated_digits": {
    "p1": [d1, d2, d3],
    "p2": [d1, d2, d3],
    "p3": [d1, d2, d3]${game_type === 'pick4' ? ',\n    "p4": [d1, d2, d3]' : ''}
  },
  "reasoning": "explicación concisa en ≤200 chars",
  "confidence": 0.0
}`;

    try {
      const response = await this.llmRouter.complete([
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: userPrompt },
      ], { temperature: 0.3, maxTokens: 2048 });

      return {
        validation: this.parseLLMValidation(response.content, analysis, positions),
        cost_usd: response.cost_usd,
      };
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'LLM validation fallida — usando recomendaciones del motor');
      return {
        validation: {
          validated_digits: analysis.recommended_digits_per_position as Record<Position, number[]>,
          reasoning: 'Fallback: recomendaciones directas del motor estadístico',
          confidence: 0.6,
        },
        cost_usd: 0,
      };
    }
  }

  private parseLLMValidation(
    raw: string,
    analysis: ComprehensiveAnalysis,
    positions: Position[]
  ): LLMValidation {
    try {
      // Extract JSON from response (handles cases where LLM adds surrounding text)
      const jsonMatch = raw.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('No JSON encontrado en respuesta LLM');

      const parsed = JSON.parse(jsonMatch[0]) as {
        validated_digits?: Record<string, number[]>;
        reasoning?: string;
        confidence?: number;
      };

      const validated_digits: Record<Position, number[]> = {} as Record<Position, number[]>;
      for (const pos of positions) {
        const digits = parsed.validated_digits?.[pos];
        // Validate: must be array of valid digits (0-9)
        if (Array.isArray(digits) && digits.every(d => Number.isInteger(d) && d >= 0 && d <= 9)) {
          validated_digits[pos] = digits.slice(0, 5);
        } else {
          // Fallback for this position
          validated_digits[pos] = analysis.recommended_digits_per_position[pos] ?? [0, 1, 2];
        }
      }

      return {
        validated_digits,
        reasoning: (parsed.reasoning ?? '').slice(0, 300),
        confidence: typeof parsed.confidence === 'number'
          ? Math.max(0, Math.min(1, parsed.confidence))
          : 0.65,
      };
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err), raw: raw.slice(0, 200) }, 'Error parseando respuesta LLM — usando fallback');
      return {
        validated_digits: analysis.recommended_digits_per_position as Record<Position, number[]>,
        reasoning: 'Parse error — fallback a motor estadístico',
        confidence: 0.6,
      };
    }
  }

  // ─── Detección de alertas desde el análisis ──────────────────
  private detectAlerts(analysis: ComprehensiveAnalysis): AgentAlert[] {
    const alerts: AgentAlert[] = [];

    // Alerta si hay pocos datos (< 30 draws)
    if (analysis.algorithms_failed.length >= 4) {
      alerts.push({
        type: 'low_data',
        message: `${analysis.algorithms_failed.length} algoritmos fallaron. Verificar disponibilidad de datos.`,
        severity: 'high',
        game_type: analysis.game_type,
      });
    }

    // Alerta de drift si hay muchos algoritmos sin consensus claro
    const positions = analysis.game_type === 'pick3'
      ? (['p1', 'p2', 'p3'] as Position[])
      : (['p1', 'p2', 'p3', 'p4'] as Position[]);

    let lowConsensusPositions = 0;
    for (const pos of positions) {
      const topScore = analysis.by_position[pos]?.top_digits.length ?? 0;
      const topConsensus = analysis.by_position[pos]?.consensus_scores[0]?.consensus_score ?? 0;
      if (topConsensus < 0.35) lowConsensusPositions++;
    }
    if (lowConsensusPositions >= 2) {
      alerts.push({
        type: 'drift',
        message: `Señales de consensus débiles en ${lowConsensusPositions} posiciones. Posible cambio en patrones.`,
        severity: 'medium',
        game_type: analysis.game_type,
      });
    }

    return alerts;
  }

  // ─── DB helpers ──────────────────────────────────────────────
  private async createSession(
    trigger_type: TriggerType,
    game_type: GameType,
    draw_type: DrawType
  ): Promise<string> {
    const result = await this.agentPool.query<{ id: string }>(
      `INSERT INTO hitdash.agent_sessions (trigger_type, game_type, draw_type, status)
       VALUES ($1, $2, $3, 'running')
       RETURNING id`,
      [trigger_type, game_type, draw_type]
    );
    return result.rows[0]!.id;
  }

  private async closeSession(
    sessionId: string,
    status: 'completed' | 'failed',
    data: {
      reasoning_chain?: unknown[];
      output_data?: Record<string, unknown>;
      duration_ms?: number;
      cost_usd?: number;
      model_used?: string;
      error_message?: string;
    }
  ): Promise<void> {
    await this.agentPool.query(
      `UPDATE hitdash.agent_sessions
       SET status          = $2,
           reasoning_chain = $3,
           output_data     = $4,
           duration_ms     = $5,
           cost_usd        = $6,
           model_used      = $7,
           error_message   = $8
       WHERE id = $1`,
      [
        sessionId,
        status,
        JSON.stringify(data.reasoning_chain ?? []),
        JSON.stringify(data.output_data ?? {}),
        data.duration_ms ?? 0,
        data.cost_usd ?? 0,
        data.model_used ?? null,
        data.error_message ?? null,
      ]
    );
  }

  private async resolveStrategyId(strategyName: string): Promise<string | null> {
    const result = await this.agentPool.query<{ id: string }>(
      `SELECT id FROM hitdash.strategy_registry WHERE name = $1 LIMIT 1`,
      [strategyName]
    );
    return result.rows[0]?.id ?? null;
  }

  private async persistCartones(
    cartones: Carton[],
    game_type: GameType,
    draw_type: DrawType,
    draw_date: string,
    session_id: string,
    strategy_id: string | null
  ): Promise<string[]> {
    const ids: string[] = [];

    for (const carton of cartones) {
      const result = await this.agentPool.query<{ id: string }>(
        `INSERT INTO hitdash.carton_generations
           (game_type, draw_type, carton_size, numbers, strategy_id,
            confidence_score, draw_date, session_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          game_type,
          draw_type,
          carton.size,
          JSON.stringify(carton.numbers),
          strategy_id,
          carton.confidence_carton,
          draw_date,
          session_id,
        ]
      );
      ids.push(result.rows[0]!.id);
    }

    return ids;
  }

  private async persistAlerts(alerts: AgentAlert[], game_type: GameType): Promise<void> {
    for (const alert of alerts) {
      await this.agentPool.query(
        `INSERT INTO hitdash.proactive_alerts
           (alert_type, priority, game_type, message, data)
         VALUES ($1, $2, $3, $4, $5)`,
        [
          alert.type,
          alert.severity,
          alert.game_type ?? game_type,
          alert.message,
          JSON.stringify(alert.data ?? {}),
        ]
      );
    }
  }

  // ─── Persistir recomendaciones de pares en pair_recommendations ──
  private async persistPairRecommendations(
    recs: import('../types/agent.types.js').PairRecommendation[],
    game_type: GameType,
    draw_type: DrawType,
    draw_date: string,
    session_id: string
  ): Promise<void> {
    for (const rec of recs) {
      try {
        await this.agentPool.query(
          `INSERT INTO hitdash.pair_recommendations
             (session_id, game_type, draw_type, draw_date, half,
              optimal_n, predicted_effectiveness, cognitive_basis,
              pairs, confidence, top_n_backtest, kelly_fraction, wilson_lower)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (session_id, half) DO NOTHING`,
          [
            session_id,
            game_type,
            draw_type,
            draw_date,
            rec.half,
            rec.optimal_n ?? rec.top_n,
            rec.predicted_effectiveness ?? 0,
            rec.cognitive_basis ?? null,
            rec.pairs,
            rec.confidence,
            rec.top_n,
            null,   // kelly_fraction — disponible en backtest_results_v2 si se quiere enriquecer
            null,   // wilson_lower  — ídem
          ]
        );
        logger.info({ game_type, draw_type, half: rec.half, n: rec.pairs.length }, 'Pair recommendations persistidas');
      } catch (err) {
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Error persistiendo pair recommendations — continuando');
      }
    }
  }
}
