// ═══════════════════════════════════════════════════════════════
// HITDASH — PostDrawProcessor v1.0.0
// Orquestador del ciclo feedback completo post-sorteo
// Trigger: IngestionWorker detecta resultado nuevo → encolado en BullMQ
// Flujo: buscar cartones pendientes → comparar → embed → evaluar → drift → alert
// ═══════════════════════════════════════════════════════════════

import { Queue, Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import pino from 'pino';

import { ResultComparator }  from './ResultComparator.js';
import { StrategyEvaluator } from './StrategyEvaluator.js';
import { LearningEmbedder }  from './LearningEmbedder.js';
import { DriftDetector }     from './DriftDetector.js';
import { RAGService }        from '../services/RAGService.js';
import { TelegramNotifier }  from '../services/TelegramNotifier.js';

import type { GameType, DrawType, LotteryDigits } from '../types/agent.types.js';

const logger = pino({ name: 'PostDrawProcessor' });

const QUEUE_NAME = 'hitdash-feedback';

interface FeedbackJobData {
  draw_id: string;
  game_type: GameType;
  draw_type: DrawType;
  draw_date: string;
  actual_digits: LotteryDigits;
}

interface CartonRow {
  id: string;
  game_type: GameType;
  carton_size: number;
  numbers: Array<{ value: string; digits: LotteryDigits }>;
  strategy_id: string | null;
}

function redisConnection(): { host: string; port: number; password?: string } {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    ...(parsed.password ? { password: parsed.password } : {}),
  };
}

export class PostDrawProcessor {
  private readonly queue: Queue;
  private worker: Worker | null = null;

  private readonly comparator:  ResultComparator;
  private readonly evaluator:   StrategyEvaluator;
  private readonly embedder:    LearningEmbedder;
  private readonly drift:       DriftDetector;
  private readonly notifier:    TelegramNotifier;

  constructor(
    private readonly ballbotPool: Pool,
    private readonly agentPool: Pool,
    ragService: RAGService
  ) {
    this.queue      = new Queue(QUEUE_NAME, { connection: redisConnection() });
    this.comparator = new ResultComparator();
    this.evaluator  = new StrategyEvaluator(agentPool);
    this.embedder   = new LearningEmbedder(agentPool, ragService);
    this.drift      = new DriftDetector(ballbotPool);
    this.notifier   = new TelegramNotifier();
  }

  // ─── Encolar feedback tras nuevo resultado ───────────────────
  async enqueue(data: FeedbackJobData): Promise<void> {
    const jobId = `feedback-${data.draw_id}-${data.game_type}-${data.draw_type}`;
    await this.queue.add('process-feedback', data, {
      jobId,
      removeOnComplete: { count: 50 },
      removeOnFail: { count: 20 },
    });
    logger.info({ jobId, game_type: data.game_type, draw_type: data.draw_type }, 'Feedback encolado');
  }

  // ─── Iniciar el worker ────────────────────────────────────────
  start(): void {
    this.worker = new Worker<FeedbackJobData>(
      QUEUE_NAME,
      async (job: Job<FeedbackJobData>) => {
        logger.info({ jobId: job.id, ...job.data }, 'PostDrawProcessor: procesando feedback');
        return this.process(job.data);
      },
      { connection: redisConnection(), concurrency: 1 }
    );

    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id }, 'Feedback procesado OK');
    });
    this.worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, error: err.message }, 'Feedback fallido');
    });

    logger.info('PostDrawProcessor: worker iniciado');
  }

  // ─── Ciclo feedback completo ──────────────────────────────────
  private async process(data: FeedbackJobData): Promise<void> {
    const { draw_id, game_type, draw_type, draw_date, actual_digits } = data;

    // ─── 1. Obtener cartones pendientes del sorteo ────────────────
    const cartonRows = await this.agentPool.query<CartonRow>(
      `SELECT id, game_type, carton_size, numbers, strategy_id
       FROM hitdash.carton_generations
       WHERE game_type  = $1
         AND draw_type  = $2
         AND draw_date  = $3
         AND result_status = 'pending'`,
      [game_type, draw_type, draw_date]
    );

    const cartones = cartonRows.rows;
    if (cartones.length === 0) {
      logger.info({ game_type, draw_type, draw_date }, 'No hay cartones pendientes para este sorteo');
      return;
    }

    logger.info({ count: cartones.length, game_type, draw_type }, 'Cartones pendientes encontrados');

    // ─── 2. Comparar cada cartón contra el resultado real ─────────
    const comparisons = this.comparator.compareMany(
      cartones.map(c => ({ ...c, numbers: c.numbers as Array<{ value: string; digits: LotteryDigits }> })),
      actual_digits,
      draw_id
    );

    // ─── 3. Persistir feedback + embeddings ──────────────────────
    const { embedded, skipped } = await this.embedder.embedMany(comparisons);
    logger.info({ embedded, skipped }, 'Feedback embeddings persistidos');

    // ─── 4. Actualizar win_rate por estrategia ────────────────────
    const byStrategy = new Map<string, typeof comparisons>();
    for (const comp of comparisons) {
      const carton = cartones.find(c => c.id === comp.carton_id);
      const stratId = carton?.strategy_id ?? 'unknown';
      const existing = byStrategy.get(stratId) ?? [];
      existing.push(comp);
      byStrategy.set(stratId, existing);
    }

    for (const [stratId, results] of byStrategy) {
      if (stratId !== 'unknown') {
        await this.evaluator.evaluate(stratId, results);
      }
    }

    await this.evaluator.rebalanceStatuses();

    // ─── 4b. Actualizar pesos adaptativos desde win_rate live ─────
    // Después de cada sorteo real, las estrategias que acertaron suben de peso
    // Factor = win_rate / median_win_rate, clamped [0.5, 2.0], EMA(α=0.15)
    await this.updateLiveAdaptiveWeights(game_type, draw_type);

    // ─── 4c. Pair hit detection + adaptive top-N live update ─────
    await this.updateLivePairHits(game_type, draw_type, draw_date, actual_digits);
    await this.updateLiveAdaptiveTopN(game_type, draw_type);

    // ─── 5. Drift detection ───────────────────────────────────────
    const driftReport = await this.drift.detect(game_type, draw_type);

    if (driftReport.detected) {
      // Persistir alerta de drift en DB
      await this.agentPool.query(
        `INSERT INTO hitdash.proactive_alerts
           (alert_type, priority, game_type, message, data)
         VALUES ('drift', 'high', $1, $2, $3)`,
        [
          game_type,
          `Drift detectado en ${driftReport.drifted_positions.join(', ')} (${game_type} ${draw_type})`,
          JSON.stringify({ drifted_positions: driftReport.drifted_positions, details: driftReport.details }),
        ]
      );

      // Notificar por Telegram
      await this.notifier.notifyAlert({
        type: 'drift',
        message: driftReport.recommendation,
        severity: 'high',
        game_type,
      });
    }

    // ─── 6. Calcular accuracy reciente y notificar si es relevante ─
    const accuracy = await this.embedder.getRecentAccuracy(30);

    // Alerta si accuracy cayó por debajo del 10% (peor que random)
    if (accuracy.total_cartones >= 10 && accuracy.hit_rate < 0.05) {
      await this.notifier.notifyAlert({
        type: 'anomaly',
        message: `Hit rate bajo: ${(accuracy.hit_rate * 100).toFixed(1)}% en los últimos 30d (${accuracy.total_cartones} cartones). Revisar algoritmos.`,
        severity: 'high',
        game_type,
      });
    }

    logger.info(
      {
        game_type, draw_type, draw_date,
        total_cartones: comparisons.length,
        hits: comparisons.filter(c => c.hits_exact > 0).length,
        drift: driftReport.detected,
        accuracy_30d: accuracy.avg_accuracy,
      },
      'PostDrawProcessor: ciclo feedback completado'
    );
  }

  // ─── Recalcular pesos adaptativos desde win_rate live ────────
  // Normaliza los win_rates actuales como factores relativos a la mediana
  // para que apex_adaptive siempre use el mejor blend disponible en tiempo real
  private async updateLiveAdaptiveWeights(game_type: GameType, draw_type: DrawType): Promise<void> {
    const EMA_ALPHA = 0.15;  // más conservador que backtest (0.25) — live tiene menos datos
    const mode = draw_type === 'midday' ? 'midday' : 'evening';

    // Leer win_rates actuales de todas las estrategias base
    const { rows } = await this.agentPool.query<{ name: string; win_rate: number; total_tests: number }>(
      `SELECT name, win_rate, total_tests
       FROM hitdash.strategy_registry
       WHERE name NOT IN ('apex_adaptive', 'consensus_top')
         AND total_tests > 0
       ORDER BY win_rate DESC`
    );

    if (rows.length === 0) return;

    // Mediana de win_rates para normalización relativa
    const sorted = [...rows].sort((a, b) => a.win_rate - b.win_rate);
    const mid = Math.floor(sorted.length / 2);
    const median = sorted.length % 2 === 0
      ? ((sorted[mid - 1]!.win_rate + sorted[mid]!.win_rate) / 2)
      : sorted[mid]!.win_rate;

    const baseMedian = median > 0 ? median : 0.01;

    for (const row of rows) {
      const rawFactor = row.win_rate / baseMedian;
      const clampedFactor = Math.max(0.5, Math.min(2.0, rawFactor));

      // Upsert con EMA — si la fila no existe, se inserta con el factor inicial
      await this.agentPool.query(
        `INSERT INTO hitdash.adaptive_weights (strategy, game_type, mode, weight, sample_size)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (strategy, game_type, mode)
         DO UPDATE SET
           weight      = $4 * ${EMA_ALPHA} + hitdash.adaptive_weights.weight * ${1 - EMA_ALPHA},
           sample_size = hitdash.adaptive_weights.sample_size + $5,
           updated_at  = now()`,
        [row.name, game_type, mode, clampedFactor, row.total_tests]
      );
    }

    logger.info({ game_type, mode, strategies: rows.length }, 'Pesos adaptativos live actualizados');
  }

  // ─── Pair hit detection (v2) ────────────────────────────────────
  // Marks backtest_points_v2 rows for today's draw as hit/miss.
  // Pick 3: actual_pair = p2p3 — checks against stored top_pairs
  // Pick 4: cross-applicable — checks XY and YX in both AB and CD
  private async updateLivePairHits(
    game_type: GameType,
    draw_type: DrawType,
    draw_date: string,
    actual_digits: LotteryDigits
  ): Promise<void> {
    // Build actual pairs for this game type
    let actualAB: string | null = null;
    let actualCD: string | null = null;
    let actualDU: string | null = null;

    if (game_type === 'pick3') {
      actualDU = `${actual_digits.p2}${actual_digits.p3}`;
    } else {
      actualAB = `${actual_digits.p1}${actual_digits.p2}`;
      actualCD = `${actual_digits.p3}${actual_digits.p4 ?? 0}`;
    }

    // Load backtest_points_v2 rows for this date (if any were persisted via PairBacktestEngine)
    const { rows } = await this.agentPool.query<{
      id: string;
      backtest_id: string;
      top_pairs: string[];
      half: string;
    }>(
      `SELECT bp.id, bp.backtest_id, bp.top_pairs, br.half
       FROM hitdash.backtest_points_v2 bp
       JOIN hitdash.backtest_results_v2 br ON br.id = bp.backtest_id
       WHERE br.game_type = $1
         AND br.mode IN ($2, 'combined')
         AND bp.eval_date = $3
         AND bp.hit_pair = false`,
      [game_type, draw_type, draw_date]
    ).catch(() => ({ rows: [] as Array<{ id: string; backtest_id: string; top_pairs: string[]; half: string }> }));

    for (const row of rows) {
      let hit = false;

      if (game_type === 'pick3' && actualDU) {
        hit = row.top_pairs.includes(actualDU);
      } else if (game_type === 'pick4' && actualAB && actualCD) {
        // Cross-applicable: XY or YX in either half counts as hit
        const candidates = new Set<string>();
        for (const pair of row.top_pairs) {
          candidates.add(pair);
          candidates.add(`${pair[1]}${pair[0]}`); // inverted
        }
        hit = candidates.has(actualAB) || candidates.has(actualCD);
      }

      if (hit) {
        await this.agentPool.query(
          `UPDATE hitdash.backtest_points_v2 SET hit_pair = true WHERE id = $1`,
          [row.id]
        ).catch(() => undefined);
      }
    }

    logger.info(
      { game_type, draw_type, draw_date, checked: rows.length },
      'Pair hit detection completado'
    );
  }

  // ─── Live adaptive top-N update ─────────────────────────────────
  // Computes rolling hit_rate over last 20 eval points per strategy,
  // then applies the same updateTopN logic as PairBacktestEngine.
  private async updateLiveAdaptiveTopN(game_type: GameType, draw_type: DrawType): Promise<void> {
    const DEFAULT_TOP_N = 15;
    const MIN_TOP_N = 3;
    const MAX_TOP_N = 50;
    const mode = draw_type as string;

    // Load all strategies with backtest_results_v2 entries
    const { rows: strategies } = await this.agentPool.query<{
      strategy_name: string;
      id: string;
    }>(
      `SELECT DISTINCT strategy_name, id
       FROM hitdash.backtest_results_v2
       WHERE game_type = $1 AND mode IN ($2, 'combined')`,
      [game_type, draw_type]
    ).catch(() => ({ rows: [] as Array<{ strategy_name: string; id: string }> }));

    for (const { strategy_name, id: backtest_id } of strategies) {
      // Last 20 eval points for this strategy
      const { rows: pts } = await this.agentPool.query<{ hit_pair: boolean }>(
        `SELECT hit_pair FROM hitdash.backtest_points_v2
         WHERE backtest_id = $1
         ORDER BY draw_index DESC LIMIT 20`,
        [backtest_id]
      ).catch(() => ({ rows: [] as Array<{ hit_pair: boolean }> }));

      if (pts.length < 5) continue; // not enough data

      const hitRate = pts.filter(p => p.hit_pair).length / pts.length;

      // Load current top_n + hit_rate_history from adaptive_weights
      const { rows: aw } = await this.agentPool.query<{
        top_n: number;
        hit_rate_history: number[];
      }>(
        `SELECT top_n, hit_rate_history
         FROM hitdash.adaptive_weights
         WHERE strategy = $1 AND game_type = $2 AND mode = $3
         LIMIT 1`,
        [strategy_name, game_type, mode]
      ).catch(() => ({ rows: [] as Array<{ top_n: number; hit_rate_history: number[] }> }));

      const currentTopN = aw[0]?.top_n ?? DEFAULT_TOP_N;
      const history     = (aw[0]?.hit_rate_history ?? []) as number[];

      // Apply same adaptive logic as PairBacktestEngine.updateTopN()
      const newHistory = [...history, hitRate].slice(-10);
      let newTopN = currentTopN;
      if (newHistory.length >= 3) {
        const last3 = newHistory.slice(-3);
        if (last3.every(r => r > 0.20))     newTopN = Math.max(MIN_TOP_N, newTopN - 2);
        else if (last3.some(r => r < 0.10)) newTopN = Math.min(MAX_TOP_N, newTopN + 3);
      }

      await this.agentPool.query(
        `INSERT INTO hitdash.adaptive_weights (strategy, game_type, mode, top_n, hit_rate_history)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (strategy, game_type, mode)
         DO UPDATE SET
           top_n             = $4,
           hit_rate_history  = $5,
           updated_at        = now()`,
        [strategy_name, game_type, mode, newTopN, JSON.stringify(newHistory)]
      ).catch(() => undefined);
    }

    logger.info({ game_type, draw_type, strategies: strategies.length }, 'Adaptive top-N live actualizado');
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    logger.info('PostDrawProcessor detenido');
  }
}
