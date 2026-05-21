<!--
═══════════════════════════════════════════════════════════════════
  TruthView.vue — La verdad sin maquillaje (2026-05-21)

  "HELIX F1 SIEMPRE HA SIDO aprendizaje adaptativo autónomo didáctico"

  Vista honesta de TODOS los tests estadísticos que el sistema corre
  autónomamente. Sin marketing. Sin maquillaje. Solo:
    • p-values con corrección Bonferroni
    • Wilson 95% CI explícitos
    • Veredicto por familia de test
    • Edge real (si lo hay) o ausencia honesta

  Ruta: /agent/truth
═══════════════════════════════════════════════════════════════════
-->
<template>
  <div class="truth-view">
    <header class="tv-header">
      <div class="tv-title">
        <span class="tv-icon">🔬</span>
        <div>
          <h1 class="tv-h1">Truth Mode</h1>
          <p class="tv-sub">Edge Discovery Engine · Reporte estadístico sin maquillaje</p>
        </div>
      </div>
      <div class="tv-actions">
        <button class="tv-btn-run" @click="runDiscovery" :disabled="running">
          {{ running ? '⟳ Ejecutando...' : '🔬 Ejecutar Discovery' }}
        </button>
        <button class="tv-btn-refresh" @click="loadLatest" :disabled="loading">↻</button>
      </div>
    </header>

    <!-- Veredicto global -->
    <section v-if="run" class="tv-verdict" :class="{ 'tv-verdict--edge': run.edge_found, 'tv-verdict--null': !run.edge_found }">
      <div class="tv-verdict-icon">{{ run.edge_found ? '🎯' : '🔍' }}</div>
      <div class="tv-verdict-body">
        <div class="tv-verdict-title">
          {{ run.edge_found ? 'EDGE DETECTADO' : 'NO HAY EDGE DETECTABLE' }}
        </div>
        <div class="tv-verdict-detail">{{ run.verdict }}</div>
        <div class="tv-verdict-meta">
          <span>Run: <code>{{ run.run_id }}</code></span>
          <span>Tests: {{ run.total_tests }}</span>
          <span>Significativos: <strong>{{ run.significant_tests }}</strong></span>
          <span>Duración: {{ run.duration_ms }}ms</span>
        </div>
      </div>
    </section>

    <!-- Family summary -->
    <section v-if="familySummary.length" class="tv-section">
      <h2 class="tv-section-title">📊 Resumen por Familia de Test</h2>
      <div class="tv-family-grid">
        <div v-for="f in familySummary" :key="f.family"
             class="tv-family-card"
             :class="{ 'tv-family-card--sig': f.significant > 0 }">
          <div class="tv-family-name">{{ familyLabel(f.family) }}</div>
          <div class="tv-family-stats">
            <span class="tv-family-stat">
              <span class="tv-stat-val" :class="f.significant > 0 ? 'tv-stat-sig' : 'tv-stat-null'">
                {{ f.significant }}/{{ f.total_tests }}
              </span>
              <span class="tv-stat-lab">significativos</span>
            </span>
            <span class="tv-family-stat">
              <span class="tv-stat-val">{{ formatPValue(f.min_p_value) }}</span>
              <span class="tv-stat-lab">min p-value</span>
            </span>
          </div>
        </div>
      </div>
    </section>

    <!-- Tests detalle: filtros -->
    <section v-if="tests.length" class="tv-section">
      <div class="tv-filters">
        <label class="tv-filter-lbl">
          <input type="checkbox" v-model="onlySignificant" />
          Solo significativos
        </label>
        <select v-model="filterFamily" class="tv-filter-sel">
          <option value="">Todas las familias</option>
          <option v-for="f in familySummary" :key="f.family" :value="f.family">{{ familyLabel(f.family) }}</option>
        </select>
      </div>

      <h2 class="tv-section-title">🔬 Tests Detallados ({{ filteredTests.length }})</h2>

      <div class="tv-tests">
        <article v-for="(t, idx) in filteredTests" :key="t.test_name + idx"
                 class="tv-test"
                 :class="{ 'tv-test--sig': t.significant }">

          <div class="tv-test-header">
            <span class="tv-test-fam">{{ familyLabel(t.test_family) }}</span>
            <span class="tv-test-name">{{ t.test_name }}</span>
            <span class="tv-test-badge" :class="t.significant ? 'tv-badge-sig' : 'tv-badge-null'">
              {{ t.significant ? '🎯 SIG' : '○ no-sig' }}
            </span>
          </div>

          <div class="tv-test-h0">
            <span class="tv-test-lbl">H0:</span> {{ t.null_hypothesis }}
          </div>

          <div class="tv-test-stats">
            <div class="tv-test-stat">
              <span class="tv-test-stat-lab">test stat</span>
              <span class="tv-test-stat-val">{{ formatNumber(t.test_statistic) }}</span>
            </div>
            <div class="tv-test-stat">
              <span class="tv-test-stat-lab">p-value</span>
              <span class="tv-test-stat-val" :class="t.significant ? 'tv-stat-sig' : ''">
                {{ formatPValue(t.p_value) }}
              </span>
            </div>
            <div class="tv-test-stat">
              <span class="tv-test-stat-lab">Bonferroni α</span>
              <span class="tv-test-stat-val">{{ formatPValue(t.bonferroni_threshold) }}</span>
            </div>
            <div v-if="t.effect_size !== null" class="tv-test-stat">
              <span class="tv-test-stat-lab">{{ t.effect_size_metric }}</span>
              <span class="tv-test-stat-val">{{ formatNumber(t.effect_size) }}</span>
            </div>
            <div class="tv-test-stat">
              <span class="tv-test-stat-lab">n</span>
              <span class="tv-test-stat-val">{{ formatN(t.sample_size) }}</span>
            </div>
          </div>

          <div class="tv-test-interp">{{ t.interpretation }}</div>
        </article>
      </div>
    </section>

    <div v-if="loading" class="tv-loading">⟳ Cargando reporte...</div>
    <div v-else-if="!run" class="tv-empty">
      <p>Sin reportes previos.</p>
      <p>Haz click en <strong>🔬 Ejecutar Discovery</strong> para correr el análisis.</p>
    </div>
  </div>
</template>

<script setup>
import { ref, computed, onMounted } from 'vue';
import { apiGet, apiPost } from '../../utils/apiClient.js';

const run             = ref(null);
const tests           = ref([]);
const familySummary   = ref([]);
const loading         = ref(false);
const running         = ref(false);
const onlySignificant = ref(false);
const filterFamily    = ref('');

const FAMILY_LABELS = {
  algo_edge:        '⚙️ Algorithm Edge',
  dow_bias:         '📅 Day-of-Week Bias',
  autocorrelation:  '🔁 Autocorrelation',
  pair_persistence: '🔀 Pair Persistence',
  drift_ks:         '📈 Distribution Drift',
  diversity:        '🌐 Algorithm Diversity',
};

function familyLabel(family) {
  return FAMILY_LABELS[family] ?? family;
}

function formatPValue(p) {
  if (p == null) return '—';
  const n = Number(p);
  if (n === 0) return '<1e-15';
  if (n < 0.001) return n.toExponential(2);
  return n.toFixed(4);
}

function formatNumber(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (Math.abs(n) < 0.0001) return n.toExponential(2);
  if (Math.abs(n) > 1000) return n.toExponential(2);
  return n.toFixed(4);
}

function formatN(v) {
  if (v == null) return '—';
  const n = Number(v);
  if (n >= 1e6) return (n / 1e6).toFixed(2) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

const filteredTests = computed(() => {
  return tests.value.filter(t => {
    if (onlySignificant.value && !t.significant) return false;
    if (filterFamily.value && t.test_family !== filterFamily.value) return false;
    return true;
  });
});

async function loadLatest() {
  loading.value = true;
  try {
    const data = await apiGet('/api/agent/edge-discovery/report');
    run.value = data.run;
    tests.value = data.tests ?? [];
    familySummary.value = data.family_summary ?? [];
  } catch (err) {
    if (!String(err).includes('404')) console.error(err);
    run.value = null;
    tests.value = [];
    familySummary.value = [];
  } finally {
    loading.value = false;
  }
}

async function runDiscovery() {
  running.value = true;
  try {
    const result = await apiPost('/api/agent/edge-discovery/run', { scope: 'all' });
    console.log('Edge discovery started:', result);
    // Poll for completion
    const poll = setInterval(async () => {
      await loadLatest();
      if (run.value && run.value.status === 'completed') {
        clearInterval(poll);
        running.value = false;
      }
    }, 3000);
    // Safety: stop polling after 5 min
    setTimeout(() => { clearInterval(poll); running.value = false; }, 300000);
  } catch (err) {
    console.error(err);
    running.value = false;
  }
}

onMounted(loadLatest);
</script>

<style scoped>
.truth-view {
  max-width: 1200px;
  margin: 0 auto;
  padding: 1rem 0;
  display: flex; flex-direction: column;
  gap: 1.5rem;
}

.tv-header {
  display: flex; justify-content: space-between; align-items: flex-end;
  padding-bottom: 1rem;
  border-bottom: 1px solid #1e2d40;
}
.tv-title { display: flex; gap: 1rem; align-items: center; }
.tv-icon  { font-size: 2.5rem; }
.tv-h1    { margin: 0; font-size: 1.5rem; font-weight: 800; color: #e2e8f0; }
.tv-sub   { margin: 0.2rem 0 0; font-size: 0.8rem; color: #64748b; }

.tv-actions { display: flex; gap: 0.5rem; }
.tv-btn-run, .tv-btn-refresh {
  background: #1e3a5f; color: #60a5fa;
  border: 1px solid #1e40af; border-radius: 6px;
  padding: 0.5rem 0.9rem; font-size: 0.85rem; font-weight: 600;
  cursor: pointer; transition: all 0.15s;
}
.tv-btn-run:hover, .tv-btn-refresh:hover { background: #1e40af; color: #fff; }
.tv-btn-run:disabled { opacity: 0.5; cursor: not-allowed; }

.tv-verdict {
  display: flex; gap: 1.5rem; align-items: flex-start;
  padding: 1.25rem 1.5rem;
  border-radius: 10px;
  border: 2px solid;
}
.tv-verdict--edge { background: rgba(34, 197, 94, 0.08);  border-color: #16a34a; }
.tv-verdict--null { background: rgba(100, 116, 139, 0.08); border-color: #475569; }
.tv-verdict-icon  { font-size: 2.5rem; }
.tv-verdict-body  { flex: 1; }
.tv-verdict-title { font-size: 1.1rem; font-weight: 800; color: #e2e8f0; margin-bottom: 0.3rem; }
.tv-verdict--edge .tv-verdict-title { color: #4ade80; }
.tv-verdict-detail { font-size: 0.85rem; color: #cbd5e1; margin-bottom: 0.5rem; line-height: 1.5; }
.tv-verdict-meta { font-size: 0.7rem; color: #64748b; display: flex; gap: 1rem; flex-wrap: wrap; }
.tv-verdict-meta code { background: rgba(0,0,0,0.3); padding: 0.1rem 0.4rem; border-radius: 3px; }

.tv-section { display: flex; flex-direction: column; gap: 1rem; }
.tv-section-title {
  font-size: 0.85rem; font-weight: 700; color: #94a3b8;
  letter-spacing: 0.06em; text-transform: uppercase;
}

.tv-family-grid {
  display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 0.75rem;
}
.tv-family-card {
  background: #0f1623;
  border: 1px solid #1e2d40; border-radius: 8px;
  padding: 0.9rem 1rem;
  display: flex; flex-direction: column; gap: 0.4rem;
}
.tv-family-card--sig {
  border-color: #16a34a;
  background: rgba(34, 197, 94, 0.05);
}
.tv-family-name { font-size: 0.85rem; font-weight: 700; color: #cbd5e1; }
.tv-family-stats { display: flex; gap: 1rem; }
.tv-family-stat { display: flex; flex-direction: column; gap: 0.1rem; }
.tv-stat-val { font-size: 1rem; font-weight: 800; color: #e2e8f0; font-family: var(--font-mono, monospace); }
.tv-stat-sig { color: #4ade80; }
.tv-stat-null { color: #64748b; }
.tv-stat-lab { font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }

.tv-filters {
  display: flex; gap: 1rem; align-items: center;
  padding: 0.5rem 0;
}
.tv-filter-lbl {
  font-size: 0.8rem; color: #94a3b8;
  display: flex; gap: 0.4rem; align-items: center;
  cursor: pointer;
}
.tv-filter-sel {
  background: #0f1623; color: #e2e8f0;
  border: 1px solid #1e2d40; border-radius: 4px;
  padding: 0.3rem 0.6rem; font-size: 0.8rem;
}

.tv-tests { display: flex; flex-direction: column; gap: 0.6rem; }
.tv-test {
  background: #0f1623;
  border: 1px solid #1e2d40; border-radius: 8px;
  padding: 0.85rem 1rem;
}
.tv-test--sig {
  border-color: #16a34a;
  background: rgba(34, 197, 94, 0.04);
}

.tv-test-header {
  display: flex; gap: 0.6rem; align-items: center;
  margin-bottom: 0.5rem;
}
.tv-test-fam {
  font-size: 0.7rem; font-weight: 700;
  padding: 0.15rem 0.5rem; border-radius: 4px;
  background: #1e2d40; color: #94a3b8;
}
.tv-test-name {
  font-family: var(--font-mono, monospace); font-size: 0.75rem;
  color: #64748b; flex: 1; word-break: break-all;
}
.tv-test-badge {
  font-size: 0.7rem; font-weight: 700;
  padding: 0.15rem 0.6rem; border-radius: 4px;
}
.tv-badge-sig { background: #16a34a; color: white; }
.tv-badge-null { background: rgba(100, 116, 139, 0.2); color: #94a3b8; }

.tv-test-h0 {
  font-size: 0.78rem; color: #cbd5e1;
  margin-bottom: 0.5rem; line-height: 1.4;
}
.tv-test-lbl { color: #64748b; font-weight: 600; }

.tv-test-stats {
  display: flex; gap: 1.5rem; flex-wrap: wrap;
  padding: 0.5rem 0;
  border-top: 1px solid #1a2535;
  border-bottom: 1px solid #1a2535;
  margin-bottom: 0.5rem;
}
.tv-test-stat { display: flex; flex-direction: column; gap: 0.1rem; }
.tv-test-stat-lab { font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
.tv-test-stat-val { font-size: 0.85rem; font-weight: 700; color: #e2e8f0; font-family: var(--font-mono, monospace); }

.tv-test-interp {
  font-size: 0.78rem; color: #94a3b8;
  line-height: 1.5; font-style: italic;
}

.tv-loading, .tv-empty {
  padding: 3rem 1rem; text-align: center;
  background: #0f1623;
  border: 1px solid #1e2d40; border-radius: 10px;
  color: #64748b; font-size: 0.85rem;
}
</style>
