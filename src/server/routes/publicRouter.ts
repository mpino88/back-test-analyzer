// ═══════════════════════════════════════════════════════════════
// HELIX — Public Router v1.0.0 (2026-05-22)
//
// Endpoints PÚBLICOS (sin auth) para verificación de Truth Certificates.
//
// Filosofía: si decimos "verificable por cualquiera", debe SER verificable
// por cualquiera — incluyendo periodistas, reguladores e inversores sin
// credenciales. La transparencia es el producto.
//
// Endpoints:
//   GET  /api/public/certificate/:id          — descargar cert público
//   POST /api/public/certificate/:id/verify   — verificar HMAC offline
//   GET  /api/public/cert-stats                — estadísticas agregadas
//
// Rate limiting aplicado (genérico, sin API key).
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'PublicRouter' });

export function createPublicRouter(agentPool: Pool): Router {
  const router = Router();

  // GET /api/public/certificate/:id — pública, sin auth
  router.get('/certificate/:id', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);

      // Validate format to prevent injection (TC-YYYY-MM-DD-HEX)
      if (!/^TC-\d{4}-\d{2}-\d{2}-[A-F0-9]{8}$/.test(id)) {
        res.status(400).json({ error: 'Formato de certificate_id inválido' });
        return;
      }

      const { TruthCertificateService } = await import('../../agent/services/TruthCertificateService.js');
      const svc = new TruthCertificateService(agentPool);
      const cert = await svc.getCertificate(id);
      if (!cert) {
        res.status(404).json({ error: 'Certificado no encontrado' });
        return;
      }

      // CORS abierto para permitir verificación desde dominios externos
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Cache-Control', 'public, max-age=3600');
      res.json(cert);
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'public/certificate failed');
      res.status(500).json({ error: 'Error interno' });
    }
  });

  // POST /api/public/certificate/:id/verify — verificar HMAC
  router.post('/certificate/:id/verify', async (req: Request, res: Response) => {
    try {
      const id = String(req.params.id);
      if (!/^TC-\d{4}-\d{2}-\d{2}-[A-F0-9]{8}$/.test(id)) {
        res.status(400).json({ error: 'Formato inválido' });
        return;
      }

      const { TruthCertificateService } = await import('../../agent/services/TruthCertificateService.js');
      const svc = new TruthCertificateService(agentPool);
      const cert = await svc.getCertificate(id);
      if (!cert) {
        res.status(404).json({ error: 'Certificado no encontrado' });
        return;
      }
      const valid = svc.verifyCertificate(cert);

      // Return minimal verification result (no full payload)
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({
        certificate_id:    id,
        signature_valid:   valid,
        signed_at:         cert.signed_at,
        issued_at:         cert.issued_at,
        algorithm:         cert.algorithm,
        // Public-friendly summary
        prediction: {
          game_type:     cert.prediction.game_type,
          draw_type:     cert.prediction.draw_type,
          half:          cert.prediction.half,
          draw_date:     cert.prediction.draw_date,
          predicted_n:   cert.prediction.predicted_n,
        },
        statistics: {
          hit_rate_walk_forward: cert.statistics.hit_rate_walk_forward,
          wilson_95_ci_lo:       cert.statistics.wilson_95_ci_lo,
          wilson_95_ci_hi:       cert.statistics.wilson_95_ci_hi,
          edge_multiplier:       cert.statistics.edge_multiplier,
          baseline_rate:         cert.statistics.baseline_rate,
        },
        disclosure: cert.disclosure,
        audit: {
          last_edge_discovery_run_id: cert.audit.last_edge_discovery_run_id,
          n_tests_total:              cert.audit.n_tests_total,
          n_tests_significant:        cert.audit.n_tests_significant,
        },
      });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'public/verify failed');
      res.status(500).json({ error: 'Error interno' });
    }
  });

  // GET /api/public/cert-stats — métricas agregadas (público)
  router.get('/cert-stats', async (_req: Request, res: Response) => {
    try {
      const { rows } = await agentPool.query<{
        total: string; resolved: string; hits: string;
        avg_hit_rate: string; avg_edge_mult: string;
      }>(
        `SELECT
           COUNT(*)::int                                              AS total,
           SUM(CASE WHEN resolved_at IS NOT NULL THEN 1 ELSE 0 END)::int AS resolved,
           SUM(CASE WHEN hit = true THEN 1 ELSE 0 END)::int          AS hits,
           AVG(hit_rate_wf)::float                                    AS avg_hit_rate,
           AVG(edge_multiplier)::float                                AS avg_edge_mult
         FROM hitdash.truth_certificates`,
      );
      const r = rows[0];
      if (!r) {
        res.status(500).json({ error: 'No data' });
        return;
      }
      const total = Number(r.total);
      const resolved = Number(r.resolved);
      const hits = Number(r.hits);

      res.setHeader('Access-Control-Allow-Origin', '*');
      res.json({
        total_certificates:  total,
        resolved:            resolved,
        hits:                hits,
        accuracy_resolved:   resolved > 0 ? hits / resolved : null,
        avg_predicted_hit_rate: Number(r.avg_hit_rate) || 0,
        avg_edge_multiplier:    Number(r.avg_edge_mult) || 0,
        methodology: 'Bonferroni-corrected walk-forward + conformal',
        verification: {
          algorithm:    'HMAC-SHA256',
          public_route: '/api/public/certificate/:id/verify',
        },
      });
    } catch (err) {
      logger.error({ error: err instanceof Error ? err.message : String(err) }, 'public/cert-stats failed');
      res.status(500).json({ error: 'Error interno' });
    }
  });

  // CORS preflight handler
  router.options('*', (_req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.sendStatus(204);
  });

  return router;
}
