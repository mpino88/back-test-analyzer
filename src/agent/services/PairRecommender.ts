// ═══════════════════════════════════════════════════════════════
// HITDASH — PairRecommender v1.0.0
// Converts PairAnalysis into PairRecommendation(s) ready for
// Telegram and persistence.
// ═══════════════════════════════════════════════════════════════

import type { PairAnalysis } from '../types/analysis.types.js';
import type { PairRecommendation } from '../types/agent.types.js';

export class PairRecommender {
  /**
   * Single-half recommendation (Pick 3 or one half of Pick 4).
   * topNOverride lets the caller force a specific N (e.g. from LLM validation).
   */
  recommend(analysis: PairAnalysis, topNOverride?: number, validatedPairs?: string[]): PairRecommendation {
    // Cognitive N is the default — the agent self-determines the optimal count.
    const n = topNOverride ?? analysis.optimal_n;
    
    // ═══ COG-10 FIX: Integración de Votos del LLM ═══
    // Si el LLM validó pares específicos, estos se ponen al principio del ranking
    // (preservando el orden estadístico entre ellos). El resto del top-N se llena
    // con los mejores pares del motor estadístico.
    let finalPairs: string[] = [];
    if (validatedPairs && validatedPairs.length > 0) {
      // Filtrar pares que el LLM propuso pero que el motor también conoce
      const llmSet = new Set(validatedPairs);
      const fromLLM = analysis.ranked_pairs
        .filter(r => llmSet.has(r.pair))
        .map(r => r.pair);
      
      const remaining = analysis.ranked_pairs
        .filter(r => !llmSet.has(r.pair))
        .slice(0, Math.max(0, n - fromLLM.length))
        .map(r => r.pair);
      
      finalPairs = [...fromLLM, ...remaining].slice(0, n);
    } else {
      finalPairs = analysis.ranked_pairs.slice(0, n).map(r => r.pair);
    }

    // Confidence = mean score of top-N pairs, normalized against top-1 score
    const topScore = analysis.ranked_pairs[0]?.score ?? 1;
    const topSlice = analysis.ranked_pairs.filter(r => finalPairs.includes(r.pair));

    const avgScore = topScore > 0
      ? topSlice.reduce((sum, r) => sum + r.score, 0) / (topSlice.length || 1) / topScore
      : 0;

    return {
      game_type:               analysis.game_type,
      half:                    analysis.half,
      pairs:                   finalPairs,
      centena_plus:            analysis.centena_plus,
      top_n:                   n,
      confidence:              +Math.min(1, avgScore).toFixed(3),
      strategy:                'apex_consensus_v2',
      optimal_n:               analysis.optimal_n,
      predicted_effectiveness: analysis.predicted_effectiveness,
      cognitive_basis:         analysis.cognitive_basis,
    };
  }

  /**
   * Pick 4: returns two recommendations — AB and CD — as an array.
   * abValidated/cdValidated are arrays of pairs from the LLM.
   */
  recommendPick4(
    abAnalysis: PairAnalysis,
    cdAnalysis: PairAnalysis,
    topNOverride?: number,
    abValidated?: string[],
    cdValidated?: string[]
  ): PairRecommendation[] {
    return [
      this.recommend(abAnalysis, topNOverride, abValidated),
      this.recommend(cdAnalysis, topNOverride, cdValidated),
    ];
  }
}
