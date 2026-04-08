// ═══════════════════════════════════════════════════════════════
// HITDASH — CartonGenerator v1.0.0
// Genera cartones desde ComprehensiveAnalysis + validación LLM
// Producto cartesiano de top dígitos por posición → score → selección
// ═══════════════════════════════════════════════════════════════

import pino from 'pino';
import type { GameType, DrawType, Carton, CartonNumber, CartonSize, LotteryDigits } from '../types/agent.types.js';
import type { ComprehensiveAnalysis, ConsensusScore, Position } from '../types/analysis.types.js';

const logger = pino({ name: 'CartonGenerator' });

const POSITIONS: Record<GameType, Position[]> = {
  pick3: ['p1', 'p2', 'p3'],
  pick4: ['p1', 'p2', 'p3', 'p4'],
};

// Top N digits to consider per position in the cartesian product
const POOL_SIZE = 5;

interface Combination {
  digits: LotteryDigits;
  value: string;
  score: number;
  reasons: string[];
}

export class CartonGenerator {
  // ─── Generar cartones desde análisis ─────────────────────────
  generate(
    analysis: ComprehensiveAnalysis,
    size: CartonSize,
    draw_type: DrawType,
    llmValidated?: Record<Position, number[]>  // override opcional del LLM
  ): Carton {
    const { game_type } = analysis;
    const positions = POSITIONS[game_type];

    // Usar recomendaciones del LLM si están disponibles, sino las del motor
    const digitPool: Record<Position, ConsensusScore[]> = {} as Record<Position, ConsensusScore[]>;

    for (const pos of positions) {
      const allScores = analysis.by_position[pos]?.consensus_scores ?? [];

      if (llmValidated?.[pos]?.length) {
        // LLM validó y posiblemente amplió la selección
        const llmDigits = llmValidated[pos]!;
        // Reordenar scores poniendo los dígitos LLM primero
        const llmSet = new Set(llmDigits);
        const llmScores = allScores.filter(s => llmSet.has(s.digit));
        const rest = allScores.filter(s => !llmSet.has(s.digit));
        digitPool[pos] = [...llmScores, ...rest].slice(0, POOL_SIZE);
      } else {
        digitPool[pos] = allScores.slice(0, POOL_SIZE);
      }
    }

    // ─── Producto cartesiano ─────────────────────────────────────
    const combinations = this.cartesianProduct(positions, digitPool, game_type);

    // ─── Ordenar por score y seleccionar top `size` ──────────────
    combinations.sort((a, b) => b.score - a.score);

    // Asegurar diversidad: no más de 3 números con el mismo dígito en p1
    const diverse = this.diversify(combinations, size, positions);

    // ─── Construir Carton ────────────────────────────────────────
    const numbers: CartonNumber[] = diverse.map((combo, idx) => ({
      value: combo.value,
      digits: combo.digits,
      confidence: +Math.min(combo.score, 1.0).toFixed(3),
      reason: combo.reasons.slice(0, 2).join(' | '),
    }));

    const confidence_carton = numbers.length > 0
      ? +(numbers.reduce((a, n) => a + n.confidence, 0) / numbers.length).toFixed(3)
      : 0;

    logger.info(
      { game_type, draw_type, size, confidence: confidence_carton },
      'CartonGenerator: cartón generado'
    );

    return {
      id: Date.now(),
      game_type,
      size,
      numbers,
      strategy: llmValidated ? 'consensus_llm' : 'consensus_top',
      confidence_carton,
    };
  }

  // ─── Producto cartesiano de dígitos por posición ─────────────
  private cartesianProduct(
    positions: Position[],
    pool: Record<Position, ConsensusScore[]>,
    game_type: GameType
  ): Combination[] {
    // Start with single-digit combinations for first position
    let combos: Array<{ scores: ConsensusScore[]; positions: Position[] }> = (pool[positions[0]!] ?? []).map(s => ({
      scores: [s],
      positions: [positions[0]!],
    }));

    // Extend to subsequent positions
    for (let i = 1; i < positions.length; i++) {
      const pos = positions[i]!;
      const posPool = pool[pos] ?? [];
      const extended: typeof combos = [];

      for (const combo of combos) {
        for (const score of posPool) {
          extended.push({
            scores: [...combo.scores, score],
            positions: [...combo.positions, pos],
          });
        }
      }
      combos = extended;
    }

    return combos.map(combo => {
      const digits: Record<string, number> = {};
      const reasons: string[] = [];
      let totalScore = 0;

      for (let i = 0; i < positions.length; i++) {
        const pos = positions[i]!;
        const sc  = combo.scores[i]!;
        digits[pos] = sc.digit;
        totalScore += sc.consensus_score;

        const topSignal = sc.signals[0];
        if (topSignal) {
          reasons.push(`${pos}=${sc.digit}(${topSignal.algorithm}:${topSignal.score.toFixed(2)})`);
        }
      }

      const avgScore = positions.length > 0 ? totalScore / positions.length : 0;
      const value = game_type === 'pick3'
        ? `${digits['p1']}${digits['p2']}${digits['p3']}`
        : `${digits['p1']}${digits['p2']}${digits['p3']}${digits['p4']}`;

      return {
        digits: digits as unknown as LotteryDigits,
        value,
        score: +avgScore.toFixed(4),
        reasons,
      };
    });
  }

  // ─── Diversificación: evitar clustering en p1 ────────────────
  private diversify(
    combos: Combination[],
    size: CartonSize,
    positions: Position[]
  ): Combination[] {
    const selected: Combination[] = [];
    const p1Count = new Map<number, number>();
    const maxPerP1 = Math.ceil(size / 4); // max ~25% del cartón con el mismo p1

    for (const combo of combos) {
      if (selected.length >= size) break;
      const p1Val = (combo.digits as Record<string, number>)[positions[0]!] ?? 0;
      const count = p1Count.get(p1Val) ?? 0;

      if (count < maxPerP1) {
        selected.push(combo);
        p1Count.set(p1Val, count + 1);
      }
    }

    // Si no hay suficientes con diversidad, completar con los de mayor score
    if (selected.length < size) {
      const selectedValues = new Set(selected.map(c => c.value));
      for (const combo of combos) {
        if (selected.length >= size) break;
        if (!selectedValues.has(combo.value)) {
          selected.push(combo);
          selectedValues.add(combo.value);
        }
      }
    }

    return selected;
  }

  // ─── Múltiples cartones con estrategias distintas ────────────
  generateMultiple(
    analysis: ComprehensiveAnalysis,
    sizes: CartonSize[],
    draw_type: DrawType,
    llmValidated?: Record<Position, number[]>
  ): Carton[] {
    return sizes.map(size => this.generate(analysis, size, draw_type, llmValidated));
  }
}
