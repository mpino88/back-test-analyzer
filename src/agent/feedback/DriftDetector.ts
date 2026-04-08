// ═══════════════════════════════════════════════════════════════
// HITDASH — DriftDetector v1.0.0
// Chi-square EXCLUSIVAMENTE (dígitos discretos 0-9, no KS test)
// Compara distribución reciente (30d) vs histórico (365d)
// drift_detected = p_value < 0.05 en ≥ 1 posición
// ═══════════════════════════════════════════════════════════════

import type { Pool } from 'pg';
import pino from 'pino';
import type { GameType, DrawType, LotteryDigits } from '../types/agent.types.js';
import { toDbGame, toDbPeriod, DRAWS_CTE } from '../analysis/ballbotAdapter.js';
import type { Position } from '../types/analysis.types.js';

const logger = pino({ name: 'DriftDetector' });

export interface DriftReport {
  game_type: GameType;
  draw_type: DrawType;
  detected: boolean;
  drifted_positions: Position[];
  details: Array<{
    position: Position;
    chi_square: number;
    p_value: number;
    drift: boolean;
    top_shifted_digit: number;
    shift_direction: 'increase' | 'decrease' | 'none';
  }>;
  recommendation: string;
}

// ─── Chi-square p-value (reutilizado de PositionAnalysis) ──────
function gammaLn(x: number): number {
  const p = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7,
  ];
  let sum = 0.99999999999980993;
  for (let i = 0; i < p.length; i++) sum += p[i]! / (x + i + 1);
  const t = x + p.length - 0.5;
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(sum);
}

function regGammaLower(a: number, x: number): number {
  if (x <= 0) return 0;
  let term = 1.0 / a;
  let sum = term;
  for (let n = 1; n <= 300; n++) {
    term *= x / (a + n);
    sum += term;
    if (Math.abs(term) < 1e-12 * Math.abs(sum)) break;
  }
  return Math.exp(-x + a * Math.log(x) - gammaLn(a)) * sum;
}

function chiSquarePValue(chi2: number, df: number): number {
  if (chi2 <= 0) return 1;
  return Math.max(0, Math.min(1, 1 - regGammaLower(df / 2, chi2 / 2)));
}

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

export class DriftDetector {
  constructor(private readonly ballbotPool: Pool) {}

  async detect(
    game_type: GameType,
    draw_type: DrawType,
    recentDays = 30,
    historicDays = 365
  ): Promise<DriftReport> {
    const positions = POSITIONS[game_type];

    // Obtener ambas ventanas en una sola query
    const { rows } = await this.ballbotPool.query<{ draw_date: Date; digits: LotteryDigits }>(
      `${DRAWS_CTE}
       SELECT draw_date, digits FROM lottery_results ORDER BY draw_date DESC`,
      [toDbGame(game_type), toDbPeriod(draw_type), historicDays]
    );

    const cutoffRecent = new Date(Date.now() - recentDays * 86_400_000);
    const recent   = rows.filter(r => new Date(r.draw_date) >= cutoffRecent);
    const historic = rows; // todo el período histórico

    const n_r = recent.length;
    const n_h = historic.length;

    const details: DriftReport['details'] = [];
    const drifted_positions: Position[] = [];

    for (const pos of positions) {
      // Frecuencias observadas en ambas ventanas
      const recentCounts:   number[] = new Array(10).fill(0) as number[];
      const historicCounts: number[] = new Array(10).fill(0) as number[];

      for (const row of recent) {
        const v = (row.digits as Record<string, number>)[pos];
        if (v !== undefined) recentCounts[v]! += 1;
      }
      for (const row of historic) {
        const v = (row.digits as Record<string, number>)[pos];
        if (v !== undefined) historicCounts[v]! += 1;
      }

      // Chi-square: comparar distribución reciente vs esperada (uniforme basada en histórico)
      // Expected_recent[d] = (historicCounts[d] / n_h) * n_r
      let chi2 = 0;
      if (n_r > 0 && n_h > 0) {
        for (let d = 0; d <= 9; d++) {
          const expected = (historicCounts[d]! / n_h) * n_r;
          if (expected > 0) {
            const diff = recentCounts[d]! - expected;
            chi2 += (diff * diff) / expected;
          }
        }
      }

      const p_value = +chiSquarePValue(chi2, 9).toFixed(4);
      const drift = p_value < 0.05 && n_r >= 10; // mínimo 10 sorteos recientes

      // Encontrar el dígito con mayor desplazamiento
      let maxShift = 0;
      let topShiftedDigit = 0;
      let shiftDirection: 'increase' | 'decrease' | 'none' = 'none';

      if (n_r > 0 && n_h > 0) {
        for (let d = 0; d <= 9; d++) {
          const recentFreq   = recentCounts[d]! / n_r;
          const historicFreq = historicCounts[d]! / n_h;
          const shift = Math.abs(recentFreq - historicFreq);
          if (shift > maxShift) {
            maxShift = shift;
            topShiftedDigit = d;
            shiftDirection = recentFreq > historicFreq ? 'increase' : 'decrease';
          }
        }
      }

      details.push({
        position: pos,
        chi_square: +chi2.toFixed(4),
        p_value,
        drift,
        top_shifted_digit: topShiftedDigit,
        shift_direction: drift ? shiftDirection : 'none',
      });

      if (drift) drifted_positions.push(pos);
    }

    const detected = drifted_positions.length > 0;

    const recommendation = detected
      ? `Drift detectado en ${drifted_positions.join(', ')}. Reducir peso de algoritmos históricos. Priorizar ventana 7-30d.`
      : 'Sin drift significativo. Patrones estables — algoritmos de largo plazo confiables.';

    logger.info(
      { game_type, draw_type, detected, drifted: drifted_positions },
      'DriftDetector: análisis completado'
    );

    return {
      game_type,
      draw_type,
      detected,
      drifted_positions,
      details,
      recommendation,
    };
  }
}
