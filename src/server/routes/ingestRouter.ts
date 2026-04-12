// ═══════════════════════════════════════════════════════════════
// HITDASH — Ingest Router (ball-monitor webhook)
//
// Recibe el resultado de un sorteo directamente desde ball-monitor
// en el MISMO INSTANTE en que lo detecta (sin esperar el cron de 15 min).
//
// ball-monitor envía a WEBHOOK_URL (comma-separated, con retry ×3):
//   POST /api/ingest
//   Body: { date: "MM/DD/YY", game: "p3"|"p4", period: "m"|"e",
//           numbers: "9,8,5", secret: "..." }
//
// Auth: body.secret validado contra MONITOR_WEBHOOK_SECRET.
// Si MONITOR_WEBHOOK_SECRET está vacío → el endpoint acepta todo
// (seguro por red: localhost:3005 solo alcanzable desde el host VPS).
//
// Flujo tras recibir el webhook:
//   1. Idempotency check (draw_key ya en hitdash.ingested_results?)
//   2. Parsear + normalizar fecha y dígitos
//   3. RAGService.storeKnowledge → rag_knowledge
//   4. INSERT hitdash.ingested_results (ON CONFLICT DO NOTHING)
//   5. PostDrawProcessor.enqueue → feedback loop inmediato
//   6. Redis cache invalidation
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import pino from 'pino';
import type { RAGService }          from '../../agent/services/RAGService.js';
import type { PostDrawProcessor }   from '../../agent/feedback/PostDrawProcessor.js';
import type { Redis }               from 'ioredis';
import type { GameType, DrawType, LotteryDigits } from '../../agent/types/agent.types.js';

const logger = pino({ name: 'IngestRouter' });

// ─── Payload enviado por ball-monitor ────────────────────────
interface BallMonitorPayload {
  date:    string;   // "MM/DD/YY"  e.g. "04/12/26"
  game:    string;   // "p3" | "p4"
  period:  string;   // "m"  | "e"
  numbers: string;   // "9,8,5"  or  "4,3,9,0"
  secret?: string;
}

// ─── Convertir "MM/DD/YY" → "YYYY-MM-DD" ─────────────────────
// Regla de corte: YY ≤ 30 → 20YY, YY > 30 → 19YY
function parseDrawDate(raw: string): string {
  const [mm, dd, yy] = raw.split('/');
  const yyNum   = parseInt(yy!, 10);
  const century = yyNum <= 30 ? '20' : '19';
  return `${century}${yy}-${mm!.padStart(2, '0')}-${dd!.padStart(2, '0')}`;
}

export function createIngestRouter(
  agentPool:          Pool,
  ragService:         RAGService,
  postDrawProcessor:  PostDrawProcessor,
  redis:              Redis,
): Router {
  const router = Router();

  // ── POST /api/ingest ────────────────────────────────────────
  // NO requiere X-API-Key — usa body.secret para autenticación.
  // El endpoint solo es alcanzable desde el host VPS (localhost:3005).
  router.post('/', async (req: Request, res: Response) => {
    const payload = req.body as BallMonitorPayload;

    // ── Validar secret si está configurado ───────────────────
    const expectedSecret = process.env['MONITOR_WEBHOOK_SECRET'];
    if (expectedSecret && payload.secret !== expectedSecret) {
      logger.warn({ ip: req.ip }, 'IngestRouter: secret inválido');
      res.status(401).json({ error: 'Secret inválido' });
      return;
    }

    // ── Validar campos mínimos ───────────────────────────────
    const { date, game, period, numbers } = payload;
    if (!date || !game || !period || !numbers) {
      res.status(400).json({ error: 'Campos requeridos: date, game, period, numbers' });
      return;
    }

    const gameType: GameType = game === 'p3' ? 'pick3' : 'pick4';
    const drawType: DrawType = period === 'm' ? 'midday' : 'evening';
    const drawDate = parseDrawDate(date);
    const drawKey  = `${game}:${period}:${date}`;

    logger.info({ drawKey, drawDate, gameType, drawType, numbers }, 'Webhook recibido de ball-monitor');

    try {
      // ── 1. Idempotency check ──────────────────────────────
      const { rowCount } = await agentPool.query(
        `SELECT 1 FROM hitdash.ingested_results WHERE draw_key = $1`,
        [drawKey]
      );
      if ((rowCount ?? 0) > 0) {
        logger.info({ drawKey }, 'Sorteo ya ingestado — ignorando duplicado');
        res.json({ success: true, message: 'already_ingested', draw_key: drawKey });
        return;
      }

      // ── 2. Parsear dígitos ────────────────────────────────
      const parts = numbers.split(',').map(n => parseInt(n.trim(), 10));
      const digits: LotteryDigits = {
        p1: parts[0] ?? 0,
        p2: parts[1] ?? 0,
        p3: parts[2] ?? 0,
        ...(parts[3] !== undefined ? { p4: parts[3] } : {}),
      };

      // ── 3. RAG knowledge ──────────────────────────────────
      const posText = gameType === 'pick3'
        ? `P1=${digits.p1} P2=${digits.p2} P3=${digits.p3}`
        : `P1=${digits.p1} P2=${digits.p2} P3=${digits.p3} P4=${digits.p4}`;
      const content = `${gameType.toUpperCase()} ${drawType} ${drawDate}: ${posText}`;
      const source  = `draw:${drawKey}`;

      const client = await agentPool.connect();
      let ragKnowledgeId: string;
      try {
        await client.query('BEGIN');

        ragKnowledgeId = await ragService.storeKnowledge({
          content,
          category:   'pattern',
          source,
          confidence: 0.9,
          metadata:   { game_type: gameType, draw_type: drawType, draw_date: drawDate, digits },
        });

        // ── 4. INSERT ingested_results ──────────────────────
        await client.query(
          `INSERT INTO hitdash.ingested_results
             (draw_key, rag_knowledge_id, p1, p2, p3, p4, draw_date, game_type, draw_type)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (draw_key) DO NOTHING`,
          [
            drawKey, ragKnowledgeId,
            digits.p1, digits.p2, digits.p3, digits.p4 ?? null,
            drawDate, gameType, drawType,
          ]
        );

        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      // ── 5. Trigger feedback loop ──────────────────────────
      await postDrawProcessor.enqueue({
        draw_id:       ragKnowledgeId!,
        game_type:     gameType,
        draw_type:     drawType,
        draw_date:     drawDate,
        actual_digits: digits,
      });
      logger.info({ drawKey }, '🔄 Feedback encolado via webhook');

      // ── 6. Redis cache invalidation ───────────────────────
      await redis.del('hitdash:meta:draws').catch(() => {});

      logger.info({ drawKey, gameType, drawType, drawDate }, '✅ Sorteo ingestado via webhook real-time');

      res.json({
        success:  true,
        message:  'ingested',
        draw_key: drawKey,
        draw_date: drawDate,
        game_type: gameType,
        draw_type: drawType,
      });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ drawKey, error: msg }, 'Error procesando webhook de ball-monitor');
      res.status(500).json({ error: msg });
    }
  });

  return router;
}
