// ═══════════════════════════════════════════════════════════════
// HITDASH — BacktestControl Router
// Expone el motor de backtest (PairBacktestEngine) via REST + SSE.
// Soporta ejecución manual desde el panel Vue y disparos proactivos
// del HitdashAgent cuando detecta degradación de estrategias.
//
// Endpoints:
//   GET  /api/backtest-control/strategies        — catálogo de estrategias
//   GET  /api/backtest-control/history            — últimas N ejecuciones
//   POST /api/backtest-control/run                — lanzar backtest (async)
//   GET  /api/backtest-control/status/:jobId      — estado + progreso de job
//   GET  /api/backtest-control/results/:jobId     — resultados completos
//   GET  /api/backtest-control/cancel/:jobId      — cancelar job activo
//   GET  /api/backtest-control/draws/meta         — info del histórico disponible
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import pino from 'pino';
import { PairBacktestEngine, type PairStrategyName } from '../../agent/backtest/PairBacktestEngine.js';
import type { BacktestMode } from '../../agent/backtest/BacktestEngine.js';
import type { PairHalf, PairBacktestSummary } from '../../agent/types/analysis.types.js';
import { randomUUID } from 'crypto';

const logger = pino({ name: 'BacktestControlRouter' });

// ─── Catálogo de estrategias con metadata UI ──────────────────
export const STRATEGY_CATALOG: Array<{
  id: PairStrategyName;
  label: string;
  icon: string;
  category: string;
  description: string;
  default_selected: boolean;
}> = [
  {
    id: 'apex_adaptive',
    label: 'APEX Adaptive',
    icon: '🏆',
    category: 'meta',
    description: 'Meta-estrategia: combina todas con pesos aprendidos adaptativamente. Siempre corre al final.',
    default_selected: true,
  },
  {
    id: 'frequency_rank',
    label: 'Frecuencia',
    icon: '📊',
    category: 'baseline',
    description: 'Frecuencia absoluta de cada par. Baseline estadístico.',
    default_selected: true,
  },
  {
    id: 'momentum_ema',
    label: 'Momentum EMA',
    icon: '⚡',
    category: 'momentum',
    description: 'Multi-window EMA decay [3,7,14,30d]. Captura impulso reciente con α^k.',
    default_selected: true,
  },
  {
    id: 'gap_overdue_focus',
    label: 'Gap Sobredebido',
    icon: '⏰',
    category: 'momentum',
    description: 'gap_actual / avg_gap. Detecta pares cuya ausencia supera el intervalo histórico.',
    default_selected: true,
  },
  {
    id: 'hot_cold_weighted',
    label: 'Hot / Cold',
    icon: '🌡',
    category: 'momentum',
    description: 'sigmoid(z-score) de frecuencia 7d vs 90d. Hot = alta actividad reciente.',
    default_selected: true,
  },
  {
    id: 'streak_reversal',
    label: 'Reversión de Racha',
    icon: '🔄',
    category: 'reversal',
    description: 'Pares en racha de ausencia ≥ (media + 2σ). Candidatos a reversión estadística.',
    default_selected: true,
  },
  {
    id: 'moving_avg_signal',
    label: 'Moving Average',
    icon: '📈',
    category: 'trend',
    description: 'Golden cross SMA-7 > SMA-14. Señal de tendencia alcista confirmada.',
    default_selected: false,
  },
  {
    id: 'position_bias',
    label: 'Sesgo Posicional',
    icon: '🎯',
    category: 'structural',
    description: 'Desviación de la distribución uniforme (10%). Detecta sesgos estructurales.',
    default_selected: false,
  },
  {
    id: 'pair_correlation',
    label: 'Correlación de Par',
    icon: '🔗',
    category: 'structural',
    description: 'P(X,Y) / (P(X)×P(Y)). Dependencia real entre posiciones del par.',
    default_selected: false,
  },
  {
    id: 'fibonacci_pisano',
    label: 'Fibonacci Pisano',
    icon: '🌀',
    category: 'cyclic',
    description: 'Alineación con período de Pisano módulo 60. Detecta periodicidad oculta.',
    default_selected: false,
  },
  {
    id: 'consensus_top',
    label: 'Consenso',
    icon: '⚖️',
    category: 'meta',
    description: 'Votación ponderada de las 9 estrategias base con pesos fijos.',
    default_selected: false,
  },
];

// ─── Job tracker (en memoria — survives within process lifetime) ─
export type JobStatus = 'queued' | 'running' | 'completed' | 'error' | 'cancelled';

export interface BacktestJob {
  id:          string;
  status:      JobStatus;
  game_type:   string;
  mode:        string;
  halves:      string[];
  strategies:  string[];
  top_n:       number;
  date_from?:  string;
  date_to?:    string;
  started_at:  string;
  finished_at?: string;
  progress:    { done: number; total: number; current_strategy: string };
  results?:    PairBacktestSummary[];
  error?:      string;
  triggered_by: 'manual' | 'agent_proactive' | 'scheduled';
}

const jobs = new Map<string, BacktestJob>();
const MAX_JOBS_HISTORY = 50;

function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS_HISTORY) return;
  const sorted = [...jobs.entries()].sort((a, b) =>
    a[1].started_at.localeCompare(b[1].started_at)
  );
  for (const [id] of sorted.slice(0, jobs.size - MAX_JOBS_HISTORY)) {
    jobs.delete(id);
  }
}

// ─── Exported runner (also used by HitdashAgent proactive) ────
export async function runBacktestJob(
  engine: PairBacktestEngine,
  params: {
    game_type:    'pick3' | 'pick4';
    mode:         BacktestMode;
    strategies:   PairStrategyName[];
    top_n:        number;
    date_from?:   string;
    date_to?:     string;
    triggered_by: BacktestJob['triggered_by'];
  }
): Promise<string> {
  const job: BacktestJob = {
    id:           randomUUID(),
    status:       'queued',
    game_type:    params.game_type,
    mode:         params.mode,
    halves:       params.game_type === 'pick4' ? ['ab', 'cd'] : ['du'],
    strategies:   params.strategies,
    top_n:        params.top_n,
    date_from:    params.date_from,
    date_to:      params.date_to,
    started_at:   new Date().toISOString(),
    progress:     { done: 0, total: params.strategies.length + 1, current_strategy: '' },
    triggered_by: params.triggered_by,
  };

  jobs.set(job.id, job);
  pruneJobs();

  logger.info({ jobId: job.id, ...params }, 'BacktestJob: encolado');

  // Run async (non-blocking)
  setImmediate(async () => {
    job.status = 'running';
    try {
      const halves: PairHalf[] = params.game_type === 'pick4' ? ['ab', 'cd'] : ['du'];
      const allResults: PairBacktestSummary[] = [];

      for (const half of halves) {
        if ((job.status as string) === 'cancelled') break;
        const summaries = await engine.runAll(params.mode, params.game_type, half, {
          top_n:           params.top_n,
          date_from:       params.date_from,
          date_to:         params.date_to,
          strategy_filter: params.strategies.filter(s => s !== 'apex_adaptive'),
          on_progress:     (done, total, strategy) => {
            job.progress = { done, total, current_strategy: strategy };
          },
        });
        allResults.push(...summaries);
      }

      job.results     = allResults;
      job.status      = 'completed';
      job.finished_at = new Date().toISOString();
      logger.info({ jobId: job.id, results: allResults.length }, 'BacktestJob: completado');
    } catch (err) {
      job.status      = 'error';
      job.error       = err instanceof Error ? err.message : String(err);
      job.finished_at = new Date().toISOString();
      logger.error({ jobId: job.id, error: job.error }, 'BacktestJob: error');
    }
  });

  return job.id;
}

// ─── Router factory ───────────────────────────────────────────
export function createBacktestControlRouter(
  agentPool: Pool,
  ballbotPool: Pool
): Router {
  const router  = Router();
  const engine  = new PairBacktestEngine(ballbotPool, agentPool);

  // ── GET /strategies ──────────────────────────────────────────
  router.get('/strategies', (_req: Request, res: Response) => {
    res.json(STRATEGY_CATALOG);
  });

  // ── GET /draws/meta ──────────────────────────────────────────
  // Retorna rango de fechas disponible + total de sorteos por juego
  router.get('/draws/meta', async (_req: Request, res: Response) => {
    try {
      const { rows } = await ballbotPool.query<{
        game: string;
        period: string;
        count: string;
        date_min: string;
        date_max: string;
      }>(
        `SELECT game, period,
                COUNT(*)::text AS count,
                MIN(created_at)::date::text AS date_min,
                MAX(created_at)::date::text AS date_max
         FROM public.draws
         GROUP BY game, period
         ORDER BY game, period`
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  // ── GET /history ─────────────────────────────────────────────
  router.get('/history', (_req: Request, res: Response) => {
    const list = [...jobs.values()]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))
      .slice(0, 30)
      .map(j => ({
        id:           j.id,
        status:       j.status,
        game_type:    j.game_type,
        mode:         j.mode,
        strategies:   j.strategies,
        top_n:        j.top_n,
        date_from:    j.date_from,
        date_to:      j.date_to,
        started_at:   j.started_at,
        finished_at:  j.finished_at,
        triggered_by: j.triggered_by,
        progress:     j.progress,
        result_count: j.results?.length ?? 0,
      }));
    res.json(list);
  });

  // ── POST /run ────────────────────────────────────────────────
  router.post('/run', async (req: Request, res: Response) => {
    const {
      game_type   = 'pick3',
      mode        = 'combined',
      strategies  = STRATEGY_CATALOG.filter(s => s.default_selected).map(s => s.id),
      top_n       = 15,
      date_from,
      date_to,
    } = req.body as {
      game_type?:  string;
      mode?:       string;
      strategies?: string[];
      top_n?:      number;
      date_from?:  string;
      date_to?:    string;
    };

    const validGames   = ['pick3', 'pick4'];
    const validModes   = ['midday', 'evening', 'combined'];
    const validStrats  = new Set(STRATEGY_CATALOG.map(s => s.id));

    if (!validGames.includes(game_type))
      return res.status(400).json({ error: 'game_type inválido: pick3|pick4' });
    if (!validModes.includes(mode))
      return res.status(400).json({ error: 'mode inválido: midday|evening|combined' });
    if (!Array.isArray(strategies) || strategies.length === 0)
      return res.status(400).json({ error: 'strategies no puede ser vacío' });

    const invalidStrats = (strategies as string[]).filter(s => !validStrats.has(s as PairStrategyName));
    if (invalidStrats.length > 0)
      return res.status(400).json({ error: `Estrategias desconocidas: ${invalidStrats.join(', ')}` });

    if (typeof top_n !== 'number' || top_n < 1 || top_n > 99)
      return res.status(400).json({ error: 'top_n debe ser 1–99' });

    // Verificar que no haya un job corriendo ya para el mismo contexto
    const running = [...jobs.values()].find(
      j => j.status === 'running' && j.game_type === game_type && j.mode === mode
    );
    if (running) {
      return res.status(409).json({
        error: 'Ya hay un backtest corriendo para este contexto',
        job_id: running.id,
      });
    }

    const jobId = await runBacktestJob(engine, {
      game_type:    game_type as 'pick3' | 'pick4',
      mode:         mode as BacktestMode,
      strategies:   strategies as PairStrategyName[],
      top_n,
      date_from,
      date_to,
      triggered_by: 'manual',
    });

    logger.info({ jobId, game_type, mode, strategies, top_n }, 'BacktestControl: job lanzado manualmente');
    return res.json({ job_id: jobId, status: 'queued' });
  });

  // ── GET /status/:jobId ────────────────────────────────────────
  router.get('/status/:jobId', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params['jobId']));
    if (!job) return res.status(404).json({ error: 'Job no encontrado' });
    return res.json({
      id:           job.id,
      status:       job.status,
      progress:     job.progress,
      started_at:   job.started_at,
      finished_at:  job.finished_at,
      triggered_by: job.triggered_by,
      error:        job.error,
    });
  });

  // ── GET /results/:jobId ───────────────────────────────────────
  router.get('/results/:jobId', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params['jobId']));
    if (!job) return res.status(404).json({ error: 'Job no encontrado' });
    if (job.status !== 'completed')
      return res.status(202).json({ status: job.status, progress: job.progress });
    return res.json({
      job_id:      job.id,
      game_type:   job.game_type,
      mode:        job.mode,
      top_n:       job.top_n,
      date_from:   job.date_from,
      date_to:     job.date_to,
      started_at:  job.started_at,
      finished_at: job.finished_at,
      results:     job.results,
    });
  });

  // ── GET /cancel/:jobId ────────────────────────────────────────
  router.get('/cancel/:jobId', (req: Request, res: Response) => {
    const job = jobs.get(String(req.params['jobId']));
    if (!job) return res.status(404).json({ error: 'Job no encontrado' });
    if (job.status !== 'running' && job.status !== 'queued')
      return res.status(400).json({ error: 'Solo se puede cancelar un job running/queued' });
    job.status      = 'cancelled';
    job.finished_at = new Date().toISOString();
    return res.json({ cancelled: true });
  });

  // ── GET /adaptive-state ───────────────────────────────────────
  // Estado actual de adaptive_weights para mostrar en el panel
  router.get('/adaptive-state', async (req: Request, res: Response) => {
    const game_type = (req.query['game_type'] as string) ?? 'pick3';
    const mode      = (req.query['mode']      as string) ?? 'combined';
    try {
      const { rows } = await agentPool.query(
        `SELECT strategy, weight, top_n, hit_rate_history, updated_at::text
         FROM hitdash.adaptive_weights
         WHERE game_type = $1 AND mode = $2
         ORDER BY weight DESC`,
        [game_type, mode]
      );
      res.json(rows);
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  return router;
}
