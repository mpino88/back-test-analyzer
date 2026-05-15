// ═══════════════════════════════════════════════════════════════
// HELIX — TrendMomentumSweetSpot v1.0 (2026-05-14)
//
// "EMERGING SWEET SPOT" — variante quirúrgica de TrendMomentum.
//
// HIPÓTESIS EMPÍRICA (validada por el usuario observando el bot):
//   El bracket más predictivo del top-15 de Fuerza de Tendencia Pro
//   son los pares que cumplen TODOS:
//     - count_recent == 1   (1 hit en últimos 30 — "emergiendo")
//     - momentum     >= 3.0 (alza fuerte ≥3x baseline histórico)
//     - count_all    >= 3   (historial mínimo validado)
//
//   Estos pares están en el "punto óptimo señal/ruido":
//     - No son outliers ya quemados (count_recent ≥ 3 = mean reversion)
//     - No son ruido sin historia (count_all < 3)
//     - No son falsos positivos (momentum < 3x = variación natural)
//
// RELACIÓN CON TrendMomentum CLÁSICO:
//   - TrendMomentum (v3):    momentum ≥ 3.0  ∧  count_recent ≥ 1  → ~12-15 candidatos
//   - TrendMomentumSweetSpot: momentum ≥ 3.0 ∧ count_recent == 1  → ~10-12 candidatos
//
//   El Sweet Spot es un SUBCONJUNTO estricto del trend_momentum endurecido.
//   Si la hipótesis es correcta, su hit_rate debería ser SUPERIOR al de
//   trend_momentum clásico (porque excluye los outliers de alta Rec%).
//
// FALLBACK GRACEFUL:
//   Si el filtro estricto deja vacío (régimen sin pares emergentes),
//   se relaja primero a count_recent ≤ 2, luego a count_recent ≤ 3.
//   Si todo falla → 0.01 en todos los pares (señal mínima al consenso).
//
// EVALUACIÓN VIA CHAMPION MODE:
//   Este algoritmo compite con TrendMomentum en algo_rank_history.
//   Si su hit_rate reciente supera 0.30, Champion Mode lo elevará
//   automáticamente al 60% del peso del consenso.
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType } from '../../types/agent.types.js';
import type { AnalysisPeriod, PairHalf } from '../../types/analysis.types.js';
import { TrendMomentum } from './TrendMomentum.js';

const logger = pino({ name: 'TrendMomentumSweetSpot' });

const RECENT_WINDOW       = 30;
const MIN_COUNT_ALL       = 3;
const MOMENTUM_THRESHOLD  = 3.0;          // alza fuerte (matching bot)
const SWEET_SPOT_TARGET   = 1;            // EXACTAMENTE 1 hit reciente
const FALLBACK_MAX_RECENT = [2, 3];       // si vacío, relajar progresivamente

export class TrendMomentumSweetSpot {
  private readonly base: TrendMomentum;

  constructor(pool: Pool) {
    this.base = new TrendMomentum(pool);
  }

  async runPairs(
    game_type: GameType,
    draw_type: DrawType,
    half: PairHalf,
    _period: AnalysisPeriod = 90
  ): Promise<Record<string, number>> {
    const flat = (): Record<string, number> => {
      const r: Record<string, number> = {};
      for (let x = 0; x <= 9; x++) for (let y = 0; y <= 9; y++) r[`${x}${y}`] = 0.01;
      return r;
    };

    try {
      const { stats } = await this.base.computeStats(game_type, draw_type, half);
      if (!stats.length) return flat();

      // ── FILTRO PRIMARIO: sweet spot estricto ────────────────────
      // count_recent == 1 AND momentum >= 3 AND count_all >= 3
      let valid = stats.filter(s =>
        s.count_all    >= MIN_COUNT_ALL      &&
        s.count_recent === SWEET_SPOT_TARGET &&
        s.momentum     >= MOMENTUM_THRESHOLD
      );

      let regime: 'strict' | 'relaxed_2' | 'relaxed_3' | 'fallback' = 'strict';

      // ── FALLBACK 1: relajar a count_recent ≤ 2 ──────────────────
      if (!valid.length) {
        valid = stats.filter(s =>
          s.count_all    >= MIN_COUNT_ALL                  &&
          s.count_recent >= 1 && s.count_recent <= FALLBACK_MAX_RECENT[0]! &&
          s.momentum     >= MOMENTUM_THRESHOLD
        );
        regime = 'relaxed_2';
      }

      // ── FALLBACK 2: relajar a count_recent ≤ 3 ──────────────────
      if (!valid.length) {
        valid = stats.filter(s =>
          s.count_all    >= MIN_COUNT_ALL                  &&
          s.count_recent >= 1 && s.count_recent <= FALLBACK_MAX_RECENT[1]! &&
          s.momentum     >= MOMENTUM_THRESHOLD
        );
        regime = 'relaxed_3';
      }

      // ── FALLBACK 3: vacío → señal plana mínima ──────────────────
      if (!valid.length) {
        logger.info({ game_type, draw_type, half }, 'SweetSpot: sin candidatos en ningún régimen, retorna flat');
        return flat();
      }

      // ── Normalizar scores [0,1] entre candidatos válidos ────────
      const maxM = Math.max(...valid.map(s => s.momentum), 1e-9);
      const validSet = new Set(valid.map(s => s.pair));
      const scores: Record<string, number> = {};
      for (const s of stats) {
        scores[s.pair] = validSet.has(s.pair) ? s.momentum / maxM : 0.01;
      }

      logger.debug(
        {
          game_type, draw_type, half,
          regime, candidates: valid.length,
          top: valid.slice(0, 5).map(s => `${s.pair}(${s.momentum.toFixed(1)}x,rec=${s.count_recent})`),
        },
        'TrendMomentumSweetSpot: runPairs completado'
      );

      return scores;
    } catch (err) {
      logger.error({ err, game_type, draw_type, half }, 'TrendMomentumSweetSpot: DB error — flat scores');
      return flat();
    }
  }
}
