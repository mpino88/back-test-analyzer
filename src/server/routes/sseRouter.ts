// ═══════════════════════════════════════════════════════════════
// HITDASH — SSE (Server-Sent Events) Router
// GET /events/agent-status
// Push cada 30s al dashboard — más ligero que Socket.io
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import pino from 'pino';

const logger = pino({ name: 'SSERouter' });

export function createSSERouter(agentPool: Pool, redis: Redis): Router {
  const router = Router();

  router.get('/events/agent-status', async (req: Request, res: Response) => {
    // Headers SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no'); // Caddy/nginx: no buffering
    res.flushHeaders();

    logger.info('Cliente SSE conectado');

    const sendStatus = async (): Promise<void> => {
      try {
        const [sessionRow, alertRow, ingestionRow, ragRow, cycleRow] = await Promise.all([
          agentPool.query<{ status: string; created_at: string; game_type: string; draw_type: string; model_used: string; duration_ms: number }>(
            `SELECT status, created_at::text, game_type, draw_type, model_used, duration_ms
             FROM hitdash.agent_sessions
             ORDER BY created_at DESC LIMIT 1`
          ),
          agentPool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM hitdash.proactive_alerts WHERE acknowledged = false`
          ),
          agentPool.query<{ ingested_at: string }>(
            `SELECT ingested_at::text FROM hitdash.ingested_results ORDER BY ingested_at DESC LIMIT 1`
          ),
          agentPool.query<{ count: string }>(
            `SELECT COUNT(*)::text AS count FROM hitdash.rag_knowledge`
          ),
          agentPool.query<{ created_at: string; game_type: string; draw_type: string }>(
            `SELECT created_at::text, game_type, draw_type
             FROM hitdash.agent_sessions
             WHERE status = 'completed'
             ORDER BY created_at DESC LIMIT 1`
          ),
        ]);

        const redisAlive = await redis.ping().then(() => true).catch(() => false);

        const payload = {
          online: true,
          timestamp: new Date().toISOString(),
          last_session:     sessionRow.rows[0] ?? null,
          pending_alerts:   parseInt(alertRow.rows[0]!.count, 10),
          last_ingestion:   ingestionRow.rows[0]?.ingested_at ?? null,
          rag_documents:    parseInt(ragRow.rows[0]!.count, 10),
          last_agent_cycle: cycleRow.rows[0]?.created_at ?? null,
          redis_ok:         redisAlive,
        };

        res.write(`data: ${JSON.stringify(payload)}\n\n`);
      } catch (err) {
        res.write(`data: ${JSON.stringify({ online: false, error: 'DB error' })}\n\n`);
        logger.error({ error: err }, 'Error en SSE status check');
      }
    };

    // Envío inmediato al conectar
    await sendStatus();

    // Envío periódico cada 30 segundos
    const interval = setInterval(sendStatus, 30_000);

    // Heartbeat cada 15s para mantener conexión viva (previene timeout en proxies)
    const heartbeat = setInterval(() => {
      res.write(': heartbeat\n\n');
    }, 15_000);

    // Limpiar al desconectar cliente
    req.on('close', () => {
      clearInterval(interval);
      clearInterval(heartbeat);
      logger.info('Cliente SSE desconectado');
    });
  });

  return router;
}
