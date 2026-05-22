// ═══════════════════════════════════════════════════════════════
// HELIX — Alliance Router v1.0.0 (2026-05-22)
//
// Endpoint de ALIANZA BALLBOT ↔ HELIX ↔ CEREBRO F1.
//
// Flujo:
//   1. Ballbot llama POST /api/alliance/ballbot/predict con user_id + combo
//   2. HELIX ejecuta pipeline v2 completo (Cerebro F1)
//   3. Auto-issue Truth Certificate firmado para esa predicción
//   4. Devuelve { pairs, certificate_id, verify_url, disclosure }
//   5. Ballbot muestra badge "🔐 Verified by HELIX" en su UI
//   6. Usuario click → /verify?id=TC-... → ve disclosure honesto
//
// Cuando draw real ocurre:
//   1. PostDrawProcessor resuelve cert via resolveCertificate()
//   2. Webhook → Ballbot {{BALLBOT_WEBHOOK_URL}}/cert-resolved
//   3. Ballbot notifica al usuario con outcome firmado
//
// FILOSOFÍA:
//   No vendemos edge. Vendemos auditoría matemática verificable.
//   Cada predicción es un acto de transparencia, no de promesa.
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'AllianceRouter' });

// Public verify base URL — cambiar a dominio prod si difiere
const PUBLIC_VERIFY_BASE =
  process.env['HELIX_PUBLIC_VERIFY_BASE'] ?? 'https://dash.ballbot.tel/verify';

export function createAllianceRouter(agentPool: Pool): Router {
  const router = Router();

  // ─────────────────────────────────────────────────────────────
  // POST /api/alliance/ballbot/predict
  // Endpoint principal de la alianza. Ballbot llama esto y recibe
  // predicción + cert ya emitido.
  // ─────────────────────────────────────────────────────────────
  router.post('/ballbot/predict', async (req: Request, res: Response) => {
    try {
      const {
        user_id,        // ID del usuario Ballbot
        game_type,      // 'pick3' | 'pick4'
        draw_type,      // 'midday' | 'evening'
        half,           // 'du' | 'ab' | 'cd'
        draw_date,      // YYYY-MM-DD
        top_n,          // default 15
      } = req.body ?? {};

      // Validation
      if (!user_id || !game_type || !draw_type || !half || !draw_date) {
        res.status(400).json({
          error: 'Faltan campos requeridos',
          required: ['user_id', 'game_type', 'draw_type', 'half', 'draw_date'],
        });
        return;
      }

      const validGames  = ['pick3', 'pick4'];
      const validDraws  = ['midday', 'evening'];
      const validHalves = ['du', 'ab', 'cd'];
      if (!validGames.includes(game_type) ||
          !validDraws.includes(draw_type) ||
          !validHalves.includes(half)) {
        res.status(400).json({ error: 'Parámetros inválidos' });
        return;
      }

      const effectiveTopN = Math.min(Math.max(Number(top_n ?? 15), 5), 50);

      // 1. Pipeline HELIX v2 completo via HelixV2Engine
      const { HelixV2Engine } = await import('../../agent/services/HelixV2Engine.js');
      const engine = new HelixV2Engine(agentPool);

      let prediction;
      try {
        prediction = await engine.predict(
          game_type, draw_type, half, draw_date,
        );
      } catch (predictErr) {
        logger.error({ err: predictErr, user_id }, 'alliance/predict: HelixV2Engine.predict failed');
        // Fallback: query last pair_recommendations
        const { rows } = await agentPool.query<{ pairs: string[] }>(
          `SELECT pairs FROM hitdash.pair_recommendations
           WHERE game_type=$1 AND draw_type=$2 AND half=$3 AND draw_date=$4
           ORDER BY created_at DESC LIMIT 1`,
          [game_type, draw_type, half, draw_date],
        );
        if (rows.length === 0) {
          res.status(503).json({
            error: 'No hay predicción disponible para esta combo/fecha',
            user_id, game_type, draw_type, half, draw_date,
          });
          return;
        }
        prediction = { top_pairs: rows[0]!.pairs, apex_algo: null };
      }

      const predictedTop = (prediction as any).top_pairs ?? (prediction as any).predicted_top ?? [];
      const algoUsed     = (prediction as any).apex_algo ?? (prediction as any).algo_used ?? null;

      // 2. Auto-issue Truth Certificate
      const { TruthCertificateService } = await import('../../agent/services/TruthCertificateService.js');
      const certSvc = new TruthCertificateService(agentPool);
      const cert = await certSvc.issueCertificate({
        game_type, draw_type, half, draw_date,
        predicted_top: predictedTop,
        algo_used: algoUsed,
        prediction_id: undefined, // optional FK if we link to pair_recommendations
      });

      // 3. Persistir vínculo con user_id (audit trail cross-product)
      // jsonb_set requiere que el path padre exista. Usamos || (concat) para
      // crear/mergear el objeto alliance si no existe.
      try {
        await agentPool.query(
          `UPDATE hitdash.truth_certificates
              SET payload_json = payload_json
                || jsonb_build_object('alliance', jsonb_build_object('user_id', $2::text, 'linked_at', now()))
            WHERE certificate_id = $1`,
          [cert.certificate_id, String(user_id)],
        );
      } catch (linkErr) {
        // Non-fatal: cert ya emitido
        logger.warn({ err: linkErr, cert_id: cert.certificate_id }, 'alliance: failed to link user_id');
      }

      // 4. Response payload optimizado para Ballbot UI
      res.json({
        success: true,
        user_id,
        prediction: {
          game_type, draw_type, half, draw_date,
          pairs: predictedTop,
          top_n: predictedTop.length,
          algo_used: algoUsed,
        },
        certificate: {
          id:           cert.certificate_id,
          verify_url:   `${PUBLIC_VERIFY_BASE}?id=${cert.certificate_id}`,
          signature:    cert.signature,
          algorithm:    cert.algorithm,
          // Stats inline para UI rápida (sin redownload)
          hit_rate_wf:  cert.statistics.hit_rate_walk_forward,
          wilson_lo:    cert.statistics.wilson_95_ci_lo,
          wilson_hi:    cert.statistics.wilson_95_ci_hi,
          edge_x:       cert.statistics.edge_multiplier,
        },
        disclosure: cert.disclosure,
        audit_summary: {
          edge_discovery_run: cert.audit.last_edge_discovery_run_id,
          n_tests_total:      cert.audit.n_tests_total,
          n_tests_significant:cert.audit.n_tests_significant,
        },
      });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'alliance/predict failed');
      res.status(500).json({ error: 'Error en predicción', details: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // POST /api/alliance/ballbot/resolve-day
  // Batch resolve TODOS los certificates con draw_date dado.
  // Llamado por PostDrawProcessor (interno) o cron de Ballbot.
  // Emite webhook por cada cert resuelto.
  // ─────────────────────────────────────────────────────────────
  router.post('/ballbot/resolve-day', async (req: Request, res: Response) => {
    try {
      const { draw_date, outcomes } = req.body ?? {};
      // outcomes: { 'pick3:evening:du': '47', 'pick4:evening:ab': '23', ... }

      if (!draw_date || !outcomes || typeof outcomes !== 'object') {
        res.status(400).json({ error: 'draw_date + outcomes requeridos' });
        return;
      }

      // 1. Get all unresolved certs for this date
      const { rows: pending } = await agentPool.query<{
        certificate_id: string; game_type: string; draw_type: string; half: string;
        payload_json: any;
      }>(
        `SELECT certificate_id, game_type, draw_type, half, payload_json
         FROM hitdash.truth_certificates
         WHERE draw_date = $1 AND resolved_at IS NULL`,
        [draw_date],
      );

      const { TruthCertificateService } = await import('../../agent/services/TruthCertificateService.js');
      const certSvc = new TruthCertificateService(agentPool);

      const webhookUrl = process.env['BALLBOT_WEBHOOK_URL'];
      const resolutions: Array<Record<string, unknown>> = [];

      for (const p of pending) {
        const key = `${p.game_type}:${p.draw_type}:${p.half}`;
        const actual = (outcomes as Record<string, string>)[key];
        if (!actual) continue;

        await certSvc.resolveCertificate(p.certificate_id, actual);

        // Re-query to get hit status
        const { rows: resolved } = await agentPool.query<{ hit: boolean; predicted_top: string[] }>(
          `SELECT hit, predicted_top FROM hitdash.truth_certificates WHERE certificate_id=$1`,
          [p.certificate_id],
        );
        if (resolved[0]) {
          const userId = p.payload_json?.alliance?.user_id ?? null;
          const resolution = {
            certificate_id: p.certificate_id,
            user_id:        userId,
            game_type:      p.game_type,
            draw_type:      p.draw_type,
            half:           p.half,
            draw_date,
            actual_pair:    actual,
            hit:            resolved[0].hit,
            verify_url:     `${PUBLIC_VERIFY_BASE}?id=${p.certificate_id}`,
          };
          resolutions.push(resolution);

          // Fire-and-forget webhook to Ballbot
          if (webhookUrl && userId) {
            fetch(`${webhookUrl}/cert-resolved`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(resolution),
            }).catch(webhookErr => {
              logger.warn({ err: webhookErr, cert_id: p.certificate_id }, 'webhook to Ballbot failed (non-fatal)');
            });
          }
        }
      }

      logger.info({ draw_date, resolved: resolutions.length, pending: pending.length }, '🔗 Alliance: batch resolution');

      res.json({
        success: true,
        draw_date,
        n_certs_resolved: resolutions.length,
        n_certs_pending:  pending.length - resolutions.length,
        resolutions,
      });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'alliance/resolve-day failed');
      res.status(500).json({ error: 'Error', details: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/alliance/ballbot/user/:user_id/certs
  // Devuelve TODOS los certs emitidos para un usuario Ballbot.
  // Para mostrar histórico en su perfil.
  // ─────────────────────────────────────────────────────────────
  router.get('/ballbot/user/:user_id/certs', async (req: Request, res: Response) => {
    try {
      const userId = String(req.params.user_id);
      const limit  = Math.min(Number(req.query.limit ?? 50), 200);

      const { rows } = await agentPool.query(
        `SELECT certificate_id, game_type, draw_type, half, draw_date,
                predicted_n, hit_rate_wf, wilson_lo, wilson_hi, edge_multiplier,
                hit, resolved_at, generated_at
         FROM hitdash.truth_certificates
         WHERE payload_json->'alliance'->>'user_id' = $1
         ORDER BY generated_at DESC
         LIMIT $2`,
        [userId, limit],
      );

      const resolved = rows.filter(r => r.hit !== null);
      const hits = resolved.filter(r => r.hit === true).length;

      res.json({
        user_id: userId,
        total_certs:    rows.length,
        resolved_certs: resolved.length,
        user_accuracy:  resolved.length > 0 ? hits / resolved.length : null,
        certificates:   rows.map(r => ({
          ...r,
          verify_url: `${PUBLIC_VERIFY_BASE}?id=${r.certificate_id}`,
        })),
      });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'alliance/user-certs failed');
      res.status(500).json({ error: 'Error', details: err instanceof Error ? err.message : String(err) });
    }
  });

  // ─────────────────────────────────────────────────────────────
  // GET /api/alliance/ballbot/stats
  // Stats agregadas de la alianza — para dashboard B2B/admin.
  // ─────────────────────────────────────────────────────────────
  router.get('/ballbot/stats', async (_req: Request, res: Response) => {
    try {
      const { rows } = await agentPool.query<{
        total_alliance_certs:  string;
        unique_users:           string;
        resolved:               string;
        hits:                   string;
        avg_hit_rate:           string;
      }>(
        `SELECT
           COUNT(*)::int                                                AS total_alliance_certs,
           COUNT(DISTINCT payload_json->'alliance'->>'user_id')::int    AS unique_users,
           SUM(CASE WHEN hit IS NOT NULL THEN 1 ELSE 0 END)::int        AS resolved,
           SUM(CASE WHEN hit = true THEN 1 ELSE 0 END)::int            AS hits,
           AVG(hit_rate_wf)::float                                      AS avg_hit_rate
         FROM hitdash.truth_certificates
         WHERE payload_json->'alliance'->>'user_id' IS NOT NULL`,
      );

      const r = rows[0];
      if (!r) {
        res.json({
          total_alliance_certs: 0, unique_users: 0,
          resolved: 0, hits: 0,
          alliance_accuracy: null, avg_predicted_hit_rate: 0,
        });
        return;
      }

      const total    = Number(r.total_alliance_certs);
      const resolved = Number(r.resolved);
      const hits     = Number(r.hits);

      res.json({
        total_alliance_certs:  total,
        unique_users:          Number(r.unique_users),
        resolved:              resolved,
        hits:                  hits,
        alliance_accuracy:     resolved > 0 ? hits / resolved : null,
        avg_predicted_hit_rate: Number(r.avg_hit_rate) || 0,
        verification_base:     PUBLIC_VERIFY_BASE,
      });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'alliance/stats failed');
      res.status(500).json({ error: 'Error', details: err instanceof Error ? err.message : String(err) });
    }
  });

  return router;
}
