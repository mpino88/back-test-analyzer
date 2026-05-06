// ═══════════════════════════════════════════════════════════════
// HITDASH — AgentScheduler v1.0.0
// BullMQ cron — dispara HitdashAgent antes de cada sorteo
// Florida Lottery: Midday ~12:30 PM | Evening ~7:30 PM (ET = UTC-4)
// Cron ejecuta 60 min antes para tener cartones listos a tiempo
// ═══════════════════════════════════════════════════════════════

import { Queue, Worker, type Job } from 'bullmq';
import type { Pool } from 'pg';
import pino from 'pino';
import { HitdashAgent } from './HitdashAgent.js';
import { RAGService } from '../services/RAGService.js';
import type { TelegramNotifier } from '../services/TelegramNotifier.js';
import type { GameType, DrawType } from '../types/agent.types.js';
import { CognitiveLearner } from '../learning/CognitiveLearner.js';

const logger = pino({ name: 'AgentScheduler' });

const QUEUE_NAME = 'hitdash-agent';

interface AgentJobData {
  game_type: GameType;
  draw_type: DrawType;
  draw_date: string;   // YYYY-MM-DD
  trigger: 'cron' | 'manual';
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

// ═══ BN-07 FIX: Timezone dinámica — EDT/EST correcta ═══
// Florida: EDT (UTC-4) segundo domingo de marzo → primer domingo de noviembre
//          EST (UTC-5) el resto del año
function getEasternOffsetMinutes(now: Date): number {
  const year = now.getUTCFullYear();

  // Segundo domingo de marzo (inicio DST a las 2:00 AM ET)
  const march1 = new Date(Date.UTC(year, 2, 1));
  const dstStart = new Date(Date.UTC(year, 2, 1 + (7 - march1.getUTCDay()) % 7 + 7));
  dstStart.setUTCHours(7, 0, 0, 0); // 2:00 AM EST = 07:00 UTC

  // Primer domingo de noviembre (fin DST a las 2:00 AM ET)
  const nov1 = new Date(Date.UTC(year, 10, 1));
  const dstEnd = new Date(Date.UTC(year, 10, 1 + (7 - nov1.getUTCDay()) % 7));
  dstEnd.setUTCHours(6, 0, 0, 0); // 2:00 AM EDT = 06:00 UTC

  const isEDT = now >= dstStart && now < dstEnd;
  return isEDT ? -4 * 60 : -5 * 60;
}

// Calcular próxima fecha de sorteo en formato YYYY-MM-DD
// Los sorteos de Florida son todos los días
function nextDrawDate(draw_type: DrawType): string {
  const now = new Date();
  const etOffset = getEasternOffsetMinutes(now);
  const etNow = new Date(now.getTime() + etOffset * 60_000);

  const midday  = new Date(etNow); midday.setUTCHours(12, 30, 0, 0);
  const evening = new Date(etNow); evening.setUTCHours(19, 30, 0, 0);

  let drawTime = draw_type === 'midday' ? midday : evening;

  // Si ya pasó el sorteo de hoy, usar mañana
  if (etNow >= drawTime) {
    drawTime = new Date(drawTime.getTime() + 86_400_000);
  }

  return drawTime.toISOString().split('T')[0]!;
}

export class AgentScheduler {
  private readonly queue: Queue;
  private worker: Worker | null = null;
  private notifier: TelegramNotifier | null = null;

  constructor(
    private readonly ballbotPool: Pool,
    private readonly agentPool: Pool,
    private readonly ragService: RAGService
  ) {
    this.queue = new Queue(QUEUE_NAME, { connection: redisConnection() });
  }

  /** Inject TelegramNotifier for proactive admin alerts on job failures/stalls */
  setNotifier(notifier: TelegramNotifier): void {
    this.notifier = notifier;
    logger.info('AgentScheduler: TelegramNotifier vinculado');
  }

  // ─── Registrar los 4 jobs cron (pick3+pick4 × midday+evening) ─
  async register(): Promise<void> {
    const jobs: Array<{
      name: string;
      game_type: GameType;
      draw_type: DrawType;
      // ═══ COG-02 FIX: Crons en UTC fijos que funcionan todo el año (EDT y EST)
      // Midday FL 12:30 PM ET = 16:30 UTC (EDT) = 17:30 UTC (EST) — tomamos 16:30 como balance
      // Evening FL 7:29 PM ET = 23:29 UTC (EDT) = 00:29 UTC (EST) — tomamos 23:30 UTC
      // Antes: 15:30 UTC = 11:30 AM ET en EDT (demasiado temprano, en EST = 10:30 AM)
      // Ahora: 16:30 UTC = 12:30 PM ET en EDT = 11:30 AM ET en EST (60min antes del sorteo)
      cron: string;
    }> = [
      { name: 'pick3-midday',  game_type: 'pick3', draw_type: 'midday',  cron: '30 16 * * *' },
      { name: 'pick3-evening', game_type: 'pick3', draw_type: 'evening', cron: '30 23 * * *' },
      // ═══ F12 FIX: Escalonar pick4 +5 minutos para evitar bloqueo BullMQ concurrency=1
      // Pick3 y Pick4 en el mismo cron exacto → solo 1 corre a la vez → pick4 llega tarde al sorteo
      { name: 'pick4-midday',  game_type: 'pick4', draw_type: 'midday',  cron: '35 16 * * *' },
      { name: 'pick4-evening', game_type: 'pick4', draw_type: 'evening', cron: '35 23 * * *' },
    ];

    // ── Re-aprendizaje cognitivo semanal (domingo 03:00 UTC) ─────────
    // Cada semana hay ~14 sorteos nuevos por combinación.
    // Re-ejecutar el CognitiveLearner incorpora esos sorteos al historial
    // y refina los pesos óptimos con datos frescos.
    await this.queue.upsertJobScheduler(
      'scheduler-cognitive-relearn',
      { pattern: '0 3 * * 0' }, // domingo 03:00 UTC
      {
        name: 'cognitive-relearn',
        data: { trigger: 'weekly_relearn' } as any,
        opts: {
          removeOnComplete: { count: 4 },
          removeOnFail: { count: 2 },
        },
      }
    );
    logger.info({ cron: '0 3 * * 0' }, 'CognitiveLearner: re-aprendizaje semanal registrado');

    for (const job of jobs) {
      await this.queue.upsertJobScheduler(
        `scheduler-${job.name}`,
        { pattern: job.cron },
        {
          name: 'agent-run',
          data: {
            game_type: job.game_type,
            draw_type: job.draw_type,
            // ═══ ANO-06 FIX: draw_date es calculado dinámicamente en el worker
            // NO aquí — esto se ejecutaría solo al boot, congelando la fecha.
            // Usamos un placeholder que el worker sobreescribirá en tiempo real.
            draw_date: 'dynamic',
            trigger: 'cron',
          } satisfies AgentJobData,
          opts: {
            removeOnComplete: { count: 20 },
            removeOnFail: { count: 10 },
            attempts: 2,
            backoff: { type: 'exponential', delay: 30_000 },
          },
        }
      );
      logger.info({ job: job.name, cron: job.cron }, 'Job cron registrado');
    }

    logger.info('AgentScheduler: 4 jobs cron registrados');
  }

  // ─── Iniciar el worker que procesa los jobs ───────────────────
  start(): void {
    const agent           = new HitdashAgent(this.ballbotPool, this.agentPool, this.ragService, this.notifier ?? undefined);
    const cognitiveLearner = new CognitiveLearner(this.agentPool);

    const RELEARN_COMBOS: Array<{ game_type: 'pick3'|'pick4'; draw_type: 'midday'|'evening'; half: 'du'|'ab'|'cd' }> = [
      { game_type: 'pick3', draw_type: 'midday',  half: 'du' },
      { game_type: 'pick3', draw_type: 'evening', half: 'du' },
      { game_type: 'pick4', draw_type: 'midday',  half: 'ab' },
      { game_type: 'pick4', draw_type: 'midday',  half: 'cd' },
      { game_type: 'pick4', draw_type: 'evening', half: 'ab' },
      { game_type: 'pick4', draw_type: 'evening', half: 'cd' },
    ];

    this.worker = new Worker<AgentJobData>(
      QUEUE_NAME,
      async (job: Job<AgentJobData>) => {
        // ── Re-aprendizaje cognitivo semanal ──────────────────────────
        if ((job.data as any).trigger === 'weekly_relearn') {
          logger.info('AgentScheduler: re-aprendizaje cognitivo semanal iniciado');
          for (const combo of RELEARN_COMBOS) {
            try {
              const report = await cognitiveLearner.learnFromHistory(
                combo.game_type, combo.draw_type, combo.half
              );
              logger.info(
                { ...combo, draws: report.draws_learned, hit_rate: report.holdout_hit_rate },
                'CognitiveLearner semanal: combo completado'
              );
            } catch (err) {
              logger.warn({ ...combo, error: String(err) }, 'CognitiveLearner semanal: error — continuando');
            }
            await new Promise(r => setTimeout(r, 5_000));
          }
          if (this.notifier) {
            await this.notifier.sendAdminLog(
              '🔄 *Re-aprendizaje cognitivo semanal completado*\n' +
              '6 combinaciones procesadas — pesos actualizados con historial completo.'
            ).catch(() => {});
          }
          return 'relearn-done';
        }

        const { game_type, draw_type, trigger } = job.data;
        // ═══ ANO-06 FIX: Calcular draw_date en tiempo de ejecución, NO en boot.
        // Garantiza que los cartones generados siempre tengan la fecha real de HOY.
        const draw_date = nextDrawDate(draw_type);
        logger.info({ game_type, draw_type, draw_date, trigger }, 'AgentScheduler: ejecutando job');

        const result = await agent.run({
          trigger_type: trigger === 'cron' ? 'cron' : 'manual',
          game_type,
          draw_type,
          draw_date,
        });

        // ─── Proactive backtest check post-ciclo ─────────────────────
        // Después de cada ciclo del agente, verificar si se debe lanzar
        // un backtest autónomo (>7 días sin backtest o ≥30 sorteos nuevos)
        setImmediate(async () => {
          try {
            const check = await agent.checkAndTriggerProactiveBacktest(game_type, draw_type);
            if (check.triggered) {
              logger.info(
                { game_type, draw_type, reason: check.reason, job_id: check.job_id },
                'AgentScheduler: backtest proactivo disparado post-ciclo'
              );
            }
          } catch (err) {
            logger.warn({ error: err instanceof Error ? err.message : String(err) },
              'AgentScheduler: error en proactive backtest check (no crítico)');
          }
        });

        return result;
      },
      {
        connection: redisConnection(),
        concurrency: 1, // Un análisis a la vez para no saturar la DB
      }
    );

    this.worker.on('completed', (job) => {
      logger.info({ jobId: job.id, name: job.name }, 'Job completado');
    });

    this.worker.on('failed', (job, err) => {
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.error({ jobId: job?.id, error: errMsg }, 'Job fallido');
      if (this.notifier) {
        this.notifier.notifyAgentJobFailed({
          queue: QUEUE_NAME,
          jobId: job?.id,
          game_type: (job?.data as AgentJobData | undefined)?.game_type,
          draw_type: (job?.data as AgentJobData | undefined)?.draw_type,
          error: errMsg,
        }).catch(() => {});
      }
    });

    this.worker.on('stalled', (jobId) => {
      logger.warn({ jobId }, 'Job estancado — será reintentado');
      if (this.notifier) {
        this.notifier.notifyJobStalled(QUEUE_NAME, jobId).catch(() => {});
      }
    });

    logger.info('AgentScheduler: worker iniciado');
  }

  // ─── Disparo manual (para testing / webhook / admin) ──────────
  async triggerManual(
    game_type: GameType,
    draw_type: DrawType,
    draw_date?: string
  ): Promise<string> {
    const date = draw_date ?? nextDrawDate(draw_type);
    const job = await this.queue.add(
      'agent-run',
      {
        game_type,
        draw_type,
        draw_date: date,
        trigger: 'manual',
      } satisfies AgentJobData,
      { jobId: `manual-${game_type}-${draw_type}-${Date.now()}` }
    );
    logger.info({ jobId: job.id, game_type, draw_type, date }, 'Job manual encolado');
    return job.id ?? '';
  }

  // ─── Estado de la cola ────────────────────────────────────────
  async getQueueStatus(): Promise<{
    waiting: number;
    active: number;
    completed: number;
    failed: number;
  }> {
    const [waiting, active, completed, failed] = await Promise.all([
      this.queue.getWaitingCount(),
      this.queue.getActiveCount(),
      this.queue.getCompletedCount(),
      this.queue.getFailedCount(),
    ]);
    return { waiting, active, completed, failed };
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
    logger.info('AgentScheduler detenido');
  }
}
