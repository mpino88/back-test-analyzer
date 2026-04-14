// ═══════════════════════════════════════════════════════════════
// HITDASH — IngestionWorker v2.0
// Lee lottery_results del PostgreSQL de Ballbot (READ-ONLY: BALLBOT_DATABASE_URL)
// Escribe en hitdash.rag_knowledge + hitdash.ingested_results (AGENT_DATABASE_URL)
// NO modifica ninguna tabla del schema "public" de Ballbot.
// ═══════════════════════════════════════════════════════════════

import { Queue, Worker, type Job } from 'bullmq';
import { Pool } from 'pg';
import pino from 'pino';
import type { PostDrawProcessor } from '../feedback/PostDrawProcessor.js';
import type { TelegramNotifier } from './TelegramNotifier.js';
import type { LotteryDigits, GameType, DrawType } from '../types/agent.types.js';
import type { Redis } from 'ioredis';

const logger = pino({ name: 'IngestionWorker' });
// ═══ F04 FIX: BATCH_LIMIT 20 → 200 para cubrir gaps de hasta ~100 días sin pérdida de datos.
// Con LIMIT=20 y 2 sorteos/día × 2 juegos = sistema pierde datos silenciosamente tras 5 días offline.
// 200 draws = ~50 días de cobertura por ciclo de 15 min. Si el gap es mayor, ver `backfill-ultra.cjs`.
const BATCH_LIMIT = 200;
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
  private readonly redis: Redis;
  private readonly queue: Queue;
  private worker: Worker | null = null;
  private feedbackProcessor: PostDrawProcessor | null = null;
  private notifier: TelegramNotifier | null = null;

  constructor(ballbotPool: Pool, agentPool: Pool, redis: Redis) {
    this.ballbotPool = ballbotPool;
    this.agentPool = agentPool;
    this.redis = redis;

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

  /**
   * Inject TelegramNotifier for proactive admin service logs.
   * Called from server/index.ts after server boots successfully.
   */
  setNotifier(notifier: TelegramNotifier): void {
    this.notifier = notifier;
    logger.info('IngestionWorker: TelegramNotifier vinculado — logs de servicio ACTIVOS');
  }

  // ═══════════════════════════════════════════════════════════════
  // ARQUITECTURA CORRECTA — Safety Net 2×/día
  // ─────────────────────────────────────────────────────────────
  // ball-monitor ya envía cada sorteo via webhook POST /api/ingest
  // en el instante exacto en que lo detecta → ingesta real-time.
  //
  // El IngestionWorker ya NO necesita correr cada 15 min (96×/día).
  // Su único rol ahora es: fallback de reconciliación si el webhook
  // falla (crash de ball-monitor, error de red, proceso caído).
  //
  // Horarios de sorteo Florida (ET):
  //   Midday:  ~12:30 PM ET = 17:00 UTC (EDT) / 18:00 UTC (EST)
  //   Evening: ~21:45 ET   = 02:15 UTC+1 (EDT) / 03:15 UTC+1 (EST)
  //
  // Safety net: 30 minutos después de cada draw time esperado:
  //   Post-Midday:  17:30 UTC — si webhook falló, catch aquí
  //   Post-Evening: 02:30 UTC — si webhook falló, catch aquí
  // ═══════════════════════════════════════════════════════════════
  async register(): Promise<void> {
    // Eliminar el scheduler de 15 minutos si aún existía en Redis
    await this.queue.removeJobScheduler('ingestion-scheduler').catch(() => {});

    // Post-Midday safety net — 17:30 UTC (12:30 PM EDT / 11:30 AM EST)
    await this.queue.upsertJobScheduler(
      'ingestion-post-midday',
      { pattern: '30 17 * * *' },
      {
        name: 'ingest',
        data: { trigger: 'cron' } satisfies IngestionJobData,
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 3 } },
      }
    );

    // Post-Evening safety net — 02:30 UTC (21:30 ET siguiente día)
    await this.queue.upsertJobScheduler(
      'ingestion-post-evening',
      { pattern: '30 2 * * *' },
      {
        name: 'ingest',
        data: { trigger: 'cron' } satisfies IngestionJobData,
        opts: { removeOnComplete: { count: 5 }, removeOnFail: { count: 3 } },
      }
    );

    logger.info('IngestionWorker: safety net 2×/día registrado (17:30 UTC + 02:30 UTC)');
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
        concurrency: 1, // un solo job a la vez — safety net, no compite con webhook
      }
    );

    this.worker.on('completed', (_job, result: IngestionStats) => {
      logger.info({
        processed: result.processed,
        skipped: result.skipped,
        errors: result.errors,
        duration_ms: result.duration_ms,
      }, 'Ingesta completada');

      // ─── Notificación proactiva a admins ──────────────────────
      if (this.notifier && result.processed > 0) {
        const emoji = result.errors > 0 ? '⚠️' : '✅';
        const msg = [
          `${emoji} *HITDASH — Ingesta completada*`,
          `📥 Sorteos nuevos: *${result.processed}*`,
          result.skipped > 0  ? `⏭ Saltados: ${result.skipped}` : '',
          result.errors > 0   ? `❌ Errores: ${result.errors}` : '',
          `⏱ Duración: ${result.duration_ms}ms`,
          `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
        ].filter(Boolean).join('\n');
        this.notifier.sendAdminLog(msg).catch(() => {});
      }
    });

    this.worker.on('failed', (job, err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ jobId: job?.id, error: errMsg }, 'Ingesta fallida');

      // ─── Notificación de fallo crítico a admins ───────────────
      if (this.notifier) {
        const msg = [
          `🔴 *HITDASH — Ingesta FALLIDA*`,
          `❌ Error: ${String(errMsg).slice(0, 200)}`,
          `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
        ].join('\n');
        this.notifier.sendAdminLog(msg).catch(() => {});
      }
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

    // ═══ COG-05 FIX: Activar freshness check — jamás había sido invocado.
    // Si Ballbot no recibe sorteos por >8 horas, alertar via Sentinel.
    const fresh = await this.checkFreshness();
    if (!fresh && this.notifier) {
      this.notifier.sendAdminLog(
        `⚠️ *HITDASH — Data Staleness Detectada*\n` +
        `🕗 Sin sorteos nuevos en Ballbot (>4 horas)\n` +
        `🔧 Verificar scraper de Florida Lottery\n` +
        `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`
      ).catch(() => {});
    }

    // ═══ ANO-NEW-04 FIX: Timezone mismatch & Infinite Loop
    // Antes: se comparaba MAX(ingested_at) local vs created_at de Ballbot (con TZ distinto).
    // Esto causaba que `created_at > lastAt` siempre fuera true para sorteos en UTC,
    // procesando los mismos sorteos una y otra vez cada 15 mins (y duplicando RAG patterns).
    // Ahora: Traemos los últimos N sorteos de Ballbot y filtramos explícitamente por draw_key original.

    // BATCH_LIMIT usa constante global (200) — no redefinir localmente
    interface DrawRow {
      game: string;
      period: string;
      date: string;
      numbers: string;
      created_at: Date;
    }

    const { rows: recentDraws } = await this.ballbotPool.query<DrawRow>(
      `SELECT game, period, date, numbers, created_at
       FROM public.draws
       ORDER BY created_at DESC
       LIMIT $1`,
      [BATCH_LIMIT]
    );

    if (recentDraws.length === 0) {
      logger.info('No hay resultados en Ballbot');
      stats.duration_ms = Date.now() - startTime;
      return stats;
    }

    // Process oldest first
    recentDraws.reverse();

    const pending: DrawRow[] = [];
    for (const row of recentDraws) {
      const drawKey = `${row.game}:${row.period}:${row.date}`;
      const { rowCount } = await this.agentPool.query(
        `SELECT 1 FROM hitdash.ingested_results WHERE draw_key = $1`,
        [drawKey]
      );
      if (rowCount === 0) {
        pending.push(row);
      }
    }

    if (pending.length === 0) {
      logger.info('No hay resultados pendientes de ingesta tras filtrar');
      stats.duration_ms = Date.now() - startTime;
      return stats;
    }

    logger.info({ count: pending.length }, 'Resultados pendientes encontrados');

    // 3. Procesar cada resultado
    for (const row of pending) {
      const drawKey = `${row.game}:${row.period}:${row.date}`;
      try {
        await this.processResult(row);
        stats.processed++;
        logger.info({ draw_key: drawKey }, 'Resultado ingestado');

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
            draw_id: drawKey,
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

    // 4. Invalidez de cache — si hubo algo nuevo, el dashboard debe refrescar metadatos
    if (stats.processed > 0) {
      await this.redis.del('hitdash:meta:draws').catch(() => {});
      logger.info('Cache de metadatos invalidado tras ingesta exitosa');
    }

    // 5. Log de completado
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
    // Regla de corte: YY <= 30 → 20YY (2000-2030), YY > 30 → 19YY (1931-1999)
    // Evita que datos históricos de los 90s se almacenen como 2092.
    const [mm, dd, yy] = row.date.split('/');
    const yyNum   = parseInt(yy!, 10);
    const century = yyNum <= 30 ? '20' : '19';
    const drawDate = `${century}${yy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;

    const drawKey = `${row.game}:${row.period}:${row.date}`;

    // Sorteos van SOLO a ingested_results (datos tabulares, query SQL).
    // NO se embiden en rag_knowledge — datos numéricos sin semántica narrativa
    // no aportan valor al vector search y contaminan el contexto del chat.
    await this.agentPool.query(
      `INSERT INTO hitdash.ingested_results
        (draw_key, p1, p2, p3, p4, draw_date, game_type, draw_type)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (draw_key) DO UPDATE SET
          p1 = EXCLUDED.p1,
          p2 = EXCLUDED.p2,
          p3 = EXCLUDED.p3,
          p4 = EXCLUDED.p4,
          draw_date = EXCLUDED.draw_date,
          game_type = EXCLUDED.game_type,
          draw_type = EXCLUDED.draw_type`,
      [drawKey, digits.p1, digits.p2, digits.p3, digits.p4 ?? null, drawDate, gameType, drawType]
    );
    return drawKey;
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    logger.info('IngestionWorker detenido');
  }
}
