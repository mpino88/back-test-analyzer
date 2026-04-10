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
  return game_type; // Se guardan como 'pick3' o 'pick4'
}

export function toDbPeriod(draw_type: DrawType): string {
  return draw_type; // Se guardan como 'midday' o 'evening'
}

/**
 * ═══ x10 PRO OPTIMIZATION ═══
 * CTE que lee de la base de datos LOCAL (hitdash.ingested_results)
 * con dígitos ya parseados. Elimina la latencia de red externa y el split_part cost.
 */
export const DRAWS_CTE = `
WITH lottery_results AS (
  SELECT
    draw_date,
    jsonb_build_object(
      'p1', p1,
      'p2', p2,
      'p3', p3,
      'p4', p4
    ) AS digits
  FROM hitdash.ingested_results
  WHERE game_type = $1
    AND draw_type = $2
    AND draw_date >= CURRENT_DATE - ($3 || ' days')::interval
)`;

export const DRAWS_CTE_ALL = `
WITH lottery_results AS (
  SELECT
    draw_date,
    jsonb_build_object(
      'p1', p1,
      'p2', p2,
      'p3', p3,
      'p4', p4
    ) AS digits
  FROM hitdash.ingested_results
  WHERE game_type = $1
    AND draw_type = $2
    AND draw_date >= CURRENT_DATE - interval '1095 days'
)`;
