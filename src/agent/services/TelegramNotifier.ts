// ═══════════════════════════════════════════════════════════════
// HITDASH — TelegramNotifier v1.0.0
// Envía cartones y alertas al canal de Telegram via grammy
// Sin dependencia de sistema global — usa solo credenciales .env
// ═══════════════════════════════════════════════════════════════

import { Bot } from 'grammy';
import pino from 'pino';
import type { Carton, AgentAlert, GameType, DrawType, PairRecommendation } from '../types/agent.types.js';

const logger = pino({ name: 'TelegramNotifier' });

const PRIORITY_EMOJI: Record<string, string> = {
  low: '🔵', medium: '🟡', high: '🟠', critical: '🔴',
};

export class TelegramNotifier {
  private readonly bot: Bot | null;
  private readonly chatIds: string[];   // one or more admin chat IDs
  private readonly enabled: boolean;

  constructor() {
    const token  = process.env['TELEGRAM_BOT_TOKEN'];
    const rawIds = process.env['TELEGRAM_CHAT_ID'] ?? '';

    // Support comma-separated list: "123456789,987654321"
    this.chatIds = rawIds
      .split(',')
      .map(id => id.trim())
      .filter(id => id.length > 0);

    if (!token || this.chatIds.length === 0) {
      logger.warn('TELEGRAM_BOT_TOKEN / TELEGRAM_CHAT_ID no configurados — notificaciones deshabilitadas');
      this.bot = null;
      this.enabled = false;
    } else {
      this.bot = new Bot(token);
      this.enabled = true;
      logger.info({ recipients: this.chatIds.length }, 'TelegramNotifier: destinatarios configurados');
    }
  }

  // ─── Formatear cartón como bloque de texto ────────────────────
  private formatCarton(carton: Carton, idx: number): string {
    const header = `🎰 *Cartón #${idx + 1}* (${carton.size} números | conf: ${(carton.confidence_carton * 100).toFixed(0)}%)`;
    const strategy = `📊 Estrategia: \`${carton.strategy}\``;

    // Dividir números en filas de 5
    const nums = carton.numbers.map(n => n.value);
    const rows: string[] = [];
    for (let i = 0; i < nums.length; i += 5) {
      rows.push(nums.slice(i, i + 5).join('  '));
    }
    const grid = rows.map(r => `\`${r}\``).join('\n');

    return [header, strategy, grid].join('\n');
  }

  // ─── Notificar cartones pre-sorteo ───────────────────────────
  async notifyCartones(
    cartones: Carton[],
    game_type: GameType,
    draw_type: DrawType,
    draw_date: string,
    reasoning?: string
  ): Promise<void> {
    const gameLabel = game_type === 'pick3' ? 'Pick 3' : 'Pick 4';
    const drawLabel = draw_type === 'midday' ? '🌤 Midday' : '🌆 Evening';

    const header = [
      `🎯 *HITDASH — ${gameLabel} ${drawLabel}*`,
      `📅 Sorteo: ${draw_date}`,
      `🤖 Análisis: ${cartones.length} cartón(es) generado(s)`,
      '─────────────────────────',
    ].join('\n');

    const cartonBlocks = cartones.map((c, i) => this.formatCarton(c, i)).join('\n\n');

    const footer = reasoning
      ? `\n💡 *Razonamiento:*\n_${reasoning.slice(0, 300)}_`
      : '';

    const disclaimer = '\n\n⚠️ _Solo análisis estadístico. No garantía de resultados._';

    const message = [header, cartonBlocks, footer, disclaimer].join('\n');

    await this.send(message);
    logger.info({ game_type, draw_type, cartones: cartones.length }, 'Cartones enviados a Telegram');
  }

  // ─── Notificar alerta proactiva ───────────────────────────────
  async notifyAlert(alert: AgentAlert): Promise<void> {
    const emoji = PRIORITY_EMOJI[alert.severity] ?? '⚪';
    const message = [
      `${emoji} *HITDASH Alert — ${alert.type.toUpperCase()}*`,
      `Severidad: ${alert.severity}`,
      alert.game_type ? `Juego: ${alert.game_type}` : '',
      `\n${alert.message}`,
    ]
      .filter(Boolean)
      .join('\n');

    await this.send(message);
    logger.info({ type: alert.type, severity: alert.severity }, 'Alerta enviada a Telegram');
  }

  // ─── Notificar resumen de sesión ──────────────────────────────
  async notifySessionSummary(params: {
    session_id: string;
    game_type: GameType;
    draw_type: DrawType;
    algorithms_ok: number;
    algorithms_fail: number;
    duration_ms: number;
    cost_usd: number;
    model_used: string;
  }): Promise<void> {
    const { game_type, draw_type, algorithms_ok, algorithms_fail, duration_ms, cost_usd, model_used } = params;

    const message = [
      `✅ *HITDASH — Ciclo completado*`,
      `🎮 ${game_type} ${draw_type}`,
      `⚙️  Algoritmos: ${algorithms_ok} OK / ${algorithms_fail} fallidos`,
      `🤖 Modelo: \`${model_used}\``,
      `⏱  Duración: ${(duration_ms / 1000).toFixed(1)}s`,
      `💰 Costo: $${cost_usd.toFixed(4)}`,
    ].join('\n');

    await this.send(message);
  }

  // ─── Notificar recomendaciones de pares (v2) ─────────────────
  async notifyPairs(
    recs: PairRecommendation[],
    game_type: GameType,
    draw_type: DrawType,
    draw_date: string,
    reasoning?: string
  ): Promise<void> {
    const gameLabel = game_type === 'pick3' ? 'Pick 3' : 'Pick 4';
    const drawLabel = draw_type === 'midday' ? '🌤 Midday' : '🌆 Evening';

    const header = [
      `🎯 *HITDASH — ${gameLabel} ${drawLabel}*`,
      `📅 Sorteo: ${draw_date}`,
      '─────────────────────',
    ].join('\n');

    const blocks: string[] = [];

    for (const rec of recs) {
      // Chunk pairs into rows of 8 for readability
      const rows: string[] = [];
      for (let i = 0; i < rec.pairs.length; i += 8) {
        rows.push(rec.pairs.slice(i, i + 8).join('  '));
      }
      const grid = rows.map(r => `\`${r}\``).join('\n');

      let halfLabel: string;
      if (rec.half === 'du')       halfLabel = '🔢 Pares recomendados (decena+unidad):';
      else if (rec.half === 'ab')  halfLabel = '🔢 AB recomendados (p1+p2):';
      else                         halfLabel = '🔢 CD recomendados (p3+p4):';

      const block = [halfLabel, grid];

      if (rec.centena_plus !== undefined) {
        block.push(`⭐ *Centena Plus:* \`${rec.centena_plus}\` _(opcional, agregar tu preferida)_`);
      }

      // Cognitive N line: the agent states its own mathematically-determined N
      // and the estimated effectiveness (Wilson CI lower bound)
      const effectPct = (rec.predicted_effectiveness * 100).toFixed(1);
      const cogLine = rec.predicted_effectiveness > 0
        ? `🧠 *N=${rec.optimal_n} pares* · efectividad mínima estimada: *${effectPct}%* _(Wilson 95% CI)_`
        : `🧠 *N=${rec.optimal_n} pares* _(calculado cognitivamente — sin datos de backtest aún)_`;
      block.push(cogLine);
      block.push(`📊 Score consensus: ${(rec.confidence * 100).toFixed(0)}% | Piso histórico: ${rec.top_n}`);
      blocks.push(block.join('\n'));
    }

    const footer = reasoning
      ? `\n💡 _${reasoning.slice(0, 300)}_`
      : '';

    const disclaimer = '\n⚠️ _Solo análisis estadístico. No garantía de resultados._';

    const message = [header, blocks.join('\n\n'), footer, disclaimer].join('\n');

    await this.send(message);
    logger.info({ game_type, draw_type, halves: recs.map(r => r.half) }, 'Pares enviados a Telegram');
  }

  // ─── Canal independiente: logs de servicio para admins ──────────
  // Independiente del flujo de usuario — reporta estado interno del sistema.
  async sendAdminLog(message: string): Promise<void> {
    await this.send(message);
  }

  // ─── Notificación de arranque del servidor ────────────────────────
  async notifyServiceBoot(params: {
    port: number;
    redis: boolean;
    agentDb: boolean;
    ballbotDb: boolean;
  }): Promise<void> {
    const { port, redis, agentDb, ballbotDb } = params;
    const message = [
      `🚀 *HITDASH — Servidor arrancado*`,
      `📍 Puerto: ${port}`,
      `🔵 Agent DB: ${agentDb ? '✅ Conectado' : '❌ Offline'}`,
      `🔵 Ballbot DB: ${ballbotDb ? '✅ Conectado' : '⚠️ Sin conexión'}`,
      `🔵 Redis: ${redis ? '✅ Conectado' : '⚠️ Sin conexión'}`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n');
    await this.send(message);
    logger.info('Notificación de boot enviada a admins');
  }

  // ─── Método base de envío con retry — envía a TODOS los admins ──
  private async send(text: string, retries = 2): Promise<void> {
    if (!this.enabled || !this.bot) return;

    // Fire to all chat IDs in parallel; failures per recipient are isolated.
    await Promise.all(this.chatIds.map(chatId => this.sendToOne(chatId, text, retries)));
  }

  private async sendToOne(chatId: string, text: string, retries: number): Promise<void> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        await this.bot!.api.sendMessage(chatId, text, { parse_mode: 'Markdown' });
        return;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (attempt < retries) {
          logger.warn({ chatId, attempt, error: msg }, 'Telegram send falló — reintentando');
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        } else {
          logger.error({ chatId, error: msg }, 'Telegram send fallido definitivamente para este destinatario');
          // Isolated — other recipients are not affected
        }
      }
    }
  }
}
