// ═══════════════════════════════════════════════════════════════
// HITDASH — CycleDetector v1.0.0
//
// Puerto exacto de Ballbot cycle_detector.ts
//
// Detecta ciclos de aparición para cada par (00-99):
//   1. Calcula inter-arrival gaps (en número de sorteos entre apariciones)
//   2. Agrupa gaps en bandas con tolerancia ±20%
//   3. Si la banda dominante concentra ≥22% de los gaps → cycleLength
//   4. phase = drawsSinceLast / cycleLength
//   5. Candidatos: phase ≥ 0.8 (dentro de la ventana de ciclo)
//
// Interpretación de phase:
//   ≈ 1.0 → en el punto de ciclo (due)
//   > 1.2 → sobredebido (overdue)
//   < 0.9 → aún no llega al ciclo
//
// Usado como señal S4 en BayesianScore.
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import type { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';

const logger = pino({ name: 'CycleDetector' });

const BAND_TOLERANCE   = 0.20;  // ±20% para clustering de gaps
const MIN_CONCENTRATION = 0.22; // ≥22% de gaps en la banda dominante → ciclo detectado
const PHASE_THRESHOLD   = 0.80; // phase ≥ 0.8 → candidato
const MIN_APPEARANCES   = 5;    // mínimo de apariciones para ciclo confiable

export interface CycleStat {
  pair:          string;
  hasCycle:      boolean;
  cycleLength:   number;     // en número de sorteos
  drawsSinceLast: number;
  phase:         number;     // drawsSinceLast / cycleLength
  concentration: number;     // % de gaps en la banda dominante
  score:         number;     // [0,1] para consensus
}

export class CycleDetector {
  constructor(private readonly pool: Pool) {}

  // ─── Computa estadísticas de ciclo para todos los pares ──────
  async computeStats(
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf
  ): Promise<CycleStat[]> {
    const { rows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number;
    }>(
      `SELECT p1, p2, p3, p4
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
       ORDER BY draw_date DESC`,
      [game_type, draw_type]
    );

    if (rows.length < MIN_APPEARANCES + 1) {
      return this.flatStats();
    }

    const extractPair = (r: { p1: number; p2: number; p3: number; p4: number }): number => {
      if (half === 'ab') return r.p1 * 10 + r.p2;
      if (half === 'cd') return r.p3 * 10 + r.p4;
      return r.p2 * 10 + r.p3;
    };

    // Índices de aparición por par (más reciente = índice 0)
    const appearances: Record<number, number[]> = {};
    for (let i = 0; i < rows.length; i++) {
      const p = extractPair(rows[i]!);
      if (!appearances[p]) appearances[p] = [];
      appearances[p]!.push(i);
    }

    const stats: CycleStat[] = [];
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const n    = x * 10 + y;
        const pair = `${x}${y}`;
        const idxs = appearances[n] ?? [];

        if (idxs.length < MIN_APPEARANCES) {
          stats.push({ pair, hasCycle: false, cycleLength: 0, drawsSinceLast: idxs[0] ?? rows.length, phase: 0, concentration: 0, score: 0.01 });
          continue;
        }

        // Inter-arrival gaps (en sorteos)
        const gaps: number[] = [];
        for (let i = 0; i < idxs.length - 1; i++) {
          gaps.push(idxs[i + 1]! - idxs[i]!);
        }

        // Band clustering: detectar si hay una longitud de ciclo dominante
        const { cycleLength, concentration } = this.detectDominantCycle(gaps);
        const hasCycle     = concentration >= MIN_CONCENTRATION;
        const drawsSinceLast = idxs[0] ?? rows.length;
        const phase        = hasCycle && cycleLength > 0 ? drawsSinceLast / cycleLength : 0;

        const score = hasCycle && phase >= PHASE_THRESHOLD
          ? Math.min(1.0, phase / 2.0)  // normalizar: phase=2x → score=1.0
          : 0.01;

        stats.push({ pair, hasCycle, cycleLength, drawsSinceLast, phase, concentration, score });
      }
    }

    return stats;
  }

  // ─── runPairs: para el consensus de AnalysisEngine ───────────
  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf,
    _period:   AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    try {
      const stats = await this.computeStats(game_type, draw_type, half);
      const scores: Record<string, number> = {};
      for (const s of stats) {
        scores[s.pair] = s.score;
      }
      return scores;
    } catch (err) {
      logger.error({ err }, 'CycleDetector: error en runPairs');
      return this.flatScores();
    }
  }

  // ─── getCandidates: filtra con thresholds Ballbot ─────────────
  getCandidatesFromStats(stats: CycleStat[], topN: number = 15): string[] {
    return stats
      .filter(s => s.hasCycle && s.phase >= PHASE_THRESHOLD)
      .sort((a, b) => b.phase - a.phase)
      .slice(0, topN)
      .map(s => s.pair);
  }

  // ─── Detectar ciclo dominante via band clustering ─────────────
  private detectDominantCycle(gaps: number[]): { cycleLength: number; concentration: number } {
    if (gaps.length === 0) return { cycleLength: 0, concentration: 0 };

    // Agrupar gaps en bandas con tolerancia ±20%
    const bands: Map<number, number> = new Map();  // centerGap → count

    for (const gap of gaps) {
      let assigned = false;
      for (const [center] of bands) {
        if (Math.abs(gap - center) / center <= BAND_TOLERANCE) {
          bands.set(center, bands.get(center)! + 1);
          assigned = true;
          break;
        }
      }
      if (!assigned) {
        bands.set(gap, 1);
      }
    }

    // Banda dominante
    let maxCount  = 0;
    let cycleLength = 0;
    for (const [center, count] of bands) {
      if (count > maxCount) {
        maxCount    = count;
        cycleLength = center;
      }
    }

    const concentration = gaps.length > 0 ? maxCount / gaps.length : 0;
    return { cycleLength, concentration };
  }

  private flatStats(): CycleStat[] {
    const stats: CycleStat[] = [];
    for (let x = 0; x <= 9; x++)
      for (let y = 0; y <= 9; y++)
        stats.push({ pair: `${x}${y}`, hasCycle: false, cycleLength: 0, drawsSinceLast: 0, phase: 0, concentration: 0, score: 0.01 });
    return stats;
  }

  private flatScores(): Record<string, number> {
    const r: Record<string, number> = {};
    for (let x = 0; x <= 9; x++)
      for (let y = 0; y <= 9; y++)
        r[`${x}${y}`] = 0.01;
    return r;
  }
}
