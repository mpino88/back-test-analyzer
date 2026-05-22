<!--
═══════════════════════════════════════════════════════════════════
  LabsSportsView.vue — Sports vertical skeleton (2026-05-22)

  ADMIN-ONLY. Placeholder for Q3 2026 build.

  Foundation reusable: PredictorProtocol, Edge Discovery, Conformal,
  Walk-forward, Truth Certificates — todo aplicable cuando construyamos.

  Ruta: /agent/labs/sports
═══════════════════════════════════════════════════════════════════
-->
<template>
  <div class="lab-view">
    <header class="lab-header">
      <div class="lab-title">
        <span class="lab-icon">🧪</span>
        <div>
          <h1 class="lab-h1">Labs · Sports Lab</h1>
          <p class="lab-sub">Vertical experimental · admin-only · scope: NFL/NBA spread &amp; total line predictions</p>
        </div>
      </div>
      <span class="lab-status">Coming Q3 2026</span>
    </header>

    <section class="lab-card">
      <h2 class="lab-section-title">🎯 Hipótesis del vertical</h2>
      <p class="lab-text">
        En sports betting, las líneas (spreads, totals, moneylines) son fijadas por casas
        de apuestas que <strong>incorporan información asimétrica</strong> y bias del público.
        Existe edge <em>documentado académicamente</em> en:
      </p>
      <ul class="lab-list">
        <li><strong>Closing Line Value (CLV)</strong> — línea inicial vs línea de cierre</li>
        <li><strong>Reverse line movement</strong> — sharp money vs public money divergence</li>
        <li><strong>Hawkes self-exciting</strong> sobre movimiento de líneas (Hawkes &amp; Almeida 2018)</li>
        <li><strong>Late lines</strong> — overreaction a noticias de injury / weather</li>
      </ul>
    </section>

    <section class="lab-card">
      <h2 class="lab-section-title">🔧 Stack reutilizable de HELIX</h2>
      <div class="lab-reuse-grid">
        <div class="lab-reuse">
          <strong>PredictorProtocol</strong>
          <span>Interface ya construida, agnóstica de dominio</span>
        </div>
        <div class="lab-reuse">
          <strong>EdgeDiscoveryEngine</strong>
          <span>Tests Bonferroni-honest aplican universalmente</span>
        </div>
        <div class="lab-reuse">
          <strong>ConformalPredictor</strong>
          <span>Coverage guarantee teorema universal</span>
        </div>
        <div class="lab-reuse">
          <strong>HelixRetrospectiveSimulator</strong>
          <span>Walk-forward sin leakage para cualquier time-series</span>
        </div>
        <div class="lab-reuse">
          <strong>TruthCertificateService</strong>
          <span>HMAC-SHA256 verificable, dominio-agnóstico</span>
        </div>
        <div class="lab-reuse">
          <strong>ThompsonSampler</strong>
          <span>Bayesian online learning universal</span>
        </div>
      </div>
    </section>

    <section class="lab-card">
      <h2 class="lab-section-title">📅 Roadmap tentativo</h2>
      <div class="lab-timeline">
        <div class="lab-step"><strong>Fase 0</strong>: Skeleton creado (hoy) — folder labs/sports, README, placeholder UI</div>
        <div class="lab-step"><strong>Fase 1</strong>: SportsPredictor implements PredictorProtocol — ingesta líneas (Pinnacle, DraftKings)</div>
        <div class="lab-step"><strong>Fase 2</strong>: Hawkes self-exciting sobre movimientos de líneas — backtesting MLB temporada 2024-2026</div>
        <div class="lab-step"><strong>Fase 3</strong>: Edge Discovery sobre features sports — CLV, reverse movement, late line</div>
        <div class="lab-step"><strong>Fase 4</strong>: Truth Certificates por predicción — verify público</div>
        <div class="lab-step"><strong>Fase 5</strong>: B2B pilot con 1 sportsbook white-label</div>
      </div>
    </section>

    <section class="lab-card lab-card--warning">
      <h2 class="lab-section-title">⚠️ Estado actual</h2>
      <p class="lab-text">
        Este vertical está marcado como <strong>admin-only</strong> y no se construye hasta que
        Opción A (transparencia matemática del juego loto) tenga métricas de validación.
        El foundation técnico está listo — solo falta priorización temporal.
      </p>
      <p class="lab-text" style="margin-top: 0.5rem;">
        <code>src/agent/labs/sports/</code> existe como skeleton sin código funcional.
        <br>
        <code>src/agent/labs/crypto/</code> también disponible para activación futura.
      </p>
    </section>
  </div>
</template>

<script setup>
// Skeleton — sin lógica funcional aún
</script>

<style scoped>
.lab-view {
  max-width: 900px; margin: 0 auto;
  padding: 1rem 0;
  display: flex; flex-direction: column; gap: 1.25rem;
}
.lab-header {
  display: flex; justify-content: space-between; align-items: flex-end;
  padding-bottom: 1rem; border-bottom: 1px solid #1e2d40;
}
.lab-title { display: flex; gap: 1rem; align-items: center; }
.lab-icon  { font-size: 2.5rem; }
.lab-h1    { margin: 0; font-size: 1.5rem; font-weight: 800; color: #e2e8f0; }
.lab-sub   { margin: 0.2rem 0 0; font-size: 0.8rem; color: #64748b; }
.lab-status {
  background: rgba(167, 139, 250, 0.15); color: #a78bfa;
  border: 1px solid rgba(167, 139, 250, 0.3);
  padding: 0.4rem 0.8rem; border-radius: 6px;
  font-size: 0.75rem; font-weight: 700;
}
.lab-card {
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 10px;
  padding: 1.25rem 1.5rem;
}
.lab-card--warning { background: rgba(251, 191, 36, 0.04); border-color: rgba(251, 191, 36, 0.25); }
.lab-section-title {
  font-size: 0.85rem; font-weight: 700; color: #94a3b8;
  letter-spacing: 0.05em; text-transform: uppercase;
  margin: 0 0 0.75rem;
}
.lab-text { font-size: 0.88rem; color: #cbd5e1; line-height: 1.6; margin: 0; }
.lab-list { margin: 0.5rem 0 0; padding-left: 1.25rem; color: #cbd5e1; font-size: 0.85rem; line-height: 1.8; }
.lab-list strong { color: #60a5fa; }

.lab-reuse-grid {
  display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.5rem;
}
.lab-reuse {
  background: rgba(34, 197, 94, 0.04);
  border: 1px solid rgba(34, 197, 94, 0.2);
  border-radius: 6px; padding: 0.7rem 0.85rem;
  display: flex; flex-direction: column; gap: 0.25rem;
}
.lab-reuse strong { color: #4ade80; font-size: 0.82rem; }
.lab-reuse span { color: #94a3b8; font-size: 0.72rem; line-height: 1.4; }

.lab-timeline { display: flex; flex-direction: column; gap: 0.5rem; }
.lab-step {
  background: rgba(0,0,0,0.2); border-left: 2px solid #60a5fa;
  padding: 0.6rem 0.9rem; border-radius: 4px;
  font-size: 0.85rem; color: #cbd5e1; line-height: 1.5;
}
.lab-step strong { color: #60a5fa; }

code { background: rgba(0,0,0,0.3); padding: 0.1rem 0.35rem; border-radius: 3px; font-size: 0.78rem; color: #fbbf24; }
</style>
