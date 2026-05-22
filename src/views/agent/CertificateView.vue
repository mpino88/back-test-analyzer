<!--
═══════════════════════════════════════════════════════════════════
  CertificateView.vue — Truth Certificates UI (2026-05-22)

  Interfaz pública para listar, descargar y verificar certificados
  criptográficamente firmados de predicciones HELIX.

  "We don't promise edge — we prove honesty."

  Ruta: /agent/certificates
═══════════════════════════════════════════════════════════════════
-->
<template>
  <div class="cert-view">
    <header class="cv-header">
      <div class="cv-title">
        <span class="cv-icon">📜</span>
        <div>
          <h1 class="cv-h1">Truth Certificates</h1>
          <p class="cv-sub">Certificados criptográficamente firmados · Diferenciador único de mercado</p>
        </div>
      </div>
      <div class="cv-actions">
        <button class="cv-btn-issue" @click="showIssueModal = true">
          📜 Emitir certificado
        </button>
        <button class="cv-btn-refresh" @click="loadList" :disabled="loading">↻</button>
      </div>
    </header>

    <!-- Manifest / Value Proposition -->
    <section class="cv-manifest">
      <div class="cv-manifest-row">
        <div class="cv-manifest-icon">🔐</div>
        <div>
          <div class="cv-manifest-title">HMAC-SHA256 signed</div>
          <div class="cv-manifest-detail">Cada cert verificable offline con clave pública</div>
        </div>
      </div>
      <div class="cv-manifest-row">
        <div class="cv-manifest-icon">📊</div>
        <div>
          <div class="cv-manifest-title">Wilson 95% CI honesto</div>
          <div class="cv-manifest-detail">Sin marketing — solo números crudos walk-forward</div>
        </div>
      </div>
      <div class="cv-manifest-row">
        <div class="cv-manifest-icon">🔬</div>
        <div>
          <div class="cv-manifest-title">Edge Discovery linked</div>
          <div class="cv-manifest-detail">Cada cert referencia un run_id auditable de tests estadísticos</div>
        </div>
      </div>
      <div class="cv-manifest-row">
        <div class="cv-manifest-icon">🩸</div>
        <div>
          <div class="cv-manifest-title">Disclosure obligatorio</div>
          <div class="cv-manifest-detail">"edge_demonstrated: false" cuando CI incluye baseline</div>
        </div>
      </div>
    </section>

    <!-- Lista de certificates -->
    <section class="cv-section" v-if="certs.length">
      <h2 class="cv-section-title">📋 Certificados emitidos ({{ certs.length }})</h2>
      <div class="cv-table-wrap">
        <table class="cv-table">
          <thead>
            <tr>
              <th>Certificate ID</th>
              <th>Combo</th>
              <th>Draw date</th>
              <th>Top-N</th>
              <th class="ta-r">Hit rate</th>
              <th class="ta-r">Wilson CI 95%</th>
              <th class="ta-r">Edge ×</th>
              <th>Status</th>
              <th>Acciones</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in certs" :key="c.certificate_id">
              <td class="cv-cert-id">
                <code>{{ c.certificate_id }}</code>
              </td>
              <td>
                <span class="cv-combo-badge">
                  {{ c.game_type }} · {{ c.draw_type }} · {{ c.half }}
                </span>
              </td>
              <td>{{ formatDate(c.draw_date) }}</td>
              <td>{{ c.predicted_n }}</td>
              <td class="ta-r cv-hr">{{ formatPct(c.hit_rate_wf) }}</td>
              <td class="ta-r cv-ci">
                {{ formatPct(c.wilson_lo) }}–{{ formatPct(c.wilson_hi) }}
              </td>
              <td class="ta-r" :class="edgeClass(c.edge_multiplier)">
                {{ formatX(c.edge_multiplier) }}
              </td>
              <td>
                <span v-if="c.hit === true"  class="cv-status-hit">✓ HIT</span>
                <span v-else-if="c.hit === false" class="cv-status-miss">✗ MISS</span>
                <span v-else class="cv-status-pending">⏳ Pendiente</span>
              </td>
              <td>
                <button class="cv-btn-action" @click="viewCert(c.certificate_id)">Ver</button>
                <button class="cv-btn-action cv-btn-verify" @click="verifyCert(c.certificate_id)">Verify</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-else-if="loading" class="cv-loading">⟳ Cargando certificados...</div>
    <div v-else class="cv-empty">
      <p>Sin certificados emitidos aún.</p>
      <p>Click <strong>📜 Emitir certificado</strong> para crear uno.</p>
    </div>

    <!-- Detalle modal -->
    <div v-if="selectedCert" class="cv-modal-overlay" @click="selectedCert = null">
      <div class="cv-modal" @click.stop>
        <div class="cv-modal-header">
          <h2>Certificate Detail</h2>
          <button class="cv-modal-close" @click="selectedCert = null">×</button>
        </div>
        <div class="cv-modal-body">
          <pre class="cv-json">{{ JSON.stringify(selectedCert, null, 2) }}</pre>
        </div>
        <div class="cv-modal-footer">
          <button class="cv-btn-action" @click="downloadCert(selectedCert)">⬇ Descargar JSON</button>
          <button class="cv-btn-verify" @click="verifyCert(selectedCert.certificate_id)">🔐 Verify HMAC</button>
        </div>
      </div>
    </div>

    <!-- Issue modal -->
    <div v-if="showIssueModal" class="cv-modal-overlay" @click="showIssueModal = false">
      <div class="cv-modal" @click.stop>
        <div class="cv-modal-header">
          <h2>Emitir Truth Certificate</h2>
          <button class="cv-modal-close" @click="showIssueModal = false">×</button>
        </div>
        <div class="cv-modal-body">
          <div class="cv-form">
            <label class="cv-form-row">
              <span class="cv-form-lbl">Game type</span>
              <select v-model="issueForm.game_type">
                <option value="pick3">pick3</option>
                <option value="pick4">pick4</option>
              </select>
            </label>
            <label class="cv-form-row">
              <span class="cv-form-lbl">Draw type</span>
              <select v-model="issueForm.draw_type">
                <option value="evening">evening</option>
                <option value="midday">midday</option>
              </select>
            </label>
            <label class="cv-form-row">
              <span class="cv-form-lbl">Half</span>
              <select v-model="issueForm.half">
                <option value="du">du (Pick3 / Pick4 du)</option>
                <option value="ab">ab (Pick4 only)</option>
                <option value="cd">cd (Pick4 only)</option>
              </select>
            </label>
            <label class="cv-form-row">
              <span class="cv-form-lbl">Draw date</span>
              <input type="date" v-model="issueForm.draw_date" />
            </label>
            <label class="cv-form-row">
              <span class="cv-form-lbl">Algo used (opcional)</span>
              <input type="text" v-model="issueForm.algo_used" placeholder="frequency, bayesian_score..." />
            </label>
            <label class="cv-form-row">
              <span class="cv-form-lbl">Predicted top (comma-sep)</span>
              <textarea v-model="issueForm.predicted_top_str" rows="3" placeholder="22, 66, 99, 00, 11..."></textarea>
            </label>
          </div>
        </div>
        <div class="cv-modal-footer">
          <button class="cv-btn-action" @click="showIssueModal = false">Cancelar</button>
          <button class="cv-btn-issue" @click="issueCert" :disabled="issuing">
            {{ issuing ? '⟳ Emitiendo...' : '📜 Emitir' }}
          </button>
        </div>
      </div>
    </div>

    <!-- Verify result -->
    <div v-if="verifyResult" class="cv-verify-banner" :class="verifyResult.signature_valid ? 'cv-verify-ok' : 'cv-verify-bad'">
      <div class="cv-verify-icon">{{ verifyResult.signature_valid ? '✅' : '❌' }}</div>
      <div>
        <div class="cv-verify-title">
          Signature {{ verifyResult.signature_valid ? 'VÁLIDA' : 'INVÁLIDA' }}
        </div>
        <div class="cv-verify-detail">
          <code>{{ verifyResult.certificate_id }}</code>
        </div>
      </div>
      <button class="cv-verify-close" @click="verifyResult = null">×</button>
    </div>
  </div>
</template>

<script setup>
import { ref, onMounted } from 'vue';
import { apiGet, apiPost } from '../../utils/apiClient.js';

const certs          = ref([]);
const loading        = ref(false);
const selectedCert   = ref(null);
const showIssueModal = ref(false);
const issuing        = ref(false);
const verifyResult   = ref(null);

const issueForm = ref({
  game_type:         'pick3',
  draw_type:         'evening',
  half:              'du',
  draw_date:         new Date().toISOString().slice(0, 10),
  algo_used:         '',
  predicted_top_str: '22, 66, 99, 00, 11, 88, 33, 44, 55, 77, 72, 40, 15, 38, 81',
});

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
  return new Date(iso).toISOString().slice(0, 10);
}

function edgeClass(v) {
  if (v == null) return '';
  const x = Number(v);
  if (x >= 1.10) return 'cv-edge-good';
  if (x >= 1.00) return 'cv-edge-neutral';
  return 'cv-edge-bad';
}

async function loadList() {
  loading.value = true;
  try {
    const data = await apiGet('/api/agent/certificate-list');
    certs.value = data.certificates ?? [];
  } catch (err) {
    console.error(err);
    certs.value = [];
  } finally {
    loading.value = false;
  }
}

async function viewCert(id) {
  try {
    const cert = await apiGet(`/api/agent/certificate/${id}`);
    selectedCert.value = cert;
  } catch (err) {
    console.error(err);
  }
}

async function verifyCert(id) {
  try {
    const result = await apiPost(`/api/agent/certificate/${id}/verify`, {});
    verifyResult.value = result;
    setTimeout(() => { verifyResult.value = null; }, 8000);
  } catch (err) {
    console.error(err);
  }
}

function downloadCert(cert) {
  const json = JSON.stringify(cert, null, 2);
  const blob = new Blob([json], { type: 'application/json' });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `${cert.certificate_id}.json`;
  a.click();
  URL.revokeObjectURL(url);
}

async function issueCert() {
  issuing.value = true;
  try {
    const predicted_top = issueForm.value.predicted_top_str
      .split(',').map(s => s.trim()).filter(Boolean);
    const payload = {
      game_type:     issueForm.value.game_type,
      draw_type:     issueForm.value.draw_type,
      half:          issueForm.value.half,
      draw_date:     issueForm.value.draw_date,
      predicted_top,
    };
    if (issueForm.value.algo_used) payload.algo_used = issueForm.value.algo_used;

    const result = await apiPost('/api/agent/certificate/issue', payload);
    selectedCert.value = result.certificate;
    showIssueModal.value = false;
    await loadList();
  } catch (err) {
    console.error(err);
    alert('Error emitiendo certificado: ' + (err.message ?? err));
  } finally {
    issuing.value = false;
  }
}

onMounted(loadList);
</script>

<style scoped>
.cert-view {
  max-width: 1200px;
  margin: 0 auto;
  display: flex; flex-direction: column;
  gap: 1.5rem;
  padding: 1rem 0;
}

.cv-header {
  display: flex; justify-content: space-between; align-items: flex-end;
  padding-bottom: 1rem;
  border-bottom: 1px solid #1e2d40;
}
.cv-title { display: flex; gap: 1rem; align-items: center; }
.cv-icon  { font-size: 2.5rem; }
.cv-h1    { margin: 0; font-size: 1.5rem; font-weight: 800; color: #e2e8f0; }
.cv-sub   { margin: 0.2rem 0 0; font-size: 0.8rem; color: #64748b; }

.cv-actions { display: flex; gap: 0.5rem; }
.cv-btn-issue, .cv-btn-refresh, .cv-btn-action, .cv-btn-verify {
  border: 1px solid #1e40af; border-radius: 6px;
  padding: 0.5rem 0.9rem; font-size: 0.85rem; font-weight: 600;
  cursor: pointer; transition: all 0.15s;
}
.cv-btn-issue { background: #1e3a5f; color: #60a5fa; }
.cv-btn-issue:hover { background: #1e40af; color: #fff; }
.cv-btn-refresh { background: transparent; color: #94a3b8; border-color: #1e2d40; }
.cv-btn-action {
  background: #1a2535; color: #cbd5e1;
  border-color: #1e2d40;
  padding: 0.3rem 0.6rem; font-size: 0.75rem;
  margin-right: 0.3rem;
}
.cv-btn-verify { background: #14532d; color: #4ade80; border-color: #16a34a; }
.cv-btn-action:hover { background: #1e3a5f; }
.cv-btn-issue:disabled { opacity: 0.5; cursor: not-allowed; }

/* Manifest */
.cv-manifest {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0.85rem;
  padding: 1rem;
  background: rgba(34, 197, 94, 0.05);
  border: 1px solid rgba(34, 197, 94, 0.2);
  border-radius: 10px;
}
.cv-manifest-row { display: flex; gap: 0.75rem; align-items: flex-start; }
.cv-manifest-icon { font-size: 1.5rem; flex-shrink: 0; }
.cv-manifest-title { font-size: 0.85rem; font-weight: 700; color: #4ade80; }
.cv-manifest-detail { font-size: 0.72rem; color: #94a3b8; line-height: 1.4; margin-top: 0.15rem; }

/* Section */
.cv-section { display: flex; flex-direction: column; gap: 0.75rem; }
.cv-section-title {
  font-size: 0.85rem; font-weight: 700; color: #94a3b8;
  letter-spacing: 0.06em; text-transform: uppercase;
}

/* Table */
.cv-table-wrap { overflow-x: auto; }
.cv-table {
  width: 100%; border-collapse: collapse;
  font-size: 0.82rem; color: #cbd5e1;
  background: #0f1623;
  border-radius: 8px;
  overflow: hidden;
}
.cv-table th {
  background: #0a0d14; color: #64748b;
  font-size: 0.7rem; text-transform: uppercase; letter-spacing: 0.06em;
  padding: 0.6rem 0.75rem; text-align: left;
  border-bottom: 1px solid #1e2d40;
}
.cv-table td { padding: 0.55rem 0.75rem; border-bottom: 1px solid #111827; vertical-align: middle; }
.cv-table tr:hover td { background: rgba(30, 45, 64, 0.4); }

.cv-cert-id code {
  background: rgba(0,0,0,0.3); padding: 0.15rem 0.4rem;
  border-radius: 3px; font-size: 0.72rem;
  color: #fbbf24;
}
.cv-combo-badge {
  background: #1e2d40; color: #cbd5e1;
  padding: 0.15rem 0.4rem; border-radius: 3px;
  font-size: 0.7rem; font-family: monospace;
}
.cv-hr { color: #e2e8f0; font-weight: 600; font-family: monospace; }
.cv-ci { color: #94a3b8; font-size: 0.75rem; font-family: monospace; }

.ta-r { text-align: right; }
.cv-edge-good { color: #4ade80; font-weight: 700; }
.cv-edge-neutral { color: #fbbf24; }
.cv-edge-bad { color: #f87171; }

.cv-status-hit { color: #4ade80; font-weight: 700; }
.cv-status-miss { color: #f87171; }
.cv-status-pending { color: #64748b; font-size: 0.75rem; }

.cv-loading, .cv-empty {
  padding: 3rem 1rem; text-align: center;
  background: #0f1623;
  border: 1px solid #1e2d40; border-radius: 10px;
  color: #64748b;
}

/* Modal */
.cv-modal-overlay {
  position: fixed; inset: 0;
  background: rgba(0,0,0,0.7);
  display: flex; align-items: center; justify-content: center;
  z-index: 1000; padding: 1rem;
}
.cv-modal {
  background: #0f1623;
  border: 1px solid #1e2d40; border-radius: 10px;
  max-width: 800px; width: 100%;
  max-height: 85vh; display: flex; flex-direction: column;
}
.cv-modal-header {
  display: flex; justify-content: space-between; align-items: center;
  padding: 1rem 1.25rem;
  border-bottom: 1px solid #1e2d40;
}
.cv-modal-header h2 { margin: 0; font-size: 1rem; color: #e2e8f0; }
.cv-modal-close {
  background: transparent; border: none; color: #94a3b8;
  font-size: 1.5rem; cursor: pointer; line-height: 1;
}
.cv-modal-body {
  flex: 1; overflow-y: auto;
  padding: 1rem 1.25rem;
}
.cv-modal-footer {
  display: flex; gap: 0.5rem; justify-content: flex-end;
  padding: 0.75rem 1.25rem;
  border-top: 1px solid #1e2d40;
}

.cv-json {
  background: #0a0d14; color: #cbd5e1;
  padding: 1rem; border-radius: 6px;
  font-size: 0.75rem; line-height: 1.5;
  overflow-x: auto; white-space: pre-wrap;
}

.cv-form { display: flex; flex-direction: column; gap: 0.75rem; }
.cv-form-row {
  display: grid; grid-template-columns: 180px 1fr;
  gap: 0.5rem; align-items: center;
}
.cv-form-lbl { color: #94a3b8; font-size: 0.8rem; }
.cv-form input, .cv-form select, .cv-form textarea {
  background: #0a0d14; color: #e2e8f0;
  border: 1px solid #1e2d40; border-radius: 4px;
  padding: 0.4rem 0.6rem; font-size: 0.85rem;
}

/* Verify banner */
.cv-verify-banner {
  position: fixed; bottom: 1.5rem; right: 1.5rem;
  display: flex; gap: 0.75rem; align-items: center;
  padding: 0.85rem 1.25rem;
  background: #0f1623;
  border: 2px solid;
  border-radius: 10px;
  box-shadow: 0 8px 24px rgba(0,0,0,0.5);
  z-index: 1100;
  max-width: 400px;
}
.cv-verify-ok { border-color: #16a34a; }
.cv-verify-bad { border-color: #dc2626; }
.cv-verify-icon { font-size: 1.5rem; }
.cv-verify-title {
  font-size: 0.85rem; font-weight: 700; color: #e2e8f0;
}
.cv-verify-ok .cv-verify-title { color: #4ade80; }
.cv-verify-bad .cv-verify-title { color: #f87171; }
.cv-verify-detail { font-size: 0.7rem; color: #94a3b8; font-family: monospace; }
.cv-verify-close {
  margin-left: 0.5rem;
  background: transparent; border: none; color: #94a3b8;
  font-size: 1.2rem; cursor: pointer; line-height: 1;
}
</style>
