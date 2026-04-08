// ═══════════════════════════════════════════════════════════════
// HITDASH — ResultComparator v1.0.0
// Compara cartones generados vs resultado real del sorteo
// Calcula hits_exact, hits_partial, accuracy_score por cartón
// ═══════════════════════════════════════════════════════════════

import pino from 'pino';
import type { GameType, LotteryDigits, FeedbackResult } from '../types/agent.types.js';

const logger = pino({ name: 'ResultComparator' });

interface CartonRow {
  id: string;
  game_type: GameType;
  numbers: Array<{ value: string; digits: LotteryDigits }>;
  carton_size: number;
}

export interface ComparisonResult {
  carton_id: string;
  draw_id: string;
  game_type: GameType;
  predicted: LotteryDigits[];   // todos los números del cartón
  actual: LotteryDigits;        // resultado real
  hits_exact: number;           // números que coinciden EXACTAMENTE
  hits_partial: number;         // números con ≥2 dígitos correctos en posición
  accuracy_score: number;       // hits_exact / carton_size
  learning_notes: string;
}

export class ResultComparator {
  // ─── Comparar un cartón contra un resultado real ──────────────
  compare(carton: CartonRow, actual: LotteryDigits, draw_id: string): ComparisonResult {
    const positions = carton.game_type === 'pick3'
      ? (['p1', 'p2', 'p3'] as const)
      : (['p1', 'p2', 'p3', 'p4'] as const);

    let hits_exact = 0;
    let hits_partial = 0;
    const predicted: LotteryDigits[] = [];

    for (const num of carton.numbers) {
      predicted.push(num.digits);

      // Exact match: todos los dígitos en posición correcta
      const isExact = positions.every(
        pos => (num.digits as Record<string, number>)[pos] === (actual as Record<string, number>)[pos]
      );

      if (isExact) {
        hits_exact++;
        continue;
      }

      // Partial: ≥ 2 dígitos correctos en la misma posición
      const matchCount = positions.filter(
        pos => (num.digits as Record<string, number>)[pos] === (actual as Record<string, number>)[pos]
      ).length;

      if (matchCount >= 2) hits_partial++;
    }

    const accuracy_score = carton.carton_size > 0
      ? +(hits_exact / carton.carton_size).toFixed(4)
      : 0;

    // Generar notas de aprendizaje
    const actualStr = positions.map(p => (actual as Record<string, number>)[p]).join('');
    const notes = this.buildLearningNotes(
      carton.game_type,
      hits_exact,
      hits_partial,
      carton.carton_size,
      actualStr,
      carton.numbers.slice(0, 3).map(n => n.value)
    );

    logger.info(
      { carton_id: carton.id, hits_exact, hits_partial, accuracy: accuracy_score },
      'ResultComparator: comparación completada'
    );

    return {
      carton_id: carton.id,
      draw_id,
      game_type: carton.game_type,
      predicted,
      actual,
      hits_exact,
      hits_partial,
      accuracy_score,
      learning_notes: notes,
    };
  }

  // ─── Comparar múltiples cartones ─────────────────────────────
  compareMany(cartones: CartonRow[], actual: LotteryDigits, draw_id: string): ComparisonResult[] {
    return cartones.map(c => this.compare(c, actual, draw_id));
  }

  private buildLearningNotes(
    game_type: GameType,
    hits_exact: number,
    hits_partial: number,
    size: number,
    actualStr: string,
    predictedSamples: string[]
  ): string {
    const pct = size > 0 ? Math.round((hits_exact / size) * 100) : 0;
    const level =
      hits_exact > 0 ? 'HIT' :
      hits_partial >= 2 ? 'PARTIAL_STRONG' :
      hits_partial === 1 ? 'PARTIAL_WEAK' : 'MISS';

    return `${game_type} result=${actualStr} level=${level} exact=${hits_exact}/${size}(${pct}%) partial=${hits_partial} samples=[${predictedSamples.join(',')}]`.slice(0, 500);
  }
}
