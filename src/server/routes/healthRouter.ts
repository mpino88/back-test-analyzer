// ═══════════════════════════════════════════════════════════════
// HITDASH — Health Endpoint
// GET /health → responde en <200ms
// Monitoreado por UptimeRobot
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import type { Redis } from 'ioredis';
import type { HealthStatus } from '../../agent/types/agent.types.js';

export function createHealthRouter(agentPool: Pool, redis: Redis): Router {
  const router = Router();

  router.get('/health', async (_req: Request, res: Response) => {
    const health: HealthStatus = {
      status: 'ok',
      timestamp: new Date().toISOString(),
      checks: {
        database: { ok: false, latency_ms: 0 },
        redis: { ok: false, latency_ms: 0 },
        rag_count: 0,
        last_agent_cycle: null,
        last_ingestion: null,
      },
    };

    // Check PostgreSQL (agentPool — VPS local)
    try {
      const dbStart = Date.now();
      const result = await Promise.race([
        agentPool.query<{ count: string; oldest: string | null }>(
          `SELECT
             (SELECT COUNT(*)::text FROM hitdash.rag_knowledge) AS count,
             (SELECT MAX(ingested_at)::text FROM hitdash.ingested_results) AS oldest`
        ),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('DB timeout')), 2000)
        ),
      ]);
      health.checks.database = { ok: true, latency_ms: Date.now() - dbStart };
      health.checks.rag_count = parseInt(result.rows[0]!.count, 10);
      health.checks.last_ingestion = result.rows[0]!.oldest ?? null;
    } catch {
      health.checks.database = { ok: false, latency_ms: 0 };
      health.status = 'degraded';
    }

    // Check Redis
    try {
      const redisStart = Date.now();
      await Promise.race([
        redis.ping(),
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('Redis timeout')), 1000)
        ),
      ]);
      health.checks.redis = { ok: true, latency_ms: Date.now() - redisStart };
    } catch {
      health.checks.redis = { ok: false, latency_ms: 0 };
      health.status = health.status === 'ok' ? 'degraded' : health.status;
    }

    // Último ciclo del agente
    try {
      const session = await agentPool.query<{ created_at: string }>(
        `SELECT created_at::text FROM hitdash.agent_sessions
         WHERE status = 'completed'
         ORDER BY created_at DESC LIMIT 1`
      );
      health.checks.last_agent_cycle = session.rows[0]?.created_at ?? null;
    } catch {
      // no crítico
    }

    // Si DB está caída: status = 'down'
    if (!health.checks.database.ok && !health.checks.redis.ok) {
      health.status = 'down';
    }

    const httpStatus = health.status === 'ok' ? 200 : health.status === 'degraded' ? 200 : 503;
    res.status(httpStatus).json(health);
  });

  return router;
}
