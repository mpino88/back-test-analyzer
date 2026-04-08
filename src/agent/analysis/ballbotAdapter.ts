// ═══════════════════════════════════════════════════════════════
// HITDASH — BallbotAdapter
// Normaliza el schema real de Ballbot (public.draws) al formato
// interno esperado por los 8 algoritmos.
//
// Schema real Ballbot:
//   game   : 'p3' | 'p4'
//   period : 'm' | 'e'
//   numbers: '9,8,5'  (CSV string)
//   date   : '03/22/26' (MM/DD/YY)
//   created_at: timestamptz
// ═══════════════════════════════════════════════════════════════

import type { GameType, DrawType } from '../types/agent.types.js';

export function toDbGame(game_type: GameType): string {
  return game_type === 'pick3' ? 'p3' : 'p4';
}

export function toDbPeriod(draw_type: DrawType): string {
  return draw_type === 'midday' ? 'm' : 'e';
}

/**
 * CTE que normaliza public.draws al formato lottery_results.
 * Parámetros posicionales: $1=game, $2=period, $3=period_days
 * Uso: prependear a cualquier SELECT ... FROM lottery_results
 */
export const DRAWS_CTE = `
WITH lottery_results AS (
  SELECT
    created_at::date AS draw_date,
    jsonb_build_object(
      'p1', split_part(numbers, ',', 1)::int,
      'p2', split_part(numbers, ',', 2)::int,
      'p3', split_part(numbers, ',', 3)::int,
      'p4', CASE WHEN game = 'p4' THEN split_part(numbers, ',', 4)::int ELSE NULL END
    ) AS digits
  FROM public.draws
  WHERE game = $1
    AND period = $2
    AND created_at >= now() - ($3 || ' days')::interval
)`;

/**
 * Variante sin date filter cuando el algoritmo quiere filtrar manualmente.
 * Parámetros: $1=game, $2=period
 */
export const DRAWS_CTE_ALL = `
WITH lottery_results AS (
  SELECT
    created_at::date AS draw_date,
    created_at,
    jsonb_build_object(
      'p1', split_part(numbers, ',', 1)::int,
      'p2', split_part(numbers, ',', 2)::int,
      'p3', split_part(numbers, ',', 3)::int,
      'p4', CASE WHEN game = 'p4' THEN split_part(numbers, ',', 4)::int ELSE NULL END
    ) AS digits
  FROM public.draws
  WHERE game = $1
    AND period = $2
    AND created_at >= now() - interval '1095 days'
)`;
