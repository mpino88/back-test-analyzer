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
import { createHealthRouter } from './routes/healthRouter.js';
import { createAgentRouter } from './routes/agentRouter.js';
import { createSSERouter } from './routes/sseRouter.js';
import { createBacktestControlRouter } from './routes/backtestControlRouter.js';
import { IngestionWorker } from '../agent/services/IngestionWorker.js';
import { RAGService } from '../agent/services/RAGService.js';
import { AgentScheduler } from '../agent/core/AgentScheduler.js';
import { PostDrawProcessor } from '../agent/feedback/PostDrawProcessor.js';

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
const ingestionWorker = new IngestionWorker(ballbotPool, agentPool, ragService);
const agentScheduler = new AgentScheduler(ballbotPool, agentPool, ragService);
const postDrawProcessor = new PostDrawProcessor(ballbotPool, agentPool, ragService);

// ═══ BN-01 FIX: Vincular feedback loop ═══
// IngestionWorker → PostDrawProcessor (el cable que faltaba)
ingestionWorker.setFeedbackProcessor(postDrawProcessor);

// ─── App Express ────────────────────────────────────────────────
const app = express();

app.use(cors({
  origin: process.env['CORS_ORIGIN'] ?? 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());

// Logging de requests
app.use((req, _res, next) => {
  logger.info({ method: req.method, path: req.path }, 'Request recibido');
  next();
});

// ─── Rutas ──────────────────────────────────────────────────────
app.use(createHealthRouter(agentPool, redis));
app.use('/api/agent', createAgentRouter(agentPool, agentScheduler, ballbotPool));
app.use('/api/backtest-control', createBacktestControlRouter(agentPool, ballbotPool));
app.use(createSSERouter(agentPool, redis));

// 404 handler
app.use((_req, res) => {
  res.status(404).json({ error: 'Ruta no encontrada' });
});

// Error handler
app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  logger.error({ error: err.message }, 'Error no manejado');
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
    logger.error({ error: err }, '❌ Error conectando a Redis');
    process.exit(1);
  }

  // Iniciar IngestionWorker
  await ingestionWorker.register();
  ingestionWorker.start();
  logger.info('✅ IngestionWorker iniciado');

  // Iniciar AgentScheduler (cron pre-sorteo)
  await agentScheduler.register();
  agentScheduler.start();
  logger.info('✅ AgentScheduler iniciado (4 crons: pick3+pick4 × midday+evening)');

  // Iniciar PostDrawProcessor (feedback loop)
  postDrawProcessor.start();
  logger.info('✅ PostDrawProcessor iniciado');

  app.listen(PORT, () => {
    logger.info(`🚀 Hitdash Server corriendo en puerto ${PORT}`);
    logger.info(`   Health: http://localhost:${PORT}/health`);
    logger.info(`   API:    http://localhost:${PORT}/api/agent/status`);
    logger.info(`   SSE:    http://localhost:${PORT}/events/agent-status`);
  });
}

// ─── Graceful shutdown ──────────────────────────────────────────
async function shutdown(signal: string): Promise<void> {
  logger.info({ signal }, 'Shutdown iniciado — cerrando conexiones...');
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
process.on('SIGINT', () => shutdown('SIGINT'));

start().catch(err => {
  logger.error(err, 'Error fatal al iniciar servidor');
  process.exit(1);
});
