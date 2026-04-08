// ═══════════════════════════════════════════════════════════════
// HITDASH — RAGService v2.0
// Embedder intercambiable: gemini-embedding-001 por defecto
// Rate limiting: 50 RPM (token bucket)
// Idempotencia: ON CONFLICT (source, category) DO UPDATE
// ═══════════════════════════════════════════════════════════════

import { GoogleGenAI } from '@google/genai';
import type { Pool } from 'pg';
import pino from 'pino';
import type { RagResult, StoreKnowledgeInput, RagCategory } from '../types/agent.types.js';

export type EmbedderFn = (text: string) => Promise<number[]>;

const logger = pino({ name: 'RAGService' });

// Token bucket para rate limiting (50 RPM = 1 token cada 1200ms)
class TokenBucket {
  private tokens: number;
  private lastRefill: number;
  private readonly maxTokens: number;
  private readonly refillRateMs: number;

  constructor(maxTokens: number, refillRateMs: number) {
    this.maxTokens = maxTokens;
    this.refillRateMs = refillRateMs;
    this.tokens = maxTokens;
    this.lastRefill = Date.now();
  }

  async consume(): Promise<void> {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const refills = Math.floor(elapsed / this.refillRateMs);
    if (refills > 0) {
      this.tokens = Math.min(this.maxTokens, this.tokens + refills);
      this.lastRefill = now;
    }
    if (this.tokens <= 0) {
      const waitMs = this.refillRateMs - (now - this.lastRefill);
      await new Promise(resolve => setTimeout(resolve, waitMs));
      this.tokens = 1;
    }
    this.tokens--;
  }
}

export class RAGService {
  private readonly pool: Pool;
  private readonly embedder: EmbedderFn;
  private readonly bucket: TokenBucket;

  constructor(pool: Pool, embedder?: EmbedderFn) {
    this.pool = pool;
    this.bucket = new TokenBucket(50, 1200); // 50 RPM
    this.embedder = embedder ?? this.defaultEmbedder.bind(this);
  }

  private async defaultEmbedder(text: string): Promise<number[]> {
    const apiKey = process.env['GEMINI_API_KEY'];
    if (!apiKey) throw new Error('GEMINI_API_KEY no configurada');

    const ai = new GoogleGenAI({ apiKey });
    const result = await ai.models.embedContent({
      model: 'gemini-embedding-001',
      contents: text,
    });

    const values = result.embeddings?.[0]?.values;
    if (!values || values.length !== 3072) {
      throw new Error(`Embedding inválido: dimensiones recibidas ${values?.length ?? 0}, esperadas 3072`);
    }
    return values;
  }

  async embedText(text: string): Promise<number[]> {
    await this.bucket.consume();

    let lastError: Error | null = null;
    const delays = [1000, 2000, 4000];

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const embedding = await this.embedder(text);
        logger.info({ attempt: attempt + 1, dims: embedding.length }, 'Embedding generado');
        return embedding;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        logger.warn({ attempt: attempt + 1, error: lastError.message }, 'Error al generar embedding — reintentando');
        if (attempt < 2) {
          const jitter = Math.random() * 500;
          await new Promise(resolve => setTimeout(resolve, delays[attempt]! + jitter));
        }
      }
    }

    throw lastError ?? new Error('Error desconocido al generar embedding');
  }

  async storeKnowledge(input: StoreKnowledgeInput): Promise<string> {
    const { content, category, source, confidence = 0.5, metadata = {} } = input;

    const embedding = await this.embedText(content);
    const vectorLiteral = `[${embedding.join(',')}]`;

    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO hitdash.rag_knowledge
         (content, embedding, category, source, confidence, metadata)
       VALUES ($1, $2::vector, $3, $4, $5, $6)
       ON CONFLICT (source, category) DO UPDATE SET
         content    = EXCLUDED.content,
         embedding  = EXCLUDED.embedding,
         confidence = EXCLUDED.confidence,
         metadata   = EXCLUDED.metadata,
         updated_at = now()
       RETURNING id`,
      [content, vectorLiteral, category, source, confidence, JSON.stringify(metadata)]
    );

    const id = result.rows[0]!.id;
    logger.info({ id, source, category }, 'Conocimiento almacenado en RAG');
    return id;
  }

  async searchSimilar(
    query: string,
    topK: number = 10,
    category?: RagCategory,
    minSimilarity: number = 0.65
  ): Promise<RagResult[]> {
    const embedding = await this.embedText(query);
    const vectorLiteral = `[${embedding.join(',')}]`;

    const result = await this.pool.query<RagResult & { similarity: number }>(
      `SELECT
         id, content, category, source, confidence, metadata,
         1 - (embedding <=> $1::vector) AS similarity
       FROM hitdash.rag_knowledge
       WHERE ($2::text IS NULL OR category = $2)
         AND 1 - (embedding <=> $1::vector) >= $3
       ORDER BY embedding <=> $1::vector
       LIMIT $4`,
      [vectorLiteral, category ?? null, minSimilarity, topK]
    );

    logger.info({ query_len: query.length, results: result.rows.length, category }, 'RAG search completado');
    return result.rows;
  }

  async deleteStale(olderThanDays: number): Promise<number> {
    const result = await this.pool.query(
      `DELETE FROM hitdash.rag_knowledge
       WHERE created_at < now() - ($1 || ' days')::interval
         AND category NOT IN ('strategy')`,  // nunca borrar estrategias
      [olderThanDays]
    );
    const count = result.rowCount ?? 0;
    logger.info({ count, olderThanDays }, 'RAG: registros obsoletos eliminados');
    return count;
  }

  async healthCheck(): Promise<{ count: number; oldestEntry: Date | null }> {
    const result = await this.pool.query<{ count: string; oldest: Date | null }>(
      `SELECT COUNT(*)::text AS count, MIN(created_at) AS oldest FROM hitdash.rag_knowledge`
    );
    return {
      count: parseInt(result.rows[0]!.count, 10),
      oldestEntry: result.rows[0]!.oldest,
    };
  }
}
