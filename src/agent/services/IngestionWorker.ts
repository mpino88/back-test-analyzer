// ═══════════════════════════════════════════════════════════════
// HITDASH — IngestionWorker v2.0
// Lee lottery_results del PostgreSQL de Ballbot (READ-ONLY: BALLBOT_DATABASE_URL)
// Escribe en hitdash.rag_knowledge + hitdash.ingested_results (AGENT_DATABASE_URL)
// NO modifica ninguna tabla del schema "public" de Ballbot.
// ═══════════════════════════════════════════════════════════════

import { Queue, Worker, type Job } from 'bullmq';
import { Pool } from 'pg';
import pino from 'pino';
import { RAGService } from './RAGService.js';
import type { PostDrawProcessor } from '../feedback/PostDrawProcessor.js';
import type { LotteryDigits, GameType, DrawType } from '../types/agent.types.js';

const logger = pino({ name: 'IngestionWorker' });
const BATCH_SIZE = 20;
const QUEUE_NAME = 'hitdash-ingestion';

function parseRedisUrl(): { host: string; port: number; password?: string } {
  const url = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || '6379', 10),
    ...(parsed.password ? { password: parsed.password } : {}),
  };
}

interface IngestionJobData {
  trigger: 'cron' | 'manual' | 'webhook';
}

interface IngestionStats {
  processed: number;
  skipped: number;
  errors: number;
  duration_ms: number;
}

export class IngestionWorker {
  private readonly ballbotPool: Pool;   // READ-ONLY — Render PostgreSQL
  private readonly agentPool: Pool;     // READ-WRITE — VPS PostgreSQL
  private readonly ragService: RAGService;
  private readonly queue: Queue;
  private worker: Worker | null = null;
  private feedbackProcessor: PostDrawProcessor | null = null;

  constructor(ballbotPool: Pool, agentPool: Pool, ragService: RAGService) {
    this.ballbotPool = ballbotPool;
    this.agentPool = agentPool;
    this.ragService = ragService;

    this.queue = new Queue(QUEUE_NAME, { connection: parseRedisUrl() });
  }

  /**
   * Inject PostDrawProcessor after construction to avoid circular deps.
   * Called from server/index.ts after both services are instantiated.
   */
  setFeedbackProcessor(processor: PostDrawProcessor): void {
    this.feedbackProcessor = processor;
    logger.info('IngestionWorker: PostDrawProcessor vinculado — feedback loop ACTIVO');
  }

  // Registra el job repetible cada 15 minutos con jobId fijo (deduplicación)
  async register(): Promise<void> {
    await this.queue.upsertJobScheduler(
      'ingestion-scheduler',
      { every: 15 * 60 * 1000 }, // 15 minutos
      {
        name: 'ingest',
        data: { trigger: 'cron' } satisfies IngestionJobData,
        opts: {
          removeOnComplete: { count: 10 },
          removeOnFail: { count: 5 },
        },
      }
    );
    logger.info('IngestionWorker: job cron registrado (cada 15 min)');
  }

  // Inicia el worker que procesa los jobs de la cola
  start(): void {

    this.worker = new Worker<IngestionJobData>(
      QUEUE_NAME,
      async (job: Job<IngestionJobData>) => {
        logger.info({ trigger: job.data.trigger }, 'Iniciando ciclo de ingesta');
        return this.runIngestion();
      },
      {
        connection: parseRedisUrl(),
        concurrency: 1, // un solo job a la vez
      }
    );

    this.worker.on('completed', (job, result: IngestionStats) => {
      logger.info({
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
        duration_ms: result.duration_ms,
      }, 'Ingesta completada');
    });

    this.worker.on('failed', (job, err) => {
      logger.error({ jobId: job?.id, error: err.message }, 'Ingesta fallida');
    });

    logger.info('IngestionWorker: worker iniciado');
  }

  // Dispara una ingesta manual (webhook de Ball-monitor u otro trigger externo)
  async triggerManual(): Promise<void> {
    await this.queue.add(
      'ingest',
      { trigger: 'webhook' } satisfies IngestionJobData,
      { jobId: `manual-${Date.now()}` }
    );
    logger.info('Ingesta manual encolada');
  }

  // Verifica si hay resultados frescos (últimas 4 horas) en Ballbot
  async checkFreshness(): Promise<boolean> {
    const result = await this.ballbotPool.query<{ count: string }>(
      `SELECT COUNT(*)::text AS count FROM public.draws
       WHERE created_at > now() - interval '4 hours'`
    );
    const count = parseInt(result.rows[0]!.count, 10);
    logger.info({ fresh_count: count }, 'Freshness check completado');
    return count > 0;
  }

  private async runIngestion(): Promise<IngestionStats> {
    const startTime = Date.now();
    const stats: IngestionStats = { processed: 0, skipped: 0, errors: 0, duration_ms: 0 };

    // 1. Watermark: timestamp del último draw ingestado
    const wmResult = await this.agentPool.query<{ last_at: string | null }>(
      `SELECT MAX(ingested_at)::text AS last_at FROM hitdash.ingested_results`
    );
    const lastAt = wmResult.rows[0]?.last_at ?? '2000-01-01T00:00:00Z';

    // 2. Fetch draws de Ballbot más nuevos que el watermark
    interface DrawRow {
      game: string;
      period: string;
      date: string;
      numbers: string;
      created_at: Date;
    }
    const pending = await this.ballbotPool.query<DrawRow>(
      `SELECT game, period, date, numbers, created_at
       FROM public.draws
       WHERE created_at > $1
       ORDER BY created_at ASC
       LIMIT $2`,
      [lastAt, BATCH_SIZE]
    );

    if (pending.rows.length === 0) {
      logger.info('No hay resultados pendientes de ingesta');
      stats.duration_ms = Date.now() - startTime;
      return stats;
    }

    logger.info({ count: pending.rows.length, since: lastAt }, 'Resultados pendientes encontrados');

    // 3. Procesar cada resultado
    for (const row of pending.rows) {
      const drawKey = `${row.game}:${row.period}:${row.date}`;
      try {
        const ragKnowledgeId = await this.processResult(row);
        stats.processed++;
        logger.info({ draw_key: drawKey, rag_id: ragKnowledgeId }, 'Resultado ingestado');

        // ═══ BN-01 FIX: Disparar feedback loop autónomo ═══
        // Cada resultado nuevo activa: comparar → aprender → ajustar pesos → drift
        if (this.feedbackProcessor) {
          const parts = row.numbers.split(',').map(n => parseInt(n.trim(), 10));
          const digits: LotteryDigits = {
            p1: parts[0] ?? 0, p2: parts[1] ?? 0, p3: parts[2] ?? 0,
            ...(parts[3] !== undefined ? { p4: parts[3] } : {}),
          };
          const gameType: GameType = row.game === 'p3' ? 'pick3' : 'pick4';
          const drawType: DrawType = row.period === 'm' ? 'midday' : 'evening';
          const [mm, dd, yy] = row.date.split('/');
          const drawDate = `20${yy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;

          await this.feedbackProcessor.enqueue({
            draw_id: ragKnowledgeId,
            game_type: gameType,
            draw_type: drawType,
            draw_date: drawDate,
            actual_digits: digits,
          });
          logger.info({ draw_key: drawKey }, '🔄 Feedback encolado para PostDrawProcessor');
        }
      } catch (err) {
        stats.errors++;
        logger.error({
          draw_key: drawKey,
          error: err instanceof Error ? err.message : String(err)
        }, 'Error al ingestar resultado');
      }
    }

    // 4. Log de completado
    await this.agentPool.query(
      `INSERT INTO hitdash.agent_logs (level, metadata, created_at)
       VALUES ('info', $1, now())`,
      [JSON.stringify({ event: 'ingestion_complete', ...stats })]
    );

    stats.duration_ms = Date.now() - startTime;
    return stats;
  }

  private async processResult(row: {
    game: string; period: string; date: string; numbers: string; created_at: Date;
  }): Promise<string> {
    // Parsear numbers CSV "9,8,5" → LotteryDigits
    const parts = row.numbers.split(',').map(n => parseInt(n.trim(), 10));
    const digits: LotteryDigits = {
      p1: parts[0] ?? 0,
      p2: parts[1] ?? 0,
      p3: parts[2] ?? 0,
      ...(parts[3] !== undefined ? { p4: parts[3] } : {}),
    };

    const gameType = row.game === 'p3' ? 'pick3' : 'pick4';
    const drawType = row.period === 'm' ? 'midday' : 'evening';

    // Convertir MM/DD/YY → YYYY-MM-DD
    const [mm, dd, yy] = row.date.split('/');
    const drawDate = `20${yy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;

    const posText = gameType === 'pick3'
      ? `P1=${digits.p1} P2=${digits.p2} P3=${digits.p3}`
      : `P1=${digits.p1} P2=${digits.p2} P3=${digits.p3} P4=${digits.p4}`;

    const content = `${gameType.toUpperCase()} ${drawType} ${drawDate}: ${posText}`;
    const drawKey  = `${row.game}:${row.period}:${row.date}`;
    const source   = `draw:${drawKey}`;

    const agentClient = await this.agentPool.connect();
    try {
      await agentClient.query('BEGIN');

      const ragKnowledgeId = await this.ragService.storeKnowledge({
        content,
        category: 'pattern',
        source,
        confidence: 0.9,
        metadata: { game_type: gameType, draw_type: drawType, draw_date: drawDate, digits },
      });

      await agentClient.query(
        `INSERT INTO hitdash.ingested_results (draw_key, rag_knowledge_id)
         VALUES ($1, $2)
         ON CONFLICT (draw_key) DO NOTHING`,
        [drawKey, ragKnowledgeId]
      );

      await agentClient.query('COMMIT');
      return ragKnowledgeId;
    } catch (err) {
      await agentClient.query('ROLLBACK');
      throw err;
    } finally {
      agentClient.release();
    }
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    logger.info('IngestionWorker detenido');
  }
}
