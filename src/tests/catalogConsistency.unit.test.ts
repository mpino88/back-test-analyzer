// ═══════════════════════════════════════════════════════════════
// HELIX — Test: coherencia del catálogo de algoritmos (FIX #7)
//
// Verifica que NINGÚN componente referencia algoritmos eliminados
// ni tiene listas hardcoded que puedan desincronizarse del catálogo
// canónico (CANONICAL_ALGORITHMS).
//
// Si un test falla aquí, significa que añadiste/eliminaste un algo
// sin actualizar todos los puntos de la pipeline. Es un test
// estructural — bloquea regresiones de tipo "fibonacci_pisano vuelve
// a aparecer en pps_state porque alguien no actualizó su array local".
// ═══════════════════════════════════════════════════════════════

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  ALGORITHM_WEIGHTS,
  CANONICAL_ALGORITHMS,
  ELIMINATED_ALGORITHMS,
} from '../agent/types/analysis.types.js';

const SRC_ROOT = join(__dirname, '..', '..', 'src');

function readSrc(relPath: string): string {
  return readFileSync(join(SRC_ROOT, relPath), 'utf8');
}

describe('Catalog consistency — CANONICAL_ALGORITHMS as single source of truth', () => {
  it('CANONICAL_ALGORITHMS has exactly 21 entries', () => {
    expect(CANONICAL_ALGORITHMS).toHaveLength(21);
  });

  it('CANONICAL_ALGORITHMS keys === ALGORITHM_WEIGHTS keys', () => {
    const canonical = new Set(CANONICAL_ALGORITHMS);
    const weights   = new Set(Object.keys(ALGORITHM_WEIGHTS));

    const missing = [...canonical].filter(a => !weights.has(a));
    const extra   = [...weights].filter(a => !canonical.has(a));

    expect(missing, `Algoritmos en CANONICAL pero NO en WEIGHTS: ${missing.join(', ')}`).toHaveLength(0);
    expect(extra,   `Algoritmos en WEIGHTS pero NO en CANONICAL: ${extra.join(', ')}`).toHaveLength(0);
  });

  it('ELIMINATED_ALGORITHMS contains fibonacci_pisano, cycle_detector, mirror_complement', () => {
    expect(ELIMINATED_ALGORITHMS).toContain('fibonacci_pisano');
    expect(ELIMINATED_ALGORITHMS).toContain('cycle_detector');
    expect(ELIMINATED_ALGORITHMS).toContain('mirror_complement');
  });

  it('CANONICAL y ELIMINATED son disjuntos (no overlap)', () => {
    const canonical   = new Set(CANONICAL_ALGORITHMS);
    const eliminated  = new Set(ELIMINATED_ALGORITHMS);
    const intersection = [...canonical].filter(a => eliminated.has(a));
    expect(intersection).toHaveLength(0);
  });
});

describe('Catalog consistency — no hardcoded fibonacci_pisano in active code', () => {
  // Estos archivos NO deben referenciar fibonacci_pisano fuera de comentarios.
  // Si lo hacen, es un legacy code path que podría re-introducirlo.
  const FORBIDDEN_REFS: Array<{ file: string; comment?: string }> = [
    // CognitiveLearner.ALGO_NAMES debe usar CANONICAL_ALGORITHMS (no array local)
    { file: 'agent/learning/CognitiveLearner.ts',
      comment: 'Debe importar de analysis.types.ts, no listar fibonacci_pisano' },
    // AnalysisEngine NO debe correr fibonacci_pisano en analyzePairs
    { file: 'agent/analysis/AnalysisEngine.ts',
      comment: 'Solo en comentarios "removed" — no en código activo' },
  ];

  for (const { file, comment } of FORBIDDEN_REFS) {
    it(`${file}: fibonacci_pisano solo aparece en comentarios (${comment})`, () => {
      const content = readSrc(file);
      const lines = content.split('\n');

      // Buscar líneas que mencionen fibonacci_pisano FUERA de comentarios
      const activeRefs = lines.filter((line, idx) => {
        if (!line.includes('fibonacci_pisano')) return false;
        const trimmed = line.trim();
        // Skip si es comentario de línea o bloque
        if (trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*')) return false;
        // Skip si está dentro de un string literal "describe('fibonacci..."
        // o es parte de un test name
        if (file.includes('.test.')) return false;
        return true;
      });

      expect(activeRefs,
        `Referencias activas a fibonacci_pisano en ${file}:\n${activeRefs.join('\n')}`
      ).toHaveLength(0);
    });
  }
});

describe('Catalog consistency — SnapshotBackfillService scoreForDate covers all 21 algos', () => {
  it('SnapshotBackfillService implementa una scoreXYZ function por cada algoritmo canónico', () => {
    const content = readSrc('agent/services/SnapshotBackfillService.ts');
    // Buscar todas las definiciones async function scoreXYZ
    const matches = Array.from(content.matchAll(/^async function (score\w+)\(/gm));
    const implementedFns = matches.map(m => m[1]!);

    // Mapeo algo_name → función esperada (camelCase de cada algoritmo)
    const expectedFns: Record<string, string> = {
      'frequency':            'scoreFrequency',
      'hot_cold':             'scoreHotCold',
      'gap_analysis':         'scoreGapAnalysis',
      'calendar_pattern':     'scoreCalendarPattern',
      'markov_order2':        'scoreMarkovOrder2',
      'transition_follow':    'scoreTransitionFollow',
      'decade_family':        'scoreDecadeFamily',
      'max_per_week_day':     'scoreMaxPerWeekDay',
      'pairs_correlation':    'scorePairsCorrelation',
      'streak':               'scoreStreak',
      'position':             'scorePosition',
      'moving_averages':      'scoreMovingAverages',
      'bayesian_score':       'scoreBayesianScore',
      'pair_return_cycle':    'scorePairReturnCycle',
      'sum_pattern_filter':   'scoreSumPatternFilter',
      'double_triple':        'scoreDoubleTriple',
      'cross_draw':           'scoreCrossDraw',
      'trend_momentum':       'scoreTrendMomentum',
      'trend_momentum_sweet': 'scoreTrendMomentumSweet',
      'est_individuales':     'scoreEstIndividuales',
      'terminal_analysis':    'scoreTerminalAnalysis',
    };

    for (const algo of CANONICAL_ALGORITHMS) {
      const expectedFn = expectedFns[algo];
      expect(expectedFn, `No expected function name registered for ${algo}`).toBeDefined();
      expect(implementedFns, `SnapshotBackfillService falta función ${expectedFn} para ${algo}`)
        .toContain(expectedFn!);
    }
  });
});
