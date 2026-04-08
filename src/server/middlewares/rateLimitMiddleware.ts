// ═══════════════════════════════════════════════════════════════
// HITDASH — Rate Limit Middleware (Shield Layer 2)
// In-memory store: sin dependencia de Redis → escudo siempre activo
// ═══════════════════════════════════════════════════════════════
import { rateLimit } from 'express-rate-limit';

/**
 * Límite global anti-DDoS / anti-bot.
 * 100 peticiones cada 15 minutos por IP.
 * Protege TODO el ecosistema.
 */
export function createGlobalLimiter() {
  return rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    skipSuccessfulRequests: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: 'Demasiadas peticiones. Por favor intente más tarde.',
        code: 'RATE_LIMIT_GLOBAL',
      });
    },
  });
}

/**
 * Límite estricto para endpoints que consumen LLM / DB intensivo.
 * Previene Denial-of-Wallet: máx 5 peticiones por minuto por IP.
 * Aplica a: /trigger, /backtest/run, /backtest/v2/run, /backtest/progressive, /backtest/unified
 */
export function createStrictLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({
        error: 'Límite de operaciones intensivas alcanzado. Protegiendo recursos del servidor.',
        code: 'RATE_LIMIT_STRICT',
      });
    },
  });
}
