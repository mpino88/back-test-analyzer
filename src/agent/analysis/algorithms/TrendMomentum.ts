// ═══════════════════════════════════════════════════════════════
// HITDASH — TrendMomentum v3.0.0 (2026-05-14 — bot's strict filter)
//
// Fórmula exacta de Ballbot "Fuerza de Tendencia Pro":
//
//   momentum(pair) = freq_recent(30 draws) / freq_historical(all)
//
// CAMBIO CRÍTICO v3 (matching bot's "↑↑↑ alza fuerte" filter):
//   ANTES: MOMENTUM_THRESHOLD = 1.0  (cualquier alza) — DEMASIADO PERMISIVO
//   AHORA: MOMENTUM_THRESHOLD = 3.0  (alza FUERTE — bot's classification)
//
//   Razonamiento empírico:
//   - El bot reporta sólo pares con momentum ≥ 3x como candidatos serios
//   - Pares con momentum 1.0-3.0 son ruido (variación natural)
//   - Bajar el umbral metía 50-70 pares espurios al consenso → dilución
//
// Criterios candidatos (v3):
//   countAll     >= 3   (mínimo histórico para señal válida)
//   countRecent  >= 1   (al menos un hit reciente — no inventos)
//   momentum     >= 3.0 (alza fuerte ≥3x — bot's "↑↑↑")
//
// Extracción de pares — idéntica a Ballbot:
//   pick3 du: p2*10 + p3  (decena + unidad)
//   pick4 ab: p1*10 + p2
//   pick4 cd: p3*10 + p4
//
// Ventana: SOLO el draw_type objetivo (como Ballbot validDateKeys(map, period))
//
// Score para el consensus:
//   Normalizado [0,1] via min-max sobre momentum scores entre VÁLIDOS.
//   Pares fuera del filtro → 0.01 (señal mínima, no cero para evitar division-by-zero downstream)
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import type { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';
// DRAWS_CTE_ALL removido: TrendMomentum usa query directa sin filtro draw_type (Ballbot formula)

const logger = pino({ name: 'TrendMomentum' });

const RECENT_WINDOW       = 30;   // ventana reciente — igual que Ballbot
const MIN_COUNT_ALL       = 3;    // mínimo histórico para señal válida
const MIN_COUNT_RECENT    = 1;    // mínimo 1 hit reciente (no inventos en vacío)
const MOMENTUM_THRESHOLD  = 3.0;  // v3: alza FUERTE (bot's "↑↑↑") — antes era 1.0 (demasiado laxo)

export interface MomentumStat {
  pair:         string;
  count_all:    number;
  count_recent: number;
  freq_all:     number;
  freq_recent:  number;
  momentum:     number;
}

export class TrendMomentum {
  constructor(private readonly pool: Pool) {}

  // ── Computa momentum stats para todos los pares ────────────────
  // Usado tanto por runPairs() como por el endpoint de backtesting
  async computeStats(
    game_type: GameType,
    draw_type: DrawType,   // USADO — igual que Ballbot validDateKeys(map, period)
    half: PairHalf
  ): Promise<{ stats: MomentumStat[]; total_all: number; total_recent: number }> {

    // ═══ BALLBOT FORMULA EXACTA — ventana POR draw_type ════════════════════
    // Ballbot usa validDateKeys(map, period, mapSource) que filtra las fechas
    // donde existe ese period (m/e). Histórico = todos los sorteos de ESE turno.
    // Reciente = últimos 30 sorteos de ESE turno.
    //
    // Corrección v2: la ventana combinada (mid+eve) distorsionaba momentum.
    // Un par fuerte de noche inflaba freq_recent de mediodía → momentum falso.
    // Ahora cada turno usa su propia distribución histórica y reciente.
    const { rows: allRows } = await this.pool.query<{
      p1: number; p2: number; p3: number; p4: number;
    }>(
      `SELECT p1, p2, p3, p4
       FROM hitdash.ingested_results
       WHERE game_type  = $1
         AND draw_type  = $2
       ORDER BY draw_date DESC`,
      [game_type, draw_type]
    );

    if (allRows.length === 0) return { stats: [], total_all: 0, total_recent: 0 };

    const total_all    = allRows.length;
    const recentRows   = allRows.slice(0, RECENT_WINDOW);
    const total_recent = recentRows.length;

    const extractPair = (row: { p1: number; p2: number; p3: number; p4: number }): number => {
      if (half === 'ab') return row.p1 * 10 + row.p2;
      if (half === 'cd') return row.p3 * 10 + row.p4;
      return row.p2 * 10 + row.p3; // 'du'
    };

    // Contar por par
    const countAll:    Record<number, number> = {};
    const countRecent: Record<number, number> = {};

    for (const row of allRows) {
      const p = extractPair(row);
      countAll[p] = (countAll[p] ?? 0) + 1;
    }
    for (const row of recentRows) {
      const p = extractPair(row);
      countRecent[p] = (countRecent[p] ?? 0) + 1;
    }

    // Construir stats para todos los pares 00-99
    const stats: MomentumStat[] = [];
    for (let x = 0; x <= 9; x++) {
      for (let y = 0; y <= 9; y++) {
        const n = x * 10 + y;
        const ca = countAll[n]    ?? 0;
        const cr = countRecent[n] ?? 0;

        const fa = total_all    > 0 ? ca / total_all    : 0;
        const fr = total_recent > 0 ? cr / total_recent : 0;

        // Fórmula Ballbot exacta
        let momentum: number;
        if (fa > 0) {
          momentum = fr / fa;
        } else {
          momentum = cr > 0 ? 10 : 0; // nuevo número emergente
        }

        stats.push({
          pair:         `${x}${y}`,
          count_all:    ca,
          count_recent: cr,
          freq_all:     +fa.toFixed(6),
          freq_recent:  +fr.toFixed(6),
          momentum:     +momentum.toFixed(4),
        });
      }
    }

    return { stats, total_all, total_recent };
  }

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,   // ahora propagado a computeStats
    half: PairHalf,
    _period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const flat = (): Record<string, number> => {
      const r: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) r[`${x}${y}`] = 0.01;
      return r;
    };

    try {
      const { stats } = await this.computeStats(game_type, draw_type, half);
      if (!stats.length) return flat();

      // Filtrar (v3 — bot's strict "↑↑↑ alza fuerte"):
      //   mínimo histórico + al menos 1 hit reciente + momentum ≥ 3x
      const valid = stats.filter(s =>
        s.count_all    >= MIN_COUNT_ALL    &&
        s.count_recent >= MIN_COUNT_RECENT &&
        s.momentum     >= MOMENTUM_THRESHOLD
      );

      // ─── FALLBACK: si el filtro estricto deja vacío, relajar a momentum ≥ 1.5
      // para no dejar al consenso completamente ciego en regímenes secos.
      // Solo se activa cuando NO hay ninguna alza fuerte detectable.
      let validForScoring = valid;
      if (!valid.length) {
        validForScoring = stats.filter(s =>
          s.count_all    >= MIN_COUNT_ALL    &&
          s.count_recent >= MIN_COUNT_RECENT &&
          s.momentum     >= 1.5
        );
        if (!validForScoring.length) return flat();
      }

      // Normalizar scores [0,1] por max momentum entre candidatos válidos
      const maxM = Math.max(...validForScoring.map(s => s.momentum), 1e-9);
      const validSet = new Set(validForScoring.map(s => s.pair));
      const scores: Record<string, number> = {};

      for (const s of stats) {
        if (validSet.has(s.pair)) {
          scores[s.pair] = s.momentum / maxM;
        } else {
          scores[s.pair] = 0.01; // no candidato — señal mínima
        }
      }

      logger.debug(
        { game_type, draw_type, half, candidates: valid.length },
        'TrendMomentum: runPairs completado'
      );

      return scores;
    } catch (err) {
      logger.error({ err, game_type, draw_type, half }, 'TrendMomentum: DB error — flat scores');
      return flat();
    }
  }
}
