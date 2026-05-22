// ═══════════════════════════════════════════════════════════════
// HELIX × Ballbot Mirror — Types v1.0.0 (2026-05-22)
//
// Réplica espejo de las 18+ estrategias de Ballbot dentro de HELIX,
// usando hitdash.ingested_results como fuente de datos (los mismos
// que Ballbot consume).
//
// FILOSOFÍA:
//   • SIN tocar el código de Ballbot
//   • Output formato similar al bot original
//   • Backtest retrospectivo individual por estrategia (5 años)
//   • Comparación HONESTA contra ganadores reales
//   • Transparencia matemática como diferenciador
// ═══════════════════════════════════════════════════════════════

export type GameType  = 'pick3' | 'pick4';
export type DrawType  = 'midday' | 'evening';
export type PairHalf  = 'du' | 'ab' | 'cd';

/**
 * Catálogo único de estrategias Ballbot replicadas.
 *
 *   ballbot_id : identificador en Ballbot (snake_case)
 *   helix_id   : algoritmo canónico equivalente en HELIX (si existe)
 *   status     : 'canonical' (usa HELIX algo) | 'mirror_only' (solo Ballbot, no en consenso HELIX)
 *   bot_title  : título exacto del bot ("Estrategia 5 — Fuerza de Tendencia Pro")
 *   emoji      : ícono usado por el bot
 */
export interface BallbotStrategyMeta {
  ballbot_id:  string;
  helix_id:    string | null;
  status:      'canonical' | 'mirror_only';
  bot_title:   string;
  emoji:       string;
  description: string;
}

export const BALLBOT_STRATEGIES: BallbotStrategyMeta[] = [
  // ─── ESTRATEGIAS QUE EXISTEN EN HELIX (14 canónicas) ─────────────
  {
    ballbot_id: 'freq_analysis', helix_id: 'frequency',
    status: 'canonical',
    bot_title: 'Radar de Frecuencias Absoluta',
    emoji: '🎯',
    description: 'Cuántas veces ha salido cada número en el histórico total.',
  },
  {
    ballbot_id: 'gap_due', helix_id: 'gap_analysis',
    status: 'canonical',
    bot_title: 'Números Debidos (Gap Analysis)',
    emoji: '⏳',
    description: 'Números con gap > average → debidos a salir.',
  },
  {
    ballbot_id: 'calendar_pattern', helix_id: 'calendar_pattern',
    status: 'canonical',
    bot_title: 'Reloj de Probabilidades',
    emoji: '📅',
    description: 'Patrones por día de semana, mes, día del mes y combinaciones.',
  },
  {
    ballbot_id: 'transition_follow', helix_id: 'transition_follow',
    status: 'canonical',
    bot_title: 'Rastreador de Secuencias (Markov-1)',
    emoji: '🔗',
    description: 'Dado el sorteo anterior, qué tiende a aparecer.',
  },
  {
    ballbot_id: 'trend_momentum', helix_id: 'trend_momentum',
    status: 'canonical',
    bot_title: 'Fuerza de Tendencia Pro',
    emoji: '📈',
    description: 'Momentum = freq_reciente(30) / freq_histórica. Detecta números en alza.',
  },
  {
    ballbot_id: 'positional_analysis', helix_id: 'position',
    status: 'canonical',
    bot_title: 'Radiografía Posicional',
    emoji: '🎯',
    description: 'Frecuencia por posición (centena, decena, unidad).',
  },
  {
    ballbot_id: 'streak_analysis', helix_id: 'streak',
    status: 'canonical',
    bot_title: 'Detector de Rachas Pro',
    emoji: '🔥',
    description: 'Hot streaks + cold-streak due factor.',
  },
  {
    ballbot_id: 'bayesian_score', helix_id: 'bayesian_score',
    status: 'canonical',
    bot_title: 'Score Probabilístico Bayesiano',
    emoji: '🧠',
    description: 'Combinación ponderada de 6 señales: freq, gap, momentum, ciclo, Markov, streak.',
  },
  {
    ballbot_id: 'markov_order2', helix_id: 'markov_order2',
    status: 'canonical',
    bot_title: 'Cadena de IA Predictiva Pro (Markov-2)',
    emoji: '🔮',
    description: 'Cadena de Markov de orden 2: P(siguiente | últimos dos).',
  },
  {
    ballbot_id: 'decade_family', helix_id: 'decade_family',
    status: 'canonical',
    bot_title: 'Análisis de Bloques Ganadores (Familias)',
    emoji: '🏷',
    description: 'Momentum + due por familia D0..D9 (00-09, 10-19, ...).',
  },
  {
    ballbot_id: 'terminal_analysis', helix_id: 'terminal_analysis',
    status: 'canonical',
    bot_title: 'Cierres Perfectos (Terminales)',
    emoji: '🎚',
    description: 'Análisis del último dígito (terminal). Momentum + due.',
  },
  {
    ballbot_id: 'max_per_week_day', helix_id: 'max_per_week_day',
    status: 'canonical',
    bot_title: 'Maximizador por Día de Semana',
    emoji: '📊',
    description: 'Top N por DoW del próximo sorteo estimado.',
  },
  {
    ballbot_id: 'est_individuales', helix_id: 'est_individuales',
    status: 'canonical',
    bot_title: 'Estadísticas Individuales',
    emoji: '📈',
    description: 'Solo Pick3. Hot por proximidad al máximo histórico.',
  },
  {
    ballbot_id: 'pairs_correlation', helix_id: 'pairs_correlation',
    status: 'canonical',
    bot_title: 'Correlación de Pares',
    emoji: '🔀',
    description: 'P(X,Y) vs P(X)·P(Y). Detecta dependencia entre posiciones del par.',
  },

  // ─── ESTRATEGIAS BALLBOT-ONLY (no en consenso HELIX) ─────────────
  {
    ballbot_id: 'cycle_detector', helix_id: null,
    status: 'mirror_only',
    bot_title: 'Radar de Ciclos Pro y Periodicidad',
    emoji: '🔄',
    description: 'Detecta ciclos con band-tolerance ±20% y concentración ≥22%.',
  },
  {
    ballbot_id: 'mirror_complement', helix_id: null,
    status: 'mirror_only',
    bot_title: 'Sincronía Oculta (Espejo)',
    emoji: '🪞',
    description: 'Detecta correlación entre número y su espejo/complemento (47↔74, 99-n).',
  },
  {
    ballbot_id: 'unodostres', helix_id: null,
    status: 'mirror_only',
    bot_title: 'Resonancia Temporal Fibonacci',
    emoji: '🔢',
    description: 'Score = exp(-(t-F_n)²/(2σ²)) sobre serie Fibonacci [1,2,3,5,8,13,21,34,55,89,144].',
  },
  {
    ballbot_id: 'unodostres_plus', helix_id: null,
    status: 'mirror_only',
    bot_title: 'Fibonacci PLUS (Combinado M+E)',
    emoji: '✨',
    description: 'Variante con período combinado (mediodía + noche) y top-N dinámico.',
  },
];

export interface BallbotStrategyResult {
  ballbot_id:  string;
  helix_id:    string | null;
  status:      'canonical' | 'mirror_only';
  bot_title:   string;
  emoji:       string;
  candidates:  string[];           // top-N pares (formato '00'-'99')
  scores:      Record<string, number>;  // par → score normalizado [0,1]
  // Backtest retrospectivo (cuando disponible)
  retrospective?: {
    n_total:     number;
    hits_at_15:  number;
    hits_at_25:  number;
    hit_rate_15: number;
    hit_rate_25: number;
    wilson_lo_15: number;
    wilson_hi_15: number;
    edge_15_pp:  number;          // hit_rate_15 - 0.15 (en pp)
    edge_25_pp:  number;          // hit_rate_25 - 0.25
  } | null;
  // Metadata adicional
  generated_at: string;
  window_recent: number;          // típicamente 30 (sorteos recientes)
  total_history: number;
}

export interface MirrorRunRequest {
  game_type: GameType;
  draw_type: DrawType;
  half:      PairHalf;
  top_n?:    number;
  as_of?:    string;             // YYYY-MM-DD — point-in-time
}

export interface MirrorRunResponse {
  game_type:    GameType;
  draw_type:    DrawType;
  half:         PairHalf;
  as_of:        string;
  top_n:        number;
  total_draws:  number;
  generated_at: string;
  strategies:   BallbotStrategyResult[];
  // Comparación
  helix_consensus: {
    top_pairs:   string[];
    algo_leader: string | null;
    edge_x:      number | null;
    disclosure:  string;
  } | null;
}
