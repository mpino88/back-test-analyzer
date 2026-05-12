// ═══════════════════════════════════════════════════════════════
// HELIX — AlgorithmDiversityAnalyzer v1.0.0 (PATCH 2026-05-12)
//
// Detecta REDUNDANCIA entre algoritmos del consensus.
// Si 5 algos dan la misma señal, el consensus no es más fuerte —
// es ruido inflado. Este servicio calcula:
//   - Jaccard similarity entre top-N de cada par de algoritmos
//   - Cluster de algoritmos redundantes (similarity > 0.65)
//   - "diversity_score" del consensus actual [0,1]
//
// Uso: post-predicción, log estructurado para análisis.
// Si diversity_score < 0.5 → señal de que algoritmos cluster están
// dominando el ranking final (consensus artificialmente inflado).
// ═══════════════════════════════════════════════════════════════

import pino from 'pino';

const logger = pino({ name: 'AlgorithmDiversityAnalyzer' });

const REDUNDANCY_THRESHOLD = 0.65; // Jaccard > 0.65 = algoritmos redundantes
const DEFAULT_TOP_N        = 15;   // ventana de comparación

export interface AlgoOverlap {
  algo_a:    string;
  algo_b:    string;
  jaccard:   number;  // |A∩B| / |A∪B|
  shared:    number;  // |A∩B|
  redundant: boolean; // jaccard > threshold
}

export interface DiversityReport {
  total_algos:       number;
  overlap_pairs:     AlgoOverlap[];          // sorted by jaccard desc
  redundancy_clusters: string[][];           // grupos de algos con jaccard > 0.65
  diversity_score:   number;                 // [0,1] — 1=máxima diversidad
  recommendation:    'healthy' | 'redundant' | 'collapsed';
}

export class AlgorithmDiversityAnalyzer {

  /**
   * Analiza el ranking de cada algoritmo y detecta redundancia.
   * @param algoScores Map<algo_name, scores: Record<pair, number>>
   * @param topN cuántos pares top considerar (default 15)
   */
  analyze(
    algoScores: Map<string, Record<string, number>>,
    topN: number = DEFAULT_TOP_N
  ): DiversityReport {
    const algos = Array.from(algoScores.keys());
    if (algos.length < 2) {
      return {
        total_algos: algos.length,
        overlap_pairs: [],
        redundancy_clusters: [],
        diversity_score: 1.0,
        recommendation: 'healthy',
      };
    }

    // 1. Extraer top-N de cada algoritmo
    const topSets = new Map<string, Set<string>>();
    for (const a of algos) {
      const scores = algoScores.get(a)!;
      const top = Object.entries(scores)
        .sort(([, x], [, y]) => y - x)
        .slice(0, topN)
        .map(([pair]) => pair);
      topSets.set(a, new Set(top));
    }

    // 2. Jaccard pairwise
    const overlaps: AlgoOverlap[] = [];
    for (let i = 0; i < algos.length; i++) {
      for (let j = i + 1; j < algos.length; j++) {
        const A = topSets.get(algos[i]!)!;
        const B = topSets.get(algos[j]!)!;
        const intersection = new Set([...A].filter(x => B.has(x)));
        const union        = new Set([...A, ...B]);
        const jaccard      = union.size > 0 ? intersection.size / union.size : 0;
        overlaps.push({
          algo_a: algos[i]!,
          algo_b: algos[j]!,
          jaccard: +jaccard.toFixed(3),
          shared: intersection.size,
          redundant: jaccard > REDUNDANCY_THRESHOLD,
        });
      }
    }
    overlaps.sort((a, b) => b.jaccard - a.jaccard);

    // 3. Clustering por redundancia (transitive closure simple)
    const clusters: string[][] = this._buildClusters(algos, overlaps);

    // 4. Diversity score: 1 − fracción de algoritmos en clusters redundantes
    const algosInClusters = new Set<string>();
    for (const cluster of clusters) {
      for (const a of cluster) algosInClusters.add(a);
    }
    const diversity_score = +((1 - algosInClusters.size / algos.length)).toFixed(3);

    const recommendation: DiversityReport['recommendation'] =
      diversity_score >= 0.7 ? 'healthy' :
      diversity_score >= 0.4 ? 'redundant' :
      'collapsed';

    logger.info(
      { total_algos: algos.length, clusters: clusters.length, diversity_score, recommendation },
      'AlgorithmDiversityAnalyzer: análisis completado'
    );

    return {
      total_algos: algos.length,
      overlap_pairs: overlaps.slice(0, 20),  // top 20 mayor solapamiento
      redundancy_clusters: clusters,
      diversity_score,
      recommendation,
    };
  }

  // Union-find clustering
  private _buildClusters(algos: string[], overlaps: AlgoOverlap[]): string[][] {
    const parent = new Map<string, string>();
    for (const a of algos) parent.set(a, a);

    const find = (x: string): string => {
      if (parent.get(x) === x) return x;
      const root = find(parent.get(x)!);
      parent.set(x, root);
      return root;
    };

    const union = (a: string, b: string): void => {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent.set(ra, rb);
    };

    for (const o of overlaps) {
      if (o.redundant) union(o.algo_a, o.algo_b);
    }

    const groups = new Map<string, string[]>();
    for (const a of algos) {
      const r = find(a);
      if (!groups.has(r)) groups.set(r, []);
      groups.get(r)!.push(a);
    }

    // Solo clusters con ≥2 miembros son interesantes
    return Array.from(groups.values()).filter(g => g.length >= 2);
  }
}
