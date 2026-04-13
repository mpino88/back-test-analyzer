// ═══════════════════════════════════════════════════════════════
// HITDASH — TelegramNotifier v2.0 (SENTINEL)
// Canal de usuario:    cartones, alertas, recomendaciones de pares
// Canal de servicio:   logs proactivos de toda la infraestructura
//   • Boot / Shutdown               • DB connection loss/recovery
//   • Redis loss/recovery           • Express 500 errors
//   • Rate limit breaches           • Agent job failures / stalls
//   • RAG embedding fallback        • Memory pressure
// Envío paralelo a todos los admins. Fallo de un recipient no afecta a otros.
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
    const token = process.env['TELEGRAM_BOT_TOKEN'];
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
    const header = `🎰 *Matriz #${idx + 1}* (${carton.size} líneas de impacto | certeza: ${(carton.confidence_carton * 100).toFixed(0)}%)`;
    const strategy = `📊 Patrón Operativo: \`${carton.strategy}\``;

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
      `💎 *HITDASH APEX — ${gameLabel} ${drawLabel}*`,
      `📅 Target: ${draw_date}`,
      `🤖 Análisis Confidencial: ${cartones.length} matrices de impacto generadas`,
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
      `💎 *HITDASH — Inferencia Confirmada*`,
      `📅 Sorteo: ${draw_date} | ${gameLabel} ${drawLabel}`,
      '────────────────────────',
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
      if (rec.half === 'du') halfLabel = '🎯 Bloque Alfa (Decena+Unidad):';
      else if (rec.half === 'ab') halfLabel = '🎯 Bloque AB (Posición 1+2):';
      else halfLabel = '🎯 Bloque CD (Posición 3+4):';

      const block = [halfLabel, grid];

      if (rec.centena_plus !== undefined) {
        block.push(`⭐ *Centena Plus:* \`${rec.centena_plus}\` _(opcional, agregar tu preferida)_`);
      }

      // Cognitive N line: effectiveness vs random baseline (B4)
      // Baseline = optimal_n / 100 (random pair pick probability)
      const randomBaseline = rec.optimal_n / 100;
      const effectPct      = (rec.predicted_effectiveness * 100).toFixed(1);
      const vsAzarDelta    = ((rec.predicted_effectiveness - randomBaseline) * 100);
      const vsAzarStr      = vsAzarDelta >= 0
        ? `+${vsAzarDelta.toFixed(1)}%`
        : `${vsAzarDelta.toFixed(1)}%`;
      const cogLine = rec.predicted_effectiveness > 0
        ? `📈 *${effectPct}%* efectividad mínima · *${vsAzarStr}* vs azar _(N=${rec.optimal_n})_`
        : `🛡️ Análisis estadístico activo _(N=${rec.optimal_n} pares · acumulando historial)_`;
      block.push(cogLine);
      block.push(`📊 Certeza algorítmica: ${(rec.confidence * 100).toFixed(0)}%`);
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

  // ════════════════════════════════════════════════════════════
  // CANAL DE SERVICIO — SENTINEL (independiente del flujo usuario)
  // ════════════════════════════════════════════════════════════

  async sendAdminLog(message: string): Promise<void> {
    await this.send(message);
  }

  // 1. BOOT
  async notifyServiceBoot(params: {
    port: number; redis: boolean; agentDb: boolean; ballbotDb: boolean;
  }): Promise<void> {
    const { port, redis, agentDb, ballbotDb } = params;
    const mem = process.memoryUsage();
    await this.send([
      `🚀 *HITDASH — Servidor arrancado*`,
      `📍 Puerto: ${port}`,
      `${agentDb ? '✅' : '❌'} Agent DB`,
      `${ballbotDb ? '✅' : '⚠️'} Ballbot DB (READ-ONLY)`,
      `${redis ? '✅' : '⚠️'} Redis / BullMQ`,
      `💾 Heap: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n'));
    logger.info('Notificación de boot enviada a admins');
  }

  // 2. SHUTDOWN
  async notifyShutdown(signal: string): Promise<void> {
    await this.send([
      `🛑 *HITDASH — Servidor detenido*`,
      `📡 Señal: \`${signal}\``,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n'));
  }

  // 3. DB connection event (lost | recovered)
  async notifyDbEvent(db: 'agent' | 'ballbot', event: 'lost' | 'recovered', error?: string): Promise<void> {
    const emoji = event === 'lost' ? '🔴' : '🟢';
    const label = db === 'agent' ? 'Agent DB' : 'Ballbot DB (Render)';
    await this.send([
      `${emoji} *HITDASH — ${label} ${event === 'lost' ? 'CAÍDA' : 'RECUPERADA'}*`,
      error ? `❌ ${String(error).slice(0, 200)}` : '',
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].filter(Boolean).join('\n'));
  }

  // 4. Redis event (lost | recovered)
  async notifyRedisEvent(event: 'lost' | 'recovered', error?: string): Promise<void> {
    const emoji = event === 'lost' ? '🔴' : '🟢';
    await this.send([
      `${emoji} *HITDASH — Redis / BullMQ ${event === 'lost' ? 'CAÍDO' : 'RECUPERADO'}*`,
      `⚠️ BullMQ jobs + Rate Limiting afectados`,
      error ? `❌ ${String(error).slice(0, 200)}` : '',
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].filter(Boolean).join('\n'));
  }

  // 5. Express 500
  async notifyExpressError(method: string, path: string, error: string): Promise<void> {
    await this.send([
      `🔴 *HITDASH — Error 500*`,
      `📡 \`${method} ${path}\``,
      `❌ ${String(error).slice(0, 300)}`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n'));
  }

  // 6. Rate limit breach
  async notifyRateLimitBreach(ip: string, path: string): Promise<void> {
    await this.send([
      `🟠 *HITDASH — Rate Limit alcanzado*`,
      `🌐 IP: \`${ip}\`  |  Ruta: \`${path}\``,
      `⚠️ Posible ataque o abuso de API`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n'));
  }

  // 7. BullMQ job fallido
  async notifyAgentJobFailed(params: {
    queue: string; jobId?: string; game_type?: string; draw_type?: string; error: string;
  }): Promise<void> {
    const { queue, jobId, game_type, draw_type, error } = params;
    await this.send([
      `🔴 *HITDASH — Job fallido*`,
      `⚙️ Cola: \`${queue}\`${jobId ? `  |  ID: \`${jobId}\`` : ''}`,
      game_type ? `🎮 ${game_type} ${draw_type ?? ''}` : '',
      `❌ ${String(error).slice(0, 250)}`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].filter(Boolean).join('\n'));
  }

  // 8. Job estancado
  async notifyJobStalled(queue: string, jobId: string): Promise<void> {
    await this.send([
      `🟠 *HITDASH — Job estancado (stalled)*`,
      `⚙️ Cola: \`${queue}\`  |  ID: \`${jobId}\``,
      `♻️ Será reintentado automáticamente`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n'));
  }

  // 9. RAG fallback a pseudo-embedding
  async notifyEmbeddingFallback(reason: string): Promise<void> {
    await this.send([
      `🟡 *HITDASH — RAG en modo fallback*`,
      `🧠 Gemini Embedding no disponible`,
      `⚠️ ${String(reason).slice(0, 200)}`,
      `ℹ️ El agente sigue operativo con precisión reducida`,
      `🔧 Fix: verificar API Key / facturación en Google AI Studio`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n'));
  }

  // 10. Memoria alta
  async notifyHighMemory(heapMb: number, thresholdMb: number): Promise<void> {
    await this.send([
      `🟠 *HITDASH — Presión de memoria*`,
      `💾 Heap: ${heapMb.toFixed(1)} MB  (umbral: ${thresholdMb} MB)`,
      `⚠️ Considerar reinicio si sigue escalando`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n'));
  }

  // 11. Endpoint lento
  async notifySlowEndpoint(method: string, path: string, durationMs: number): Promise<void> {
    await this.send([
      `🟡 *HITDASH — Endpoint lento*`,
      `📡 \`${method} ${path}\`  —  ${durationMs}ms`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n'));
  }

  // 12. Unhandled rejection / uncaught exception
  async notifyUnhandledError(type: 'unhandledRejection' | 'uncaughtException', error: string): Promise<void> {
    await this.send([
      `🔴 *HITDASH — Error crítico no capturado*`,
      `⚡ \`${type}\``,
      `❌ ${String(error).slice(0, 300)}`,
      `🚨 El proceso puede haberse reiniciado`,
      `🕐 ${new Date().toLocaleString('es-PR', { timeZone: 'America/Puerto_Rico' })}`,
    ].join('\n'));
  }


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
