// ═══════════════════════════════════════════════════════════════
// HITDASH — LLMRouter v1.0.0
// Primary: gemini-2.5-flash | Fallback: claude-sonnet-4-6
// Circuit breaker: 5 fallos consecutivos → OPEN 120s
// ═══════════════════════════════════════════════════════════════

import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import pino from 'pino';
import type { LLMModel, Message, LLMOptions, LLMResponse } from '../types/agent.types.js';

const logger = pino({ name: 'LLMRouter' });

// Cost per 1M tokens (USD)
const COST_PER_MTK: Record<LLMModel, { input: number; output: number }> = {
  'gemini-2.5-flash': { input: 0.075, output: 0.30 },
  'claude-sonnet-4-6': { input: 3.0,   output: 15.0  },
};

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

export class LLMRouter {
  private state: CircuitState = 'CLOSED';
  private failureCount = 0;
  private openedAt: number | null = null;

  private readonly FAILURE_THRESHOLD = 5;
  private readonly OPEN_DURATION_MS  = 120_000; // 2 min

  private get isCircuitOpen(): boolean {
    if (this.state === 'OPEN') {
      if (Date.now() - (this.openedAt ?? 0) >= this.OPEN_DURATION_MS) {
        this.state = 'HALF_OPEN';
        logger.info('Circuit breaker → HALF_OPEN: probando Gemini');
        return false;
      }
      return true;
    }
    return false;
  }

  private onSuccess(): void {
    this.failureCount = 0;
    if (this.state !== 'CLOSED') {
      this.state = 'CLOSED';
      logger.info('Circuit breaker → CLOSED: Gemini recuperado');
    }
  }

  private onFailure(): void {
    this.failureCount++;
    if (this.failureCount >= this.FAILURE_THRESHOLD) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      logger.warn({ failures: this.failureCount }, 'Circuit breaker → OPEN: usando Claude como fallback');
    }
  }

  // ─── Gemini 2.5 Flash ────────────────────────────────────────
  private async callGemini(
    messages: Message[],
    opts: LLMOptions
  ): Promise<LLMResponse> {
    const apiKey = process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

    const ai = new GoogleGenAI({ apiKey });
    const model: LLMModel = 'gemini-2.5-flash';
    const startMs = Date.now();

    // Build Gemini contents from messages
    // System message → system instruction, rest → contents
    const systemMsg = messages.find(m => m.role === 'system');
    const userMessages = messages.filter(m => m.role !== 'system');

    const contents = userMessages.map(m => ({
      role: m.role as 'user' | 'model',
      parts: [{ text: m.content }],
    }));

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents,
      config: {
        systemInstruction: systemMsg?.content,
        temperature: opts.temperature ?? 0.4,
        maxOutputTokens: opts.maxTokens ?? 4096,
      },
    });

    const content = response.text ?? '';
    const promptTokens     = response.usageMetadata?.promptTokenCount     ?? 0;
    const completionTokens = response.usageMetadata?.candidatesTokenCount ?? 0;
    const costs = COST_PER_MTK[model];
    const cost_usd = (promptTokens * costs.input + completionTokens * costs.output) / 1_000_000;

    return {
      content,
      model,
      prompt_tokens:     promptTokens,
      completion_tokens: completionTokens,
      latency_ms:        Date.now() - startMs,
      cost_usd:          +cost_usd.toFixed(6),
    };
  }

  // ─── Claude Sonnet 4.6 (fallback) ────────────────────────────
  private async callClaude(
    messages: Message[],
    opts: LLMOptions
  ): Promise<LLMResponse> {
    const apiKey = process.env['ANTHROPIC_API_KEY'];
    if (!apiKey) throw new Error('ANTHROPIC_API_KEY no configurada');

    const client = new Anthropic({ apiKey });
    const model: LLMModel = 'claude-sonnet-4-6';
    const startMs = Date.now();

    const systemMsg = messages.find(m => m.role === 'system')?.content;
    const chatMessages = messages
      .filter(m => m.role !== 'system')
      .map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const response = await client.messages.create({
      model: 'claude-sonnet-4-6',
      max_tokens: opts.maxTokens ?? 4096,
      temperature: opts.temperature ?? 0.4,
      system: systemMsg,
      messages: chatMessages,
    });

    const content = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const promptTokens     = response.usage.input_tokens;
    const completionTokens = response.usage.output_tokens;
    const costs = COST_PER_MTK[model];
    const cost_usd = (promptTokens * costs.input + completionTokens * costs.output) / 1_000_000;

    return {
      content,
      model,
      prompt_tokens:     promptTokens,
      completion_tokens: completionTokens,
      latency_ms:        Date.now() - startMs,
      cost_usd:          +cost_usd.toFixed(6),
    };
  }

  // ─── Punto de entrada principal ──────────────────────────────
  async complete(messages: Message[], opts: LLMOptions = {}): Promise<LLMResponse> {
    // Primary: Gemini (si circuit no está abierto)
    if (!this.isCircuitOpen) {
      try {
        const result = await this.callGemini(messages, opts);
        this.onSuccess();
        logger.info(
          { model: result.model, tokens_in: result.prompt_tokens, tokens_out: result.completion_tokens, cost: result.cost_usd },
          'LLM completado'
        );
        return result;
      } catch (err) {
        this.onFailure();
        logger.warn({ error: err instanceof Error ? err.message : String(err) }, 'Gemini falló — usando Claude fallback');
      }
    } else {
      logger.warn('Circuit breaker OPEN — usando Claude directamente');
    }

    // Fallback: Claude Sonnet 4.6 (solo si ANTHROPIC_API_KEY está configurado y no es placeholder)
    const claudeKey = process.env['ANTHROPIC_API_KEY'];
    if (!claudeKey || claudeKey === 'PENDING' || claudeKey.length < 20) {
      throw new Error('Gemini no disponible temporalmente. Verifica GEMINI_API_KEY en el servidor.');
    }
    const result = await this.callClaude(messages, opts);
    logger.info(
      { model: result.model, tokens_in: result.prompt_tokens, tokens_out: result.completion_tokens, cost: result.cost_usd },
      'LLM fallback completado'
    );
    return result;
  }

  getCircuitState(): { state: CircuitState; failures: number } {
    return { state: this.state, failures: this.failureCount };
  }
}
