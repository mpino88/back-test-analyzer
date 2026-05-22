<!--
═══════════════════════════════════════════════════════════════════
  PublicVerifyView.vue — Public Certificate Verification (2026-05-22)

  Página PÚBLICA accesible sin login. Cualquier persona puede:
   1. Pegar un certificate_id (formato TC-YYYY-MM-DD-HEX)
   2. Verificar la signature HMAC criptográficamente
   3. Ver disclosure honesto (edge_demonstrated, CI includes baseline)
   4. Ver estadísticas agregadas del sistema

  Ruta: /verify
  Sin auth — esto ES la transparencia como producto.
═══════════════════════════════════════════════════════════════════
-->
<template>
  <div class="pv-root">
    <header class="pv-header">
      <div class="pv-brand">
        <span class="pv-logo">🧬</span>
        <span class="pv-title">HELIX</span>
        <span class="pv-tagline">Truth Verification Portal</span>
      </div>
      <a href="/" class="pv-home-link">← Volver</a>
    </header>

    <main class="pv-main">
      <section class="pv-hero">
        <h1 class="pv-hero-title">Verifica un Certificado HELIX</h1>
        <p class="pv-hero-sub">
          Cada predicción de HELIX se acompaña de un <strong>Truth Certificate</strong>
          criptográficamente firmado. Aquí puedes verificar offline cualquier certificado
          emitido — sin login, sin API key.
        </p>
        <p class="pv-hero-sub pv-hero-honesty">
          <strong>Importante:</strong> nuestro sistema actualmente <em>no demuestra edge</em>
          sobre el azar. Esto está documentado en cada certificado con el campo
          <code>edge_demonstrated</code>. La transparencia <em>es</em> el producto.
        </p>
      </section>

      <!-- Stats agregadas -->
      <section v-if="stats" class="pv-stats">
        <div class="pv-stat">
          <div class="pv-stat-val">{{ stats.total_certificates }}</div>
          <div class="pv-stat-lbl">Total certificados emitidos</div>
        </div>
        <div class="pv-stat">
          <div class="pv-stat-val">{{ stats.resolved }}</div>
          <div class="pv-stat-lbl">Resueltos (con outcome real)</div>
        </div>
        <div class="pv-stat" v-if="stats.accuracy_resolved !== null">
          <div class="pv-stat-val">{{ formatPct(stats.accuracy_resolved) }}</div>
          <div class="pv-stat-lbl">Accuracy real observada</div>
        </div>
        <div class="pv-stat">
          <div class="pv-stat-val">{{ formatPct(stats.avg_predicted_hit_rate) }}</div>
          <div class="pv-stat-lbl">Hit rate promedio (walk-forward)</div>
        </div>
      </section>

      <!-- Verify form -->
      <section class="pv-form-card">
        <label class="pv-form-lbl" for="cert-input">Certificate ID</label>
        <div class="pv-input-row">
          <input
            id="cert-input"
            type="text"
            v-model="certId"
            placeholder="TC-2026-05-22-B93752D5"
            @keyup.enter="verify"
            class="pv-input"
          />
          <button class="pv-btn" @click="verify" :disabled="loading || !certId">
            {{ loading ? '⟳ Verificando...' : '🔐 Verificar' }}
          </button>
        </div>
        <div class="pv-input-hint">
          Formato: <code>TC-YYYY-MM-DD-XXXXXXXX</code> (8 caracteres hex)
        </div>
      </section>

      <!-- Resultado -->
      <section v-if="result" class="pv-result" :class="result.signature_valid ? 'pv-result-ok' : 'pv-result-bad'">
        <div class="pv-result-header">
          <div class="pv-result-icon">{{ result.signature_valid ? '✅' : '❌' }}</div>
          <div>
            <div class="pv-result-title">
              {{ result.signature_valid ? 'Signature VÁLIDA' : 'Signature INVÁLIDA' }}
            </div>
            <div class="pv-result-subtitle">
              <code>{{ result.certificate_id }}</code>
            </div>
          </div>
          <div class="pv-result-algo">
            {{ result.algorithm }}
          </div>
        </div>

        <div class="pv-result-grid">
          <!-- Predicción -->
          <div class="pv-result-section">
            <h3 class="pv-result-h3">📋 Predicción</h3>
            <div class="pv-kv">
              <span class="pv-k">Game</span>
              <span class="pv-v">{{ result.prediction.game_type }} · {{ result.prediction.draw_type }} · {{ result.prediction.half }}</span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">Draw date</span>
              <span class="pv-v">{{ result.prediction.draw_date }}</span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">Top-N pairs</span>
              <span class="pv-v">{{ result.prediction.predicted_n }}</span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">Issued at</span>
              <span class="pv-v">{{ formatDate(result.issued_at) }}</span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">Signed at</span>
              <span class="pv-v">{{ formatDate(result.signed_at) }}</span>
            </div>
          </div>

          <!-- Estadísticas -->
          <div class="pv-result-section">
            <h3 class="pv-result-h3">📊 Estadísticas walk-forward</h3>
            <div class="pv-kv">
              <span class="pv-k">Hit rate</span>
              <span class="pv-v">{{ formatPct(result.statistics.hit_rate_walk_forward) }}</span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">Wilson 95% CI</span>
              <span class="pv-v">
                [{{ formatPct(result.statistics.wilson_95_ci_lo) }}, {{ formatPct(result.statistics.wilson_95_ci_hi) }}]
              </span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">Baseline (aleatorio)</span>
              <span class="pv-v">{{ formatPct(result.statistics.baseline_rate) }}</span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">Edge multiplier</span>
              <span class="pv-v" :class="edgeClass(result.statistics.edge_multiplier)">
                {{ formatX(result.statistics.edge_multiplier) }}
              </span>
            </div>
          </div>

          <!-- Disclosure HONESTO -->
          <div class="pv-result-section pv-disclosure"
               :class="result.disclosure.edge_demonstrated ? 'pv-disclosure-edge' : 'pv-disclosure-noedge'">
            <h3 class="pv-result-h3">🩸 Disclosure honesto</h3>
            <div class="pv-kv">
              <span class="pv-k">Edge demostrado</span>
              <span class="pv-v">
                <strong :class="result.disclosure.edge_demonstrated ? 'pv-yes' : 'pv-no'">
                  {{ result.disclosure.edge_demonstrated ? 'SÍ' : 'NO' }}
                </strong>
              </span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">CI incluye baseline</span>
              <span class="pv-v">
                <strong :class="result.disclosure.confidence_interval_includes_baseline ? 'pv-yes' : 'pv-no'">
                  {{ result.disclosure.confidence_interval_includes_baseline ? 'SÍ' : 'NO' }}
                </strong>
              </span>
            </div>
            <div class="pv-statement">
              {{ result.disclosure.statement }}
            </div>
          </div>

          <!-- Audit -->
          <div class="pv-result-section">
            <h3 class="pv-result-h3">🔬 Audit trail</h3>
            <div class="pv-kv">
              <span class="pv-k">Edge Discovery run</span>
              <span class="pv-v"><code>{{ result.audit.last_edge_discovery_run_id ?? '—' }}</code></span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">Tests totales</span>
              <span class="pv-v">{{ result.audit.n_tests_total ?? '—' }}</span>
            </div>
            <div class="pv-kv">
              <span class="pv-k">Tests significativos</span>
              <span class="pv-v">
                <strong>{{ result.audit.n_tests_significant ?? '—' }}</strong>
                / {{ result.audit.n_tests_total ?? '—' }}
              </span>
            </div>
          </div>
        </div>

        <div class="pv-result-footer">
          <button class="pv-btn-secondary" @click="downloadFull">⬇ Descargar JSON completo</button>
        </div>
      </section>

      <!-- Error -->
      <section v-if="error" class="pv-error">
        <div class="pv-error-icon">⚠️</div>
        <div>
          <div class="pv-error-title">{{ error.title }}</div>
          <div class="pv-error-detail">{{ error.detail }}</div>
        </div>
      </section>

      <!-- About -->
      <section class="pv-about">
        <h2>Sobre los Truth Certificates</h2>
        <ul>
          <li><strong>HMAC-SHA256</strong>: cada cert firmado criptográficamente con clave compartida.</li>
          <li><strong>Canonical JSON</strong>: serialización con keys ordenadas para signature determinístico.</li>
          <li><strong>Walk-forward</strong>: hit rate calculado SIN future leakage sobre 5+ años de datos.</li>
          <li><strong>Bonferroni-corrected</strong>: p-values del Edge Discovery con corrección por múltiples comparaciones.</li>
          <li><strong>Conformal coverage</strong>: garantía probabilística de teorema (Angelopoulos & Bates 2023).</li>
          <li><strong>Disclosure obligatorio</strong>: cada cert declara explícitamente si edge fue demostrado.</li>
        </ul>
        <p class="pv-about-cta">
          Esta es la primera plataforma de loto con verificación criptográfica de
          estadísticas. La transparencia <em>es</em> el producto.
        </p>
      </section>
    </main>

    <footer class="pv-footer">
      Powered by HELIX · Bliss Systems LLC · Cada cert verificable offline
    </footer>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';

const certId  = ref('');
const result  = ref(null);
const stats   = ref(null);
const loading = ref(false);
const error   = ref(null);

// Auto-load cert_id from URL query (?id=TC-...)
onMounted(() => {
  const params = new URLSearchParams(window.location.search);
  const id = params.get('id');
  if (id) { certId.value = id; verify(); }
  loadStats();
});

async function loadStats() {
  try {
    const r = await fetch('/api/public/cert-stats');
    if (r.ok) stats.value = await r.json();
  } catch (e) {
    console.warn('No stats available', e);
  }
}

async function verify() {
  if (!certId.value) return;
  loading.value = true;
  error.value   = null;
  result.value  = null;

  try {
    const r = await fetch(`/api/public/certificate/${encodeURIComponent(certId.value)}/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (r.status === 404) {
      error.value = { title: 'Certificado no encontrado', detail: `No existe cert con ID ${certId.value}` };
      return;
    }
    if (r.status === 400) {
      const body = await r.json();
      error.value = { title: 'Formato inválido', detail: body.error ?? 'El cert ID no cumple formato esperado' };
      return;
    }
    if (!r.ok) {
      error.value = { title: 'Error', detail: `HTTP ${r.status}` };
      return;
    }

    result.value = await r.json();
    // Update URL with ?id= for shareable link
    const url = new URL(window.location.href);
    url.searchParams.set('id', certId.value);
    window.history.replaceState({}, '', url.toString());
  } catch (e) {
    error.value = { title: 'Error de red', detail: String(e) };
  } finally {
    loading.value = false;
  }
}

async function downloadFull() {
  try {
    const r = await fetch(`/api/public/certificate/${encodeURIComponent(certId.value)}`);
    if (!r.ok) return;
    const cert = await r.json();
    const blob = new Blob([JSON.stringify(cert, null, 2)], { type: 'application/json' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = `${certId.value}.json`;
    a.click();
    URL.revokeObjectURL(url);
  } catch (e) {
    console.error(e);
  }
}

function formatPct(v) {
  if (v == null) return '—';
  return (Number(v) * 100).toFixed(2) + '%';
}
function formatX(v) {
  if (v == null) return '—';
  return Number(v).toFixed(3) + '×';
}
function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString();
}
function edgeClass(v) {
  if (v == null) return '';
  const n = Number(v);
  if (n >= 1.10) return 'pv-yes';
  if (n >= 1.00) return 'pv-neutral';
  return 'pv-no';
}
</script>

<style scoped>
.pv-root {
  min-height: 100vh;
  background: linear-gradient(180deg, #0a0d14 0%, #0f1623 100%);
  color: #e2e8f0;
  font-family: 'Inter', system-ui, sans-serif;
  display: flex; flex-direction: column;
}

/* Header */
.pv-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 1rem 2rem;
  border-bottom: 1px solid #1e2d40;
  background: rgba(15, 22, 35, 0.8); backdrop-filter: blur(8px);
}
.pv-brand { display: flex; align-items: center; gap: 0.5rem; }
.pv-logo { font-size: 1.5rem; }
.pv-title { font-size: 1.1rem; font-weight: 800; color: #60a5fa; letter-spacing: 0.06em; }
.pv-tagline { font-size: 0.7rem; color: #475569; text-transform: uppercase; letter-spacing: 0.1em; margin-left: 0.5rem; }
.pv-home-link { color: #64748b; text-decoration: none; font-size: 0.85rem; }
.pv-home-link:hover { color: #94a3b8; }

/* Main */
.pv-main {
  flex: 1;
  max-width: 900px;
  margin: 0 auto;
  padding: 2.5rem 1.5rem;
  display: flex; flex-direction: column;
  gap: 2rem;
  width: 100%;
}

/* Hero */
.pv-hero { text-align: center; }
.pv-hero-title {
  font-size: 1.8rem; font-weight: 800;
  margin: 0 0 0.75rem;
  background: linear-gradient(90deg, #60a5fa, #a78bfa);
  -webkit-background-clip: text; background-clip: text;
  -webkit-text-fill-color: transparent;
}
.pv-hero-sub {
  font-size: 0.95rem; color: #cbd5e1; line-height: 1.6;
  max-width: 700px; margin: 0 auto;
}
.pv-hero-honesty {
  margin-top: 0.75rem;
  padding: 0.75rem 1rem;
  background: rgba(251, 191, 36, 0.07);
  border: 1px solid rgba(251, 191, 36, 0.25);
  border-radius: 8px;
  font-size: 0.85rem;
}
.pv-hero-honesty code {
  background: rgba(0,0,0,0.3); padding: 0.1rem 0.35rem; border-radius: 3px; color: #fbbf24;
}

/* Stats */
.pv-stats {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
  gap: 0.75rem;
}
.pv-stat {
  background: #0f1623;
  border: 1px solid #1e2d40; border-radius: 8px;
  padding: 1rem 1.25rem; text-align: center;
}
.pv-stat-val { font-size: 1.5rem; font-weight: 800; color: #60a5fa; font-family: var(--font-mono, monospace); }
.pv-stat-lbl { font-size: 0.7rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-top: 0.25rem; }

/* Form */
.pv-form-card {
  background: #0f1623;
  border: 1px solid #1e2d40; border-radius: 10px;
  padding: 1.5rem;
}
.pv-form-lbl { display: block; font-size: 0.8rem; color: #94a3b8; margin-bottom: 0.5rem; }
.pv-input-row { display: flex; gap: 0.5rem; }
.pv-input {
  flex: 1;
  background: #0a0d14; color: #e2e8f0;
  border: 1px solid #1e2d40; border-radius: 6px;
  padding: 0.75rem 1rem;
  font-family: var(--font-mono, monospace); font-size: 0.9rem;
}
.pv-input:focus { border-color: #60a5fa; outline: none; }
.pv-btn {
  background: linear-gradient(180deg, #1e3a5f, #1e40af);
  color: #fff; border: 1px solid #1e40af; border-radius: 6px;
  padding: 0.75rem 1.5rem; font-weight: 700; cursor: pointer;
  white-space: nowrap;
}
.pv-btn:hover { background: linear-gradient(180deg, #1e40af, #2563eb); }
.pv-btn:disabled { opacity: 0.4; cursor: not-allowed; }
.pv-btn-secondary {
  background: transparent; color: #cbd5e1;
  border: 1px solid #1e2d40; border-radius: 6px;
  padding: 0.5rem 1rem; font-size: 0.85rem; cursor: pointer;
}
.pv-input-hint {
  margin-top: 0.5rem;
  font-size: 0.75rem; color: #64748b;
}
.pv-input-hint code { background: rgba(0,0,0,0.3); padding: 0.1rem 0.35rem; border-radius: 3px; color: #fbbf24; }

/* Result */
.pv-result {
  border-radius: 10px;
  padding: 1.5rem;
  border: 2px solid;
}
.pv-result-ok { background: rgba(34, 197, 94, 0.05); border-color: #16a34a; }
.pv-result-bad { background: rgba(220, 38, 38, 0.05); border-color: #dc2626; }

.pv-result-header { display: flex; align-items: center; gap: 1rem; margin-bottom: 1.5rem; }
.pv-result-icon { font-size: 2.5rem; }
.pv-result-title { font-size: 1.2rem; font-weight: 800; }
.pv-result-ok .pv-result-title { color: #4ade80; }
.pv-result-bad .pv-result-title { color: #f87171; }
.pv-result-subtitle { font-size: 0.75rem; color: #64748b; font-family: var(--font-mono, monospace); }
.pv-result-algo {
  margin-left: auto;
  padding: 0.3rem 0.7rem;
  background: rgba(96, 165, 250, 0.15);
  color: #60a5fa;
  border: 1px solid #1e40af;
  border-radius: 4px;
  font-size: 0.7rem; font-weight: 700;
}

.pv-result-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr));
  gap: 1rem;
}
.pv-result-section {
  background: rgba(0,0,0,0.2);
  border: 1px solid rgba(255,255,255,0.05);
  border-radius: 8px;
  padding: 1rem;
}
.pv-result-h3 {
  margin: 0 0 0.75rem;
  font-size: 0.85rem; color: #94a3b8;
  text-transform: uppercase; letter-spacing: 0.05em;
}

.pv-kv {
  display: flex; justify-content: space-between;
  padding: 0.3rem 0;
  font-size: 0.85rem;
  border-bottom: 1px solid rgba(255,255,255,0.04);
}
.pv-kv:last-child { border-bottom: none; }
.pv-k { color: #64748b; }
.pv-v { color: #cbd5e1; font-family: var(--font-mono, monospace); font-size: 0.8rem; text-align: right; }
.pv-yes { color: #4ade80; }
.pv-no  { color: #f87171; }
.pv-neutral { color: #fbbf24; }

.pv-disclosure-edge   { border-color: rgba(34, 197, 94, 0.3); background: rgba(34, 197, 94, 0.05); }
.pv-disclosure-noedge { border-color: rgba(251, 191, 36, 0.3); background: rgba(251, 191, 36, 0.05); }
.pv-statement {
  margin-top: 0.75rem;
  padding: 0.75rem;
  background: rgba(0,0,0,0.3);
  border-radius: 6px;
  font-size: 0.8rem; line-height: 1.5;
  color: #cbd5e1;
}

.pv-result-footer { margin-top: 1rem; text-align: right; }

/* Error */
.pv-error {
  background: rgba(220, 38, 38, 0.1);
  border: 2px solid #dc2626; border-radius: 10px;
  padding: 1.25rem; display: flex; gap: 1rem; align-items: center;
}
.pv-error-icon { font-size: 2rem; }
.pv-error-title { font-size: 1rem; font-weight: 700; color: #f87171; }
.pv-error-detail { font-size: 0.85rem; color: #cbd5e1; margin-top: 0.25rem; }

/* About */
.pv-about {
  background: #0f1623;
  border: 1px solid #1e2d40; border-radius: 10px;
  padding: 1.5rem;
}
.pv-about h2 {
  margin: 0 0 1rem;
  font-size: 1rem; color: #60a5fa;
}
.pv-about ul {
  margin: 0; padding-left: 1.25rem;
  font-size: 0.85rem; color: #cbd5e1; line-height: 1.7;
}
.pv-about li { margin: 0.25rem 0; }
.pv-about-cta {
  margin-top: 1rem; padding-top: 1rem;
  border-top: 1px solid rgba(255,255,255,0.05);
  font-size: 0.85rem; color: #94a3b8;
  font-style: italic;
}

/* Footer */
.pv-footer {
  padding: 1.5rem;
  text-align: center;
  font-size: 0.75rem; color: #475569;
  border-top: 1px solid #1e2d40;
}
</style>
