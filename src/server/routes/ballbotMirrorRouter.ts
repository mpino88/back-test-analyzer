// ═══════════════════════════════════════════════════════════════
// HELIX — Ballbot Mirror Router v1.0.0 (2026-05-22)
//
// Endpoints para el módulo Mirror (réplica espejo Ballbot dentro HELIX).
// Acceso autenticado vía /api/agent.
// ═══════════════════════════════════════════════════════════════

import { Router, type Request, type Response } from 'express';
import type { Pool } from 'pg';
import pino from 'pino';

const logger = pino({ name: 'BallbotMirrorRouter' });

export function createBallbotMirrorRouter(agentPool: Pool): Router {
  const router = Router();

  // GET /strategies — lista catálogo (18+)
  router.get('/strategies', async (_req: Request, res: Response) => {
    try {
      const { BallbotMirrorService } = await import('../../agent/ballbot-mirror/BallbotMirrorService.js');
      const svc = new BallbotMirrorService(agentPool);
      res.json({ count: svc.listStrategies().length, strategies: svc.listStrategies() });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'list strategies failed');
      res.status(500).json({ error: 'Error listando estrategias' });
    }
  });

  // POST /run — ejecuta TODAS las estrategias y devuelve resultados + comparación HELIX
  router.post('/run', async (req: Request, res: Response) => {
    try {
      const {
        game_type = 'pick3',
        draw_type = 'evening',
        half      = 'du',
        top_n     = 15,
        as_of,
      } = req.body ?? {};

      const validGames  = ['pick3', 'pick4'];
      const validDraws  = ['midday', 'evening'];
      const validHalves = ['du', 'ab', 'cd'];

      if (!validGames.includes(game_type) ||
          !validDraws.includes(draw_type) ||
          !validHalves.includes(half)) {
        res.status(400).json({ error: 'Parámetros inválidos' });
        return;
      }

      const safeTopN = Math.min(Math.max(Number(top_n), 5), 50);

      const { BallbotMirrorService } = await import('../../agent/ballbot-mirror/BallbotMirrorService.js');
      const svc = new BallbotMirrorService(agentPool);
      const result = await svc.runAll({ game_type, draw_type, half, top_n: safeTopN, as_of });

      res.json(result);
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'mirror/run failed');
      res.status(500).json({ error: 'Error en mirror run', details: err instanceof Error ? err.message : String(err) });
    }
  });

  // GET /retrospective?algo=X&game=Y&draw=Z&half=W
  // Hit rate histórico de un algoritmo específico
  router.get('/retrospective', async (req: Request, res: Response) => {
    try {
      const helix_id  = String(req.query.algo ?? '');
      const game_type = String(req.query.game ?? 'pick3');
      const draw_type = String(req.query.draw ?? 'evening');
      const half      = String(req.query.half ?? 'du');

      if (!helix_id) {
        res.status(400).json({ error: 'Falta query param: algo' });
        return;
      }

      const { rows } = await agentPool.query<{
        n_total: string; hits_15: string; hits_25: string;
        rank_avg: string;
      }>(
        `SELECT COUNT(*)::int AS n_total,
                SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::int AS hits_15,
                SUM(CASE WHEN rank_of_winner <= 25 THEN 1 ELSE 0 END)::int AS hits_25,
                AVG(rank_of_winner)::float AS rank_avg
         FROM hitdash.algo_rank_history
         WHERE algo_name=$1 AND game_type=$2 AND draw_type=$3 AND half=$4`,
        [helix_id, game_type, draw_type, half],
      );

      const r = rows[0];
      if (!r || Number(r.n_total) === 0) {
        res.json({
          helix_id, game_type, draw_type, half,
          n_total: 0, message: 'Sin datos retrospectivos para este algo/combo',
        });
        return;
      }

      const n = Number(r.n_total);
      const h15 = Number(r.hits_15);
      const h25 = Number(r.hits_25);
      const hr15 = h15 / n;
      const hr25 = h25 / n;

      // Wilson 95% CI
      const z = 1.96;
      const center15 = (hr15 + (z*z)/(2*n)) / (1 + (z*z)/n);
      const margin15 = (z * Math.sqrt(hr15*(1-hr15)/n + (z*z)/(4*n*n))) / (1 + (z*z)/n);

      res.json({
        helix_id, game_type, draw_type, half,
        n_total:     n,
        hits_at_15:  h15,
        hits_at_25:  h25,
        hit_rate_15: +hr15.toFixed(4),
        hit_rate_25: +hr25.toFixed(4),
        wilson_lo_15: Math.max(0, +(center15 - margin15).toFixed(4)),
        wilson_hi_15: +(center15 + margin15).toFixed(4),
        edge_15_pp:  +((hr15 - 0.15) * 100).toFixed(2),
        edge_25_pp:  +((hr25 - 0.25) * 100).toFixed(2),
        rank_avg:    +Number(r.rank_avg).toFixed(1),
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'retrospective failed');
      res.status(500).json({ error: 'Error en retrospective' });
    }
  });

  // GET /retrospective-all?game=X&draw=Y&half=Z
  // Hit rates retrospectivos para TODOS los algoritmos en un combo
  router.get('/retrospective-all', async (req: Request, res: Response) => {
    try {
      const game_type = String(req.query.game ?? 'pick3');
      const draw_type = String(req.query.draw ?? 'evening');
      const half      = String(req.query.half ?? 'du');
      const window    = String(req.query.window ?? 'all'); // 'all' | '90d' | '180d' | '365d'

      let dateFilter = '';
      if (window === '90d')  dateFilter = `AND draw_date >= CURRENT_DATE - INTERVAL '90 days'`;
      if (window === '180d') dateFilter = `AND draw_date >= CURRENT_DATE - INTERVAL '180 days'`;
      if (window === '365d') dateFilter = `AND draw_date >= CURRENT_DATE - INTERVAL '365 days'`;

      const { rows } = await agentPool.query<{
        algo_name: string; n: string; h15: string; h25: string; rank_avg: string;
      }>(
        `SELECT algo_name,
                COUNT(*)::int AS n,
                SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::int AS h15,
                SUM(CASE WHEN rank_of_winner <= 25 THEN 1 ELSE 0 END)::int AS h25,
                AVG(rank_of_winner)::float AS rank_avg
         FROM hitdash.algo_rank_history
         WHERE game_type=$1 AND draw_type=$2 AND half=$3 ${dateFilter}
         GROUP BY algo_name
         HAVING COUNT(*) >= 30
         ORDER BY (SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::float / COUNT(*)) DESC`,
        [game_type, draw_type, half],
      );

      const results = rows.map(r => {
        const n = Number(r.n);
        const h15 = Number(r.h15);
        const hr15 = h15 / n;
        const z = 1.96;
        const center = (hr15 + (z*z)/(2*n)) / (1 + (z*z)/n);
        const margin = (z * Math.sqrt(hr15*(1-hr15)/n + (z*z)/(4*n*n))) / (1 + (z*z)/n);
        return {
          algo_name: r.algo_name,
          n,
          hit_rate_15: +hr15.toFixed(4),
          hit_rate_25: +(Number(r.h25)/n).toFixed(4),
          wilson_lo_15: Math.max(0, +(center - margin).toFixed(4)),
          wilson_hi_15: +(center + margin).toFixed(4),
          edge_15_pp:  +((hr15 - 0.15) * 100).toFixed(2),
          rank_avg:    +Number(r.rank_avg).toFixed(1),
          significant: (center - margin) > 0.15,  // Wilson lower > baseline
        };
      });

      res.json({
        game_type, draw_type, half, window,
        count: results.length,
        algorithms: results,
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'retrospective-all failed');
      res.status(500).json({ error: 'Error en retrospective-all' });
    }
  });

  return router;
}
