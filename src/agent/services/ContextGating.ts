// ═══════════════════════════════════════════════════════════════
// HELIX — ContextGating v1.0.0 (2026-05-19)
//
// Gating network: computes per-algorithm weight multipliers based
// on the current EVT regime detected by EVTScorer.
//
// PROBLEM SOLVED:
//   In standard consensus, all algorithms have roughly equal weight.
//   When double_triple detects a Hawkes cluster (e.g. 6-6-6-6 after
//   8-8-8-8 17 days prior), it gets averaged out of the top-10.
//   ContextGating amplifies the relevant specialists and suppresses
//   noise algorithms during abnormal regimes.
//
// WEIGHT SEMANTICS:
//   All weights start at 1.0 (neutral). A weight of 2.0 means
//   "treat this algorithm as if it had 2x its normal confidence."
//   The consensus engine multiplies base ALGORITHM_WEIGHTS by these.
//
// REGIME → WEIGHT MAP:
//   HAWKES_QUAD_CLUSTER:   double_triple up to 4x, trend suppressed
//   HAWKES_TRIPLE_CLUSTER: double_triple up to 3x, streak boosted
//   EVT_QUAD_OVERDUE:      double_triple 1.8x
//   EVT_TRIPLE_OVERDUE:    double_triple 1.4x, streak 1.3x
//   NORMAL:                all 1.0 (no adjustment)
// ═══════════════════════════════════════════════════════════════

import { Pool } from 'pg';
import pino from 'pino';
import { EVTScorer, type EVTState } from './EVTScorer.js';
import { MultivariateHawkesAnalyzer } from './MultivariateHawkesAnalyzer.js';
import { CANONICAL_ALGORITHMS } from '../types/analysis.types.js';

const logger = pino({ name: 'ContextGating' });

// ── Public interfaces ──────────────────────────────────────────
export interface GatingWeights {
  weights:          Record<string, number>;  // algo_name → multiplier
  regime:           string;
  regime_strength:  number;
  explanation:      string;
  // ── B3 (2026-05-20): Multivariate Hawkes pair boosts ──
  // pair_boosts[pair] = lift factor cuando hay señal dígito-a-dígito significativa.
  // Solo activado cuando el último sorteo produce un dígito con excitación Bonferroni-confirmada.
  // En NORMAL: vacío. Si hay 1+ par significativo: mapa de boosts por par específico.
  pair_boosts?:     Record<string, number>;
  hawkes_explanation?: string;
}

// ── Default (neutral) weight for any algorithm ────────────────
const NEUTRAL = 1.0;

// ══════════════════════════════════════════════════════════════
export class ContextGating {
  private readonly evtScorer: EVTScorer;
  private readonly hawkesAnalyzer: MultivariateHawkesAnalyzer;

  constructor(private readonly pool: Pool) {
    this.evtScorer       = new EVTScorer(pool);
    this.hawkesAnalyzer  = new MultivariateHawkesAnalyzer(pool);
  }

  // ─── Compute gating weights for current moment ─────────────
  async computeGating(
    game_type:   string,
    draw_type:   string,
    half:        string,
    as_of_date?: string,
  ): Promise<GatingWeights> {
    logger.debug({ game_type, draw_type, half, as_of_date }, 'computeGating start');

    const evt = await this.evtScorer.computeState(game_type, draw_type, as_of_date);

    // Initialise all canonical algorithms at neutral weight
    const weights: Record<string, number> = {};
    for (const algo of CANONICAL_ALGORITHMS) {
      weights[algo] = NEUTRAL;
    }

    let explanation: string;

    switch (evt.regime) {
      case 'HAWKES_QUAD_CLUSTER': {
        // Amplify the double/triple specialist
        const boostDT = 1 + 3.0 * evt.quad_hawkes_intensity;   // 1.0 .. 4.0
        weights['double_triple']    = round2(boostDT);
        // Suppress trend/calendar — less relevant when repetition is the signal
        weights['trend_momentum']    = 0.7;
        weights['trend_momentum_sweet'] = 0.7;
        weights['calendar_pattern']  = 0.5;
        explanation = `HAWKES_QUAD_CLUSTER (intensity=${evt.quad_hawkes_intensity.toFixed(3)}, ` +
          `days_since_quad=${evt.days_since_quad}): ` +
          `double_triple ×${boostDT.toFixed(2)}, trend_momentum ×0.7, calendar_pattern ×0.5`;
        break;
      }

      case 'HAWKES_TRIPLE_CLUSTER': {
        const boostDT = 1 + 2.0 * evt.triple_hawkes_intensity;  // 1.0 .. 3.0
        weights['double_triple']  = round2(boostDT);
        weights['streak']         = 1.5;
        weights['markov_order2']  = 1.3;
        explanation = `HAWKES_TRIPLE_CLUSTER (intensity=${evt.triple_hawkes_intensity.toFixed(3)}, ` +
          `days_since_triple=${evt.days_since_triple}): ` +
          `double_triple ×${boostDT.toFixed(2)}, streak ×1.5, markov_order2 ×1.3`;
        break;
      }

      case 'EVT_QUAD_OVERDUE': {
        weights['double_triple']     = 1.8;
        weights['transition_follow'] = 0.8;   // transitions less predictive when overdue
        explanation = `EVT_QUAD_OVERDUE (days_since_quad=${evt.days_since_quad}): ` +
          `double_triple ×1.8, transition_follow ×0.8`;
        break;
      }

      case 'EVT_TRIPLE_OVERDUE': {
        weights['double_triple'] = 1.4;
        weights['streak']        = 1.3;
        explanation = `EVT_TRIPLE_OVERDUE (days_since_triple=${evt.days_since_triple}): ` +
          `double_triple ×1.4, streak ×1.3`;
        break;
      }

      case 'NORMAL':
      default: {
        explanation = 'NORMAL regime — all weights at 1.0 (no adjustment)';
        break;
      }
    }

    // ── B3 (2026-05-20): Multivariate Hawkes pair-level boosts ──
    // Para pick3, intentamos derivar boosts dígito-a-dígito desde la matriz Hawkes.
    // SOLO se activa cuando hay 1+ par (d_prev, d_curr) Bonferroni-significativo
    // en la posición relevante (p2 para half=du de pick3, p1 para ab de pick4, etc.).
    // Si no hay señal: pair_boosts queda undefined (no aplica).
    let pairBoosts: Record<string, number> | undefined;
    let hawkesExplanation: string | undefined;
    try {
      const result = await this.computePairBoosts(game_type, draw_type, half);
      if (result && Object.keys(result.boosts).length > 0) {
        pairBoosts = result.boosts;
        hawkesExplanation = result.explanation;
      }
    } catch (err) {
      logger.debug({ err: err instanceof Error ? err.message : String(err) },
        'Hawkes pair boosts not available — non-fatal');
    }

    logger.info(
      { game_type, draw_type, half, regime: evt.regime, regime_strength: evt.regime_strength,
        hawkes_pairs: pairBoosts ? Object.keys(pairBoosts).length : 0 },
      'ContextGating computed',
    );

    return {
      weights,
      regime:          evt.regime,
      regime_strength: evt.regime_strength,
      explanation,
      pair_boosts:        pairBoosts,
      hawkes_explanation: hawkesExplanation,
    };
  }

  // ── B3: Multivariate Hawkes → pair-level boosts ──────────────
  // Computa boosts por par específico (no por algoritmo).
  // Aplicable cuando la matriz Hawkes tiene celdas significativas (Bonferroni).
  //
  // FLUJO:
  //   1. Identifica las posiciones de dígito relevantes para el half:
  //      pick3 du = (p2, p3), pick4 ab = (p1, p2), pick4 cd = (p3, p4)
  //   2. Para cada posición, computa la matriz Hawkes y busca pares significativos
  //   3. Lee el último sorteo para obtener los dígitos previos
  //   4. Para cada par "XY" candidato, multiplica boosts si:
  //      - (last_pos1, X) tiene excitación → boost para todos los pares XY
  //      - (last_pos2, Y) tiene excitación → boost para todos los pares XY
  private async computePairBoosts(
    game_type: string,
    draw_type: string,
    half:      string,
  ): Promise<{ boosts: Record<string, number>; explanation: string } | null> {
    // Mapeo half → posiciones de dígito relevantes
    const positionMap: Record<string, ['p1'|'p2'|'p3'|'p4', 'p1'|'p2'|'p3'|'p4']> = {
      'du': ['p2', 'p3'],   // pick3 — par p2p3
      'ab': ['p1', 'p2'],   // pick4 — par p1p2
      'cd': ['p3', 'p4'],   // pick4 — par p3p4
    };
    const positions = positionMap[half];
    if (!positions) return null;
    const [pos1, pos2] = positions;

    // Solo aplicar para pick3 (donde detectamos señal Bonferroni en p1) — empíricamente sustentado
    // Para pick4: NO hay señal multivariada significativa a nivel dígito (confirmed)
    if (game_type !== 'pick3') return null;

    // Computar matriz para ambas posiciones
    const [matrix1, matrix2] = await Promise.all([
      this.hawkesAnalyzer.analyze(game_type as 'pick3'|'pick4', draw_type as 'midday'|'evening', pos1),
      this.hawkesAnalyzer.analyze(game_type as 'pick3'|'pick4', draw_type as 'midday'|'evening', pos2),
    ]);

    // Si ninguna posición tiene señal, no aplica
    if (!matrix1.has_signal && !matrix2.has_signal) return null;

    // Leer el último sorteo para obtener los dígitos previos
    const { rows } = await this.pool.query<{
      [key: string]: number;
    }>(
      `SELECT p1, p2, p3, p4 FROM hitdash.ingested_results
       WHERE game_type = $1 AND draw_type = $2
       ORDER BY draw_date DESC LIMIT 1`,
      [game_type, draw_type],
    );

    const lastDraw = rows[0];
    if (!lastDraw) return null;

    const lastDigit1 = Number(lastDraw[pos1]);
    const lastDigit2 = Number(lastDraw[pos2]);

    if (isNaN(lastDigit1) || isNaN(lastDigit2)) return null;

    // Build pair boosts: para cada par XY ∈ {00..99}
    //   boost[XY] = matrix1[last_d1][X] × matrix2[last_d2][Y]
    // Solo añadir al map si boost se desvía de 1.0 (≥0.95 o ≤1.05)
    const boosts: Record<string, number> = {};
    const significantPairs1 = new Set(matrix1.significant_pairs.map(p => `${p.digit_from}->${p.digit_to}`));
    const significantPairs2 = new Set(matrix2.significant_pairs.map(p => `${p.digit_from}->${p.digit_to}`));

    for (let x = 0; x < 10; x++) {
      for (let y = 0; y < 10; y++) {
        const lift1 = matrix1.excitation_matrix[lastDigit1]?.[x] ?? 1.0;
        const lift2 = matrix2.excitation_matrix[lastDigit2]?.[y] ?? 1.0;

        // Solo aplicar lift si la celda específica fue significativa post-Bonferroni
        const apply1 = significantPairs1.has(`${lastDigit1}->${x}`);
        const apply2 = significantPairs2.has(`${lastDigit2}->${y}`);

        const effectiveLift1 = apply1 ? lift1 : 1.0;
        const effectiveLift2 = apply2 ? lift2 : 1.0;
        const finalBoost = effectiveLift1 * effectiveLift2;

        // Cap conservador: [0.5, 2.0] para evitar over-amplification
        const capped = Math.max(0.5, Math.min(2.0, finalBoost));

        // Solo añadir al map si se desvía ≥5% de neutral
        if (Math.abs(capped - 1.0) >= 0.05) {
          const pairKey = `${x}${y}`;
          boosts[pairKey] = +capped.toFixed(3);
        }
      }
    }

    if (Object.keys(boosts).length === 0) return null;

    const explanation = `Multivariate Hawkes: último ${pos1}=${lastDigit1}, ${pos2}=${lastDigit2}. ` +
      `${Object.keys(boosts).length} pares con boost significativo aplicados ` +
      `(matrix sig: ${matrix1.n_significant}+${matrix2.n_significant} pares Bonferroni).`;

    return { boosts, explanation };
  }

  // Expose EVT state directly for callers that need it
  async getEVTState(
    game_type:   string,
    draw_type:   string,
    as_of_date?: string,
  ): Promise<EVTState> {
    return this.evtScorer.computeState(game_type, draw_type, as_of_date);
  }

  // Expose retrovalidate pass-through
  async retrovalidate(
    game_type: string,
    draw_type: string,
    from_date: string,
    to_date:   string,
  ) {
    return this.evtScorer.retrovalidate(game_type, draw_type, from_date, to_date);
  }
}

// ── Helpers ────────────────────────────────────────────────────
function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
