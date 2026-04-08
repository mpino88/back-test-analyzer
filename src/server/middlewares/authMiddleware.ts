import { type Request, type Response, type NextFunction } from 'express';
import pino from 'pino';

const logger = pino({ name: 'AuthMiddleware' });

/**
 * Middleware para validar la API Key en solicitudes al agente.
 * Se espera que el cliente envíe el header `X-API-Key`
 * o que venga en la query `?api_key=XYZ`.
 */
export function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  const apiKey = req.headers['x-api-key'] || req.query['api_key'];
  const expectedKey = process.env['AGENT_API_KEY'];

  // Si no hay API key configurada en el servidor, bloqueamos todo por seguridad extrema
  // o según la política de la empresa (Zero Trust).
  if (!expectedKey) {
    logger.fatal('AGENT_API_KEY no está configurada en .env. Denegando todo acceso.');
    res.status(500).json({ error: 'Configuración de seguridad del servidor incompleta.' });
    return;
  }

  if (apiKey !== expectedKey) {
    logger.warn({ ip: req.ip, path: req.path }, 'Intento de acceso no autorizado');
    res.status(401).json({ error: 'No autorizado. API Key inválida.' });
    return;
  }

  next();
}
