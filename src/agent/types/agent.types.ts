// ═══════════════════════════════════════════════════════════════
// HITDASH — Tipos base del agente
// ═══════════════════════════════════════════════════════════════

// ─── Lotería ────────────────────────────────────────────────────
export type GameType = 'pick3' | 'pick4';
export type DrawType = 'midday' | 'evening';

export interface LotteryDigits {
  p1: number;
  p2: number;
  p3: number;
  p4?: number; // solo Pick 4
  [key: string]: number | undefined;
}

export interface LotteryResult {
  id: string;
  game_type: GameType;
  draw_type: DrawType;
  draw_date: Date;
  digits: LotteryDigits;
  created_at: Date;
}

// ─── RAG ────────────────────────────────────────────────────────
export type RagCategory = 'analysis' | 'strategy' | 'learning' | 'pattern';

export interface RagResult {
  id: string;
  content: string;
  category: RagCategory;
  source: string;
  similarity: number;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface StoreKnowledgeInput {
  content: string;
  category: RagCategory;
  source: string;
  confidence?: number;
  metadata?: Record<string, unknown>;
}

// ─── Agente ─────────────────────────────────────────────────────
export type TriggerType = 'cron' | 'manual' | 'fallback';
export type SessionStatus = 'running' | 'completed' | 'failed';
export type ResultStatus = 'pending' | 'hit' | 'partial' | 'miss';
export type AlertType = 'anomaly' | 'streak' | 'overdue' | 'drift' | 'system' | 'low_data';
export type AlertPriority = 'low' | 'medium' | 'high' | 'critical';
export type StrategyStatus = 'active' | 'testing' | 'retired';

export interface AgentTrigger {
  trigger_type: TriggerType;
  game_type: GameType;
  draw_type: DrawType;
  draw_date?: Date;
}

export interface AgentSession {
  id: string;
  trigger_type: TriggerType;
  game_type: GameType;
  draw_type: DrawType;
  context_data: Record<string, unknown>;
  reasoning_chain: unknown[];
  output_data: Record<string, unknown>;
  duration_ms: number;
  model_used: string;
  tokens_in: number;
  tokens_out: number;
  cost_usd: number;
  status: SessionStatus;
  error_message?: string;
  created_at: Date;
}

// ─── Cartones ───────────────────────────────────────────────────
export type CartonSize = 9 | 10 | 16 | 20 | 25;

export interface CartonNumber {
  value: string;          // ej: "472" para Pick3, "4723" para Pick4
  digits: LotteryDigits;
  confidence: number;
  reason: string;
}

export interface Carton {
  id: number;
  game_type: GameType;
  size: CartonSize;
  numbers: CartonNumber[];
  strategy: string;
  confidence_carton: number;
}

// ─── Pair Recommendation (v2 — reemplaza Carton en modo par) ────
// ─── Confidence tiers — decisión magistral ──────────────────────
// must:  top 30% del ranking PPS-ponderado → apostar con convicción
// cover: siguiente 50%                     → cobertura mínima
// watch: último 20%                        → no apostar aún
export interface ConfidenceTiers {
  must:  string[];   // máxima convicción algorítmica
  cover: string[];   // cobertura de borde
  watch: string[];   // borderline — incluidos en N pero sin convicción
}

export interface PairRecommendation {
  game_type:     GameType;
  half:          'du' | 'ab' | 'cd';
  pairs:         string[];       // top-N pares en orden de ranking
  tiers:         ConfidenceTiers; // stratificación de decisión
  centena_plus?: number;
  top_n:         number;
  confidence:    number;         // score promedio normalizado [0,1]
  strategy:      string;
  optimal_n:               number;
  predicted_effectiveness: number;
  cognitive_basis:         string;
}

// ─── Alertas ────────────────────────────────────────────────────
export interface AgentAlert {
  type: AlertType;
  message: string;
  severity: 'low' | 'medium' | 'high';
  game_type?: GameType;
  data?: Record<string, unknown>;
}

// ─── Estrategias ────────────────────────────────────────────────
export interface Strategy {
  id: string;
  name: string;
  description: string;
  algorithm: string;
  parameters: Record<string, unknown>;
  win_rate: number;
  total_tests: number;
  last_evaluated?: Date;
  status: StrategyStatus;
}

// ─── LLM ────────────────────────────────────────────────────────
export type LLMModel = 'gemini-2.5-flash' | 'claude-sonnet-4-6';

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface LLMOptions {
  temperature?: number;
  maxTokens?: number;
  model?: LLMModel;
}

export interface LLMResponse {
  content: string;
  model: LLMModel;
  prompt_tokens: number;
  completion_tokens: number;
  latency_ms: number;
  cost_usd: number;
}

// ─── Feedback ───────────────────────────────────────────────────
export interface FeedbackResult {
  carton_id: string;
  draw_id: string;
  hits_exact: number;
  hits_partial: number;
  accuracy_score: number;
  learning_notes: string;
}

export interface CalibrationResult {
  factor: number;
  calibration_error: number | null;
  window_size: number;
  message?: string;
}

// ─── Briefing (output del agente al LLM) ────────────────────────
export interface AgentBriefingOutput {
  briefing: {
    game_type: GameType;
    draw_type: DrawType;
    draw_date: string;
    analysis_summary: string;
    algorithms_used: string[];
    data_period: string;
    confidence_global: number;
    calibration_factor_applied: number;
  };
  recommended_cartones: Carton[];
  alerts: AgentAlert[];
  disclaimer: string;
}

// ─── Health ─────────────────────────────────────────────────────
export interface HealthStatus {
  status: 'ok' | 'degraded' | 'down';
  timestamp: string;
  checks: {
    database: { ok: boolean; latency_ms: number };
    redis: { ok: boolean; latency_ms: number };
    rag_count: number;
    last_agent_cycle: string | null;
    last_ingestion: string | null;
  };
}
