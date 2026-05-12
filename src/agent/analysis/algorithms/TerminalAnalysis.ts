// ═══════════════════════════════════════════════════════════════
// HITDASH — TerminalAnalysis v1.0.0
//
// Puerto exacto de Ballbot terminal_analysis.ts
//
// Agrupa los 100 pares (00-99) por su terminal (último dígito).
// Para cada terminal calcula momentum + due factor → score.
// Selecciona los top 4 terminales → para cada uno los top 5 pares.
//
// Fórmula:
//   termScore(t) = 0.6 × momentum(t) + 0.4 × min(3, dueFactor(t))
//
//   momentum(t)   = freq_recent(30) / freq_historical(all)
//   dueFactor(t)  = drawsSinceLastSeen / avgGap
//
// Útil como complemento al DigitAnalyzer en Pick3 (p3/unidad).
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import type { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';

const logger = pino({ name: 'TerminalAnalysis' });

const RECENT_WINDOW   = 30;
const TOP_TERMINALS   = 4;
const PAIRS_PER_TERM  = 5;
const W_MOMENTUM      = 0.6;
const W_DUE           = 0.4;

export interface TerminalStat {
  terminal:     number;  // 0-9 (último dígito del par)
  momentum:     number;
  dueFactor:    number;
  termScore:    number;
  topPairs:     string[];  // top PAIRS_PER_TERM pares de este terminal
}

export class TerminalAnalysis {
  constructor(private readonly pool: Pool) {}

  async computeStats(
    game_type: GameType,
    draw_type: DrawType,
    half:      PairHalf
  ): Promise<{ terminals: TerminalStat[]; pairCounts: Record<string, number> }> {
    const { rows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number;
    }>(
      `SELECT p1, p2, p3, p4
       FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
       ORDER BY draw_date DESC`,
      [game_type, draw_type]
    );

    if (rows.length === 0) return { terminals: [], pairCounts: {} };

    const extractPair = (r: { p1: number; p2: number; p3: number; p4: number }): number => {
      if (half === 'ab') return r.p1 * 10 + r.p2;
      if (half === 'cd') return r.p3 * 10 + r.p4;
      return r.p2 * 10 + r.p3;
    };

    const totalAll    = rows.length;
    const recentRows  = rows.slice(0, RECENT_WINDOW);
    const totalRecent = recentRows.length;

    // Conteo por par (histórico y reciente)
    const pairCountAll:    Record<number, number> = {};
    const pairCountRecent: Record<number, number> = {};
    // Índice de última aparición por par (para dueFactor)
    const lastSeenIdx: Record<number, number> = {};

    for (let i = 0; i < rows.length; i++) {
      const p = extractPair(rows[i]!);
      pairCountAll[p] = (pairCountAll[p] ?? 0) + 1;
      if (lastSeenIdx[p] === undefined) lastSeenIdx[p] = i;
    }
    for (const row of recentRows) {
      const p = extractPair(row);
      pairCountRecent[p] = (pairCountRecent[p] ?? 0) + 1;
    }

    // Conteo por terminal (0-9)
    const termAll:    number[] = new Array(10).fill(0);
    const termRecent: number[] = new Array(10).fill(0);
    const termLastIdx: number[] = new Array(10).fill(totalAll); // default = never seen

    for (let p = 0; p < 100; p++) {
      const t  = p % 10;
      const ca = pairCountAll[p] ?? 0;
      const cr = pairCountRecent[p] ?? 0;
      termAll[t]    += ca;
      termRecent[t] += cr;
      const li = lastSeenIdx[p];
      if (li !== undefined && li < termLastIdx[t]!) {
        termLastIdx[t] = li;
      }
    }

    // Avg gap por terminal (draws entre apariciones)
    const termAvgGap: number[] = termAll.map((ca, _t) => ca > 0 ? totalAll / ca : totalAll);

    // Score por terminal
    const terminals: TerminalStat[] = [];
    for (let t = 0; t < 10; t++) {
      const freqAll    = totalAll    > 0 ? termAll[t]!    / totalAll    : 0;
      const freqRecent = totalRecent > 0 ? termRecent[t]! / totalRecent : 0;
      const momentum   = freqAll > 0 ? Math.min(5, freqRecent / freqAll) : (termRecent[t]! > 0 ? 5 : 0);
      const dueFactor  = termAvgGap[t]! > 0 ? termLastIdx[t]! / termAvgGap[t]! : 0;
      const termScore  = W_MOMENTUM * (momentum / 5) + W_DUE * Math.min(1, dueFactor / 3);

      // Top pares de este terminal por frecuencia histórica
      const pairsOfTerm = Array.from({ length: 10 }, (_, d) => d * 10 + t)
        .sort((a, b) => (pairCountAll[b] ?? 0) - (pairCountAll[a] ?? 0))
        .slice(0, PAIRS_PER_TERM)
        .map(n => String(Math.floor(n / 10)) + String(n % 10));

      terminals.push({ terminal: t, momentum, dueFactor, termScore, topPairs: pairsOfTerm });
    }

    // Exposición del pairCounts para AlgorithmCandidateService
    const pairCounts: Record<string, number> = {};
    for (let p = 0; p < 100; p++) {
      pairCounts[String(Math.floor(p / 10)) + String(p % 10)] = pairCountAll[p] ?? 0;
    }

    return { terminals, pairCounts };
  }

  // ─── runPairs: score normalizado para consensus ───────────────
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
      const { terminals } = await this.computeStats(game_type, draw_type, half);
      if (!terminals.length) return flat();

      // Seleccionar top terminales
      const topTerms = [...terminals]
        .sort((a, b) => b.termScore - a.termScore)
        .slice(0, TOP_TERMINALS);

      const maxTermScore = topTerms[0]?.termScore ?? 1;
      const scores: Record<string, number> = {};

      for (let x = 0; x <= 9; x++) {
        for (let y = 0; y <= 9; y++) {
          const term  = y;
          const pair  = `${x}${y}`;
          const ts    = terminals[term];
          const inTop = topTerms.some(t => t.terminal === term);
          if (inTop && ts) {
            // Score proporcional al termScore del terminal
            scores[pair] = Math.min(1, ts.termScore / maxTermScore);
          } else {
            scores[pair] = 0.01;
          }
        }
      }

      logger.debug({ game_type, draw_type, half, top_terminals: topTerms.map(t => t.terminal) }, 'TerminalAnalysis: runPairs completado');
      return scores;
    } catch (err) {
      logger.error({ err }, 'TerminalAnalysis: error en runPairs');
      return flat();
    }
  }

  // ─── getCandidates: top 4 terminales × top 5 pares ───────────
  getCandidatesFromStats(terminals: TerminalStat[], topN: number = 20): string[] {
    const topTerms = [...terminals]
      .sort((a, b) => b.termScore - a.termScore)
      .slice(0, TOP_TERMINALS);

    const candidates: string[] = [];
    for (const term of topTerms) {
      for (const pair of term.topPairs) {
        if (!candidates.includes(pair)) candidates.push(pair);
        if (candidates.length >= topN) break;
      }
      if (candidates.length >= topN) break;
    }
    return candidates;
  }
}
