import { rateLimit } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import type { Redis } from 'ioredis';

/**
 * Crea un limitador global para evitar spam leve.
 * 100 peticiones cada 15 minutos por IP.
 */
export function createGlobalLimiter(redisClient: Redis) {
  return rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutos
    limit: 100,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new RedisStore({
      // @ts-expect-error - Conocido problema de tipos entre ioredis y rate-limit-redis
      sendCommand: (...args: string[]) => redisClient.call(...args),
    }),
    handler: (req, res) => {
      res.status(429).json({ error: 'Demasiadas peticiones. Por favor intente más tarde.' });
    },
  });
}

/**
 * Crea un limitador estricto para operaciones costosas (LLM o Backtest).
 * 2 peticiones por minuto por IP.
 */
export function createStrictLimiter(redisClient: Redis) {
  return rateLimit({
    windowMs: 60 * 1000, // 1 minuto
    limit: 2,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    store: new RedisStore({
      // @ts-expect-error
      sendCommand: (...args: string[]) => redisClient.call(...args),
    }),
    handler: (req, res) => {
      res.status(429).json({ error: 'Límite de operaciones intensivas alcanzado. Protegiendo recursos del servidor.' });
    },
  });
}
