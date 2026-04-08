// ═══════════════════════════════════════════════════════════════
// HITDASH — backtestJobRunner
// Módulo neutral compartido entre HitdashAgent (agent layer) y
// backtestControlRouter (server layer).
// Contiene: STRATEGY_CATALOG, BacktestJob, runBacktestJob()
// ═══════════════════════════════════════════════════════════════

import pino from 'pino';
import { randomUUID } from 'crypto';
import { PairBacktestEngine, type PairStrategyName } from './PairBacktestEngine.js';
import type { BacktestMode } from './BacktestEngine.js';
import type { PairHalf, PairBacktestSummary } from '../types/analysis.types.js';

const logger = pino({ name: 'BacktestJobRunner' });

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
  id:           string;
  status:       JobStatus;
  game_type:    string;
  mode:         string;
  halves:       string[];
  strategies:   string[];
  top_n:        number;
  date_from?:   string;
  date_to?:     string;
  started_at:   string;
  finished_at?: string;
  progress:     { done: number; total: number; current_strategy: string };
  results?:     PairBacktestSummary[];
  error?:       string;
  triggered_by: 'manual' | 'agent_proactive' | 'scheduled';
}

export const jobs = new Map<string, BacktestJob>();
const MAX_JOBS_HISTORY = 50;

export function pruneJobs(): void {
  if (jobs.size <= MAX_JOBS_HISTORY) return;
  const sorted = [...jobs.entries()].sort((a, b) =>
    a[1].started_at.localeCompare(b[1].started_at)
  );
  for (const [id] of sorted.slice(0, jobs.size - MAX_JOBS_HISTORY)) {
    jobs.delete(id);
  }
}

// ─── Exported runner (used by backtestControlRouter + HitdashAgent) ─
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
