<template>
  <div class="bc-view">

    <!-- ── HEADER ─────────────────────────────────────────────── -->
    <div class="bc-header">
      <div>
        <h1 class="bc-title">Centro de Control · Backtest</h1>
        <p class="bc-subtitle">Ejecución manual o autónoma · Todas las estrategias · Histórico completo</p>
      </div>
      <div class="bc-header-right">
        <span class="auto-badge" v-if="hasProactiveJob">
          🤖 Proactivo activo
        </span>
        <button class="btn-sec" @click="loadHistory(); loadAdaptiveState()">↻ Historial</button>
      </div>
    </div>

    <!-- ── DRAWS META INFO ─────────────────────────────────────── -->
    <div class="draws-meta" v-if="drawsMetaForContext">
      <span class="dm-item">📅 Histórico disponible</span>
      <span class="dm-sep">·</span>
      <span class="dm-val">{{ drawsMetaForContext.count.toLocaleString() }} sorteos</span>
      <span class="dm-sep">·</span>
      <span class="dm-val">{{ drawsMetaForContext.date_min }} → {{ drawsMetaForContext.date_max }}</span>
    </div>

    <!-- ── CONFIG PANEL ────────────────────────────────────────── -->
    <div class="config-panel">

      <!-- Step 1: Contexto -->
      <div class="config-section">
        <div class="cs-title"><span class="cs-num">1</span> Contexto</div>
        <div class="cs-row">
          <div class="cs-group">
            <label class="cs-label">Juego</label>
            <div class="btn-group">
              <button :class="['btn-opt', gameType === 'pick3' && 'btn-opt--active']" @click="gameType = 'pick3'">Pick 3</button>
              <button :class="['btn-opt', gameType === 'pick4' && 'btn-opt--active']" @click="gameType = 'pick4'">Pick 4</button>
            </div>
          </div>
          <div class="cs-group">
            <label class="cs-label">Sorteo</label>
            <div class="btn-group">
              <button :class="['btn-opt', mode === 'midday'  && 'btn-opt--active']" @click="mode = 'midday'">Mediodía</button>
              <button :class="['btn-opt', mode === 'evening' && 'btn-opt--active']" @click="mode = 'evening'">Noche</button>
              <button :class="['btn-opt', mode === 'combined'&& 'btn-opt--active']" @click="mode = 'combined'">Ambos</button>
            </div>
          </div>
        </div>
      </div>

      <!-- Step 2: Rango de fechas -->
      <div class="config-section">
        <div class="cs-title"><span class="cs-num">2</span> Rango de Fechas <span class="cs-opt">(opcional — vacío = histórico completo)</span></div>
        <div class="cs-row">
          <div class="cs-group">
            <label class="cs-label">Desde</label>
            <input type="date" class="cs-input" v-model="dateFrom" :max="dateTo || undefined" />
          </div>
          <div class="cs-group">
            <label class="cs-label">Hasta</label>
            <input type="date" class="cs-input" v-model="dateTo" :min="dateFrom || undefined" />
          </div>
          <button class="btn-ghost" @click="dateFrom = ''; dateTo = ''" v-if="dateFrom || dateTo">✕ Limpiar</button>
        </div>
      </div>

      <!-- Step 3: Estrategias -->
      <div class="config-section">
        <div class="cs-title-row">
          <div class="cs-title"><span class="cs-num">3</span> Estrategias <span class="cs-badge">{{ selectedStrats.size }} / {{ catalog.length }}</span></div>
          <div class="strat-actions">
            <button class="btn-ghost" @click="selectAll()">Todas</button>
            <button class="btn-ghost" @click="selectDefault()">Por defecto</button>
            <button class="btn-ghost" @click="selectNone()">Ninguna</button>
          </div>
        </div>
        <div class="strat-grid" v-if="!catalogLoading">
          <button
            v-for="s in catalog"
            :key="s.id"
            class="strat-btn"
            :class="{
              'strat-btn--selected': selectedStrats.has(s.id),
              'strat-btn--apex': s.id === 'apex_adaptive',
            }"
            :style="{ '--sc': catMeta(s.category).color }"
            @click="toggleStrategy(s.id)"
            :title="s.description"
          >
            <span class="sb-icon">{{ s.icon }}</span>
            <span class="sb-label">{{ s.label }}</span>
            <span class="sb-cat" :style="{ color: catMeta(s.category).color }">{{ s.category }}</span>
            <span class="sb-check" v-if="selectedStrats.has(s.id)">✓</span>
          </button>
        </div>
        <div v-else class="state-msg"><div class="spinner"></div> Cargando catálogo…</div>
      </div>

      <!-- Step 4: Top-N + Run -->
      <div class="config-section">
        <div class="cs-title"><span class="cs-num">4</span> Top-N Candidatos</div>
        <div class="cs-row">
          <div class="cs-group">
            <div class="topn-presets">
              <button v-for="n in [5, 10, 15, 20, 30]" :key="n"
                :class="['btn-opt', 'btn-opt--sm', topN === n && 'btn-opt--active']"
                @click="topN = n">{{ n }}</button>
            </div>
            <div class="topn-custom">
              <label class="cs-label">Personalizado</label>
              <input type="number" class="cs-input cs-input--sm" v-model.number="topN" min="1" max="99" />
              <span class="cs-hint">pares de 100 posibles</span>
            </div>
          </div>

          <!-- Run button -->
          <div class="run-wrap">
            <button
              class="btn-run"
              :disabled="running || selectedStrats.size === 0"
              @click="runBacktest()"
            >
              <span v-if="!running">▶ Ejecutar Backtest</span>
              <span v-else class="running-label">
                <span class="spin-small">↻</span> Corriendo… {{ progressPct }}%
              </span>
            </button>
            <button v-if="running" class="btn-cancel" @click="cancelJob()">✕ Cancelar</button>
          </div>
        </div>
      </div>
    </div>

    <!-- ── LIVE PROGRESS ───────────────────────────────────────── -->
    <div class="progress-panel" v-if="running || jobStatus === 'completed' || jobStatus === 'error'">
      <div class="pp-header">
        <span class="pp-status" :class="`pp-status--${jobStatus}`">
          {{ statusLabel(jobStatus) }}
        </span>
        <span class="pp-strategy" v-if="running">{{ jobProgress.current_strategy }}</span>
        <span class="pp-time" v-if="!running && activeJobId">Job: {{ activeJobId?.slice(0,8) }}</span>
      </div>
      <div class="pp-bar-bg">
        <div
          class="pp-bar-fill"
          :class="{ 'pp-bar-fill--error': jobStatus === 'error' }"
          :style="{ width: progressPct + '%', transition: 'width 0.4s' }"
        ></div>
      </div>
      <div class="pp-steps" v-if="running">
        <span>{{ jobProgress.done }} / {{ jobProgress.total }} estrategias</span>
        <span>{{ progressPct }}%</span>
      </div>
      <div class="pp-error" v-if="jobStatus === 'error'">⚠ {{ jobError }}</div>
    </div>

    <!-- ── RESULTS ─────────────────────────────────────────────── -->
    <div class="section" v-if="resultsSorted.length">
      <div class="section-title-row">
        <span class="section-title">Resultados · {{ gameType.toUpperCase() }} · {{ mode }}</span>
        <span class="res-meta" v-if="dateFrom || dateTo">
          {{ dateFrom || '…' }} → {{ dateTo || 'hoy' }}
        </span>
      </div>

      <!-- Results table -->
      <div class="results-table">
        <div class="rt-row rt-row--header">
          <span>#</span>
          <span>Estrategia</span>
          <span>Hit Rate</span>
          <span>Win Rate</span>
          <span>Top-N</span>
          <span>Eval. pts</span>
          <span>Top Pairs</span>
          <span>MRR</span>
          <span>Sharpe</span>
        </div>
        <div
          v-for="(r, i) in resultsSorted"
          :key="r.strategy_name"
          class="rt-row"
          :class="{
            'rt-row--apex': r.strategy_name === 'apex_adaptive',
            'rt-row--top3': i < 3 && r.strategy_name !== 'apex_adaptive'
          }"
        >
          <span class="rt-rank">
            <span v-if="i === 0 && r.strategy_name !== 'apex_adaptive'">🥇</span>
            <span v-else-if="i === 1 && r.strategy_name !== 'apex_adaptive'">🥈</span>
            <span v-else-if="i === 2 && r.strategy_name !== 'apex_adaptive'">🥉</span>
            <span v-else class="rt-n">#{{ i+1 }}</span>
          </span>
          <span class="rt-name">
            <span>{{ stratMeta(r.strategy_name).icon }}</span>
            {{ stratMeta(r.strategy_name).label }}
          </span>
          <span class="rt-rate" :style="{ color: rateColor(r.hit_rate ?? 0) }">
            {{ pct(r.hit_rate ?? 0) }}
          </span>
          <span class="rt-wr">{{ pct(r.win_rate ?? 0) }}</span>
          <span class="rt-topn">
            <span class="topn-pill" :class="topnClass(r.final_top_n ?? r.top_n ?? 15)">
              {{ r.final_top_n ?? r.top_n ?? 15 }}
            </span>
          </span>
          <span class="rt-eval">{{ r.total_eval_pts ?? '—' }}</span>
          <span class="rt-pairs">
            <span
              v-for="p in (r.top_pairs_sample ?? []).slice(0, 5)"
              :key="p"
              class="pair-chip"
            >{{ p }}</span>
          </span>
          <span class="rt-mrr">{{ r.mrr?.toFixed(3) ?? '—' }}</span>
          <span class="rt-sharpe" :class="sharpeClass(r.sharpe)">{{ r.sharpe?.toFixed(2) ?? '—' }}</span>
        </div>
      </div>

      <!-- APEX best pairs highlight -->
      <div class="apex-highlight" v-if="apexResult">
        <div class="ah-header">🏆 APEX Adaptive — Top {{ topN }} Pares Recomendados</div>
        <div class="ah-pairs">
          <span
            v-for="(p, i) in (apexResult.top_pairs_sample ?? []).slice(0, topN)"
            :key="p"
            class="ah-pair"
            :class="i < 5 ? 'ah-pair--top5' : ''"
          >
            <span class="ah-rank">{{ i+1 }}</span>
            {{ p }}
          </span>
        </div>
        <div class="ah-meta">
          Hit rate: <strong :style="{ color: rateColor(apexResult.hit_rate ?? 0) }">{{ pct(apexResult.hit_rate ?? 0) }}</strong>
          · Sharpe: <strong>{{ apexResult.sharpe?.toFixed(2) ?? '—' }}</strong>
          · Eval: <strong>{{ apexResult.total_eval_pts ?? '—' }} sorteos</strong>
        </div>
      </div>
    </div>

    <!-- ── ADAPTIVE STATE ──────────────────────────────────────── -->
    <div class="section" v-if="adaptiveState.length">
      <div class="section-title">⚙️ Estado Adaptativo Actual · {{ gameType }} · {{ mode }}</div>
      <div class="adaptive-table">
        <div class="at-row at-row--header">
          <span>Estrategia</span>
          <span>Peso</span>
          <span>Top-N</span>
          <span>Último update</span>
          <span>Historial Hit Rate</span>
        </div>
        <div v-for="aw in adaptiveState" :key="aw.strategy" class="at-row">
          <span class="at-name">{{ stratMeta(aw.strategy).icon }} {{ stratMeta(aw.strategy).label }}</span>
          <span class="at-weight" :class="weightClass(aw.weight)">{{ aw.weight?.toFixed(3) }}×</span>
          <span class="at-topn">
            <span class="topn-pill" :class="topnClass(aw.top_n)">{{ aw.top_n }}</span>
          </span>
          <span class="at-date">{{ aw.updated_at?.slice(0,16).replace('T',' ') ?? '—' }}</span>
          <span class="at-hist">
            <div class="hist-sparkbars">
              <div
                v-for="(r, i) in (aw.hit_rate_history ?? []).slice(-8)"
                :key="i"
                class="hsb"
                :style="{ height: Math.max(4, r * 200) + 'px', background: rateColor(r) }"
                :title="pct(r)"
              ></div>
            </div>
          </span>
        </div>
      </div>
    </div>

    <!-- ── JOB HISTORY ─────────────────────────────────────────── -->
    <div class="section" v-if="history.length">
      <div class="section-title">Historial de Ejecuciones</div>
      <div class="history-list">
        <div
          v-for="j in history"
          :key="j.id"
          class="hj-card"
          :class="`hj-card--${j.status}`"
          @click="loadJobResults(j.id)"
        >
          <div class="hj-left">
            <span class="hj-status-dot" :class="`dot--${j.status}`"></span>
            <div>
              <div class="hj-context">{{ j.game_type.toUpperCase() }} · {{ j.mode }} · Top-{{ j.top_n }}</div>
              <div class="hj-date">{{ fmtDate(j.started_at) }}</div>
            </div>
          </div>
          <div class="hj-center">
            <span class="hj-by" :class="`by--${j.triggered_by}`">
              {{ j.triggered_by === 'manual' ? '👤 Manual' : j.triggered_by === 'agent_proactive' ? '🤖 Proactivo' : '⏰ Cron' }}
            </span>
            <span class="hj-strats">{{ j.strategies?.length ?? 0 }} estrategias</span>
          </div>
          <div class="hj-right">
            <span class="hj-status">{{ statusLabel(j.status) }}</span>
            <span class="hj-results" v-if="j.result_count">{{ j.result_count }} resultados</span>
            <span class="hj-progress" v-if="j.status === 'running'">{{ j.progress?.done }}/{{ j.progress?.total }}</span>
          </div>
        </div>
      </div>
    </div>

  </div>
</template>

<script setup>
import { onMounted, computed, watch } from 'vue';
import { useBacktestControl, CATEGORY_META } from '../../composables/agent/useBacktestControl.js';

const {
  catalog, drawsMeta, catalogLoading,
  gameType, mode, topN, dateFrom, dateTo, selectedStrats,
  activeJobId, jobStatus, jobProgress, jobResults, jobError, running,
  progressPct, resultsSorted,
  history, adaptiveState,
  drawsMetaForContext, pct, fmtDate,
  loadCatalog, loadHistory, loadAdaptiveState,
  toggleStrategy, selectAll, selectNone, selectDefault,
  runBacktest, cancelJob, loadJobResults,
} = useBacktestControl();

onMounted(async () => {
  await Promise.all([loadCatalog(), loadHistory(), loadAdaptiveState()]);
});

// Reload adaptive state when context changes
watch([gameType, mode], () => loadAdaptiveState());

// ─── Computed ────────────────────────────────────────────────────
const hasProactiveJob = computed(() =>
  history.value.some(j => j.triggered_by === 'agent_proactive' && j.status === 'running')
);

const apexResult = computed(() =>
  resultsSorted.value.find(r => r.strategy_name === 'apex_adaptive')
);

// ─── Helpers ─────────────────────────────────────────────────────
function catMeta(cat) {
  return CATEGORY_META[cat] ?? { color: '#94a3b8', label: cat };
}

const STRAT_META = {};
function stratMeta(id) {
  if (STRAT_META[id]) return STRAT_META[id];
  const found = catalog.value.find(s => s.id === id);
  return found ?? { icon: '🔵', label: id };
}

function rateColor(r) {
  if (r >= 0.18) return '#22c55e';
  if (r >= 0.12) return '#f59e0b';
  return '#f87171';
}

function topnClass(n) {
  if (n <= 10) return 'topn-pill--good';
  if (n <= 20) return 'topn-pill--warn';
  return 'topn-pill--high';
}

function weightClass(w) {
  if (w >= 1.3) return 'w--high';
  if (w <= 0.7) return 'w--low';
  return 'w--mid';
}

function sharpeClass(s) {
  if (s == null) return '';
  if (s >= 1.5) return 'sharpe--good';
  if (s >= 0.8) return 'sharpe--mid';
  return 'sharpe--low';
}

function statusLabel(s) {
  return {
    queued:    '⏳ En cola',
    running:   '⚡ Corriendo',
    completed: '✅ Completado',
    error:     '❌ Error',
    cancelled: '✕ Cancelado',
  }[s] ?? s ?? '—';
}
</script>

<style scoped>
.bc-view { max-width: 1400px; margin: 0 auto; color: #e2e8f0; }

/* ── Header ─────────────────────────────────────────────────────── */
.bc-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; flex-wrap: wrap; gap: 0.75rem; }
.bc-title { font-size: 1.5rem; font-weight: 700; color: #f1f5f9; margin: 0 0 0.2rem; }
.bc-subtitle { font-size: 0.82rem; color: #64748b; margin: 0; }
.bc-header-right { display: flex; gap: 0.5rem; align-items: center; }
.auto-badge { font-size: 0.7rem; background: #052e1633; color: #22c55e; border: 1px solid #22c55e44; padding: 0.25rem 0.6rem; border-radius: 20px; font-weight: 700; }

/* ── Draws meta ─────────────────────────────────────────────────── */
.draws-meta { display: flex; align-items: center; gap: 0.5rem; font-size: 0.75rem; color: #64748b; background: #0f1623; border: 1px solid #1e2d40; border-radius: 8px; padding: 0.5rem 0.85rem; margin-bottom: 1.25rem; flex-wrap: wrap; }
.dm-sep { color: #334155; }
.dm-val { color: #94a3b8; font-weight: 600; }

/* ── Config panel ────────────────────────────────────────────────── */
.config-panel { background: #0a1120; border: 1px solid #1e2d40; border-radius: 14px; overflow: hidden; margin-bottom: 1.5rem; }

.config-section { padding: 1.1rem 1.25rem; border-bottom: 1px solid #0f1623; }
.config-section:last-child { border-bottom: none; }

.cs-title { font-size: 0.78rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; margin-bottom: 0.75rem; display: flex; align-items: center; gap: 0.5rem; }
.cs-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
.cs-num { display: inline-flex; align-items: center; justify-content: center; width: 18px; height: 18px; background: #1e2d40; color: #60a5fa; border-radius: 50%; font-size: 0.65rem; font-weight: 800; flex-shrink: 0; }
.cs-opt { font-size: 0.65rem; color: #475569; text-transform: none; letter-spacing: 0; font-weight: 400; }
.cs-badge { font-size: 0.65rem; background: #1e3a5f; color: #60a5fa; padding: 0.1rem 0.45rem; border-radius: 10px; text-transform: none; letter-spacing: 0; }
.cs-row { display: flex; gap: 1.5rem; align-items: center; flex-wrap: wrap; }
.cs-group { display: flex; flex-direction: column; gap: 0.35rem; }
.cs-label { font-size: 0.65rem; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; }
.cs-hint { font-size: 0.65rem; color: #334155; }
.cs-input { background: #0f1623; border: 1px solid #1e2d40; color: #e2e8f0; padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.8rem; }
.cs-input--sm { width: 70px; }

/* Buttons */
.btn-group { display: flex; gap: 0.25rem; }
.btn-opt { background: #0f1623; border: 1px solid #1e2d40; color: #64748b; padding: 0.35rem 0.8rem; border-radius: 6px; font-size: 0.78rem; cursor: pointer; transition: all 0.15s; }
.btn-opt--sm { padding: 0.25rem 0.6rem; font-size: 0.72rem; }
.btn-opt:hover { border-color: #334155; color: #94a3b8; }
.btn-opt--active { background: #1e3a5f; border-color: #3b82f6; color: #60a5fa; font-weight: 700; }
.btn-ghost { background: none; border: 1px solid #1e2d40; color: #64748b; padding: 0.25rem 0.6rem; border-radius: 6px; font-size: 0.72rem; cursor: pointer; }
.btn-ghost:hover { border-color: #334155; color: #94a3b8; }
.btn-sec { background: #1e2d40; border: 1px solid #334155; color: #94a3b8; padding: 0.35rem 0.7rem; border-radius: 6px; font-size: 0.78rem; cursor: pointer; }

/* Strategy grid */
.strat-actions { display: flex; gap: 0.3rem; }
.strat-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(160px, 1fr)); gap: 0.5rem; }
.strat-btn {
  position: relative; background: #0f1623; border: 1px solid #1e2d40;
  border-radius: 8px; padding: 0.6rem 0.75rem; cursor: pointer;
  display: flex; flex-direction: column; gap: 0.15rem; text-align: left;
  transition: all 0.15s;
}
.strat-btn:hover { border-color: var(--sc, #3b82f6); }
.strat-btn--selected { border-color: var(--sc, #3b82f6); background: linear-gradient(135deg, #0f1623, #111c2e); box-shadow: 0 0 10px color-mix(in srgb, var(--sc, #3b82f6) 10%, transparent); }
.strat-btn--apex.strat-btn--selected { border-color: #fbbf24; }
.sb-icon { font-size: 1.1rem; }
.sb-label { font-size: 0.75rem; font-weight: 600; color: #e2e8f0; }
.sb-cat { font-size: 0.6rem; text-transform: uppercase; letter-spacing: 0.05em; }
.sb-check { position: absolute; top: 0.4rem; right: 0.5rem; color: var(--sc, #22c55e); font-size: 0.75rem; font-weight: 800; }

/* Top-N + Run */
.topn-presets { display: flex; gap: 0.25rem; margin-bottom: 0.5rem; }
.topn-custom { display: flex; align-items: center; gap: 0.5rem; }
.run-wrap { display: flex; gap: 0.5rem; align-items: center; margin-left: auto; }
.btn-run {
  background: linear-gradient(135deg, #1e3a5f, #1d4ed8);
  border: 1px solid #3b82f6; color: #e2e8f0; font-weight: 700;
  padding: 0.65rem 1.5rem; border-radius: 8px; font-size: 0.9rem; cursor: pointer;
  transition: all 0.15s; white-space: nowrap;
}
.btn-run:hover:not(:disabled) { background: linear-gradient(135deg, #1e4a7f, #2563eb); }
.btn-run:disabled { opacity: 0.5; cursor: not-allowed; }
.btn-cancel { background: #450a0a33; border: 1px solid #f8717133; color: #f87171; padding: 0.5rem 0.85rem; border-radius: 8px; font-size: 0.8rem; cursor: pointer; }
.running-label { display: flex; align-items: center; gap: 0.4rem; }
.spin-small { display: inline-block; animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }

/* ── Progress panel ──────────────────────────────────────────────── */
.progress-panel { background: #0a1120; border: 1px solid #1e2d40; border-radius: 10px; padding: 1rem 1.25rem; margin-bottom: 1.5rem; }
.pp-header { display: flex; align-items: center; gap: 0.75rem; margin-bottom: 0.6rem; flex-wrap: wrap; }
.pp-status { font-size: 0.8rem; font-weight: 700; }
.pp-status--queued   { color: #f59e0b; }
.pp-status--running  { color: #60a5fa; }
.pp-status--completed{ color: #22c55e; }
.pp-status--error    { color: #f87171; }
.pp-status--cancelled{ color: #64748b; }
.pp-strategy { font-size: 0.72rem; color: #64748b; }
.pp-time { font-size: 0.65rem; color: #334155; font-family: monospace; }
.pp-bar-bg { height: 6px; background: #1e2d40; border-radius: 3px; overflow: hidden; }
.pp-bar-fill { height: 100%; background: linear-gradient(90deg, #3b82f6, #22c55e); border-radius: 3px; }
.pp-bar-fill--error { background: #ef4444; }
.pp-steps { display: flex; justify-content: space-between; font-size: 0.65rem; color: #475569; margin-top: 0.35rem; }
.pp-error { font-size: 0.75rem; color: #f87171; margin-top: 0.5rem; }

/* ── Section ─────────────────────────────────────────────────────── */
.section { margin-bottom: 1.75rem; }
.section-title { font-size: 0.78rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.07em; margin-bottom: 0.75rem; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.75rem; }
.res-meta { font-size: 0.72rem; color: #475569; font-family: monospace; }

/* ── Results table ───────────────────────────────────────────────── */
.results-table { background: #0a1120; border: 1px solid #1e2d40; border-radius: 10px; overflow: hidden; margin-bottom: 1rem; }
.rt-row {
  display: grid;
  grid-template-columns: 44px 1fr 80px 70px 55px 70px 1fr 65px 65px;
  padding: 0.5rem 0.75rem; border-bottom: 1px solid #0f1623;
  align-items: center; font-size: 0.78rem;
}
.rt-row--header { font-size: 0.62rem; color: #475569; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #1e2d40; }
.rt-row--apex  { background: linear-gradient(90deg, #1a120033, transparent); }
.rt-row--top3  { border-left: 2px solid #3b82f666; }
.rt-rank { font-size: 0.85rem; }
.rt-n { font-size: 0.65rem; color: #475569; }
.rt-name { display: flex; gap: 0.4rem; align-items: center; font-size: 0.8rem; font-weight: 500; }
.rt-rate { font-weight: 800; font-size: 0.88rem; }
.rt-wr, .rt-eval, .rt-mrr { color: #64748b; }
.rt-pairs { display: flex; flex-wrap: wrap; gap: 2px; }
.pair-chip { font-size: 0.65rem; font-family: monospace; background: #1e2d40; padding: 0.1rem 0.3rem; border-radius: 3px; color: #94a3b8; }
.topn-pill { font-size: 0.68rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: 4px; }
.topn-pill--good { background: #052e1633; color: #22c55e; }
.topn-pill--warn { background: #451a0333; color: #f59e0b; }
.topn-pill--high { background: #450a0a33; color: #f87171; }
.sharpe--good { color: #22c55e; font-weight: 700; }
.sharpe--mid  { color: #f59e0b; }
.sharpe--low  { color: #f87171; }
.w--high { color: #22c55e; font-weight: 700; }
.w--mid  { color: #94a3b8; }
.w--low  { color: #f87171; }

/* ── APEX highlight ──────────────────────────────────────────────── */
.apex-highlight { background: linear-gradient(135deg, #0f1623, #1a120022); border: 1px solid #92400e44; border-radius: 10px; padding: 1rem 1.25rem; }
.ah-header { font-size: 0.78rem; font-weight: 700; color: #fbbf24; margin-bottom: 0.75rem; }
.ah-pairs { display: flex; flex-wrap: wrap; gap: 0.35rem; margin-bottom: 0.75rem; }
.ah-pair { display: flex; align-items: center; gap: 0.3rem; background: #1a1200; border: 1px solid #451a0355; border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 0.8rem; font-family: monospace; color: #e2e8f0; }
.ah-pair--top5 { border-color: #fbbf2444; color: #fbbf24; font-weight: 700; }
.ah-rank { font-size: 0.6rem; color: #475569; }
.ah-meta { font-size: 0.72rem; color: #64748b; }

/* ── Adaptive table ──────────────────────────────────────────────── */
.adaptive-table { background: #0a1120; border: 1px solid #1e2d40; border-radius: 10px; overflow: hidden; }
.at-row {
  display: grid;
  grid-template-columns: 1.2fr 80px 60px 140px 1fr;
  padding: 0.5rem 0.75rem; border-bottom: 1px solid #0f1623;
  font-size: 0.78rem; align-items: center;
}
.at-row--header { font-size: 0.62rem; color: #475569; text-transform: uppercase; border-bottom: 1px solid #1e2d40; }
.at-name { display: flex; gap: 0.4rem; }
.at-weight { font-weight: 700; }
.at-date { font-size: 0.65rem; color: #334155; font-family: monospace; }
.hist-sparkbars { display: flex; align-items: flex-end; gap: 2px; height: 24px; }
.hsb { min-width: 6px; border-radius: 1px 1px 0 0; flex: 1; }

/* ── History list ────────────────────────────────────────────────── */
.history-list { display: flex; flex-direction: column; gap: 0.4rem; }
.hj-card {
  background: #0a1120; border: 1px solid #1e2d40; border-radius: 8px;
  padding: 0.65rem 0.9rem; display: flex; align-items: center; justify-content: space-between;
  cursor: pointer; transition: background 0.15s; gap: 1rem;
}
.hj-card:hover { background: #111c2e; }
.hj-card--running { border-left: 2px solid #60a5fa; }
.hj-card--completed { border-left: 2px solid #22c55e44; }
.hj-card--error { border-left: 2px solid #f8717144; }
.hj-left { display: flex; gap: 0.6rem; align-items: center; }
.hj-context { font-size: 0.78rem; font-weight: 600; color: #e2e8f0; }
.hj-date { font-size: 0.65rem; color: #475569; }
.hj-center { display: flex; flex-direction: column; gap: 0.2rem; }
.hj-by { font-size: 0.65rem; font-weight: 700; }
.by--manual          { color: #60a5fa; }
.by--agent_proactive { color: #22c55e; }
.by--scheduled       { color: #f59e0b; }
.hj-strats { font-size: 0.62rem; color: #475569; }
.hj-right { display: flex; flex-direction: column; gap: 0.15rem; align-items: flex-end; }
.hj-status { font-size: 0.72rem; font-weight: 600; color: #64748b; }
.hj-results, .hj-progress { font-size: 0.65rem; color: #475569; }
.hj-status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
.dot--queued    { background: #f59e0b; }
.dot--running   { background: #60a5fa; box-shadow: 0 0 6px #60a5fa; animation: pulse 1.5s infinite; }
.dot--completed { background: #22c55e; }
.dot--error     { background: #f87171; }
.dot--cancelled { background: #475569; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }

/* ── Misc ────────────────────────────────────────────────────────── */
.state-msg { display: flex; align-items: center; gap: 0.5rem; color: #64748b; padding: 1rem; font-size: 0.8rem; }
.spinner { width: 14px; height: 14px; border: 2px solid #1e2d40; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.7s linear infinite; }

@media (max-width: 900px) {
  .rt-row { grid-template-columns: 40px 1fr 70px 60px 50px; }
  .rt-row > :nth-child(n+6) { display: none; }
  .at-row { grid-template-columns: 1fr 70px 50px; }
  .at-row > :nth-child(n+4) { display: none; }
  .strat-grid { grid-template-columns: repeat(auto-fill, minmax(130px, 1fr)); }
}
</style>
