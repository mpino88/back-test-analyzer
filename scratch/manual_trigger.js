
import { Pool } from 'pg';
import { Redis } from 'ioredis';
import { IngestionWorker } from '../src/agent/services/IngestionWorker.js';
import { RAGService } from '../src/agent/services/RAGService.js';
import { PostDrawProcessor } from '../src/agent/feedback/PostDrawProcessor.js';
import { TelegramNotifier } from '../src/agent/notifications/TelegramNotifier.js';
import dotenv from 'dotenv';
dotenv.config();

async function runManualCycle() {
  const agentPool = new Pool({ connectionString: process.env.AGENT_DATABASE_URL });
  const ballbotPool = new Pool({ 
    connectionString: process.env.BALL_DATABASE_URL || process.env.BALLBOT_DATABASE_URL,
    ssl: { rejectUnauthorized: false }
  });
  const redis = new Redis(process.env.REDIS_URL);
  
  const notifier = TelegramNotifier.getInstance();
  const rag = new RAGService(agentPool);
  rag.setNotifier(notifier);
  
  const processor = new PostDrawProcessor(agentPool, ballbotPool);
  processor.setNotifier(notifier);
  
  const worker = new IngestionWorker(ballbotPool, agentPool, rag);
  worker.setPostProcessor(processor);
  worker.setNotifier(notifier);

  console.log('--- INICIANDO CICLO MANUAL DE AUDITORÍA ---');
  await worker.runIngestion();
  console.log('--- CICLO COMPLETADO ---');
  
  await agentPool.end();
  await ballbotPool.end();
  redis.disconnect();
}

runManualCycle().catch(console.error);
