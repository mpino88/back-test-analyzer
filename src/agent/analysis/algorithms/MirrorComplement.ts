// ═══════════════════════════════════════════════════════════════
// HITDASH — MirrorComplement v1.0.0
//
// Puerto exacto de Ballbot mirror_complement.ts
//
// Detecta relaciones simétricas entre pares:
//   mirror(47)   = 74   (invertir dígitos)
//   comp99(23)   = 76   (99 - n)
//   comp100(23)  = 77   ((100 - n) % 100)
//
// Para cada par fuente, calcula la probabilidad de que cada
// variante simétrica aparezca en los próximos 1/3/7 sorteos:
//   pct1 = aparición dentro de 1 draw  / veces que salió el fuente
//   pct3 = aparición dentro de 3 draws / veces que salió el fuente
//   pct7 = aparición dentro de 7 draws / veces que salió el fuente
//
// Score agregado (del último sorteo como fuente):
//   score(target) = pct1*3 + pct3*2 + pct7
//
// Candidatos: top N por score agregado (mínimo 3 apariciones del fuente).
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import type { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';

const logger = pino({ name: 'MirrorComplement' });

const MIN_SOURCE_APPEARANCES = 3;
const W_PCT1 = 3;
const W_PCT3 = 2;
const W_PCT7 = 1;

export interface SymmetricRelation {
  source:   string;  // par fuente
  target:   string;  // par simétrico
  type:     'mirror' | 'comp99' | 'comp100';
  pct1:     number;
  pct3:     number;
  pct7:     number;
  score:    number;
  timesSourceSeen: number;
}

function mirrorOf(n: number): number {
  const d = Math.floor(n / 10);
  const u = n % 10;
  return u * 10 + d;
}

function comp99Of(n: number): number {
  return 99 - n;
}

function comp100Of(n: number): number {
  return (100 - n) % 100;
}

function fmtPair(n: number): string {
  return String(Math.floor(n / 10)) + String(n % 10);
}

export class MirrorComplement {
  constructor(private readonly pool: Pool) {}

  // ─── Computa relaciones simétricas sobre el historial ─────────
  async computeRelations(
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf
  ): Promise<SymmetricRelation[]> {
    const { rows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number;
    }>(
      `SELECT p1, p2, p3, p4
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
       ORDER BY draw_date ASC`,  // ASC: para walk-forward
      [game_type, draw_type]
    );

    if (rows.length < 10) return [];

    const extractPair = (r: { p1: number; p2: number; p3: number; p4: number }): number => {
      if (half === 'ab') return r.p1 * 10 + r.p2;
      if (half === 'cd') return r.p3 * 10 + r.p4;
      return r.p2 * 10 + r.p3;
    };

    const sequence = rows.map(r => extractPair(r));
    const N        = sequence.length;

    // Para cada par fuente: contar apariciones y co-apariciones con simétricos
    const relations: SymmetricRelation[] = [];

    for (let src = 0; src < 100; src++) {
      const variants: Array<{ target: number; type: SymmetricRelation['type'] }> = [
        { target: mirrorOf(src),  type: 'mirror'  },
        { target: comp99Of(src),  type: 'comp99'  },
        { target: comp100Of(src), type: 'comp100' },
      ];

      // Índices donde apareció el fuente
      const srcIdxs = sequence.reduce<number[]>((acc, v, i) => {
        if (v === src) acc.push(i);
        return acc;
      }, []);

      if (srcIdxs.length < MIN_SOURCE_APPEARANCES) continue;

      for (const { target, type } of variants) {
        if (target === src) continue; // no contar auto-relación

        let hit1 = 0, hit3 = 0, hit7 = 0;

        for (const idx of srcIdxs) {
          const window1 = sequence.slice(idx + 1, idx + 2);
          const window3 = sequence.slice(idx + 1, idx + 4);
          const window7 = sequence.slice(idx + 1, idx + 8);
          if (window1.includes(target)) hit1++;
          if (window3.includes(target)) hit3++;
          if (window7.includes(target)) hit7++;
        }

        const pct1 = hit1 / srcIdxs.length;
        const pct3 = hit3 / srcIdxs.length;
        const pct7 = hit7 / srcIdxs.length;
        const score = pct1 * W_PCT1 + pct3 * W_PCT3 + pct7 * W_PCT7;

        relations.push({
          source:   fmtPair(src),
          target:   fmtPair(target),
          type,
          pct1, pct3, pct7, score,
          timesSourceSeen: srcIdxs.length,
        });
      }
    }

    return relations;
  }

  // ─── runPairs: score para consensus ──────────────────────────
  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf,
    _period:   AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const flat = (): Record<string, number> => {
      const r: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) r[`${x}${y}`] = 0.01;
      return r;
    };

    try {
      // Cargar el último sorteo real
      const { rows: lastDrawRows } = await this.pool.query<{
        p1: number; p2: number; p3: number; p4: number;
      }>(
        `SELECT p1, p2, p3, p4
         FROM hitdash.ingested_results
         WHERE game_type = $1 AND draw_type = $2
         ORDER BY draw_date DESC LIMIT 1`,
        [game_type, draw_type]
      );

      if (!lastDrawRows[0]) return flat();

      const extractPair = (r: { p1: number; p2: number; p3: number; p4: number }): number => {
        if (half === 'ab') return r.p1 * 10 + r.p2;
        if (half === 'cd') return r.p3 * 10 + r.p4;
        return r.p2 * 10 + r.p3;
      };

      const lastPair = extractPair(lastDrawRows[0]);
      const relations = await this.computeRelations(game_type, draw_type, half);

      // Filtrar relaciones donde el fuente = último sorteo
      const fromLast = relations.filter(r => r.source === fmtPair(lastPair));

      if (!fromLast.length) {
        // Fallback: top relaciones por pct3 con ≥5 muestras
        const fallback = relations
          .filter(r => r.timesSourceSeen >= 5)
          .sort((a, b) => b.pct3 - a.pct3)
          .slice(0, 15);

        const scores = flat();
        const maxScore = fallback[0]?.score ?? 1;
        for (const rel of fallback) {
          scores[rel.target] = Math.max(scores[rel.target] ?? 0, rel.score / (maxScore || 1));
        }
        return scores;
      }

      const scores = flat();
      const maxScore = Math.max(...fromLast.map(r => r.score), 1e-9);
      for (const rel of fromLast) {
        scores[rel.target] = Math.max(scores[rel.target] ?? 0.01, rel.score / maxScore);
      }

      logger.debug({ game_type, draw_type, half, source: fmtPair(lastPair), targets: fromLast.map(r => r.target) }, 'MirrorComplement: runPairs completado');
      return scores;
    } catch (err) {
      logger.error({ err }, 'MirrorComplement: error en runPairs');
      return flat();
    }
  }

  // ─── getCandidates: top N por score agregado ─────────────────
  getCandidatesFromRelations(relations: SymmetricRelation[], topN: number = 15): string[] {
    // Agregar scores por target
    const aggregated = new Map<string, number>();
    for (const r of relations) {
      aggregated.set(r.target, (aggregated.get(r.target) ?? 0) + r.score);
    }
    return [...aggregated.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, topN)
      .map(([target]) => target);
  }
}
