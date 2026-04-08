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
  recommend(analysis: PairAnalysis, topNOverride?: number): PairRecommendation {
    // Cognitive N is the default — the agent self-determines the optimal count.
    // topNOverride (e.g. from LLM validation) can still force a specific value.
    const n = topNOverride ?? analysis.optimal_n;
    const topSlice = analysis.ranked_pairs.slice(0, n);

    const pairs = topSlice.map(r => r.pair);

    // Confidence = mean score of top-N pairs, normalized against top-1 score
    const topScore = analysis.ranked_pairs[0]?.score ?? 1;
    const avgScore = topScore > 0
      ? topSlice.reduce((sum, r) => sum + r.score, 0) / topSlice.length / topScore
      : 0;

    return {
      game_type:               analysis.game_type,
      half:                    analysis.half,
      pairs,
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
   * Both use analysis.top_n from their respective PairAnalysis objects.
   */
  recommendPick4(
    abAnalysis: PairAnalysis,
    cdAnalysis: PairAnalysis,
    topNOverride?: number
  ): PairRecommendation[] {
    return [
      this.recommend(abAnalysis, topNOverride),
      this.recommend(cdAnalysis, topNOverride),
    ];
  }
}
