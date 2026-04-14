// ═══════════════════════════════════════════════════════════════
// HITDASH — Agent API Routes
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { AgentScheduler } from '../../agent/core/AgentScheduler.js';
import type { GameType, DrawType } from '../../agent/types/agent.types.js';
import { BacktestEngine, type BacktestMode, type StrategyName } from '../../agent/backtest/BacktestEngine.js';
import { PairBacktestEngine } from '../../agent/backtest/PairBacktestEngine.js';
import { ProgressiveEngine }  from '../../agent/backtest/ProgressiveEngine.js';
import { RAGService }         from '../../agent/services/RAGService.js';
import { LLMRouter }          from '../../agent/services/LLMRouter.js';
import { requireApiKey } from '../middlewares/authMiddleware.js';
import { createStrictLimiter } from '../middlewares/rateLimitMiddleware.js';
import pino from 'pino';

const logger = pino({ name: 'AgentRouter' });

export function createAgentRouter(agentPool: Pool, scheduler?: AgentScheduler, ballbotPool?: Pool, redis?: import('ioredis').Redis): Router {
  const router = Router();
  const backtestEngine      = ballbotPool ? new BacktestEngine(ballbotPool, agentPool) : null;
  const pairBacktestEngine  = new PairBacktestEngine(agentPool);
  const progressiveEngine   = ballbotPool ? new ProgressiveEngine(ballbotPool) : null;
  const ragService          = new RAGService(agentPool);
  const llmRouter           = new LLMRouter();

  const strictLimiter = createStrictLimiter();

  // Autenticación global para todas las rutas del Agente
  router.use(requireApiKey);

  // GET /api/agent/status
  router.get('/status', async (_req: Request, res: Response) => {
    try {
      const [sessionRow, alertRow, ragRow, ingestRow, cycleRow] = await Promise.all([
        agentPool.query<{
          id: string;
          game_type: string;
          draw_type: string;
          status: string;
          model_used: string;
          cost_usd: number;
          created_at: string;
        }>(
          `SELECT id, game_type, draw_type, status, model_used, cost_usd, created_at::text
           FROM hitdash.agent_sessions
           ORDER BY created_at DESC LIMIT 1`
        ),
        agentPool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM hitdash.proactive_alerts
           WHERE acknowledged = false`
        ),
        agentPool.query<{ count: string }>(
          `SELECT COUNT(*)::text AS count FROM hitdash.rag_knowledge`
        ),
        // Last ingestion = most recent rag_knowledge entry
        agentPool.query<{ created_at: string }>(
          `SELECT created_at::text FROM hitdash.rag_knowledge
           ORDER BY created_at DESC LIMIT 1`
        ),
        // Last agent cycle = most recent completed agent_session
        agentPool.query<{ created_at: string }>(
          `SELECT created_at::text FROM hitdash.agent_sessions
           WHERE status = 'completed'
           ORDER BY created_at DESC LIMIT 1`
        ),
      ]);

      const redisAlive = redis
        ? await redis.ping().then(() => true).catch(() => false)
        : false;

      res.json({
        online: true,
        last_session:      sessionRow.rows[0] ?? null,
        pending_alerts:    parseInt(alertRow.rows[0]!.count, 10),
        rag_documents:     parseInt(ragRow.rows[0]!.count, 10),
        last_ingestion:    ingestRow.rows[0]?.created_at ?? null,
        last_agent_cycle:  cycleRow.rows[0]?.created_at ?? null,
        redis_ok:          redisAlive,  // real PING — no more hardcoded true
      });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error obteniendo status del agente');
      res.status(500).json({ error: 'Error obteniendo status del agente' });
    }
  });

  // GET /api/agent/strategies?sort=win_rate&order=desc
  router.get('/strategies', async (req: Request, res: Response) => {
    const sort = (req.query['sort'] as string) ?? 'win_rate';
    const order = (req.query['order'] as string) === 'asc' ? 'ASC' : 'DESC';
    const validSorts = ['win_rate', 'total_tests', 'name', 'last_evaluated'];
    const safeSort = validSorts.includes(sort) ? sort : 'win_rate';

    try {
      const result = await agentPool.query(
        `SELECT id, name, description, algorithm, win_rate, total_tests, status,
                last_evaluated::text, created_at::text
         FROM hitdash.strategy_registry
         ORDER BY ${safeSort} ${order}`
      );
      res.json(result.rows);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err), sort: safeSort }, 'Error obteniendo estrategias');
      res.status(500).json({ error: 'Error obteniendo estrategias' });
    }
  });

  // GET /api/agent/cartones?game_type=pick3&limit=50&status=all
  router.get('/cartones', async (req: Request, res: Response) => {
    const gameType = req.query['game_type'] as string | undefined;
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '50', 10), 200);
    const status = req.query['status'] as string | undefined;

    const validGameTypes = ['pick3', 'pick4'];
    const validStatuses = ['pending', 'hit', 'partial', 'miss'];

    try {
      const result = await agentPool.query(
        `SELECT cg.id, cg.game_type, cg.draw_type, cg.carton_size, cg.numbers,
                cg.confidence_score, cg.result_status, cg.draw_date::text,
                cg.created_at::text, sr.name AS strategy_name
         FROM hitdash.carton_generations cg
         LEFT JOIN hitdash.strategy_registry sr ON sr.id = cg.strategy_id
         WHERE ($1::text IS NULL OR cg.game_type = $1)
           AND ($2::text IS NULL OR cg.result_status = $2)
         ORDER BY cg.created_at DESC
         LIMIT $3`,
        [
          gameType && validGameTypes.includes(gameType) ? gameType : null,
          status && validStatuses.includes(status) ? status : null,
          limit,
        ]
      );
      res.json(result.rows);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error obteniendo cartones');
      res.status(500).json({ error: 'Error obteniendo cartones' });
    }
  });

  // GET /api/agent/accuracy?range=90d
  router.get('/accuracy', async (req: Request, res: Response) => {
    const range = (req.query['range'] as string) ?? '30d';
    const validRanges: Record<string, string> = {
      '7d': '7 days', '30d': '30 days', '90d': '90 days', '365d': '365 days',
    };
    const interval = validRanges[range] ?? '30 days';

    try {
      const result = await agentPool.query(
        `SELECT
           date_trunc('day', fl.learned_at)::text AS day,
           COUNT(*)::int AS total_cartones,
           ROUND(AVG(fl.accuracy_score)::numeric, 4)::float AS avg_accuracy,
           SUM(fl.hits_exact)::int AS total_hits_exact,
           SUM(fl.hits_partial)::int AS total_hits_partial
         FROM hitdash.feedback_loop fl
         WHERE fl.learned_at >= now() - ($1 || ' days')::interval
         GROUP BY date_trunc('day', fl.learned_at)
         ORDER BY day ASC`,
        [interval.replace(' days', '')]
      );
      res.json({
        range,
        baseline_random: 0.1,
        data: result.rows,
      });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error obteniendo accuracy');
      res.status(500).json({ error: 'Error obteniendo tendencia de accuracy' });
    }
  });

  // GET /api/agent/alerts?acknowledged=false
  router.get('/alerts', async (req: Request, res: Response) => {
    const acknowledged = req.query['acknowledged'] === 'true';

    try {
      const result = await agentPool.query(
        `SELECT id, alert_type, priority, game_type, message, data,
                sent_at::text, acknowledged, created_at::text
         FROM hitdash.proactive_alerts
         WHERE acknowledged = $1
         ORDER BY created_at DESC
         LIMIT 50`,
        [acknowledged]
      );
      res.json(result.rows);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error obteniendo alertas');
      res.status(500).json({ error: 'Error obteniendo alertas' });
    }
  });

  // GET /api/agent/sessions?limit=20
  router.get('/sessions', async (req: Request, res: Response) => {
    const limit = Math.min(parseInt(req.query['limit'] as string ?? '20', 10), 100);

    try {
      const result = await agentPool.query(
        `SELECT id, trigger_type, game_type, draw_type, status,
                model_used, tokens_in, tokens_out, cost_usd,
                duration_ms, created_at::text
         FROM hitdash.agent_sessions
         ORDER BY created_at DESC
         LIMIT $1`,
        [limit]
      );
      res.json(result.rows);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error obteniendo sesiones');
      res.status(500).json({ error: 'Error obteniendo sesiones' });
    }
  });

  // PATCH /api/agent/alerts/:id/acknowledge
  router.patch('/alerts/:id/acknowledge', async (req: Request, res: Response) => {
    const { id } = req.params;

    try {
      await agentPool.query(
        `UPDATE hitdash.proactive_alerts
         SET acknowledged = true, sent_at = now()
         WHERE id = $1`,
        [id]
      );
      res.json({ success: true });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err), id }, 'Error actualizando alerta');
      res.status(500).json({ error: 'Error actualizando alerta' });
    }
  });

  // POST /api/agent/trigger
  // Body: { game_type: 'pick3'|'pick4', draw_type: 'midday'|'evening', draw_date?: 'YYYY-MM-DD' }
  router.post('/trigger', strictLimiter, async (req: Request, res: Response) => {
    if (!scheduler) {
      res.status(503).json({ error: 'Scheduler no disponible' });
      return;
    }

    const { game_type, draw_type, draw_date } = req.body as {
      game_type?: string;
      draw_type?: string;
      draw_date?: string;
    };

    if (!['pick3', 'pick4'].includes(game_type ?? '')) {
      res.status(400).json({ error: 'game_type inválido: pick3 | pick4' });
      return;
    }
    if (!['midday', 'evening'].includes(draw_type ?? '')) {
      res.status(400).json({ error: 'draw_type inválido: midday | evening' });
      return;
    }

    try {
      const jobId = await scheduler.triggerManual(
        game_type as GameType,
        draw_type as DrawType,
        draw_date
      );
      res.json({ success: true, job_id: jobId });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error disparando agente manualmente');
      res.status(500).json({ error: 'Error disparando agente manualmente' });
    }
  });

  // GET /api/agent/queue
  router.get('/queue', async (_req: Request, res: Response) => {
    if (!scheduler) {
      res.status(503).json({ error: 'Scheduler no disponible' });
      return;
    }
    try {
      const status = await scheduler.getQueueStatus();
      res.json(status);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'Error obteniendo estado de la cola');
      res.status(500).json({ error: 'Error obteniendo estado de la cola' });
    }
  });

  // ─── Backtest endpoints ─────────────────────────────────────

  // GET /api/agent/backtest?mode=combined
  // Devuelve todos los resultados guardados de backtest
  router.get('/backtest', async (req: Request, res: Response) => {
    if (!backtestEngine) {
      res.status(503).json({ error: 'Ballbot pool no disponible' });
      return;
    }
    const mode = req.query['mode'] as BacktestMode | undefined;
    const validModes = ['midday', 'evening', 'combined'];
    try {
      const summaries = await backtestEngine.getSummaries(
        mode && validModes.includes(mode) ? mode : undefined
      );
      res.json(summaries);
    } catch (err) {
      res.status(500).json({ error: 'Error obteniendo resultados de backtest' });
    }
  });

  // GET /api/agent/backtest/:strategy/insights?mode=combined
  // Insights de centena/decena para una estrategia específica
  router.get('/backtest/:strategy/insights', async (req: Request, res: Response) => {
    if (!backtestEngine) {
      res.status(503).json({ error: 'Ballbot pool no disponible' });
      return;
    }
    const strategy = req.params['strategy'] as string;
    const mode = (req.query['mode'] as BacktestMode) ?? 'combined';
    try {
      const insights = await backtestEngine.getCentenaInsights(strategy, mode);
      res.json(insights);
    } catch (err) {
      res.status(500).json({ error: 'Error obteniendo insights de centena' });
    }
  });

  // POST /api/agent/backtest/run
  // Body: { mode?: 'midday'|'evening'|'combined', strategy?: string,
  //         max_combos?: 60, train_window_draws?: 90, eval_step?: 7 }
  // Corre la simulación (puede tardar 30-120s según el historial)
  router.post('/backtest/run', strictLimiter, async (req: Request, res: Response) => {
    if (!backtestEngine) {
      res.status(503).json({ error: 'Ballbot pool no disponible' });
      return;
    }

    const {
      mode = 'combined',
      strategy,
      max_combos = 60,
      train_window_draws = 90,
      eval_step = 7,
      top_p1_count = 2,
      top_p2_count = 3,
    } = req.body as {
      mode?: string;
      strategy?: string;
      max_combos?: number;
      train_window_draws?: number;
      eval_step?: number;
      top_p1_count?: number;
      top_p2_count?: number;
    };

    const validModes = ['midday', 'evening', 'combined'];
    const validStrategies: StrategyName[] = [
      'frequency_rank','hot_cold_weighted','gap_overdue_focus',
      'moving_avg_signal','streak_reversal','position_bias',
      'pair_correlation','consensus_top',
    ];

    if (!validModes.includes(mode)) {
      res.status(400).json({ error: 'mode inválido: midday | evening | combined' });
      return;
    }

    const config = {
      game_type:          'pick3' as const,
      mode:               mode as BacktestMode,
      max_combos:         Math.min(Math.max(max_combos, 10), 60),
      train_window_draws: Math.min(Math.max(train_window_draws, 30), 500),
      eval_step:          Math.min(Math.max(eval_step, 1), 30),
      min_train_draws:    30,
      top_p1_count:       Math.min(Math.max(top_p1_count, 1), 6),
      top_p2_count:       Math.min(Math.max(top_p2_count, 1), 6),
    };

    // Responde inmediatamente con ACK y corre en background
    res.json({ accepted: true, mode, strategy: strategy ?? 'all', config });

    try {
      if (strategy && validStrategies.includes(strategy as StrategyName)) {
        const summary = await backtestEngine.runStrategy(strategy as StrategyName, config);
        await backtestEngine.persistSummary(summary);
        await backtestEngine.updateStrategyWinRate(strategy, summary);
      } else {
        await backtestEngine.runAll(mode as BacktestMode, config);
      }
    } catch (err) {
      // Error ya loggeado en BacktestEngine
    }
  });

  // ─── POST /api/agent/backtest/v2/run ────────────────────────────
  // Corre PairBacktestEngine para pick3 o pick4.
  // Body: { game_type?: "pick3"|"pick4", mode?: "midday"|"evening"|"combined" }
  router.post('/backtest/v2/run', strictLimiter, async (req: Request, res: Response) => {
    if (!pairBacktestEngine) {
      res.status(503).json({ error: 'Ballbot pool no disponible' });
      return;
    }

    const game_type = (req.body as Record<string, string>)['game_type'] ?? 'pick3';
    const mode      = (req.body as Record<string, string>)['mode']      ?? 'combined';

    const validGames = ['pick3', 'pick4'];
    const validModes = ['midday', 'evening', 'combined'];

    if (!validGames.includes(game_type) || !validModes.includes(mode)) {
      res.status(400).json({ error: 'game_type o mode inválido' });
      return;
    }

    // ACK inmediato — el backtest corre en background (puede tardar varios minutos)
    res.json({ accepted: true, game_type, mode, engine: 'v2' });

    try {
      await pairBacktestEngine.runAll(mode as BacktestMode, game_type as 'pick3' | 'pick4');
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err), game_type, mode }, '[PairBacktest v2] Error en background');
    }
  });

  // ─── GET /api/agent/backtest/v2/results ─────────────────────────
  // Lee resultados de backtest_results_v2
  router.get('/backtest/v2/results', async (req: Request, res: Response) => {
    const game_type = (req.query['game_type'] as string) ?? 'pick3';
    const mode      = (req.query['mode']      as string) ?? 'combined';
    try {
      const { rows } = await agentPool.query(
        `SELECT strategy_name, game_type, mode, half,
                total_eval_pts, hits_pair, hit_rate,
                centena_plus_hits, centena_plus_acc,
                avg_top_n, final_top_n, date_from, date_to,
                run_duration_ms,
                mrr, expected_rank, brier_score,
                precision_at_3, precision_at_5, precision_at_10,
                wilson_lower, wilson_upper,
                cohens_h, p_value,
                cv_hit_rate, sharpe, max_miss_streak,
                autocorr_lag1, kelly_fraction
         FROM hitdash.backtest_results_v2
         WHERE game_type = $1 AND mode = $2
         ORDER BY hit_rate DESC, mrr DESC`,
        [game_type, mode]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── POST /api/agent/backtest/progressive ───────────────────────
  // Corre ProgressiveEngine directo desde Ballbot DB.
  // Body: { map_source, period, start_date, end_date, top_n?, strategy_ids? }
  router.post('/backtest/progressive', strictLimiter, async (req: Request, res: Response) => {
    if (!progressiveEngine) { res.status(503).json({ error: 'Ballbot pool no disponible' }); return; }

    const body = req.body as Record<string, unknown>;
    const mapSource   = (body['map_source'] as string) ?? 'p3';
    const period      = (body['period']     as string) ?? 'm';
    const topN        = Math.min(Math.max(Number(body['top_n']) || 10, 5), 30);
    const strategyIds = Array.isArray(body['strategy_ids']) ? body['strategy_ids'] as string[] : undefined;
    const startDate   = body['start_date'] ? new Date(body['start_date'] as string) : new Date(Date.now() - 365*24*3600*1000);
    const endDate     = body['end_date']   ? new Date(body['end_date']   as string) : new Date();

    if (!['p3','p4'].includes(mapSource) || !['m','e'].includes(period)) {
      res.status(400).json({ error: 'map_source: p3|p4  period: m|e' });
      return;
    }

    // ACK inmediato — puede tardar 30-90s
    res.json({ accepted: true, mapSource, period, topN, startDate, endDate });

    // Correr en background — resultado guardable en cache Redis si se quiere
    try {
      const result = await progressiveEngine.run({
        mapSource:   mapSource as 'p3' | 'p4',
        period:      period    as 'm'  | 'e',
        topN,
        strategyIds,
        startDate,
        endDate,
      });
      // Guardar en agentPool para consulta posterior
      await agentPool.query(
        `INSERT INTO hitdash.progressive_results
           (map_source, period, top_n, start_date, end_date, result_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (map_source, period) DO UPDATE
           SET top_n=$3, start_date=$4, end_date=$5, result_json=$6, created_at=now()`,
        [mapSource, period, topN, startDate, endDate, JSON.stringify(result)]
      ).catch(() => { /* tabla puede no existir aún */ });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err), mapSource, period }, '[Progressive] Error en background');
    }
  });

  // ─── GET /api/agent/backtest/progressive/latest ──────────────────
  // Lee el último resultado de progressive para el context dado.
  // ?map_source=p3&period=m
  router.get('/backtest/progressive/latest', async (req: Request, res: Response) => {
    const mapSource = (req.query['map_source'] as string) ?? 'p3';
    const period    = (req.query['period']     as string) ?? 'm';
    try {
      const { rows } = await agentPool.query(
        `SELECT result_json, created_at FROM hitdash.progressive_results
         WHERE map_source=$1 AND period=$2
         ORDER BY created_at DESC LIMIT 1`,
        [mapSource, period]
      );
      if (!rows.length) { res.json(null); return; }
      res.json({ ...rows[0]!['result_json'], cached_at: rows[0]!['created_at'] });
    } catch (err) {
      logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'progressive/latest — DB error, returning null');
      res.json(null);
    }
  });

  // ─── POST /api/agent/backtest/unified ───────────────────────────
  // Corre v2 (pair metrics) + Progressive en paralelo y devuelve JSON fusionado.
  // Body: { game_type, map_source, period, start_date, end_date, mode, top_n? }
  router.post('/backtest/unified', strictLimiter, async (req: Request, res: Response) => {
    if (!pairBacktestEngine || !progressiveEngine) {
      res.status(503).json({ error: 'Motores no disponibles' }); return;
    }

    const body      = req.body as Record<string, unknown>;
    const game_type = (body['game_type']  as string) ?? 'pick3';
    const mapSource = (body['map_source'] as string) ?? 'p3';
    const period    = (body['period']     as string) ?? 'm';
    const mode      = (body['mode']       as string) ?? 'combined';
    const topN      = Math.min(Math.max(Number(body['top_n']) || 10, 5), 30);
    const startDate = body['start_date'] ? new Date(body['start_date'] as string) : new Date(Date.now() - 365*24*3600*1000);
    const endDate   = body['end_date']   ? new Date(body['end_date']   as string) : new Date();

    res.json({ accepted: true, game_type, mapSource, period, mode, topN });

    try {
      // Cargar kelly_fractions de v2 para enriquecer play signals
      const { rows: v2rows } = await agentPool.query(
        `SELECT strategy_name, kelly_fraction FROM hitdash.backtest_results_v2
         WHERE game_type=$1 AND mode=$2 ORDER BY hit_rate DESC`,
        [game_type, mode]
      ).catch(() => ({ rows: [] }));

      // Mapear nombres v2 → IDs de ProgressiveEngine
      // v2 usa: frequency_rank, gap_overdue_focus, streak_reversal, momentum_ema, hot_cold_weighted
      // Progressive usa: freq_analysis, gap_due, streak_reversal, momentum_ema, hot_cold
      const V2_TO_PROGRESSIVE: Record<string, string> = {
        frequency_rank:    'freq_analysis',
        gap_overdue_focus: 'gap_due',
        streak_reversal:   'streak_reversal',
        momentum_ema:      'momentum_ema',
        hot_cold_weighted: 'hot_cold',
      };
      const kellyMap: Record<string, number> = {};
      for (const r of v2rows) {
        const progressiveId = V2_TO_PROGRESSIVE[r['strategy_name']];
        if (progressiveId) kellyMap[progressiveId] = r['kelly_fraction'];
      }

      const [v2Results, progResult] = await Promise.allSettled([
        pairBacktestEngine.runAll(mode as 'midday' | 'evening' | 'combined', game_type as 'pick3' | 'pick4'),
        progressiveEngine.run({
          mapSource: mapSource as 'p3' | 'p4',
          period:    period    as 'm'  | 'e',
          topN, startDate, endDate, kellyMap,
        }),
      ]);

      const unified = {
        game_type, mapSource, period, mode, topN,
        generated_at: new Date().toISOString(),
        pair_v2: v2Results.status === 'fulfilled' ? 'completed' : v2Results.reason,
        progressive: progResult.status === 'fulfilled' ? progResult.value : null,
        progressive_error: progResult.status === 'rejected' ? String(progResult.reason) : null,
      };

      await agentPool.query(
        `INSERT INTO hitdash.progressive_results
           (map_source, period, top_n, start_date, end_date, result_json, created_at)
         VALUES ($1,$2,$3,$4,$5,$6,now())
         ON CONFLICT (map_source, period) DO UPDATE
           SET top_n=$3, start_date=$4, end_date=$5, result_json=$6, created_at=now()`,
        [mapSource, period, topN, startDate, endDate, JSON.stringify(unified)]
      ).catch(() => {});
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, '[Unified] Error en background');
    }
  });

  // ─── GET /api/agent/pair-recommendations ───────────────────────
  // Lista las últimas recomendaciones de pares persistidas.
  // ?game_type=pick3&draw_type=evening&limit=20
  router.get('/pair-recommendations', async (req: Request, res: Response) => {
    const game_type = (req.query['game_type'] as string) ?? 'pick3';
    const draw_type = (req.query['draw_type'] as string) ?? 'evening';
    const limit     = Math.min(parseInt(req.query['limit'] as string ?? '20', 10), 100);
    const validGames = ['pick3', 'pick4'];
    const validDraws = ['midday', 'evening'];

    if (!validGames.includes(game_type) || !validDraws.includes(draw_type)) {
      res.status(400).json({ error: 'Parámetros inválidos' });
      return;
    }

    try {
      const { rows } = await agentPool.query(
        `SELECT
           pr.id, pr.game_type, pr.draw_type, pr.draw_date::text,
           pr.half, pr.optimal_n, pr.predicted_effectiveness, pr.cognitive_basis,
           pr.pairs, pr.confidence, pr.top_n_backtest, pr.kelly_fraction,
           pr.wilson_lower, pr.actual_pair, pr.hit, pr.hit_at_rank,
           pr.created_at::text,
           s.status AS session_status, s.model_used
         FROM hitdash.pair_recommendations pr
         LEFT JOIN hitdash.agent_sessions s ON s.id = pr.session_id
         WHERE pr.game_type  = $1
           AND pr.draw_type  = $2
         ORDER BY pr.created_at DESC
         LIMIT $3`,
        [game_type, draw_type, limit]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── GET /api/agent/pair-recommendations/latest ─────────────────
  // Última recomendación por juego (para el Dashboard)
  router.get('/pair-recommendations/latest', async (_req: Request, res: Response) => {
    try {
      const { rows } = await agentPool.query(
        `SELECT DISTINCT ON (game_type, draw_type, half)
           id, game_type, draw_type, draw_date::text, half,
           optimal_n, predicted_effectiveness, cognitive_basis,
           pairs, confidence, top_n_backtest,
           actual_pair, hit, hit_at_rank, created_at::text
         FROM hitdash.pair_recommendations
         ORDER BY game_type, draw_type, half, created_at DESC`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ─── GET /api/agent/backtest/v2/tracking ───────────────────────
  // Tracking histórico + adaptive state por estrategia
  // ?game_type=pick3&mode=midday
  router.get('/backtest/v2/tracking', async (req: Request, res: Response) => {
    const game_type = (req.query['game_type'] as string) ?? 'pick3';
    const mode      = (req.query['mode']      as string) ?? 'combined';
    const validGames = ['pick3', 'pick4'];
    const validModes = ['midday', 'evening', 'combined'];
    if (!validGames.includes(game_type) || !validModes.includes(mode)) {
      res.status(400).json({ error: 'game_type o mode inválido' });
      return;
    }

    try {
      // ── 1. Merge strategy_registry + adaptive_weights + backtest_results_v2 ──
      // ═══ F02 FIX: Reemplaza JOIN con backtest_results (v1 LEGACY) por backtest_results_v2.
      // V1 medía combinaciones de 3 dígitos. V2 mide hit_rate de pares. Motor activo = v2.
      // LATERAL JOIN obtiene la mejor mitad (half) por estrategia para evitar duplicados AB/CD.
      const stratRows = await agentPool.query<{
        name: string; description: string; algorithm: string;
        win_rate: number; total_tests: number; status: string;
        weight: number | null; top_n: number | null;
        hit_rate_history: number[] | null;
        total_eval_pts: number | null; hits_exact: number | null;
        hits_both: number | null; hit_rate: number | null;
        date_from: string | null; date_to: string | null;
        mrr: number | null; wilson_lower: number | null;
        sharpe: number | null; kelly_fraction: number | null;
      }>(
        `SELECT
           sr.name, sr.description, sr.algorithm,
           sr.win_rate, sr.total_tests, sr.status,
           aw.weight,
           COALESCE(aw.top_n, 15)                         AS top_n,
           COALESCE(aw.hit_rate_history, '[]'::jsonb)     AS hit_rate_history,
           br.total_eval_pts,
           br.hits_pair                                   AS hits_exact,
           br.hits_pair                                   AS hits_both,
           COALESCE(br.hit_rate, 0.0)::float              AS hit_rate,
           br.date_from::text, br.date_to::text,
           br.mrr, br.wilson_lower, br.sharpe, br.kelly_fraction
         FROM hitdash.strategy_registry sr
         LEFT JOIN hitdash.adaptive_weights aw
           ON aw.strategy = sr.name
          AND aw.game_type = $1
          AND aw.mode      = $2
         LEFT JOIN LATERAL (
           SELECT *
           FROM hitdash.backtest_results_v2 br2
           WHERE br2.strategy_name = sr.name
             AND br2.game_type     = $1
             AND br2.mode          = $2
           ORDER BY br2.hit_rate DESC
           LIMIT 1
         ) br ON true
         ORDER BY COALESCE(br.hit_rate, sr.win_rate, 0) DESC`,
        [game_type, mode]
      );

      // ── 2. Timeline (last 60 eval points por estrategia, en paralelo) ──
      const timelineMap: Record<string, Array<{ draw_index: number; eval_date: string; hit: boolean }>> = {};
      // ═══ F07 FIX: Timeline ahora usa backtest_points_v2.hit_pair (motor activo)
      // Antes: backtest_points.hit_combination (motor v1 legado — mide combos de 3 dígitos)
      // Los gráficos de momentum ahora reflejan el rendimiento real del motor de pares.
      await Promise.all(
        stratRows.rows.map(async s => {
          try {
            const pts = await agentPool.query<{
              draw_index: number; eval_date: string; hit_pair: boolean;
            }>(
              `SELECT bp.draw_index, bp.eval_date::text, bp.hit_pair
               FROM hitdash.backtest_points_v2 bp
               JOIN hitdash.backtest_results_v2 br ON br.id = bp.backtest_id
               WHERE br.strategy_name = $1
                 AND br.game_type     = $2
                 AND br.mode          = $3
               ORDER BY bp.draw_index DESC
               LIMIT 60`,
              [s.name, game_type, mode]
            );
            timelineMap[s.name] = pts.rows.reverse().map(p => ({
              draw_index: p.draw_index,
              eval_date:  p.eval_date,
              hit:        p.hit_pair,
            }));
          } catch (err) {
            logger.warn({ strategy: s.name, error: err instanceof Error ? err.message : String(err) }, 'Timeline fetch fallida — usando array vacío');
            timelineMap[s.name] = [];
          }
        })
      );

      // ── 3. Build rolling hit_rate per strategy from timeline (windows of 10) ──
      function rollingHitRate(timeline: Array<{ hit: boolean }>, windowSize = 10): number[] {
        if (timeline.length < windowSize) return [];
        const rates: number[] = [];
        for (let i = windowSize; i <= timeline.length; i++) {
          const window = timeline.slice(i - windowSize, i);
          rates.push(window.filter(p => p.hit).length / windowSize);
        }
        return rates;
      }

      const strategies = stratRows.rows.map(s => {
        const timeline  = timelineMap[s.name] ?? [];
        // Prefer DB hit_rate_history from adaptive_weights, fallback to rolling
        const rateHistory: number[] = (s.hit_rate_history && s.hit_rate_history.length > 0)
          ? s.hit_rate_history
          : rollingHitRate(timeline, 10);

        return {
          name:             s.name,
          description:      s.description,
          algorithm:        s.algorithm,
          status:           s.status,
          win_rate:         s.win_rate ?? 0,
          total_tests:      s.total_tests ?? 0,
          weight:           s.weight ?? 1.0,
          top_n:            s.top_n ?? 15,
          hit_rate:         s.hit_rate ?? s.win_rate ?? 0,
          hit_rate_history: rateHistory,
          total_eval_pts:   s.total_eval_pts ?? 0,
          hits_exact:       s.hits_exact ?? 0,
          hits_both:        s.hits_both ?? 0,
          date_from:        s.date_from,
          date_to:          s.date_to,
          timeline:         timeline.slice(-60),
          // ── v2 precision metrics (null if no backtest_results_v2 yet) ──
          mrr:              s.mrr ?? 0,
          wilson_lower:     s.wilson_lower ?? 0,
          sharpe:           s.sharpe ?? 0,
          kelly_fraction:   s.kelly_fraction ?? 0,
        };
      });

      res.json({
        game_type,
        mode,
        generated_at: new Date().toISOString(),
        strategies,
      });
    } catch (err) {
      res.status(500).json({ error: 'Error obteniendo tracking de estrategias' });
    }
  });

  // ─── GET /api/agent/rendimiento ─────────────────────────────────
  // C3: Live performance dashboard — prediction vs actual for all sorteos
  // Returns: summary stats + chronological list of pair recommendations with hit status
  router.get('/rendimiento', async (req: Request, res: Response) => {
    const game_type = (req.query['game_type'] as string) ?? 'pick3';
    const days      = Math.min(90, Math.max(7, parseInt((req.query['days'] as string) ?? '30', 10)));

    try {
      // ── Summary: hit rates by game/draw/half ─────────────────────
      const { rows: summary } = await agentPool.query<{
        game_type: string; draw_type: string; half: string;
        total: number; hits: number; hit_rate: number; avg_rank: number;
        baseline: number; vs_azar: number;
      }>(
        `SELECT
           game_type, draw_type, half,
           COUNT(*)::int                                        AS total,
           COUNT(*) FILTER (WHERE hit = true)::int             AS hits,
           ROUND(AVG(CASE WHEN hit THEN 1.0 ELSE 0.0 END)::numeric, 4)::float AS hit_rate,
           ROUND(AVG(hit_at_rank)::numeric, 1)::float          AS avg_rank,
           ROUND(AVG(optimal_n::float / 100), 4)::float        AS baseline,
           ROUND(
             AVG(CASE WHEN hit THEN 1.0 ELSE 0.0 END) -
             AVG(optimal_n::float / 100), 4
           )::float                                             AS vs_azar
         FROM hitdash.pair_recommendations
         WHERE game_type = $1
           AND created_at >= now() - ($2 || ' days')::interval
           AND hit IS NOT NULL
         GROUP BY game_type, draw_type, half
         ORDER BY game_type, draw_type, half`,
        [game_type, days]
      );

      // ── Timeline: last 60 sorteos with hit/miss ──────────────────
      const { rows: timeline } = await agentPool.query<{
        id: string; game_type: string; draw_type: string; draw_date: string;
        half: string; pairs: string[]; optimal_n: number;
        predicted_effectiveness: number; actual_pair: string | null;
        hit: boolean | null; hit_at_rank: number | null; confidence: number;
        created_at: string;
      }>(
        `SELECT
           id, game_type, draw_type, draw_date::text, half,
           pairs, optimal_n, predicted_effectiveness,
           actual_pair, hit, hit_at_rank, confidence,
           created_at::text
         FROM hitdash.pair_recommendations
         WHERE game_type = $1
           AND created_at >= now() - ($2 || ' days')::interval
         ORDER BY draw_date DESC, draw_type, half
         LIMIT 120`,
        [game_type, days]
      );

      // ── Strategy comparison: backtest v2 hit_rates ───────────────
      const { rows: strategies } = await agentPool.query<{
        strategy_name: string; half: string; hit_rate: number;
        precision_at_5: number; precision_at_10: number;
        expected_rank: number; sharpe: number; kelly_fraction: number;
        total_eval_pts: number;
      }>(
        `SELECT strategy_name, half, hit_rate,
                precision_at_5, precision_at_10,
                expected_rank, sharpe, kelly_fraction, total_eval_pts
         FROM hitdash.backtest_results_v2
         WHERE game_type = $1
         ORDER BY hit_rate DESC`,
        [game_type]
      );

      res.json({ summary, timeline, strategies, days, game_type });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POST /api/agent/chat
  // Intercomunicador IA — responde preguntas desde el contexto
  // real de la base de datos + memoria RAG del agente.
  // Body: { message: string, game_type?: GameType, history?: {role,content}[] }
  // ═══════════════════════════════════════════════════════════════
  router.post('/chat', strictLimiter, async (req: Request, res: Response) => {
    const { message, game_type, history = [] } = req.body as {
      message: string;
      game_type?: GameType;
      history?: Array<{ role: 'user' | 'assistant'; content: string }>;
    };

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
      res.status(400).json({ error: 'message requerido' });
      return;
    }
    if (message.length > 600) {
      res.status(400).json({ error: 'message demasiado largo (máx 600 caracteres)' });
      return;
    }

    try {
      const gt = (game_type ?? 'pick3') as GameType;

      // ─── 1. Contexto estructurado desde DB (parallel) ────────────
      const [recRows, btRows, alertRows, awRows, sessionRow] = await Promise.all([
        // Últimas 10 recomendaciones de pares con resultado
        agentPool.query<{
          draw_date: string; draw_type: string; half: string;
          pairs: string[]; hit: boolean | null; hit_at_rank: number | null;
          optimal_n: number; predicted_effectiveness: number;
        }>(
          `SELECT draw_date, draw_type, half, pairs, hit, hit_at_rank,
                  optimal_n, predicted_effectiveness
           FROM hitdash.pair_recommendations
           WHERE game_type = $1
           ORDER BY draw_date DESC, created_at DESC
           LIMIT 10`,
          [gt]
        ).catch(() => ({ rows: [] })),

        // Top 5 estrategias por hit_rate
        agentPool.query<{
          strategy_name: string; half: string; hit_rate: number;
          final_top_n: number; kelly_fraction: number; sharpe: number; total_eval_pts: number;
        }>(
          `SELECT strategy_name, half, hit_rate, final_top_n,
                  kelly_fraction, sharpe, total_eval_pts
           FROM hitdash.backtest_results_v2
           WHERE game_type = $1
           ORDER BY hit_rate DESC
           LIMIT 5`,
          [gt]
        ).catch(() => ({ rows: [] })),

        // Últimas 3 alertas sin reconocer
        agentPool.query<{ alert_type: string; message: string; created_at: string }>(
          `SELECT alert_type, message, created_at::text
           FROM hitdash.proactive_alerts
           WHERE acknowledged = false
           ORDER BY created_at DESC
           LIMIT 3`
        ).catch(() => ({ rows: [] })),

        // Pesos adaptativos actuales
        agentPool.query<{ strategy: string; weight: number; top_n: number; mode: string }>(
          `SELECT strategy, weight, top_n, mode
           FROM hitdash.adaptive_weights
           WHERE game_type = $1
           ORDER BY weight DESC
           LIMIT 8`,
          [gt]
        ).catch(() => ({ rows: [] })),

        // Última sesión del agente
        agentPool.query<{ status: string; created_at: string; duration_ms: number; model_used: string }>(
          `SELECT status, created_at::text, duration_ms, model_used
           FROM hitdash.agent_sessions
           ORDER BY created_at DESC LIMIT 1`
        ).catch(() => ({ rows: [] })),
      ]);

      // ─── 2. Búsqueda semántica RAG ────────────────────────────────
      const ragResults = await ragService.searchSimilar(message, 5, undefined, 0.45)
        .catch(() => [] as import('../../agent/types/agent.types.js').RagResult[]);

      // ─── 3. Construir bloque de contexto ─────────────────────────
      const recSummary = recRows.rows.length === 0
        ? 'Sin recomendaciones registradas aún.'
        : recRows.rows.map(r =>
            `[${r.draw_date} ${r.draw_type} ${r.half}] Pares: ${r.pairs.slice(0, 8).join(' ')} | ` +
            `${r.hit === null ? 'pendiente' : r.hit ? `HIT rank#${r.hit_at_rank}` : 'MISS'} | ` +
            `N=${r.optimal_n} efectividad=${(r.predicted_effectiveness * 100).toFixed(1)}%`
          ).join('\n');

      const btSummary = btRows.rows.length === 0
        ? 'Sin datos de backtest aún.'
        : btRows.rows.map(r =>
            `${r.strategy_name}(${r.half}): hit_rate=${(r.hit_rate * 100).toFixed(1)}% ` +
            `top_n=${r.final_top_n} kelly=${r.kelly_fraction?.toFixed(3) ?? 'n/a'} ` +
            `sharpe=${r.sharpe?.toFixed(2) ?? 'n/a'} pts=${r.total_eval_pts}`
          ).join('\n');

      const alertSummary = alertRows.rows.length === 0
        ? 'Sin alertas activas.'
        : alertRows.rows.map(r => `[${r.alert_type}] ${r.message} (${r.created_at})`).join('\n');

      const awSummary = awRows.rows.length === 0
        ? 'Sin pesos adaptativos aún.'
        : awRows.rows.map(r =>
            `${r.strategy}(${r.mode}): peso=${r.weight.toFixed(3)} top_n=${r.top_n}`
          ).join('\n');

      const sessionSummary = sessionRow.rows[0]
        ? `Última sesión: ${sessionRow.rows[0].status} | ${sessionRow.rows[0].created_at} | modelo: ${sessionRow.rows[0].model_used}`
        : 'Sin sesiones registradas.';

      const ragSummary = ragResults.length === 0
        ? ''
        : '\nMEMORIA RAG (patrones aprendidos):\n' +
          ragResults.map(r => `[${r.category}] ${r.content.slice(0, 200)}`).join('\n');

      // ─── 4. Historial de conversación (últimas 6 rondas) ─────────
      const recentHistory = history.slice(-6);

      // ─── 5. Prompt al LLM ─────────────────────────────────────────
      const systemPrompt = `Eres HITDASH, el agente estadístico de Bliss Systems LLC para análisis de lotería.
Respondes ÚNICAMENTE desde el contexto de tu base de datos que se te proporciona.
Si un dato no está en el contexto, di explícitamente "No tengo esa información en mi base de datos."
No inventes números ni porcentajes. Sé directo, conciso y usa lenguaje profesional en español.
Juego activo para esta consulta: ${gt.toUpperCase()}.

─── RECOMENDACIONES RECIENTES ───
${recSummary}

─── RENDIMIENTO DE ESTRATEGIAS (BACKTEST) ───
${btSummary}

─── ALERTAS ACTIVAS ───
${alertSummary}

─── PESOS ADAPTATIVOS ───
${awSummary}

─── ESTADO DEL AGENTE ───
${sessionSummary}
${ragSummary}`;

      const messages: import('../../agent/types/agent.types.js').Message[] = [
        { role: 'system', content: systemPrompt },
        ...recentHistory.map(h => ({ role: h.role, content: h.content } as import('../../agent/types/agent.types.js').Message)),
        { role: 'user', content: message },
      ];

      const llmResult = await llmRouter.complete(messages, { temperature: 0.2, maxTokens: 800 });

      // ─── 6. Fuentes utilizadas ────────────────────────────────────
      const sources: string[] = [];
      if (recRows.rows.length > 0)  sources.push('pair_recommendations');
      if (btRows.rows.length > 0)   sources.push('backtest_results_v2');
      if (alertRows.rows.length > 0) sources.push('proactive_alerts');
      if (awRows.rows.length > 0)   sources.push('adaptive_weights');
      if (ragResults.length > 0)    sources.push('rag_knowledge');

      res.json({
        response: llmResult.content,
        sources,
        model: llmResult.model,
        context_records: {
          recommendations: recRows.rows.length,
          strategies: btRows.rows.length,
          rag_hits: ragResults.length,
        },
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ error: msg }, 'chat endpoint error');
      res.status(500).json({ error: 'El agente no pudo responder. Verifica las API keys (GEMINI_API_KEY / ANTHROPIC_API_KEY).' });
    }
  });

  return router;
}
