<template>
  <!-- ══════════════════════════════════════════════════════════════ -->
  <!-- ANALYSER — cuando hay datos cargados: vista completa de charts -->
  <!-- ══════════════════════════════════════════════════════════════ -->
  <div v-if="data" class="app">
    <AppHeader :file-name="fileName" :summary="summary" @reset="reset" />
    <div class="app__body">
      <AppSidebar v-if="summary" :summary="summary" />
      <main class="app__main">
        <SubsetsGrid v-if="topSubsets && topSubsets.length > 0" title="Top Subsets" :subsets="topSubsets" />
        <SubsetsGrid v-if="bestBySize && bestBySize.length > 0" title="Best By Size" :subsets="bestBySize" />

        <div class="charts-grid stagger-children">
          <div class="charts-grid__full">
            <HitMissTimeline :forensic-log="forensicLog" :rolling="rolling" />
          </div>
          <div class="charts-grid__half">
            <HitRateByMonth :monthly-rates="monthlyRates" />
          </div>
          <div class="charts-grid__half">
            <HitRateByDow :dow-rates="dowRates" />
          </div>
          <div class="charts-grid__half">
            <StreakAnalysis :streaks="streaks" />
          </div>
          <div class="charts-grid__half">
            <CandidateHeatmap :candidates="candidates" />
          </div>
        </div>
      </main>
    </div>
  </div>

  <!-- ══════════════════════════════════════════════════════════════ -->
  <!-- LOBBY — pantalla de entrada al ecosistema Hitdash              -->
  <!-- ══════════════════════════════════════════════════════════════ -->
  <div v-else class="lobby">

    <!-- Grid de fondo decorativo -->
    <div class="lobby__grid" aria-hidden="true">
      <div class="lobby__grid-lines"></div>
      <div class="lobby__orb lobby__orb--1"></div>
      <div class="lobby__orb lobby__orb--2"></div>
      <div class="lobby__orb lobby__orb--3"></div>
    </div>

    <!-- ── HEADER ──────────────────────────────────────────────── -->
    <header class="lobby__header">
      <div class="lobby__brand">
        <span class="lobby__logo">⚡</span>
        <span class="lobby__brand-name">Hitdash</span>
      </div>
      <div class="lobby__status-chip" :class="agentOnline ? 'chip--live' : 'chip--off'">
        <span class="chip__dot"></span>
        Agente {{ agentOnline ? 'Online' : 'Offline' }}
      </div>
    </header>

    <!-- ── HERO ───────────────────────────────────────────────── -->
    <section class="lobby__hero">
      <div class="lobby__hero-tag">Florida Lottery · Pick 3 / Pick 4</div>
      <h1 class="lobby__hero-title">
        Análisis Estadístico
        <span class="lobby__hero-accent">de Alto Rendimiento</span>
      </h1>
      <p class="lobby__hero-sub">
        Motor cognitivo multi-algoritmo con 15 métricas de precisión,<br>
        señales de play progresivas y predicción IA en tiempo real.
      </p>
    </section>

    <!-- ── LIVE STATS ROW ─────────────────────────────────────── -->
    <div class="lobby__stats-row">
      <div class="lstat">
        <span class="lstat__val">{{ agentStatus?.pending_alerts ?? '—' }}</span>
        <span class="lstat__label">Alertas activas</span>
      </div>
      <div class="lstat">
        <span class="lstat__val">{{ agentStatus?.rag_documents ?? '—' }}</span>
        <span class="lstat__label">RAG docs</span>
      </div>
      <div class="lstat">
        <span class="lstat__val" :class="agentStatus?.redis_ok ? 'text-green' : 'text-red'">
          {{ agentStatus?.redis_ok ? 'OK' : 'Down' }}
        </span>
        <span class="lstat__label">Redis / Queue</span>
      </div>
      <div class="lstat">
        <span class="lstat__val">{{ lastSessionGame }}</span>
        <span class="lstat__label">Último ciclo</span>
      </div>
      <div class="lstat">
        <span class="lstat__val lstat__val--sm">{{ lastIngestion }}</span>
        <span class="lstat__label">Última ingesta</span>
      </div>
    </div>

    <!-- ── PORTALES PRINCIPALES ──────────────────────────────── -->
    <div class="lobby__portals">

      <!-- Portal 1: Analyser de reportes JSON -->
      <div
        class="portal portal--analyser"
        :class="{ 'portal--drag': isDragging }"
        @dragenter.prevent="isDragging = true"
        @dragover.prevent="isDragging = true"
        @dragleave.prevent="isDragging = false"
        @drop.prevent="handleDrop($event); isDragging = false"
      >
        <div class="portal__glow portal__glow--blue"></div>
        <div class="portal__icon">📊</div>
        <h2 class="portal__title">Analyser de Reportes</h2>
        <p class="portal__desc">
          Carga un reporte <code>ballbacktest_audit_report.json</code> de Ballbot
          para visualizar forensic log, hit rate por mes/DOW, streaks y candidatos.
        </p>
        <div class="portal__features">
          <span>Hit/Miss Timeline</span>
          <span>DOW Heatmap</span>
          <span>Streak Analysis</span>
          <span>Candidate Map</span>
        </div>
        <label class="portal__cta" for="lobby-file-input">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/>
            <path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/>
          </svg>
          Cargar JSON
          <input
            id="lobby-file-input"
            type="file"
            accept=".json"
            class="portal__input"
            @change="handleFileInput"
          />
        </label>
        <p class="portal__drop-hint">o arrastra el archivo aquí</p>
        <p v-if="error" class="portal__error">{{ error }}</p>
      </div>

      <!-- Portal 2: Agent Dashboard -->
      <RouterLink to="/agent/dashboard" class="portal portal--agent">
        <div class="portal__glow portal__glow--green"></div>
        <div class="portal__icon">🤖</div>
        <h2 class="portal__title">Agent Dashboard</h2>
        <p class="portal__desc">
          Centro de control del agente Hitdash. Predicciones en tiempo real,
          tracking de estrategias, backtests v2 y señales cognitivas de acción.
        </p>
        <div class="portal__features">
          <span>Cognitive N</span>
          <span>Pair Recs</span>
          <span>Backtest v2</span>
          <span>Play Signal</span>
        </div>
        <div class="portal__cta portal__cta--link">
          Entrar al Dashboard
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>
          </svg>
        </div>
        <!-- Last recommendation preview -->
        <div v-if="latestRec" class="portal__preview">
          <span class="preview__label">Última rec —</span>
          <span class="preview__game">{{ latestRec.game_type?.toUpperCase() }} {{ latestRec.draw_type }}</span>
          <span class="preview__n">N={{ latestRec.optimal_n }}</span>
          <span class="preview__pairs">{{ latestRec.pairs?.slice(0, 5).join(' · ') }}</span>
        </div>
      </RouterLink>

    </div>

    <!-- ── QUICK ACCESS GRID ──────────────────────────────────── -->
    <div class="lobby__quick">
      <RouterLink to="/agent/progressive" class="qlink">
        <span class="qlink__icon">▶</span>
        <div>
          <div class="qlink__title">Play Signal</div>
          <div class="qlink__sub">¿Jugar hoy? Motor progresivo</div>
        </div>
      </RouterLink>
      <RouterLink to="/agent/backtest" class="qlink">
        <span class="qlink__icon">🔬</span>
        <div>
          <div class="qlink__title">Backtest v2</div>
          <div class="qlink__sub">15 métricas de precisión</div>
        </div>
      </RouterLink>
      <RouterLink to="/agent/tracking" class="qlink">
        <span class="qlink__icon">📡</span>
        <div>
          <div class="qlink__title">Strategy Tracking</div>
          <div class="qlink__sub">Evolución histórica</div>
        </div>
      </RouterLink>
      <RouterLink to="/agent/alerts" class="qlink" :class="{ 'qlink--alert': (agentStatus?.pending_alerts ?? 0) > 0 }">
        <span class="qlink__icon">🔔</span>
        <div>
          <div class="qlink__title">
            Alertas
            <span v-if="(agentStatus?.pending_alerts ?? 0) > 0" class="qlink__badge">
              {{ agentStatus.pending_alerts }}
            </span>
          </div>
          <div class="qlink__sub">Proactive monitoring</div>
        </div>
      </RouterLink>
      <RouterLink to="/agent/accuracy" class="qlink">
        <span class="qlink__icon">📈</span>
        <div>
          <div class="qlink__title">Accuracy</div>
          <div class="qlink__sub">Tendencia histórica</div>
        </div>
      </RouterLink>
      <RouterLink to="/agent/cartones" class="qlink">
        <span class="qlink__icon">🎰</span>
        <div>
          <div class="qlink__title">Cartones</div>
          <div class="qlink__sub">Generaciones del agente</div>
        </div>
      </RouterLink>
    </div>

    <!-- ── FOOTER ─────────────────────────────────────────────── -->
    <footer class="lobby__footer">
      <span>Hitdash · Bliss Systems LLC</span>
      <span class="lobby__footer-sep">·</span>
      <span>Motor APEX v2 · Cognitive N · Wilson CI 95%</span>
    </footer>

  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { RouterLink } from 'vue-router';
import { apiGet } from '../utils/apiClient.js';

import { useFileLoader }  from '../composables/useFileLoader.js';
import { useReportData }  from '../composables/useReportData.js';
import { useAgentStatus } from '../composables/agent/useAgentStatus.js';

import FileDropzone     from '../components/upload/FileDropzone.vue';
import AppHeader        from '../components/layout/AppHeader.vue';
import AppSidebar       from '../components/layout/AppSidebar.vue';
import SubsetsGrid      from '../components/layout/SubsetsGrid.vue';
import HitMissTimeline  from '../components/charts/HitMissTimeline.vue';
import HitRateByMonth   from '../components/charts/HitRateByMonth.vue';
import HitRateByDow     from '../components/charts/HitRateByDow.vue';
import StreakAnalysis    from '../components/charts/StreakAnalysis.vue';
import CandidateHeatmap from '../components/charts/CandidateHeatmap.vue';

const { data, fileName, error, handleDrop, handleFileInput, reset } = useFileLoader();
const { summary, forensicLog, topSubsets, bestBySize, monthlyRates, dowRates, rolling, streaks, candidates } = useReportData(data);
const { status: agentStatus, connected: agentOnline } = useAgentStatus();

const isDragging = ref(false);
const latestRec  = ref(null);

const lastSessionGame = computed(() => {
  const s = agentStatus.value?.last_session;
  if (!s) return '—';
  return `${s.game_type?.toUpperCase()} ${s.draw_type}`;
});

const lastIngestion = computed(() => {
  const raw = agentStatus.value?.last_ingestion;
  if (!raw) return '—';
  return new Date(raw).toLocaleString('es-PR', { dateStyle: 'short', timeStyle: 'short' });
});

onMounted(async () => {
  try {
    const all = await apiGet('/api/agent/pair-recommendations/latest');
    latestRec.value = all?.[0] ?? null;
  } catch {}
});
</script>

<style scoped>
/* ══════════════════════════════════════════════════════════════ */
/* ANALYSER mode (data loaded)                                    */
/* ══════════════════════════════════════════════════════════════ */
.app { min-height: 100vh; display: flex; flex-direction: column; }
.app__body { display: flex; flex: 1; min-height: 0; }
.app__main { flex: 1; padding: var(--space-5); overflow-y: auto; animation: fadeIn 0.5s ease; }
.charts-grid { display: grid; grid-template-columns: 1fr 1fr; gap: var(--space-5); }
.charts-grid__full { grid-column: 1 / -1; }
.charts-grid__half { grid-column: span 1; }
@media (max-width: 1024px) {
  .app__body { flex-direction: column; }
  .charts-grid { grid-template-columns: 1fr; }
  .charts-grid__half { grid-column: 1; }
}

/* ══════════════════════════════════════════════════════════════ */
/* LOBBY                                                          */
/* ══════════════════════════════════════════════════════════════ */
.lobby {
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 2rem 1.5rem 3rem;
  gap: 2.5rem;
  position: relative;
  overflow: hidden;
  background: #070b14;
  color: #e2e8f0;
  font-family: 'Inter', system-ui, sans-serif;
}

/* ── Background decoration ────────────────────────────────────── */
.lobby__grid {
  position: absolute;
  inset: 0;
  pointer-events: none;
  overflow: hidden;
}

.lobby__grid-lines {
  position: absolute;
  inset: 0;
  background-image:
    linear-gradient(rgba(99,102,241,0.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(99,102,241,0.04) 1px, transparent 1px);
  background-size: 60px 60px;
  mask-image: radial-gradient(ellipse at center, black 40%, transparent 80%);
}

.lobby__orb {
  position: absolute;
  border-radius: 50%;
  filter: blur(80px);
  opacity: 0.18;
}
.lobby__orb--1 {
  width: 500px; height: 500px;
  background: #4f46e5;
  top: -150px; left: -100px;
  animation: orbFloat 12s ease-in-out infinite;
}
.lobby__orb--2 {
  width: 400px; height: 400px;
  background: #059669;
  bottom: 0; right: -80px;
  animation: orbFloat 15s ease-in-out infinite reverse;
}
.lobby__orb--3 {
  width: 300px; height: 300px;
  background: #7c3aed;
  top: 40%; left: 50%;
  transform: translate(-50%, -50%);
  animation: orbFloat 10s ease-in-out infinite 3s;
}

/* ── Header ───────────────────────────────────────────────────── */
.lobby__header {
  width: 100%;
  max-width: 1100px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  z-index: 1;
}

.lobby__brand {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.lobby__logo { font-size: 1.5rem; }
.lobby__brand-name {
  font-size: 1.2rem;
  font-weight: 800;
  color: #60a5fa;
  letter-spacing: -0.02em;
}
.lobby__brand-sep { color: #334155; font-size: 0.8rem; }
.lobby__brand-sub { font-size: 0.78rem; color: #475569; font-weight: 500; }

.lobby__status-chip {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.75rem;
  font-weight: 600;
  padding: 0.3rem 0.75rem;
  border-radius: 999px;
  border: 1px solid;
  letter-spacing: 0.04em;
}
.chip--live { background: #052e16; border-color: #16a34a66; color: #4ade80; }
.chip--off  { background: #1f0202; border-color: #dc262666; color: #f87171; }
.chip__dot {
  width: 7px; height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.chip--live .chip__dot { background: #22c55e; box-shadow: 0 0 6px #22c55e; animation: pulse 2s ease infinite; }
.chip--off  .chip__dot { background: #ef4444; }

/* ── Hero ─────────────────────────────────────────────────────── */
.lobby__hero {
  text-align: center;
  z-index: 1;
  max-width: 640px;
}
.lobby__hero-tag {
  font-size: 0.72rem;
  font-weight: 700;
  letter-spacing: 0.12em;
  text-transform: uppercase;
  color: #60a5fa;
  background: #1d3a5f22;
  border: 1px solid #60a5fa33;
  padding: 0.25rem 0.75rem;
  border-radius: 999px;
  display: inline-block;
  margin-bottom: 1.25rem;
}
.lobby__hero-title {
  font-size: clamp(1.8rem, 4vw, 2.8rem);
  font-weight: 800;
  line-height: 1.15;
  letter-spacing: -0.03em;
  color: #f1f5f9;
  margin-bottom: 1rem;
}
.lobby__hero-accent {
  display: block;
  background: linear-gradient(135deg, #60a5fa, #818cf8, #a78bfa);
  -webkit-background-clip: text;
  -webkit-text-fill-color: transparent;
  background-clip: text;
}
.lobby__hero-sub {
  font-size: 0.9rem;
  color: #64748b;
  line-height: 1.7;
}

/* ── Live stats row ───────────────────────────────────────────── */
.lobby__stats-row {
  display: flex;
  gap: 1.5rem;
  z-index: 1;
  flex-wrap: wrap;
  justify-content: center;
}
.lstat {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.2rem;
  padding: 0.6rem 1.2rem;
  background: #0f1623cc;
  border: 1px solid #1e2d40;
  border-radius: 10px;
  backdrop-filter: blur(8px);
  min-width: 90px;
}
.lstat__val {
  font-size: 1.25rem;
  font-weight: 800;
  color: #f1f5f9;
  line-height: 1;
}
.lstat__val--sm { font-size: 0.82rem; font-weight: 600; }
.lstat__label { font-size: 0.6rem; color: #475569; text-transform: uppercase; letter-spacing: 0.08em; }
.text-green { color: #22c55e; }
.text-red   { color: #ef4444; }

/* ── Portales ─────────────────────────────────────────────────── */
.lobby__portals {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1.5rem;
  width: 100%;
  max-width: 1100px;
  z-index: 1;
}

.portal {
  position: relative;
  background: #0a0f1c;
  border: 1px solid #1a2535;
  border-radius: 20px;
  padding: 2rem 2rem 1.75rem;
  display: flex;
  flex-direction: column;
  gap: 1rem;
  overflow: hidden;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.25s, transform 0.2s, box-shadow 0.25s;
  cursor: pointer;
}
.portal:hover {
  transform: translateY(-3px);
  box-shadow: 0 16px 48px rgba(0,0,0,0.5);
}

.portal--analyser { border-color: #1e3a5f44; }
.portal--analyser:hover { border-color: #3b82f666; box-shadow: 0 16px 48px rgba(59,130,246,0.12); }
.portal--analyser.portal--drag {
  border-color: #3b82f6;
  transform: scale(1.015);
  box-shadow: 0 0 0 3px #3b82f622;
}

.portal--agent { border-color: #14532d44; }
.portal--agent:hover { border-color: #22c55e66; box-shadow: 0 16px 48px rgba(34,197,94,0.12); }

.portal__glow {
  position: absolute;
  width: 250px; height: 250px;
  border-radius: 50%;
  filter: blur(60px);
  opacity: 0.08;
  pointer-events: none;
  top: -60px; right: -60px;
}
.portal__glow--blue  { background: #3b82f6; }
.portal__glow--green { background: #22c55e; }

.portal__icon { font-size: 2.5rem; line-height: 1; }

.portal__title {
  font-size: 1.3rem;
  font-weight: 700;
  color: #f1f5f9;
}

.portal__desc {
  font-size: 0.83rem;
  color: #64748b;
  line-height: 1.65;
}
.portal__desc code {
  font-family: 'JetBrains Mono', monospace;
  font-size: 0.75rem;
  color: #94a3b8;
  background: #1e2d40;
  padding: 1px 5px;
  border-radius: 3px;
}

.portal__features {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.portal__features span {
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.06em;
  padding: 0.15rem 0.55rem;
  border-radius: 999px;
  background: #1e2d40;
  color: #64748b;
}

.portal__cta {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 0.5rem;
  padding: 0.65rem 1.25rem;
  border-radius: 10px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.15s, box-shadow 0.15s;
  align-self: flex-start;
  margin-top: auto;
  border: none;
  background: #1d4ed8;
  color: #fff;
}
.portal--analyser .portal__cta { background: #1d4ed8; }
.portal--analyser .portal__cta:hover { background: #2563eb; box-shadow: 0 0 20px rgba(59,130,246,0.3); }

.portal__cta--link {
  background: #14532d;
  color: #4ade80;
  border: 1px solid #16a34a55;
}
.portal--agent .portal__cta:hover { background: #166534; box-shadow: 0 0 20px rgba(34,197,94,0.2); }

.portal__input { display: none; }

.portal__drop-hint {
  font-size: 0.65rem;
  color: #334155;
  margin-top: -0.5rem;
}

.portal__error {
  font-size: 0.75rem;
  color: #f87171;
  background: #1f020222;
  border: 1px solid #dc262644;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
}

/* Latest rec preview strip */
.portal__preview {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
  padding: 0.5rem 0.75rem;
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 8px;
  margin-top: auto;
}
.preview__label { font-size: 0.62rem; color: #475569; }
.preview__game  { font-size: 0.7rem; font-weight: 700; color: #60a5fa; }
.preview__n     { font-size: 0.68rem; color: #22c55e; font-weight: 600; }
.preview__pairs { font-size: 0.68rem; font-family: 'JetBrains Mono', monospace; color: #94a3b8; }

/* ── Quick access grid ────────────────────────────────────────── */
.lobby__quick {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.75rem;
  width: 100%;
  max-width: 1100px;
  z-index: 1;
}

.qlink {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  background: #0a0f1c;
  border: 1px solid #1a2535;
  border-radius: 12px;
  text-decoration: none;
  color: inherit;
  transition: border-color 0.2s, background 0.2s, transform 0.15s;
}
.qlink:hover {
  background: #0f1623;
  border-color: #253346;
  transform: translateY(-2px);
}
.qlink--alert { border-color: #dc262644; }
.qlink--alert:hover { border-color: #dc262688; }

.qlink__icon { font-size: 1.25rem; flex-shrink: 0; }
.qlink__title {
  font-size: 0.82rem;
  font-weight: 700;
  color: #e2e8f0;
  display: flex;
  align-items: center;
  gap: 0.4rem;
}
.qlink__sub {
  font-size: 0.65rem;
  color: #475569;
  margin-top: 0.1rem;
}
.qlink__badge {
  background: #ef4444;
  color: #fff;
  font-size: 0.6rem;
  font-weight: 700;
  padding: 0.1rem 0.4rem;
  border-radius: 999px;
}

/* ── Footer ───────────────────────────────────────────────────── */
.lobby__footer {
  font-size: 0.65rem;
  color: #1e2d40;
  z-index: 1;
  display: flex;
  gap: 0.5rem;
}
.lobby__footer-sep { opacity: 0.4; }

/* ── Animations ───────────────────────────────────────────────── */
@keyframes orbFloat {
  0%, 100% { transform: translate(0, 0) scale(1); }
  33%       { transform: translate(30px, -20px) scale(1.05); }
  66%       { transform: translate(-20px, 15px) scale(0.97); }
}
@keyframes pulse {
  0%, 100% { opacity: 1; box-shadow: 0 0 6px #22c55e; }
  50%       { opacity: 0.6; box-shadow: 0 0 12px #22c55e; }
}

/* ── Responsive ───────────────────────────────────────────────── */
@media (max-width: 900px) {
  .lobby__portals { grid-template-columns: 1fr; }
  .lobby__quick   { grid-template-columns: 1fr 1fr; }
}
@media (max-width: 600px) {
  .lobby__quick { grid-template-columns: 1fr; }
  .lobby { padding: 1.5rem 1rem 2rem; gap: 1.75rem; }
}
</style>
