<template>
  <div class="dashboard">
    <div class="page-header">
      <h1 class="page-title">Dashboard</h1>
      <span class="page-subtitle">Estado en tiempo real del agente Hitdash</span>
    </div>

    <!-- Status cards -->
    <div class="cards-grid">
      <div class="stat-card" :class="connected ? 'stat-card--live' : 'stat-card--offline'">
        <div class="stat-card__label">Estado del agente</div>
        <div class="stat-card__value">{{ connected ? '🟢 Online' : '🔴 Offline' }}</div>
        <div class="stat-card__sub">{{ connected ? 'SSE activo' : 'Sin conexión' }}</div>
      </div>

      <div class="stat-card">
        <div class="stat-card__label">Alertas pendientes</div>
        <div class="stat-card__value" :class="pendingAlerts > 0 ? 'text-red' : 'text-green'">
          {{ pendingAlerts }}
        </div>
        <div class="stat-card__sub">sin reconocer</div>
      </div>

      <div class="stat-card">
        <div class="stat-card__label">RAG knowledge</div>
        <div class="stat-card__value">{{ status?.rag_documents ?? '—' }}</div>
        <div class="stat-card__sub">documentos</div>
      </div>

      <div class="stat-card">
        <div class="stat-card__label">Redis</div>
        <div class="stat-card__value">{{ status?.redis_ok ? '🟢 OK' : '🔴 Down' }}</div>
        <div class="stat-card__sub">cola BullMQ</div>
      </div>
    </div>

    <!-- Última sesión -->
    <section class="section">
      <h2 class="section-title">Última sesión del agente</h2>
      <div v-if="lastSession" class="session-card">
        <div class="session-card__row">
          <span class="label">Juego</span>
          <span class="value">{{ lastSession.game_type?.toUpperCase() }} {{ lastSession.draw_type }}</span>
        </div>
        <div class="session-card__row">
          <span class="label">Estado</span>
          <span class="value badge" :class="`badge--${lastSession.status}`">{{ lastSession.status }}</span>
        </div>
        <div class="session-card__row">
          <span class="label">Modelo</span>
          <span class="value mono">{{ lastSession.model_used ?? '—' }}</span>
        </div>
        <div class="session-card__row">
          <span class="label">Costo</span>
          <span class="value">${{ lastSession.cost_usd?.toFixed(4) ?? '0.0000' }}</span>
        </div>
        <div class="session-card__row">
          <span class="label">Fecha</span>
          <span class="value">{{ formatDate(lastSession.created_at) }}</span>
        </div>
      </div>
      <div v-else class="empty">Sin sesiones registradas aún</div>
    </section>

    <!-- Trigger manual -->
    <section class="section">
      <h2 class="section-title">Disparo manual</h2>
      <div class="trigger-form">
        <select v-model="triggerGame" class="input-select">
          <option value="pick3">Pick 3</option>
          <option value="pick4">Pick 4</option>
        </select>
        <select v-model="triggerDraw" class="input-select">
          <option value="midday">Midday</option>
          <option value="evening">Evening</option>
        </select>
        <input v-model="triggerDate" type="date" class="input-date" />
        <label class="topn-label">
          <span class="topn-badge">N={{ triggerTopN }}</span>
          <input v-model.number="triggerTopN" type="range" min="5" max="15" step="1" class="topn-slider" title="Número de pares a predecir (5-15)" />
        </label>
        <button class="btn-trigger" :disabled="triggering" @click="triggerAgent">
          {{ triggering ? 'Disparando...' : '⚡ Ejecutar ahora' }}
        </button>
      </div>
      <div v-if="triggerMsg" class="trigger-msg" :class="triggerError ? 'trigger-msg--error' : 'trigger-msg--ok'">
        {{ triggerMsg }}
      </div>
    </section>

    <!-- ── Diagnóstico Forense ──────────────────────────────────── -->
    <section class="section section--diag">
      <div class="section-header">
        <h2 class="section-title">🔬 Diagnóstico del sistema (ground truth)</h2>
        <div class="diag-header-right">
          <span v-if="diagData" class="diag-age">{{ diagAge }}</span>
          <button class="btn-diag" :disabled="loadingDiag" @click="loadDiagnostics">
            {{ loadingDiag ? '⟳ Midiendo...' : '🩺 Ejecutar diagnóstico' }}
          </button>
        </div>
      </div>

      <!-- Feedback lag banner (shown even without full diagnostics) -->
      <div v-if="diagData?.feedback_lag" class="feedback-lag-card"
           :class="feedbackLagClass">
        <div class="fl-label">⏱ Feedback Lag</div>
        <div class="fl-value">
          {{ diagData.feedback_lag.feedback_lag_hours != null
             ? diagData.feedback_lag.feedback_lag_hours + 'h'
             : '—' }}
        </div>
        <div class="fl-detail">
          {{ diagData.feedback_lag.total_pending }} predicciones pendientes ·
          Última resolución: {{ diagData.feedback_lag.last_resolved_at ?? 'nunca' }}
        </div>
        <div class="fl-verdict">{{ diagData.verdict?.FEEDBACK_LAG_STATUS }}</div>
      </div>

      <!-- Prediction history 7d mini-table -->
      <div v-if="diagData?.prediction_history_7d?.length" class="pred-history">
        <div class="pred-history__title">📅 Predicciones últimos 7 días</div>
        <div class="pred-history__rows">
          <div v-for="row in diagData.prediction_history_7d" :key="row.day" class="pred-history__row">
            <span class="ph-day">{{ row.day }}</span>
            <span class="ph-predicted">{{ row.predicted }} pred.</span>
            <span class="ph-resolved" :class="row.resolved < row.predicted ? 'text-orange' : 'text-green'">
              {{ row.resolved }} resueltas
            </span>
            <span class="ph-hits text-green">{{ row.hits }} hits</span>
            <div class="ph-bar">
              <div class="ph-bar__hit" :style="`width: ${row.predicted > 0 ? (row.hits / row.predicted * 100).toFixed(0) : 0}%`"></div>
            </div>
          </div>
        </div>
      </div>

      <div v-if="diagData" class="diag-grid">
        <!-- Verdicts -->
        <div class="diag-card diag-card--verdict">
          <div class="diag-card__title">Verdicts forenses</div>
          <div class="verdict-list">
            <div class="verdict-row">
              <span class="verdict-label">F01 draw_date NULL</span>
              <span class="verdict-val" :class="diagData.verdict.F01_draw_date_null.startsWith('CONFIRMED') ? 'v--red' : 'v--green'">
                {{ diagData.verdict.F01_draw_date_null }}
              </span>
            </div>
            <div class="verdict-row">
              <span class="verdict-label">F02 feedback_loop</span>
              <span class="verdict-val" :class="diagData.verdict.F02_feedback_loop_empty.startsWith('CONFIRMED') ? 'v--red' : 'v--green'">
                {{ diagData.verdict.F02_feedback_loop_empty }}
              </span>
            </div>
            <div class="verdict-row">
              <span class="verdict-label">F04 backtest_points_v2</span>
              <span class="verdict-val v--yellow">{{ diagData.verdict.F04_backtest_points_v2_gap }}</span>
            </div>
            <div class="verdict-row">
              <span class="verdict-label">Feedback lag</span>
              <span class="verdict-val"
                :class="diagData.verdict.FEEDBACK_LAG_STATUS?.startsWith('WARNING') ? 'v--red' : diagData.verdict.FEEDBACK_LAG_STATUS?.startsWith('WATCH') ? 'v--yellow' : 'v--green'">
                {{ diagData.verdict.FEEDBACK_LAG_STATUS }}
              </span>
            </div>
          </div>
        </div>

        <!-- ingested_results -->
        <div class="diag-card">
          <div class="diag-card__title">ingested_results</div>
          <div class="diag-row">Total filas: <strong>{{ diagData.ingested_results.total?.toLocaleString() }}</strong></div>
          <div class="diag-row" :class="diagData.ingested_results.null_draw_date > 0 ? 'diag-row--alert' : ''">
            NULL draw_date: <strong>{{ diagData.ingested_results.null_draw_date }}</strong>
          </div>
          <div class="diag-row" :class="diagData.ingested_results.null_p1 > 0 ? 'diag-row--alert' : ''">
            NULL p1: <strong>{{ diagData.ingested_results.null_p1 }}</strong>
          </div>
          <div class="diag-row" :class="diagData.ingested_results.null_game_type > 0 ? 'diag-row--alert' : ''">
            NULL game_type: <strong>{{ diagData.ingested_results.null_game_type }}</strong>
          </div>
          <div class="diag-row" v-if="diagData.ingested_results.date_range">
            Rango: <strong>{{ diagData.ingested_results.date_range.earliest }} → {{ diagData.ingested_results.date_range.latest }}</strong>
          </div>
          <div class="diag-subtitle">Por combo:</div>
          <div v-for="c in diagData.ingested_results.by_game_draw" :key="`${c.game_type}-${c.draw_type}`" class="diag-row diag-row--sm">
            {{ c.game_type }}/{{ c.draw_type }}: <strong>{{ c.cnt }}</strong> fechas
          </div>
        </div>

        <!-- algo_prediction_snapshot -->
        <div class="diag-card">
          <div class="diag-card__title">algo_prediction_snapshot</div>
          <div class="diag-row">Total filas: <strong>{{ diagData.algo_prediction_snapshot.total?.toLocaleString() }}</strong></div>
          <div class="diag-row" v-if="diagData.algo_prediction_snapshot.summary">
            Fechas: <strong>{{ diagData.algo_prediction_snapshot.summary.distinct_dates }}</strong>
            · Algos: <strong>{{ diagData.algo_prediction_snapshot.summary.distinct_algos }}</strong>
          </div>
          <div class="diag-row" v-if="diagData.algo_prediction_snapshot.summary?.earliest">
            Rango: <strong>{{ diagData.algo_prediction_snapshot.summary.earliest }} → {{ diagData.algo_prediction_snapshot.summary.latest }}</strong>
          </div>
        </div>

        <!-- pair_recommendations -->
        <div class="diag-card">
          <div class="diag-card__title">pair_recommendations</div>
          <div class="diag-row">Total: <strong>{{ diagData.pair_recommendations?.total }}</strong></div>
          <div class="diag-row">Hits: <strong style="color:#4ade80">{{ diagData.pair_recommendations?.hits }}</strong></div>
          <div class="diag-row">Misses: <strong style="color:#f87171">{{ diagData.pair_recommendations?.misses }}</strong></div>
          <div class="diag-row">Pendientes: <strong style="color:#f59e0b">{{ diagData.pair_recommendations?.pending }}</strong></div>
        </div>

        <!-- proactive_alerts -->
        <div class="diag-card">
          <div class="diag-card__title">proactive_alerts (no acked)</div>
          <div v-for="a in diagData.proactive_alerts" :key="a.alert_type" class="diag-row">
            <strong>{{ a.alert_type }}</strong>: {{ a.cnt }}
            <span class="diag-meta">({{ a.oldest?.slice(0,10) }} → {{ a.newest?.slice(0,10) }})</span>
          </div>
          <div v-if="diagData.proactive_alerts.length === 0" class="diag-row">Sin alertas pendientes</div>
        </div>

        <!-- backtest_points_v2 -->
        <div class="diag-card">
          <div class="diag-card__title">backtest_points_v2</div>
          <div class="diag-row">Total: <strong>{{ diagData.backtest_points_v2?.total?.toLocaleString() }}</strong></div>
          <div class="diag-row">Con hit: <strong>{{ diagData.backtest_points_v2?.with_hit }}</strong></div>
          <div class="diag-row" v-if="diagData.backtest_points_v2?.earliest_eval">
            Rango eval: <strong>{{ diagData.backtest_points_v2.earliest_eval }} → {{ diagData.backtest_points_v2.latest_eval }}</strong>
          </div>
        </div>

        <!-- otras tablas -->
        <div class="diag-card">
          <div class="diag-card__title">Otras tablas</div>
          <div class="diag-row" :class="diagData.feedback_loop_total === 0 ? 'diag-row--alert' : ''">
            feedback_loop: <strong>{{ diagData.feedback_loop_total }}</strong>
            <span class="diag-meta" v-if="diagData.feedback_loop_total === 0">(vacía — F02 confirmado)</span>
          </div>
          <div class="diag-row">public.draws: <strong>{{ diagData.public_draws_total?.toLocaleString() }}</strong></div>
        </div>

        <!-- pps_state top algos -->
        <div class="diag-card diag-card--wide">
          <div class="diag-card__title">PPS top algos (sample_count)</div>
          <div class="pps-diag-grid">
            <div v-for="p in diagData.pps_state_top_algos" :key="p.algo_name" class="pps-diag-row">
              <span class="diag-algo">{{ p.algo_name }}</span>
              <span>PPS: <strong>{{ p.avg_pps }}</strong></span>
              <span>n: <strong>{{ p.max_samples }}</strong></span>
              <span class="diag-meta">{{ p.combos }} combos</span>
            </div>
          </div>
        </div>
      </div>

      <details v-if="diagData" class="diag-raw">
        <summary>Ver JSON crudo</summary>
        <pre>{{ JSON.stringify(diagData, null, 2) }}</pre>
      </details>
    </section>

    <!-- ── MOTOR-Σ PPS State ────────────────────────────────────── -->
    <section class="section">
      <div class="section-header">
        <h2 class="section-title">Motor-Σ — Estado de aprendizaje</h2>
        <div class="pps-controls">
          <select v-model="ppsGame" class="input-select input-select--sm" @change="refreshMotor">
            <option value="pick3">Pick 3</option>
            <option value="pick4">Pick 4</option>
          </select>
          <select v-model="ppsDraw" class="input-select input-select--sm" @change="refreshMotor">
            <option value="midday">Midday</option>
            <option value="evening">Evening</option>
          </select>
          <select v-model="ppsHalf" class="input-select input-select--sm" @change="refreshMotor">
            <option value="du">DU</option>
            <option v-if="ppsGame === 'pick4'" value="ab">AB</option>
            <option v-if="ppsGame === 'pick4'" value="cd">CD</option>
          </select>
          <button class="btn-refresh-sm" @click="refreshMotor">↻</button>
        </div>
      </div>

      <div v-if="loadingPPS" class="empty">Cargando estado del motor...</div>
      <div v-else-if="ppsError" class="empty pps-error">{{ ppsError }}</div>
      <template v-else-if="ppsData">
        <!-- Summary chips -->
        <div class="pps-summary">
          <div class="pps-chip" :class="ppsData.is_profitable ? 'pps-chip--green' : 'pps-chip--red'">
            <span class="pps-chip__label">N óptimo</span>
            <span class="pps-chip__val">{{ ppsData.optimal_n }}</span>
          </div>
          <div class="pps-chip" :class="ppsData.is_profitable ? 'pps-chip--green' : 'pps-chip--yellow'">
            <span class="pps-chip__label">Hit@N</span>
            <span class="pps-chip__val">{{ ((ppsData.hit_rate ?? 0) * 100).toFixed(1) }}%</span>
          </div>
          <div class="pps-chip" :class="ppsData.is_profitable ? 'pps-chip--green' : 'pps-chip--red'">
            <span class="pps-chip__label">Borde</span>
            <span class="pps-chip__val">{{ ppsData.is_profitable ? '✓ Sí' : '✗ No' }}</span>
          </div>
          <div class="pps-chip pps-chip--neutral">
            <span class="pps-chip__label">Base</span>
            <span class="pps-chip__val pps-chip__val--sm">{{ ppsData.motor_basis }}</span>
          </div>
          <!-- No-edge behavior indicator -->
          <div
            class="pps-chip"
            :class="ppsData.no_edge_behavior === 'block' ? 'pps-chip--red' : ppsData.no_edge_behavior === 'tighten' ? 'pps-chip--yellow' : 'pps-chip--neutral'"
            :title="ppsData.no_edge_behavior === 'block' ? 'Sin borde: predicciones bloqueadas' : ppsData.no_edge_behavior === 'tighten' ? 'Sin borde: modo defensivo N=5' : 'Sin borde: solo advertencia'"
          >
            <span class="pps-chip__label">Sin borde</span>
            <span class="pps-chip__val pps-chip__val--sm">
              {{ ppsData.no_edge_behavior === 'block' ? '🚫 block' : ppsData.no_edge_behavior === 'tighten' ? '🛡️ tighten' : '⚠️ warn' }}
            </span>
          </div>
        </div>

        <!-- Algorithm Health Summary — disabled/degraded -->
        <div
          v-if="ppsData.health_summary && (ppsData.health_summary.disabled.length > 0 || ppsData.health_summary.degraded.length > 0)"
          class="health-summary-bar"
        >
          <span class="hs-label">⚡ Salud algos:</span>
          <span v-if="ppsData.health_summary.disabled.length > 0" class="hs-badge hs-badge--disabled">
            🔴 {{ ppsData.health_summary.disabled.length }} desactivados: {{ ppsData.health_summary.disabled.join(', ') }}
          </span>
          <span v-if="ppsData.health_summary.degraded.length > 0" class="hs-badge hs-badge--degraded">
            🟡 {{ ppsData.health_summary.degraded.length }} degradados: {{ ppsData.health_summary.degraded.join(', ') }}
          </span>
        </div>
        <div v-else-if="ppsData.health_summary && ppsData.health_summary.healthy_count > 0" class="health-summary-bar health-summary-bar--ok">
          <span class="hs-label">⚡ Salud algos:</span>
          <span class="hs-badge hs-badge--ok">🟢 Todos sanos ({{ ppsData.health_summary.healthy_count }})</span>
        </div>

        <!-- ── Bucket Analysis (v3.0) — verificación empírica del Sweet Spot ── -->
        <div v-if="bucketData" class="bucket-analysis-card">
          <div class="bucket-header">
            <span class="bucket-title">🎯 Bucket Analysis · "Fuerza de Tendencia Pro"</span>
            <button class="bucket-refresh" :disabled="loadingBucket" @click="loadBucketAnalysis">
              {{ loadingBucket ? '⟳' : '🔄' }}
            </button>
          </div>

          <div v-if="bucketData.total_evaluated === 0" class="bucket-empty">
            Sin datos suficientes (necesita ≥ 30 sorteos en {{ ppsGame.toUpperCase() }} {{ ppsDraw }})
          </div>

          <template v-else>
            <div class="bucket-meta">
              <span><strong>{{ bucketData.total_evaluated }}</strong> sorteos evaluados (walk-forward)</span>
              <span>baseline aleatorio: {{ (bucketData.baseline_random * 100).toFixed(0) }}%</span>
              <span>top-15 global hit_rate: <strong>{{ (bucketData.overall.top15_hit_rate * 100).toFixed(1) }}%</strong></span>
            </div>

            <div class="bucket-grid">
              <div
                v-for="b in bucketData.buckets"
                :key="b.rec_count"
                class="bucket-cell"
                :class="bucketCellClass(b, bucketData.baseline_random, bucketData.best_bucket?.rec_count)"
              >
                <div class="bucket-cell-label">
                  Bucket {{ b.rec_count }}
                  <span v-if="b.rec_count === 1" class="bucket-cell-tag">🍯 sweet</span>
                  <span v-else-if="b.rec_count === 0" class="bucket-cell-tag">🌫 sin recientes</span>
                  <span v-else-if="b.rec_count === 3" class="bucket-cell-tag">🔥 ya caliente</span>
                </div>
                <div class="bucket-cell-rate">{{ (b.hit_rate * 100).toFixed(1) }}%</div>
                <div class="bucket-cell-sub">
                  {{ b.hits }}/{{ b.evaluations }}
                  · avg {{ b.candidates_avg }} candidatos/sorteo
                </div>
              </div>
            </div>

            <div v-if="bucketData.best_bucket" class="bucket-verdict">
              <strong>🏆 Mejor bucket:</strong>
              count_recent = <strong>{{ bucketData.best_bucket.rec_count }}</strong>
              · hit_rate <strong>{{ (bucketData.best_bucket.hit_rate * 100).toFixed(1) }}%</strong>
              · edge +{{ (bucketData.best_bucket.edge_over_baseline * 100).toFixed(1) }}pp vs random
            </div>

            <div class="threshold-comparison">
              <span class="tc-label">Threshold comparativo:</span>
              <span class="tc-pill" :class="thresholdWinner === 'ge_1' ? 'tc-pill--winner' : ''">
                momentum ≥ 1.0: {{ (bucketData.threshold_comparison.momentum_ge_1.hit_rate * 100).toFixed(1) }}%
                ({{ bucketData.threshold_comparison.momentum_ge_1.candidates_avg }} avg)
              </span>
              <span class="tc-pill" :class="thresholdWinner === 'ge_3' ? 'tc-pill--winner' : ''">
                momentum ≥ 3.0: {{ (bucketData.threshold_comparison.momentum_ge_3.hit_rate * 100).toFixed(1) }}%
                ({{ bucketData.threshold_comparison.momentum_ge_3.candidates_avg }} avg)
              </span>
            </div>
          </template>
        </div>

        <!-- ── Champion Mode (v2.5) — algoritmo dominante reciente ── -->
        <div v-if="championData" class="champion-bar"
             :class="championData.active ? 'champion-bar--active' : 'champion-bar--idle'">
          <span class="champion-icon">{{ championData.active ? '🏆' : '⚖️' }}</span>
          <span class="champion-label">Champion Mode:</span>
          <template v-if="championData.active && championData.champion">
            <span class="champion-name">{{ championData.champion.algo_name }}</span>
            <span class="champion-rate">
              {{ (championData.champion.rate * 100).toFixed(1) }}% hit rate
              <small>({{ championData.champion.hits }}/{{ championData.champion.total }})</small>
            </span>
            <span class="champion-edge">+{{ (championData.champion.edge * 100).toFixed(1) }}pp edge</span>
            <span class="champion-status">🟢 DOMINANDO consenso (60%)</span>
          </template>
          <template v-else>
            <span class="champion-status">Ningún algoritmo ≥ {{ (championData.threshold_rate * 100) }}% (consenso normal)</span>
            <span v-if="championData.ranking?.[0]" class="champion-best">
              Mejor: {{ championData.ranking[0].algo }} @ {{ (championData.ranking[0].rate * 100).toFixed(1) }}%
              ({{ championData.ranking[0].hits }}/{{ championData.ranking[0].total }})
            </span>
          </template>
        </div>

        <!-- Diversity Report -->
        <div v-if="diversityData" class="diversity-bar">
          <span class="div-label">🧩 Diversidad consensus:</span>
          <span
            class="div-score"
            :class="diversityData.diversity_score >= 0.7 ? 'div--healthy' : diversityData.diversity_score >= 0.4 ? 'div--redundant' : 'div--collapsed'"
          >{{ (diversityData.diversity_score * 100).toFixed(0) }}%</span>
          <span
            class="div-rec"
            :class="diversityData.recommendation === 'healthy' ? 'div--healthy' : diversityData.recommendation === 'redundant' ? 'div--redundant' : 'div--collapsed'"
          >
            {{ diversityData.recommendation === 'healthy' ? '🟢 sano' : diversityData.recommendation === 'redundant' ? '🟡 redundante' : '🔴 colapsado' }}
          </span>
          <span v-if="diversityData.redundancy_clusters?.length" class="div-clusters">
            Clusters redundantes:
            <span v-for="(c, i) in diversityData.redundancy_clusters" :key="i" class="div-cluster-tag">
              [{{ c.join(' + ') }}]
            </span>
          </span>
          <span v-if="diversityData.snapshot_date" class="div-snap">snapshot: {{ diversityData.snapshot_date }}</span>
        </div>

        <!-- Algorithm table -->
        <div class="pps-table-wrap" v-if="ppsData.algorithms?.length">
          <div class="pps-row pps-row--header">
            <span>Algoritmo</span>
            <span>PPS</span>
            <span>Muestras</span>
            <span>Estado</span>
          </div>
          <div
            v-for="algo in ppsData.algorithms"
            :key="algo.algo_name"
            class="pps-row"
          >
            <span class="pps-algo-name">{{ algo.algo_name }}</span>
            <span class="pps-bar-cell">
              <span class="pps-bar-track">
                <span
                  class="pps-bar-fill"
                  :style="{ width: algo.pps + '%' }"
                  :class="algo.pps >= 65 ? 'bar--high' : algo.pps >= 45 ? 'bar--mid' : 'bar--low'"
                ></span>
              </span>
              <span class="pps-num" :class="algo.pps >= 65 ? 'num--high' : algo.pps >= 45 ? 'num--mid' : 'num--low'">
                {{ algo.pps?.toFixed(1) }}
              </span>
            </span>
            <span class="pps-samples">
              {{ algo.sample_count }}
              <span class="warmup-badge" v-if="algo.sample_count < 30">warmup</span>
            </span>
            <span>
              <span
                class="health-dot"
                :class="algo.pps >= 65 ? 'dot--healthy' : algo.pps >= 40 ? 'dot--degraded' : 'dot--low'"
                :title="algo.pps >= 65 ? 'Señal fuerte' : algo.pps >= 40 ? 'Señal débil' : 'Penalizado'"
              ></span>
            </span>
          </div>
        </div>
        <div v-else class="empty">
          Sin datos PPS aún — el motor acumula datos sorteo a sorteo
        </div>
      </template>
      <div v-else class="empty">Selecciona un combo para ver el estado del motor</div>
    </section>

    <!-- Ingesta reciente -->
    <section class="section">
      <h2 class="section-title">Ingesta de datos</h2>
      <div class="info-row">
        <span class="label">Última ingesta</span>
        <span class="value">{{ formatDate(status?.last_ingestion) }}</span>
      </div>
      <div class="info-row">
        <span class="label">Último ciclo agente</span>
        <span class="value">{{ formatDate(status?.last_agent_cycle) }}</span>
      </div>
      <div class="info-row">
        <span class="label">RAG knowledge</span>
        <span class="value">{{ status?.rag_documents ?? '—' }} documentos</span>
      </div>
    </section>

    <!-- Últimas recomendaciones de pares -->
    <section class="section">
      <h2 class="section-title">Últimas Recomendaciones de Pares</h2>
      <div v-if="loadingRecs" class="empty">Cargando...</div>
      <div v-else-if="!latestRecs.length" class="empty">Sin recomendaciones aún — ejecuta el agente</div>
      <div v-else class="recs-grid">
        <div
          v-for="rec in latestRecs"
          :key="rec.id"
          class="rec-card"
          :class="rec.hit === true ? 'rec-card--hit' : rec.hit === false ? 'rec-card--miss' : ''"
        >
          <div class="rec-card__header">
            <span class="rec-badge">{{ rec.game_type?.toUpperCase() }} {{ rec.draw_type }}</span>
            <span class="rec-badge rec-badge--half">{{ rec.half?.toUpperCase() }}</span>
            <span class="rec-result" v-if="rec.hit !== null">
              {{ rec.hit ? '✓ HIT' : '✗ MISS' }}
            </span>
            <span class="rec-result rec-result--pending" v-else>⏳ Pendiente</span>
          </div>
          <div class="rec-card__n">
            <span class="rec-n-val">N={{ rec.optimal_n }}</span>
            <span class="rec-n-eff" v-if="rec.predicted_effectiveness > 0">
              {{ (rec.predicted_effectiveness * 100).toFixed(1) }}% efectividad mínima
            </span>
          </div>
          <div class="rec-tiers" v-if="rec.tiers">
            <div class="tier-row" v-if="rec.tiers.must?.length">
              <span class="tier-label tier-label--must">CERTEZA</span>
              <span
                v-for="pair in rec.tiers.must" :key="'m'+pair"
                class="pair-chip pair-chip--must"
                :class="{ 'pair-chip--hit': rec.actual_pair === pair }"
              >{{ pair }}</span>
            </div>
            <div class="tier-row" v-if="rec.tiers.cover?.length">
              <span class="tier-label tier-label--cover">COBERTURA</span>
              <span
                v-for="pair in rec.tiers.cover" :key="'c'+pair"
                class="pair-chip pair-chip--cover"
                :class="{ 'pair-chip--hit': rec.actual_pair === pair }"
              >{{ pair }}</span>
            </div>
            <div class="tier-row" v-if="rec.tiers.watch?.length">
              <span class="tier-label tier-label--watch">VIGILANCIA</span>
              <span
                v-for="pair in rec.tiers.watch" :key="'w'+pair"
                class="pair-chip pair-chip--watch"
                :class="{ 'pair-chip--hit': rec.actual_pair === pair }"
              >{{ pair }}</span>
            </div>
          </div>
          <div class="rec-pairs" v-else>
            <span
              v-for="pair in rec.pairs.slice(0, rec.optimal_n)"
              :key="pair"
              class="pair-chip"
              :class="{
                'pair-chip--hit': rec.actual_pair === pair,
                'pair-chip--top3': rec.pairs.indexOf(pair) < 3,
              }"
            >{{ pair }}</span>
          </div>
          <div class="rec-meta">{{ formatDate(rec.created_at) }}</div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted } from 'vue';
import { useAgentStatus } from '../../composables/agent/useAgentStatus.js';
import { apiGet, apiPost } from '../../utils/apiClient.js';

const { status, connected } = useAgentStatus();
const pendingAlerts = computed(() => status.value?.pending_alerts ?? 0);
const lastSession   = computed(() => status.value?.last_session ?? null);

// ── Pair recommendations ─────────────────────────────────────────
const latestRecs  = ref([]);
const loadingRecs = ref(false);

async function fetchLatestRecs() {
  loadingRecs.value = true;
  try {
    latestRecs.value = await apiGet('/api/agent/pair-recommendations/latest');
  } catch {}
  finally { loadingRecs.value = false; }
}

const triggerGame  = ref('pick3');
const triggerDraw  = ref('midday');
const triggerDate  = ref(new Date().toISOString().split('T')[0]);
const triggerTopN  = ref(10);
const triggering   = ref(false);
const triggerMsg   = ref('');
const triggerError = ref(false);

async function triggerAgent() {
  triggering.value = true;
  triggerMsg.value = '';
  try {
    const data = await apiPost('/api/agent/trigger', {
      game_type: triggerGame.value,
      draw_type: triggerDraw.value,
      draw_date: triggerDate.value,
      top_n: triggerTopN.value,
    });
    triggerMsg.value = `✅ Job encolado: ${data.job_id} (N=${triggerTopN.value})`;
    triggerError.value = false;
  } catch (e) {
    triggerMsg.value = `❌ ${e.message}`;
    triggerError.value = true;
  } finally {
    triggering.value = false;
  }
}

function formatDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString('es-PR', { dateStyle: 'short', timeStyle: 'short' });
}

// ── MOTOR-Σ PPS State ────────────────────────────────────────────
const ppsGame    = ref('pick3');
const ppsDraw    = ref('evening');
const ppsHalf    = ref('du');
const ppsData    = ref(null);
const loadingPPS = ref(false);
const ppsError   = ref('');

async function fetchPPS() {
  loadingPPS.value = true;
  ppsError.value   = '';
  try {
    ppsData.value = await apiGet(
      `/api/agent/pps?game_type=${ppsGame.value}&draw_type=${ppsDraw.value}&half=${ppsHalf.value}`
    );
  } catch (e) {
    ppsError.value = `Error cargando PPS: ${e.message}`;
  } finally {
    loadingPPS.value = false;
  }
}

// ── Diagnóstico Forense ──────────────────────────────────────
const diagData     = ref(null);
const loadingDiag  = ref(false);
const diagLoadedAt = ref(null);
let   diagTimer    = null;

// Age display for diagnostics panel ("hace 2m")
const diagAge = computed(() => {
  if (!diagLoadedAt.value) return '';
  const diff = Math.round((Date.now() - diagLoadedAt.value) / 1000);
  if (diff < 60) return `hace ${diff}s`;
  return `hace ${Math.round(diff / 60)}m`;
});

// Feedback lag color class
const feedbackLagClass = computed(() => {
  const lag = diagData.value?.feedback_lag;
  if (!lag || !lag.feedback_lag_hours) return 'fl--ok';
  if (lag.feedback_lag_hours > 24) return 'fl--critical';
  if (lag.feedback_lag_hours > 6)  return 'fl--warn';
  return 'fl--ok';
});

async function loadDiagnostics() {
  loadingDiag.value = true;
  try {
    diagData.value    = await apiGet('/api/agent/diagnostics');
    diagLoadedAt.value = Date.now();
  } catch (e) {
    diagData.value = { error: e.message };
  } finally {
    loadingDiag.value = false;
  }
}

// ── AlgorithmDiversityAnalyzer — consensus redundancy report ────
const diversityData = ref(null);

async function fetchDiversity() {
  try {
    diversityData.value = await apiGet(
      `/api/agent/algorithm-diversity?game_type=${ppsGame.value}&draw_type=${ppsDraw.value}&half=${ppsHalf.value}`
    );
  } catch { /* non-critical, silent */ }
}

// ── Champion Mode (v2.5) — algoritmo dominante reciente ─────────
const championData = ref(null);

async function fetchChampion() {
  try {
    championData.value = await apiGet(
      `/api/agent/champion-status?game_type=${ppsGame.value}&draw_type=${ppsDraw.value}&half=${ppsHalf.value}`
    );
  } catch { /* non-critical, silent */ }
}

// ── Bucket Analysis (v3.0) — verificación empírica del Sweet Spot ─
const bucketData    = ref(null);
const loadingBucket = ref(false);

async function loadBucketAnalysis() {
  loadingBucket.value = true;
  try {
    bucketData.value = await apiGet(
      `/api/agent/momentum-bucket-analysis?game_type=${ppsGame.value}&draw_type=${ppsDraw.value}&half=${ppsHalf.value}&lookback=200`
    );
  } catch (e) {
    // Silent — bucket analysis es secundario
    console.warn('Bucket analysis no disponible:', e.message);
  } finally {
    loadingBucket.value = false;
  }
}

// Threshold winner: compara momentum>=1 vs momentum>=3
const thresholdWinner = computed(() => {
  if (!bucketData.value) return null;
  const tc = bucketData.value.threshold_comparison;
  if (!tc) return null;
  return tc.momentum_ge_3.hit_rate >= tc.momentum_ge_1.hit_rate ? 'ge_3' : 'ge_1';
});

function bucketCellClass(bucket, baseline, bestRecCount) {
  const classes = [];
  if (bucket.rec_count === bestRecCount) classes.push('bucket-cell--best');
  if (bucket.hit_rate > baseline)        classes.push('bucket-cell--positive');
  if (bucket.hit_rate < baseline * 0.7)  classes.push('bucket-cell--negative');
  return classes.join(' ');
}

async function refreshMotor() {
  await Promise.all([fetchPPS(), fetchDiversity(), fetchChampion(), loadBucketAnalysis()]);
}

// Override pps-controls refresh button to also refresh diversity
onMounted(() => {
  fetchLatestRecs();
  refreshMotor();
  // Auto-refresh diagnostics every 60s (feedback lag & prediction history)
  diagTimer = setInterval(() => {
    if (diagData.value) loadDiagnostics(); // only auto-refresh if user already opened it
  }, 60_000);
});

onUnmounted(() => {
  if (diagTimer) clearInterval(diagTimer);
});
</script>

<style scoped>
.dashboard { max-width: 960px; }
.page-header { margin-bottom: 2rem; }
.page-title { font-size: 1.75rem; font-weight: 700; color: #f1f5f9; margin: 0 0 0.25rem; }
.page-subtitle { color: #64748b; font-size: 0.9rem; }

/* Cards */
.cards-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; margin-bottom: 2rem; }
.stat-card {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  padding: 1.25rem;
}
.stat-card--live  { border-color: #166534; }
.stat-card--offline { border-color: #7f1d1d; }
.stat-card__label { font-size: 0.75rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; }
.stat-card__value { font-size: 1.5rem; font-weight: 700; color: #f1f5f9; margin-bottom: 0.25rem; }
.stat-card__sub   { font-size: 0.75rem; color: #475569; }

/* Sections */
.section { margin-bottom: 2rem; }
.section-title { font-size: 1rem; font-weight: 600; color: #94a3b8; margin: 0 0 1rem; text-transform: uppercase; letter-spacing: 0.05em; }

/* Session card */
.session-card { background: #0f1623; border: 1px solid #1e2d40; border-radius: 12px; padding: 1.25rem; display: flex; flex-direction: column; gap: 0.75rem; }
.session-card__row, .info-row { display: flex; justify-content: space-between; align-items: center; }
.label { color: #64748b; font-size: 0.875rem; }
.value { color: #e2e8f0; font-size: 0.875rem; }
.mono { font-family: monospace; font-size: 0.8rem; }

/* Badge */
.badge { padding: 0.2rem 0.6rem; border-radius: 999px; font-size: 0.75rem; font-weight: 600; }
.badge--completed { background: #14532d; color: #4ade80; }
.badge--running   { background: #1e3a5f; color: #60a5fa; }
.badge--failed    { background: #450a0a; color: #f87171; }

/* Colors */
.text-red   { color: #f87171; }
.text-green { color: #4ade80; }

/* Trigger form */
.trigger-form { display: flex; gap: 0.75rem; flex-wrap: wrap; align-items: center; }
.topn-label { display: flex; align-items: center; gap: 0.5rem; }
.topn-badge { background: #1e2d40; color: #4a9eff; border-radius: 6px; padding: 0.25rem 0.5rem; font-size: 0.8rem; font-weight: 700; min-width: 3rem; text-align: center; }
.topn-slider { width: 80px; accent-color: #1d4ed8; cursor: pointer; }
.input-select, .input-date {
  background: #0f1623; border: 1px solid #1e2d40; color: #e2e8f0;
  padding: 0.5rem 0.75rem; border-radius: 8px; font-size: 0.875rem;
}
.btn-trigger {
  background: #1d4ed8; color: white; border: none; border-radius: 8px;
  padding: 0.5rem 1.25rem; font-size: 0.875rem; font-weight: 600; cursor: pointer;
  transition: background 0.15s;
}
.btn-trigger:hover:not(:disabled) { background: #2563eb; }
.btn-trigger:disabled { opacity: 0.5; cursor: not-allowed; }
.trigger-msg { margin-top: 0.75rem; font-size: 0.875rem; padding: 0.5rem 0.75rem; border-radius: 8px; }
.trigger-msg--ok    { background: #14532d30; color: #4ade80; }
.trigger-msg--error { background: #450a0a30; color: #f87171; }
.empty { color: #475569; font-size: 0.875rem; }

/* ── Pair Recs ───────────────────────────────────────────────── */
.recs-grid { display: flex; flex-direction: column; gap: 1rem; }

.rec-card {
  background: #0f1623;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  padding: 1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.rec-card--hit  { border-color: #16a34a55; }
.rec-card--miss { border-color: #dc262644; }

.rec-card__header {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.rec-badge {
  font-size: 0.68rem;
  font-weight: 700;
  background: #1e2d40;
  color: #94a3b8;
  padding: 0.15rem 0.5rem;
  border-radius: 4px;
  letter-spacing: 0.05em;
}
.rec-badge--half { background: #1a2535; color: #60a5fa; }
.rec-result { margin-left: auto; font-size: 0.75rem; font-weight: 700; color: #22c55e; }
.rec-result--pending { color: #f59e0b; }

.rec-card__n {
  display: flex;
  align-items: baseline;
  gap: 0.6rem;
}
.rec-n-val { font-size: 1rem; font-weight: 700; color: #60a5fa; }
.rec-n-eff { font-size: 0.72rem; color: #475569; }

.rec-pairs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
}
/* ── Tiered pairs ──────────────────────────────────────────────── */
.rec-tiers { display: flex; flex-direction: column; gap: 0.4rem; }
.tier-row  { display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem; }

.tier-label {
  font-size: 0.6rem; font-weight: 700; letter-spacing: 0.06em;
  padding: 0.1rem 0.4rem; border-radius: 3px; white-space: nowrap;
  margin-right: 0.2rem;
}
.tier-label--must  { background: #450a0a; color: #f87171; border: 1px solid #7f1d1d; }
.tier-label--cover { background: #451a03; color: #fb923c; border: 1px solid #7c2d12; }
.tier-label--watch { background: #1a2535; color: #64748b; border: 1px solid #1e2d40; }

.pair-chip {
  font-size: 0.75rem; font-weight: 600; font-family: monospace;
  padding: 0.15rem 0.4rem; border-radius: 4px;
  background: #131c2b; border: 1px solid #1e2d40; color: #94a3b8;
}
.pair-chip--must  { background: #1f0a0a; color: #fca5a5; border-color: #7f1d1d55; }
.pair-chip--cover { background: #1a1005; color: #fdba74; border-color: #7c2d1244; }
.pair-chip--watch { color: #64748b; }
.pair-chip--hit   { background: #052e16 !important; color: #4ade80 !important; border-color: #22c55e !important; }
.pair-chip--top3  { color: #e2e8f0; border-color: #3b82f644; }

.rec-meta { font-size: 0.65rem; color: #334155; margin-top: 0.2rem; }

/* ── MOTOR-Σ PPS Panel ─────────────────────────────────────────── */
.section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; flex-wrap: wrap; gap: 0.75rem; }
.pps-controls { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
.input-select--sm { padding: 0.3rem 0.6rem; font-size: 0.8rem; }
.btn-refresh-sm { background: #1e2d40; color: #64748b; border: 1px solid #2d4a6b; border-radius: 6px; padding: 0.3rem 0.6rem; font-size: 0.85rem; cursor: pointer; }
.btn-refresh-sm:hover { color: #e2e8f0; background: #2d4a6b; }

.pps-summary { display: flex; gap: 0.75rem; flex-wrap: wrap; margin-bottom: 1.25rem; }
.pps-chip { background: #0f1623; border: 1px solid #1e2d40; border-radius: 10px; padding: 0.6rem 1rem; display: flex; flex-direction: column; gap: 0.2rem; min-width: 90px; }
.pps-chip--green  { border-color: #16653444; background: #052e16; }
.pps-chip--red    { border-color: #7f1d1d44; background: #1a0505; }
.pps-chip--yellow { border-color: #78350f44; background: #1c1100; }
.pps-chip--neutral { border-color: #1e2d40; }
.pps-chip__label { font-size: 0.65rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
.pps-chip__val { font-size: 1.15rem; font-weight: 700; color: #e2e8f0; }
.pps-chip__val--sm { font-size: 0.72rem; font-weight: 500; color: #94a3b8; word-break: break-all; }

.pps-table-wrap { background: #0a0d14; border: 1px solid #1e2d40; border-radius: 10px; overflow: hidden; }
.pps-row { display: grid; grid-template-columns: 1fr 2fr 80px 40px; gap: 0.5rem; align-items: center; padding: 0.5rem 1rem; font-size: 0.8rem; border-bottom: 1px solid #0f1a2a; }
.pps-row:last-child { border-bottom: none; }
.pps-row--header { background: #0f1623; font-size: 0.68rem; font-weight: 600; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; }
.pps-algo-name { font-family: monospace; font-size: 0.75rem; color: #94a3b8; }
.pps-bar-cell { display: flex; align-items: center; gap: 0.5rem; }
.pps-bar-track { flex: 1; height: 6px; background: #1e2d40; border-radius: 3px; overflow: hidden; }
.pps-bar-fill { height: 100%; border-radius: 3px; transition: width 0.4s ease; }
.bar--high { background: linear-gradient(90deg, #16a34a, #22c55e); }
.bar--mid  { background: linear-gradient(90deg, #854d0e, #f59e0b); }
.bar--low  { background: linear-gradient(90deg, #7f1d1d, #ef4444); }
.pps-num { font-size: 0.75rem; font-weight: 700; min-width: 30px; text-align: right; }
.num--high { color: #4ade80; }
.num--mid  { color: #f59e0b; }
.num--low  { color: #f87171; }
.pps-samples { font-size: 0.72rem; color: #64748b; display: flex; align-items: center; gap: 0.3rem; }
.warmup-badge { background: #1e3a5f; color: #60a5fa; font-size: 0.6rem; font-weight: 600; padding: 0.1rem 0.4rem; border-radius: 4px; }
.health-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; }
.dot--healthy  { background: #22c55e; box-shadow: 0 0 5px #22c55e66; }
.dot--degraded { background: #f59e0b; }
.dot--low      { background: #ef4444; }
.pps-error { color: #f87171; font-size: 0.8rem; }

/* Algorithm health summary bar */
.health-summary-bar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; padding: 0.5rem 0.75rem; border-radius: 8px; background: #0f1623; border: 1px solid #1e2d40; margin-bottom: 1rem; font-size: 0.78rem; }
.health-summary-bar--ok { border-color: #16653430; background: #052e1615; }
.hs-label { color: #64748b; font-weight: 600; flex-shrink: 0; }
.hs-badge { padding: 0.2rem 0.6rem; border-radius: 6px; font-size: 0.72rem; font-weight: 600; }
.hs-badge--disabled { background: #1a0505; color: #f87171; border: 1px solid #7f1d1d44; }
.hs-badge--degraded { background: #1c1100; color: #f59e0b; border: 1px solid #78350f44; }
.hs-badge--ok       { background: #052e16; color: #4ade80; border: 1px solid #16653444; }

/* ── Diagnóstico Forense ───────────────────────────────────── */
.section--diag { border: 1px solid #78350f44; background: #0f0a05; padding: 1.25rem; border-radius: 12px; }
.btn-diag {
  background: #f59e0b; color: #1a1a1a; border: none; border-radius: 8px;
  padding: 0.5rem 1rem; font-size: 0.85rem; font-weight: 700; cursor: pointer;
}
.btn-diag:hover:not(:disabled) { background: #fbbf24; }
.btn-diag:disabled { opacity: 0.6; cursor: not-allowed; }

.diag-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 0.75rem; margin-top: 0.5rem; }
.diag-card { background: #0a0d14; border: 1px solid #1e2d40; border-radius: 8px; padding: 0.85rem; }
.diag-card--verdict { border-color: #f59e0b44; background: #1a0f05; grid-column: span 2; }
.diag-card--wide    { grid-column: span 2; }
.diag-card__title   { font-size: 0.78rem; color: #94a3b8; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.5rem; padding-bottom: 0.4rem; border-bottom: 1px solid #1e2d40; }
.diag-row { font-size: 0.82rem; color: #cbd5e1; padding: 0.2rem 0; }
.diag-row--sm { font-size: 0.72rem; color: #94a3b8; }
.diag-row--alert { color: #f87171; }
.diag-row strong { color: #f1f5f9; }
.diag-subtitle { margin-top: 0.4rem; font-size: 0.7rem; color: #64748b; }
.diag-meta { color: #475569; font-size: 0.72rem; }

.verdict-list { display: flex; flex-direction: column; gap: 0.4rem; }
.verdict-row { display: flex; justify-content: space-between; align-items: center; gap: 0.5rem; padding: 0.3rem 0; }
.verdict-label { font-size: 0.75rem; color: #94a3b8; font-weight: 600; }
.verdict-val { font-size: 0.72rem; font-weight: 700; padding: 0.2rem 0.5rem; border-radius: 4px; text-align: right; }
.v--red    { background: #1a0505; color: #f87171; }
.v--green  { background: #052e16; color: #4ade80; }
.v--yellow { background: #1c1100; color: #f59e0b; }

/* Diagnostics header with age */
.diag-header-right { display: flex; align-items: center; gap: 0.6rem; }
.diag-age { font-size: 0.72rem; color: #475569; font-style: italic; }

/* Feedback lag card */
.feedback-lag-card { display: grid; grid-template-columns: auto auto 1fr auto; align-items: center; gap: 0.75rem 1.25rem; padding: 0.85rem 1.1rem; border-radius: 10px; margin-bottom: 1rem; font-size: 0.82rem; border: 1px solid; }
.fl--ok       { background: #041510; border-color: #16653488; }
.fl--warn     { background: #1a1000; border-color: #78350f88; }
.fl--critical { background: #200a0a; border-color: #991b1b88; }
.fl-label     { font-size: 0.72rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; font-weight: 600; }
.fl-value     { font-size: 1.5rem; font-weight: 700; }
.fl--ok .fl-value     { color: #4ade80; }
.fl--warn .fl-value   { color: #f59e0b; }
.fl--critical .fl-value { color: #f87171; }
.fl-detail    { font-size: 0.75rem; color: #64748b; }
.fl-verdict   { font-size: 0.72rem; font-weight: 600; padding: 0.2rem 0.6rem; border-radius: 5px; background: #0f1623; color: #94a3b8; }

/* Prediction history 7d */
.pred-history { margin-bottom: 1rem; }
.pred-history__title { font-size: 0.78rem; color: #64748b; font-weight: 700; text-transform: uppercase; letter-spacing: 0.05em; margin-bottom: 0.4rem; }
.pred-history__rows  { display: flex; flex-direction: column; gap: 0.25rem; }
.pred-history__row   { display: grid; grid-template-columns: 1fr auto auto auto 80px; align-items: center; gap: 0.75rem; font-size: 0.78rem; padding: 0.3rem 0.6rem; background: #0a0d14; border-radius: 6px; }
.ph-day      { color: #94a3b8; font-family: monospace; }
.ph-predicted{ color: #64748b; }
.ph-resolved { font-weight: 600; }
.ph-hits     { font-weight: 700; }
.ph-bar      { height: 5px; background: #1e2d40; border-radius: 3px; overflow: hidden; }
.ph-bar__hit { height: 100%; background: #4ade80; border-radius: 3px; transition: width 0.4s; }

.pps-diag-grid { display: flex; flex-direction: column; gap: 0.3rem; }
.pps-diag-row  { display: grid; grid-template-columns: 1.5fr 1fr 1fr 1fr; gap: 0.4rem; font-size: 0.72rem; font-family: monospace; padding: 0.2rem 0; border-bottom: 1px solid #0f1623; }
.diag-algo     { color: #60a5fa; }

.diag-raw { margin-top: 0.75rem; }
.diag-raw summary { cursor: pointer; font-size: 0.72rem; color: #64748b; }
.diag-raw pre     { background: #050810; padding: 0.75rem; border-radius: 6px; font-size: 0.65rem; color: #94a3b8; overflow-x: auto; max-height: 400px; margin-top: 0.5rem; }

/* Diversity bar */
/* Bucket Analysis card */
.bucket-analysis-card { background: #0a0d14; border: 1px solid #1e2d40; border-radius: 10px; padding: 1rem 1.1rem; margin-bottom: 1rem; }
.bucket-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 0.7rem; }
.bucket-title  { color: #f1f5f9; font-weight: 700; font-size: 0.92rem; }
.bucket-refresh{ background: transparent; border: 1px solid #1e2d40; color: #94a3b8; padding: 0.25rem 0.55rem; border-radius: 6px; cursor: pointer; font-size: 0.85rem; }
.bucket-refresh:hover:not(:disabled) { background: #1e2d40; color: #f1f5f9; }
.bucket-refresh:disabled { opacity: 0.5; cursor: not-allowed; }

.bucket-meta { display: flex; gap: 1.2rem; flex-wrap: wrap; padding: 0.4rem 0 0.7rem; font-size: 0.78rem; color: #64748b; border-bottom: 1px solid #1e2d40; margin-bottom: 0.7rem; }
.bucket-meta strong { color: #f1f5f9; }

.bucket-empty { color: #64748b; font-style: italic; padding: 0.6rem 0; font-size: 0.82rem; }

.bucket-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.6rem; margin-bottom: 0.8rem; }
.bucket-cell { background: #050810; border: 1px solid #1e2d40; border-radius: 8px; padding: 0.65rem 0.7rem; }
.bucket-cell--best     { border-color: #4ade8088; background: #052e1622; box-shadow: 0 0 12px #4ade8033; }
.bucket-cell--positive .bucket-cell-rate { color: #4ade80; }
.bucket-cell--negative .bucket-cell-rate { color: #f87171; }
.bucket-cell-label  { font-size: 0.72rem; color: #94a3b8; font-weight: 600; margin-bottom: 0.3rem; display: flex; align-items: center; justify-content: space-between; gap: 0.3rem; }
.bucket-cell-tag    { font-size: 0.65rem; color: #fbbf24; font-weight: 400; }
.bucket-cell-rate   { font-size: 1.35rem; font-weight: 700; color: #f1f5f9; }
.bucket-cell-sub    { font-size: 0.68rem; color: #64748b; margin-top: 0.15rem; line-height: 1.3; }

.bucket-verdict { background: #052e1622; border: 1px solid #16653488; border-radius: 6px; padding: 0.5rem 0.75rem; margin-bottom: 0.6rem; font-size: 0.82rem; color: #94a3b8; }
.bucket-verdict strong { color: #4ade80; }

.threshold-comparison { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; font-size: 0.75rem; }
.tc-label  { color: #64748b; font-weight: 600; }
.tc-pill   { background: #050810; border: 1px solid #1e2d40; padding: 0.25rem 0.55rem; border-radius: 5px; color: #94a3b8; font-family: monospace; }
.tc-pill--winner { background: #052e1622; border-color: #4ade8088; color: #4ade80; font-weight: 600; }

/* Champion Mode bar */
.champion-bar { display: flex; align-items: center; gap: 0.75rem; flex-wrap: wrap; padding: 0.7rem 1rem; border-radius: 10px; margin-bottom: 0.75rem; font-size: 0.85rem; border: 1px solid; }
.champion-bar--active { background: linear-gradient(135deg, #0f2a1a 0%, #0a1410 100%); border-color: #4ade8088; box-shadow: 0 0 18px #4ade8022; }
.champion-bar--idle   { background: #0a0d14; border-color: #1e2d40; opacity: 0.85; }
.champion-icon  { font-size: 1.3rem; }
.champion-label { color: #64748b; font-weight: 600; text-transform: uppercase; font-size: 0.7rem; letter-spacing: 0.05em; }
.champion-name  { color: #4ade80; font-weight: 700; font-family: monospace; padding: 0.15rem 0.5rem; background: #052e1644; border-radius: 5px; }
.champion-rate  { color: #f1f5f9; font-weight: 600; }
.champion-rate small { color: #64748b; font-weight: 400; }
.champion-edge  { color: #fbbf24; font-weight: 700; padding: 0.15rem 0.45rem; background: #1c110044; border-radius: 4px; font-size: 0.78rem; }
.champion-status{ color: #94a3b8; font-style: italic; font-size: 0.78rem; }
.champion-bar--active .champion-status { color: #4ade80; font-style: normal; font-weight: 600; }
.champion-best  { color: #64748b; font-size: 0.75rem; }

.diversity-bar { display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; padding: 0.5rem 0.75rem; border-radius: 8px; background: #0a0d14; border: 1px solid #1e2d40; margin-bottom: 1rem; font-size: 0.78rem; }
.div-label  { color: #64748b; font-weight: 600; flex-shrink: 0; }
.div-score  { font-size: 1.05rem; font-weight: 700; }
.div-rec    { font-size: 0.75rem; font-weight: 600; padding: 0.15rem 0.5rem; border-radius: 5px; }
.div--healthy  { color: #4ade80; background: #052e1615; border: 1px solid #16653433; }
.div--redundant{ color: #f59e0b; background: #1c110015; border: 1px solid #78350f33; }
.div--collapsed{ color: #f87171; background: #1a050515; border: 1px solid #7f1d1d33; }
.div-clusters { color: #64748b; font-size: 0.72rem; display: flex; flex-wrap: wrap; gap: 0.3rem; align-items: center; }
.div-cluster-tag { background: #1e2d40; color: #94a3b8; padding: 0.1rem 0.4rem; border-radius: 4px; font-size: 0.68rem; font-family: monospace; }
.div-snap { color: #334155; font-size: 0.65rem; margin-left: auto; }

@media (max-width: 768px) {
  .cards-grid { grid-template-columns: 1fr 1fr; }
  .pps-row { grid-template-columns: 1fr 1.5fr 60px 30px; font-size: 0.72rem; }
}
</style>
