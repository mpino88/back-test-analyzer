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

  // ═══════════════════════════════════════════════════════════════
  // POINT 2 — POST /diff : comparar candidatos Ballbot (pegados) vs HELIX
  // Body: {
  //   ballbot_candidates: string[],   // ['17','54','03',...]
  //   ballbot_id:          string,     // 'trend_momentum' etc.
  //   game_type, draw_type, half, top_n
  // }
  // ═══════════════════════════════════════════════════════════════
  router.post('/diff', async (req: Request, res: Response) => {
    try {
      const {
        ballbot_candidates,
        ballbot_id,
        game_type = 'pick3',
        draw_type = 'evening',
        half      = 'du',
        top_n     = 15,
      } = req.body ?? {};

      if (!Array.isArray(ballbot_candidates) || ballbot_candidates.length === 0) {
        res.status(400).json({ error: 'ballbot_candidates debe ser array no vacío' });
        return;
      }
      if (!ballbot_id) {
        res.status(400).json({ error: 'ballbot_id requerido (e.g. trend_momentum)' });
        return;
      }

      // Normalize Ballbot candidates: ensure 2-digit zero-padded strings
      const ballbotNorm: string[] = ballbot_candidates.map((c: unknown) =>
        String(c).padStart(2, '0').slice(-2),
      );

      // Run mirror for the same combo + strategy
      const { BallbotMirrorService } = await import('../../agent/ballbot-mirror/BallbotMirrorService.js');
      const svc = new BallbotMirrorService(agentPool);
      const result = await svc.runAll({ game_type, draw_type, half, top_n: Number(top_n) });
      const helixStrat = result.strategies.find(s => s.ballbot_id === ballbot_id);

      if (!helixStrat) {
        res.status(404).json({ error: `Estrategia desconocida: ${ballbot_id}` });
        return;
      }

      const helixCands = helixStrat.candidates.slice(0, ballbotNorm.length);
      const ballbotSet = new Set(ballbotNorm);
      const helixSet   = new Set(helixCands);

      // Set overlap
      const intersection = [...ballbotSet].filter(c => helixSet.has(c));
      const onlyBallbot  = [...ballbotSet].filter(c => !helixSet.has(c));
      const onlyHelix    = [...helixSet].filter(c => !ballbotSet.has(c));
      const union        = new Set([...ballbotSet, ...helixSet]);

      // Position-exact match
      const minLen = Math.min(ballbotNorm.length, helixCands.length);
      let positionExact = 0;
      const positionMap: Array<{ pos: number; ballbot: string; helix: string; match: boolean }> = [];
      for (let i = 0; i < Math.max(ballbotNorm.length, helixCands.length); i++) {
        const b = ballbotNorm[i] ?? '—';
        const h = helixCands[i]  ?? '—';
        const m = i < minLen && b === h;
        if (m) positionExact++;
        positionMap.push({ pos: i + 1, ballbot: b, helix: h, match: m });
      }

      res.json({
        ballbot_id,
        bot_title: helixStrat.bot_title,
        game_type, draw_type, half, top_n: Number(top_n),
        ballbot_input:  ballbotNorm,
        helix_output:   helixCands,
        // Métricas de fidelidad
        set_overlap_count:   intersection.length,
        set_overlap_pct:     +(intersection.length / Math.max(ballbotNorm.length, 1) * 100).toFixed(2),
        jaccard:             +(intersection.length / Math.max(union.size, 1) * 100).toFixed(2),
        position_exact_count: positionExact,
        position_exact_pct:   +(positionExact / Math.max(minLen, 1) * 100).toFixed(2),
        // Detalle
        intersection,
        only_ballbot:        onlyBallbot,
        only_helix:          onlyHelix,
        position_map:        positionMap,
        // Backtest del algo
        retrospective: helixStrat.retrospective,
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'diff failed');
      res.status(500).json({ error: 'Error en diff', details: err instanceof Error ? err.message : String(err) });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POINT 4 — GET /timeseries : evolución mensual hit rate por algo
  // Query: ?algo=trend_momentum&game=pick3&draw=evening&half=du
  // ═══════════════════════════════════════════════════════════════
  router.get('/timeseries', async (req: Request, res: Response) => {
    try {
      const algo      = String(req.query.algo ?? '');
      const game_type = String(req.query.game ?? 'pick3');
      const draw_type = String(req.query.draw ?? 'evening');
      const half      = String(req.query.half ?? 'du');
      const bucket    = String(req.query.bucket ?? 'month'); // 'week' | 'month' | 'quarter'

      if (!algo) {
        res.status(400).json({ error: 'algo requerido' });
        return;
      }

      const trunc = bucket === 'week' ? 'week'
                  : bucket === 'quarter' ? 'quarter'
                  : 'month';

      const { rows } = await agentPool.query<{
        bucket: string; n: string; h15: string; h25: string;
      }>(
        `SELECT date_trunc('${trunc}', draw_date)::date::text AS bucket,
                COUNT(*)::int AS n,
                SUM(CASE WHEN rank_of_winner <= 15 THEN 1 ELSE 0 END)::int AS h15,
                SUM(CASE WHEN rank_of_winner <= 25 THEN 1 ELSE 0 END)::int AS h25
         FROM hitdash.algo_rank_history
         WHERE algo_name=$1 AND game_type=$2 AND draw_type=$3 AND half=$4
         GROUP BY 1 ORDER BY 1`,
        [algo, game_type, draw_type, half],
      );

      const series = rows.map(r => {
        const n = Number(r.n);
        const h15 = Number(r.h15);
        const hr15 = n > 0 ? h15 / n : 0;
        const z = 1.96;
        const center = n > 0 ? (hr15 + (z*z)/(2*n)) / (1 + (z*z)/n) : 0;
        const margin = n > 0 ? (z * Math.sqrt(hr15*(1-hr15)/n + (z*z)/(4*n*n))) / (1 + (z*z)/n) : 0;
        return {
          bucket: r.bucket,
          n,
          h15,
          h25: Number(r.h25),
          hit_rate_15: +hr15.toFixed(4),
          wilson_lo:   Math.max(0, +(center - margin).toFixed(4)),
          wilson_hi:   +(center + margin).toFixed(4),
          edge_pp:     +((hr15 - 0.15) * 100).toFixed(2),
        };
      });

      res.json({ algo, game_type, draw_type, half, bucket, count: series.length, series });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'timeseries failed');
      res.status(500).json({ error: 'Error en timeseries' });
    }
  });

  // ═══════════════════════════════════════════════════════════════
  // POINT 5 — POST /issue-certs : emite Truth Cert por cada estrategia
  // del mirror, con disclosure incluido. Útil para auditoría.
  // ═══════════════════════════════════════════════════════════════
  router.post('/issue-certs', async (req: Request, res: Response) => {
    try {
      const {
        game_type = 'pick3',
        draw_type = 'evening',
        half      = 'du',
        top_n     = 15,
        draw_date = new Date().toISOString().slice(0, 10),
        user_id,
      } = req.body ?? {};

      const { BallbotMirrorService } = await import('../../agent/ballbot-mirror/BallbotMirrorService.js');
      const { TruthCertificateService } = await import('../../agent/services/TruthCertificateService.js');

      const mirror = new BallbotMirrorService(agentPool);
      const certSvc = new TruthCertificateService(agentPool);

      const mirrorResult = await mirror.runAll({ game_type, draw_type, half, top_n: Number(top_n) });
      const certs: Array<Record<string, unknown>> = [];

      // Issue UN cert por estrategia con sus candidatos
      for (const strat of mirrorResult.strategies) {
        if (strat.candidates.length === 0) continue;
        try {
          const cert = await certSvc.issueCertificate({
            game_type, draw_type, half, draw_date,
            predicted_top: strat.candidates,
            algo_used: strat.helix_id ?? strat.ballbot_id,
            prediction_id: undefined,
          });
          certs.push({
            ballbot_id: strat.ballbot_id,
            bot_title:  strat.bot_title,
            emoji:      strat.emoji,
            cert_id:    cert.certificate_id,
            verify_url: `https://dash.ballbot.tel/verify?id=${cert.certificate_id}`,
            candidates: strat.candidates,
            disclosure: cert.disclosure,
            retro:      strat.retrospective,
          });
        } catch (certErr) {
          logger.warn({ err: certErr, ballbot_id: strat.ballbot_id }, 'cert issue failed for strategy');
        }
      }

      res.json({
        game_type, draw_type, half, draw_date, user_id: user_id ?? null,
        certs_issued: certs.length,
        certs,
      });
    } catch (err) {
      logger.error({ err: err instanceof Error ? err.message : String(err) }, 'issue-certs failed');
      res.status(500).json({ error: 'Error emitiendo certs' });
    }
  });

  return router;
}
