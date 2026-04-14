<template>
  <div class="chat-view">

    <!-- Header -->
    <div class="chat-header">
      <div class="chat-header__info">
        <span class="chat-header__icon">🤖</span>
        <div>
          <div class="chat-header__title">HITDASH — Agente IA</div>
          <div class="chat-header__sub">Consulta sobre predicciones, estrategias y rendimiento real</div>
        </div>
      </div>
      <div class="chat-header__controls">
        <select v-model="selectedGame" class="game-select">
          <option value="pick3">Pick 3</option>
          <option value="pick4">Pick 4</option>
        </select>
        <button class="btn-clear" @click="clearHistory" title="Limpiar conversación">✕ Limpiar</button>
      </div>
    </div>

    <!-- Messages area -->
    <div class="chat-messages" ref="messagesEl">

      <!-- Welcome message -->
      <div v-if="messages.length === 0" class="chat-welcome">
        <div class="chat-welcome__icon">⚡</div>
        <div class="chat-welcome__title">Pregúntame sobre los datos</div>
        <div class="chat-welcome__sub">Solo respondo desde mi base de datos real — sin inventar.</div>
        <div class="chat-welcome__section-label">Consultas</div>
        <div class="chat-welcome__examples">
          <button v-for="ex in examplesQuery" :key="ex" class="example-btn" @click="sendExample(ex)">
            {{ ex }}
          </button>
        </div>
        <div class="chat-welcome__section-label chat-welcome__section-label--cmd">Comandos de ejecución</div>
        <div class="chat-welcome__examples">
          <button v-for="ex in examplesCmd" :key="ex" class="example-btn example-btn--cmd" @click="sendExample(ex)">
            ⚡ {{ ex }}
          </button>
        </div>
      </div>

      <!-- Message bubbles -->
      <div
        v-for="(msg, i) in messages"
        :key="i"
        class="msg-row"
        :class="msg.role === 'user' ? 'msg-row--user' : 'msg-row--agent'"
      >
        <div v-if="msg.role === 'assistant'" class="msg-avatar">
          {{ msg.action_taken ? '⚡' : '🤖' }}
        </div>
        <div
          class="msg-bubble"
          :class="[
            msg.role === 'user' ? 'bubble--user' : 'bubble--agent',
            msg.action_taken ? 'bubble--action' : '',
          ]"
        >
          <!-- Action badge -->
          <div v-if="msg.action_taken" class="action-badge">
            <span class="action-badge__icon">{{ actionIcon(msg.action_taken) }}</span>
            <span class="action-badge__label">{{ actionLabel(msg.action_taken) }}</span>
            <span class="action-badge__dot"></span>
          </div>
          <div class="msg-text" v-html="formatText(msg.content)"></div>
          <div v-if="msg.sources && msg.sources.length" class="msg-sources">
            <span class="sources-label">Fuentes:</span>
            <span v-for="s in msg.sources" :key="s" class="source-chip">{{ s }}</span>
          </div>
          <div class="msg-time">{{ msg.time }}</div>
        </div>
        <div v-if="msg.role === 'user'" class="msg-avatar msg-avatar--user">👤</div>
      </div>

      <!-- Typing indicator -->
      <div v-if="loading" class="msg-row msg-row--agent">
        <div class="msg-avatar">🤖</div>
        <div class="msg-bubble bubble--agent bubble--typing">
          <span class="dot"></span>
          <span class="dot"></span>
          <span class="dot"></span>
        </div>
      </div>
    </div>

    <!-- Error banner -->
    <div v-if="error" class="chat-error">
      <span>⚠️ {{ error }}</span>
      <button @click="error = null">✕</button>
    </div>

    <!-- Input area -->
    <div class="chat-input-area">
      <textarea
        ref="inputEl"
        v-model="inputText"
        class="chat-input"
        placeholder="Pregunta al agente... (Enter para enviar, Shift+Enter nueva línea)"
        rows="1"
        :disabled="loading"
        @keydown.enter.exact.prevent="send"
        @input="autoResize"
      ></textarea>
      <button class="send-btn" :disabled="loading || !inputText.trim()" @click="send">
        <span v-if="!loading">➤</span>
        <span v-else class="spin">⟳</span>
      </button>
    </div>

  </div>
</template>

<script setup>
import { ref, nextTick, computed } from 'vue';

const API_BASE = import.meta.env.VITE_API_BASE ?? '';
const API_KEY  = import.meta.env.VITE_API_KEY  ?? '';

const selectedGame = ref('pick3');
const inputText    = ref('');
const loading      = ref(false);
const error        = ref(null);
const messagesEl   = ref(null);
const inputEl      = ref(null);

// Conversation history (persisted in sessionStorage per game)
const messages = ref(loadHistory());

const examplesQuery = [
  '¿Cuántos aciertos ha tenido el agente esta semana?',
  '¿Cuál es la estrategia con mayor hit rate?',
  '¿Qué pares recomienda actualmente el agente?',
  '¿Hay alguna alerta activa en el sistema?',
];

const examplesCmd = [
  'ejecuta el agente pick3 midday',
  'ejecuta el backtest ahora',
  'muéstrame el estado del agente',
  'reconoce las alertas',
];

const ACTION_ICONS = {
  trigger_agent:       '🚀',
  run_backtest:        '🔬',
  acknowledge_alerts:  '✅',
  status_check:        '📊',
};
const ACTION_LABELS = {
  trigger_agent:       'Agente disparado',
  run_backtest:        'Backtest iniciado',
  acknowledge_alerts:  'Alertas reconocidas',
  status_check:        'Estado consultado',
};

function actionIcon(type)  { return ACTION_ICONS[type]  ?? '⚡'; }
function actionLabel(type) { return ACTION_LABELS[type] ?? type; }

function loadHistory() {
  try {
    const saved = sessionStorage.getItem('hitdash_chat');
    return saved ? JSON.parse(saved) : [];
  } catch { return []; }
}

function saveHistory() {
  try {
    // Keep last 40 messages in session
    sessionStorage.setItem('hitdash_chat', JSON.stringify(messages.value.slice(-40)));
  } catch { /* ignore quota errors */ }
}

function clearHistory() {
  messages.value = [];
  sessionStorage.removeItem('hitdash_chat');
}

function now() {
  return new Date().toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' });
}

function formatText(text) {
  // Bold **text**, code `text`, newlines → <br>
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\n/g, '<br>');
}

async function sendExample(ex) {
  inputText.value = ex;
  await send();
}

async function send() {
  const text = inputText.value.trim();
  if (!text || loading.value) return;

  // Push user message
  messages.value.push({ role: 'user', content: text, time: now() });
  inputText.value = '';
  resetResize();
  await scrollBottom();

  loading.value = true;
  error.value   = null;

  // Build history array for context (last 6 pairs, excluding the just-pushed one)
  const history = messages.value
    .slice(-13, -1)
    .filter(m => m.role === 'user' || m.role === 'assistant')
    .map(m => ({ role: m.role, content: m.content }));

  try {
    const res = await fetch(`${API_BASE}/api/agent/chat`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(API_KEY ? { 'x-api-key': API_KEY } : {}),
      },
      body: JSON.stringify({
        message:    text,
        game_type:  selectedGame.value,
        history,
      }),
    });

    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error ?? `HTTP ${res.status}`);
    }

    const data = await res.json();

    messages.value.push({
      role:         'assistant',
      content:      data.response,
      sources:      data.sources ?? [],
      action_taken: data.action_taken ?? null,
      time:         now(),
    });

  } catch (err) {
    error.value = err.message ?? 'Error de comunicación con el agente';
    // Remove the user message that failed
    messages.value.pop();
    inputText.value = text;
  } finally {
    loading.value = false;
    saveHistory();
    await scrollBottom();
  }
}

async function scrollBottom() {
  await nextTick();
  if (messagesEl.value) {
    messagesEl.value.scrollTop = messagesEl.value.scrollHeight;
  }
}

function autoResize() {
  const el = inputEl.value;
  if (!el) return;
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 140) + 'px';
}

function resetResize() {
  const el = inputEl.value;
  if (el) el.style.height = 'auto';
}
</script>

<style scoped>
/* ─── Layout ─────────────────────────────────────────────────── */
.chat-view {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 4rem);
  max-width: 860px;
  margin: 0 auto;
  background: #0a0d14;
}

/* ─── Header ─────────────────────────────────────────────────── */
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 1rem 1.25rem;
  background: #0f1623;
  border-bottom: 1px solid #1e2d40;
  flex-shrink: 0;
}
.chat-header__info { display: flex; align-items: center; gap: 0.75rem; }
.chat-header__icon { font-size: 1.6rem; }
.chat-header__title { font-size: 1rem; font-weight: 700; color: #60a5fa; }
.chat-header__sub   { font-size: 0.75rem; color: #64748b; margin-top: 0.1rem; }
.chat-header__controls { display: flex; align-items: center; gap: 0.75rem; }

.game-select {
  background: #1a2535; color: #94a3b8; border: 1px solid #1e2d40;
  border-radius: 6px; padding: 0.35rem 0.65rem; font-size: 0.8rem;
  cursor: pointer;
}
.btn-clear {
  background: transparent; border: 1px solid #1e2d40; color: #64748b;
  border-radius: 6px; padding: 0.35rem 0.65rem; font-size: 0.78rem;
  cursor: pointer; transition: color 0.15s, border-color 0.15s;
}
.btn-clear:hover { color: #ef4444; border-color: #ef4444; }

/* ─── Messages ───────────────────────────────────────────────── */
.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 1.5rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  scroll-behavior: smooth;
}

/* Welcome screen */
.chat-welcome {
  display: flex; flex-direction: column; align-items: center;
  justify-content: center; gap: 0.75rem; flex: 1;
  text-align: center; padding: 2rem 0; color: #64748b;
}
.chat-welcome__icon  { font-size: 2.5rem; }
.chat-welcome__title { font-size: 1.05rem; font-weight: 600; color: #94a3b8; }
.chat-welcome__sub   { font-size: 0.82rem; }
.chat-welcome__examples { display: flex; flex-wrap: wrap; gap: 0.5rem; justify-content: center; margin-top: 0.5rem; }
.example-btn {
  background: #0f1623; border: 1px solid #1e2d40; color: #60a5fa;
  border-radius: 20px; padding: 0.4rem 0.9rem; font-size: 0.78rem;
  cursor: pointer; transition: background 0.15s;
}
.example-btn:hover { background: #1a2535; }

/* Message rows */
.msg-row {
  display: flex;
  align-items: flex-end;
  gap: 0.6rem;
}
.msg-row--user  { flex-direction: row-reverse; }
.msg-row--agent { flex-direction: row; }

.msg-avatar {
  font-size: 1.3rem;
  flex-shrink: 0;
  line-height: 1;
  padding-bottom: 0.1rem;
}
.msg-avatar--user { opacity: 0.7; }

/* Bubbles */
.msg-bubble {
  max-width: 75%;
  border-radius: 16px;
  padding: 0.75rem 1rem;
  font-size: 0.875rem;
  line-height: 1.55;
  word-break: break-word;
}
.bubble--user {
  background: #1d3a5f;
  color: #e2e8f0;
  border-bottom-right-radius: 4px;
}
.bubble--agent {
  background: #0f1623;
  border: 1px solid #1e2d40;
  color: #cbd5e1;
  border-bottom-left-radius: 4px;
}
.msg-text :deep(strong) { color: #60a5fa; }
.msg-text :deep(code) {
  background: #1a2535; color: #34d399;
  padding: 0.1rem 0.35rem; border-radius: 4px;
  font-family: 'Courier New', monospace; font-size: 0.82em;
}

/* Sources */
.msg-sources {
  margin-top: 0.6rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
}
.sources-label { font-size: 0.7rem; color: #475569; }
.source-chip {
  background: #0a1628; border: 1px solid #1e3a5a;
  color: #3b82f6; font-size: 0.68rem;
  padding: 0.1rem 0.5rem; border-radius: 999px;
}

.msg-time { font-size: 0.65rem; color: #475569; margin-top: 0.35rem; text-align: right; }

/* Typing indicator */
.bubble--typing {
  display: flex; gap: 0.35rem; align-items: center;
  padding: 0.9rem 1.1rem;
}
.dot {
  width: 7px; height: 7px; border-radius: 50%;
  background: #3b82f6; opacity: 0.6;
  animation: blink 1.2s infinite;
}
.dot:nth-child(2) { animation-delay: 0.2s; }
.dot:nth-child(3) { animation-delay: 0.4s; }
@keyframes blink {
  0%, 80%, 100% { opacity: 0.2; transform: scale(0.85); }
  40%            { opacity: 1;   transform: scale(1.1); }
}

/* ─── Error ──────────────────────────────────────────────────── */
.chat-error {
  display: flex; align-items: center; justify-content: space-between;
  background: #2d0f0f; border-top: 1px solid #7f1d1d;
  color: #fca5a5; font-size: 0.82rem; padding: 0.6rem 1.25rem;
  flex-shrink: 0;
}
.chat-error button {
  background: transparent; border: none; color: #f87171; cursor: pointer; font-size: 1rem;
}

/* ─── Input ──────────────────────────────────────────────────── */
.chat-input-area {
  display: flex;
  align-items: flex-end;
  gap: 0.6rem;
  padding: 0.9rem 1.25rem;
  background: #0f1623;
  border-top: 1px solid #1e2d40;
  flex-shrink: 0;
}
.chat-input {
  flex: 1;
  background: #0a0d14;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  color: #e2e8f0;
  font-size: 0.875rem;
  padding: 0.65rem 1rem;
  resize: none;
  outline: none;
  line-height: 1.5;
  font-family: inherit;
  transition: border-color 0.15s;
  max-height: 140px;
  overflow-y: auto;
}
.chat-input:focus { border-color: #3b82f6; }
.chat-input:disabled { opacity: 0.5; cursor: not-allowed; }
.chat-input::placeholder { color: #475569; }

.send-btn {
  background: #2563eb;
  border: none;
  border-radius: 10px;
  color: white;
  font-size: 1.1rem;
  width: 40px;
  height: 40px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  flex-shrink: 0;
  transition: background 0.15s, opacity 0.15s;
}
.send-btn:hover:not(:disabled) { background: #1d4ed8; }
.send-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.spin { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ─── Action bubbles ─────────────────────────────────────────── */
.bubble--action {
  border-color: #1e3a5a;
  background: #080f1e;
}
.action-badge {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.5rem;
  padding-bottom: 0.5rem;
  border-bottom: 1px solid #1e2d40;
}
.action-badge__icon  { font-size: 1rem; }
.action-badge__label { font-size: 0.72rem; font-weight: 700; color: #38bdf8; letter-spacing: 0.03em; text-transform: uppercase; }
.action-badge__dot   {
  margin-left: auto;
  width: 7px; height: 7px; border-radius: 50%;
  background: #22c55e;
  box-shadow: 0 0 5px #22c55e;
}

/* ─── Welcome: sections ──────────────────────────────────────── */
.chat-welcome__section-label {
  font-size: 0.7rem; font-weight: 700; letter-spacing: 0.08em;
  text-transform: uppercase; color: #475569;
  margin-top: 1rem; margin-bottom: 0.25rem; width: 100%; text-align: left;
  padding-left: 0.5rem;
}
.chat-welcome__section-label--cmd { color: #1e3a5a; }
.example-btn--cmd {
  border-color: #1e3a5a;
  color: #38bdf8;
  background: #080f1e;
}
.example-btn--cmd:hover { background: #0f1e35; }

@media (max-width: 768px) {
  .chat-view { height: calc(100vh - 8rem); }
  .msg-bubble { max-width: 90%; }
  .chat-welcome__examples { flex-direction: column; }
}
</style>
