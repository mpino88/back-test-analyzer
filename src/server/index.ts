// ═══════════════════════════════════════════════════════════════
// HITDASH — Express Server
// Puerto: 3001
// Sirve API del agente + SSE para dashboard
// ═══════════════════════════════════════════════════════════════

import express from 'express';
import cors from 'cors';
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import pino from 'pino';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createHealthRouter } from './routes/healthRouter.js';
import { createAgentRouter } from './routes/agentRouter.js';
import { createSSERouter } from './routes/sseRouter.js';
import { createBacktestControlRouter } from './routes/backtestControlRouter.js';
import { createIngestRouter } from './routes/ingestRouter.js';
import { IngestionWorker } from '../agent/services/IngestionWorker.js';
import { RAGService } from '../agent/services/RAGService.js';
import { AgentScheduler } from '../agent/core/AgentScheduler.js';
import { PostDrawProcessor } from '../agent/feedback/PostDrawProcessor.js';
import helmet from 'helmet';
import { createGlobalLimiter } from './middlewares/rateLimitMiddleware.js';
import { TelegramNotifier } from '../agent/services/TelegramNotifier.js';

const logger = pino({
  name: 'HitdashServer',
  ...(process.env['NODE_ENV'] !== 'production'
    ? { transport: { target: 'pino-pretty', options: { colorize: true } } }
    : {}),
});

const PORT = parseInt(process.env['PORT'] ?? '3001', 10);

// ─── Pools de BD ────────────────────────────────────────────────
// ballbotPool → READ-ONLY al PostgreSQL de Ballbot en Render
// agentPool   → READ-WRITE al PostgreSQL local del VPS (hitdash schema)
const ballbotPool = new Pool({
  connectionString: process.env['BALLBOT_DATABASE_URL'],
  max: 5,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
  ssl: process.env['BALLBOT_SSL'] === 'true' ? { rejectUnauthorized: false } : undefined,
});

const agentPool = new Pool({
  connectionString: process.env['AGENT_DATABASE_URL'],
  max: 10,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 5_000,
});

// ─── Redis ──────────────────────────────────────────────────────
const redis = new Redis(process.env['REDIS_URL'] ?? 'redis://localhost:6379', {
  maxRetriesPerRequest: null,
  lazyConnect: true,
});

// ─── Servicios del agente ────────────────────────────────────────
const ragService = new RAGService(agentPool);
const ingestionWorker = new IngestionWorker(ballbotPool, agentPool, redis);
const agentScheduler = new AgentScheduler(ballbotPool, agentPool, ragService);
const postDrawProcessor = new PostDrawProcessor(ballbotPool, agentPool, ragService);
const telegramNotifier = new TelegramNotifier();

// ═══ Vincular servicios entre sí ═══
ingestionWorker.setFeedbackProcessor(postDrawProcessor);
ingestionWorker.setNotifier(telegramNotifier);
agentScheduler.setNotifier(telegramNotifier);
ragService.setNotifier(telegramNotifier);
// ANO-01 FIX: Inyectar singleton de TelegramNotifier en PostDrawProcessor
postDrawProcessor.setNotifier(telegramNotifier);

// ─── SENTINEL: DB pool error events ───────────────────────
let agentDbAlive = true;
let ballbotDbAlive = true;
let redisAlive = false; // starts false, goes true on 'ready'

agentPool.on('error', (err: Error) => {
  logger.error({ error: err.message }, 'Agent DB pool error');
  if (agentDbAlive) {
    agentDbAlive = false;
    telegramNotifier.notifyDbEvent('agent', 'lost', err.message).catch(() => {});
  }
});
agentPool.on('connect', () => {
  if (!agentDbAlive) {
    agentDbAlive = true;
    telegramNotifier.notifyDbEvent('agent', 'recovered').catch(() => {});
  }
});

ballbotPool.on('error', (err: Error) => {
  logger.error({ error: err.message }, 'Ballbot DB pool error');
  if (ballbotDbAlive) {
    ballbotDbAlive = false;
    telegramNotifier.notifyDbEvent('ballbot', 'lost', err.message).catch(() => {});
  }
});
ballbotPool.on('connect', () => {
  if (!ballbotDbAlive) {
    ballbotDbAlive = true;
    telegramNotifier.notifyDbEvent('ballbot', 'recovered').catch(() => {});
  }
});

// ─── SENTINEL: Redis events ──────────────────────────────
redis.on('error', (err: Error) => {
  if (redisAlive) {
    redisAlive = false;
    telegramNotifier.notifyRedisEvent('lost', err.message).catch(() => {});
  }
});
redis.on('ready', () => {
  const wasDown = !redisAlive;
  redisAlive = true;
  if (wasDown) telegramNotifier.notifyRedisEvent('recovered').catch(() => {});
});

// ─── App Express ────────────────────────────────────────────────
const app = express();

// Confiar en el proxy inverso (Nginx/Apache en cPanel) para leer la IP real
// del cliente desde X-Forwarded-For. Sin esto, express-rate-limit lanza
// ERR_ERL_UNEXPECTED_X_FORWARDED_FOR y no puede aplicar rate limiting por IP.
app.set('trust proxy', 1);

app.use(helmet()); // Refuerzo estructural de cabeceras HTTP
app.use(createGlobalLimiter(telegramNotifier)); // Deflector Anti-Bots + Sentinel alerta Rate Limit


app.use(cors({
  origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// SENTINEL: slow endpoint detection + request logging
const SLOW_MS = 2000;
app.use((req, res, next) => {
  const t0 = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - t0;
    logger.info({ method: req.method, path: req.path, ms, status: res.statusCode }, 'Request completado');
    if (ms > SLOW_MS) {
      telegramNotifier.notifySlowEndpoint(req.method, req.path, ms).catch(() => {});
    }
  });
  next();
});

// ─── Frontend estático (Vue 3 compilado) ────────────────────────
// __dirname en runtime = dist-server/server/ → ../../dist = /app/dist
const __filename = fileURLToPath(import.meta.url);
const __dirname  = dirname(__filename);
const DIST_PATH  = join(__dirname, '../../dist');

// ─── Rutas ──────────────────────────────────────────────────────
app.use(createHealthRouter(agentPool, redis));
// ─── ball-monitor webhook — NO API key, autenticado por body.secret ──
// Ball-monitor envía el resultado del sorteo en el MISMO instante que lo detecta.
// Elimina el lag de 15 min del IngestionWorker cron. Sin cambios de red Docker.
app.use('/api/ingest', createIngestRouter(agentPool, ragService, postDrawProcessor, redis));
app.use('/api/agent', createAgentRouter(agentPool, agentScheduler, ballbotPool, redis));
app.use('/api/backtest-control', createBacktestControlRouter(agentPool, ballbotPool, redis));
app.use(createSSERouter(agentPool, redis));

// Servir assets del frontend (JS/CSS/img) con caché agresiva
app.use(express.static(DIST_PATH, { maxAge: '1d', etag: true }));

// SPA fallback: cualquier ruta no-API → index.html (Vue Router)
app.get('*', (_req, res) => {
  res.sendFile(join(DIST_PATH, 'index.html'));
});

// ─── SENTINEL: Express 500 ─────────────────────────────
app.use((err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const msg = err instanceof Error ? err.message : String(err);
  logger.error({ error: msg, path: req.path }, 'Error no manejado');
  telegramNotifier.notifyExpressError(req.method, req.path, msg).catch(() => {});
  res.status(500).json({ error: 'Error interno del servidor' });
});

// ─── Inicio ─────────────────────────────────────────────────────
async function start(): Promise<void> {
  // Verificar conexiones antes de iniciar
  try {
    await agentPool.query('SELECT 1');
    logger.info('✅ Agent PostgreSQL conectado');
  } catch (err) {
    logger.error({ error: err }, '❌ Error conectando a Agent PostgreSQL');
    process.exit(1);
  }

  try {
    await ballbotPool.query('SELECT 1');
    logger.info('✅ Ballbot PostgreSQL conectado (READ-ONLY)');
  } catch (err) {
    logger.warn({ error: err }, '⚠️  Ballbot PostgreSQL no disponible — ingesta deshabilitada');
  }

  try {
    await redis.connect();
    logger.info('✅ Redis conectado');
  } catch (err) {
    logger.warn(
      { error: err },
      '⚠️  Redis no disponible — BullMQ/Rate Limiting degradado. Para desarrollo local: brew install redis && brew services start redis',
    );
    // No hacer process.exit — el servidor puede funcionar sin Redis en modo degradado
  }

  // Iniciar workers BullMQ (requieren Redis — degradan si no está disponible)
  try {
    await ingestionWorker.register();
    ingestionWorker.start();
    logger.info('✅ IngestionWorker iniciado (safety net 2×/día: 17:30 + 02:30 UTC — webhook es el camino primario)');
  } catch (err) {
    logger.warn({ error: err }, '⚠️  IngestionWorker no iniciado — Redis requerido');
  }

  try {
    await agentScheduler.register();
    agentScheduler.start();
    logger.info('✅ AgentScheduler iniciado (4 crons: pick3+pick4 × midday+evening)');
  } catch (err) {
    logger.warn({ error: err }, '⚠️  AgentScheduler no iniciado — Redis requerido');
  }

  try {
    postDrawProcessor.start();
    logger.info('✅ PostDrawProcessor iniciado');
  } catch (err) {
    logger.warn({ error: err }, '⚠️  PostDrawProcessor no iniciado — Redis requerido');
  }

  app.listen(PORT, '0.0.0.0', async () => {
    logger.info(`🚀 Hitdash Server corriendo en puerto ${PORT}`);
    logger.info(`   Health: http://localhost:${PORT}/health`);
    logger.info(`   API:    http://localhost:${PORT}/api/agent/status`);
    logger.info(`   SSE:    http://localhost:${PORT}/events/agent-status`);

    // ─── Notificar a admins va Telegram que el servidor arrancó ───
    telegramNotifier.notifyServiceBoot({
      port: PORT,
      agentDb: true,              // ya verificado ariba — si llega acá, está ok
      ballbotDb: true,            // idem
      redis: true,
    }).catch(() => {});           // fire-and-forget — nunca bloquea el boot

    // ─── Proactive Cache Warm-up ───────────────────────────────────
    try {
      const CACHE_KEY = 'hitdash:meta:draws';
      const CACHE_TTL = 1800;
      // draw_key format: "{game}:{period}:{YYYY-MM-DD}" e.g. "p3:m:2026-03-22"
      const { rows } = await agentPool.query(
        `SELECT
           SPLIT_PART(draw_key, ':', 1)  AS game,
           SPLIT_PART(draw_key, ':', 2)  AS period,
           COUNT(*)::text                AS count,
           MIN(draw_date)::text          AS date_min,
           MAX(draw_date)::text          AS date_max
         FROM hitdash.ingested_results
         GROUP BY SPLIT_PART(draw_key, ':', 1), SPLIT_PART(draw_key, ':', 2)`
      );
      await redis.setex(CACHE_KEY, CACHE_TTL, JSON.stringify(rows));
      logger.info('✅ Metadata cache warmed up proactivamente');
    } catch (err) {
      logger.warn({ error: String(err) }, 'Warm-up de cache fallido — se cargará bajo demanda');
    }
  });
}

// ─── Graceful shutdown ──────────────────────────────────────────
let isShuttingDown = false;
async function shutdown(signal: string): Promise<void> {
  if (isShuttingDown) return;
  isShuttingDown = true;
  logger.info({ signal }, 'Shutdown iniciado — cerrando conexiones...');
  await Promise.race([
    telegramNotifier.notifyShutdown(signal).catch(() => {}),
    new Promise(r => setTimeout(r, 3000)),  // max 3s for Telegram before closing
  ]);
  await agentScheduler.stop();
  await postDrawProcessor.stop();
  await ingestionWorker.stop();
  await agentPool.end();
  await ballbotPool.end();
  await redis.quit();
  logger.info('Shutdown completado');
  process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));

// ─── SENTINEL: Unhandled errors (never let the process die silent) ───
process.on('unhandledRejection', (reason) => {
  const msg = reason instanceof Error ? reason.message : String(reason);
  logger.error({ error: msg }, 'unhandledRejection');
  telegramNotifier.notifyUnhandledError('unhandledRejection', msg).catch(() => {});
});

process.on('uncaughtException', (err: unknown) => {
  const msg = err instanceof Error ? err.message : String(err);
  const stack = err instanceof Error ? err.stack : undefined;
  logger.error({ error: msg, stack }, 'uncaughtException');
  telegramNotifier.notifyUnhandledError('uncaughtException', msg)
    .catch(() => {})
    .finally(() => process.exit(1));
});

// ─── SENTINEL: Memory watchdog every 5 minutes ─────────────
const MEM_THRESHOLD_MB = 512;
setInterval(() => {
  const heapMb = process.memoryUsage().heapUsed / 1024 / 1024;
  if (heapMb > MEM_THRESHOLD_MB) {
    logger.warn({ heapMb: heapMb.toFixed(1) }, 'Presión de memoria alta');
    telegramNotifier.notifyHighMemory(heapMb, MEM_THRESHOLD_MB).catch(() => {});
  }
}, 5 * 60 * 1000).unref();

start().catch(err => {
  logger.error(err, 'Error fatal al iniciar servidor');
  process.exit(1);
});
