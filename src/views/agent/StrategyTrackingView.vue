<template>
  <div class="tracking-view">

    <!-- ── HEADER ─────────────────────────────────────────────── -->
    <div class="tracking-header">
      <div class="tracking-header__left">
        <h1 class="tracking-title">Estrategias · Cognición & Aprendizaje</h1>
        <p class="tracking-subtitle">Análisis profundo · Razonamiento adaptativo · Inteligencia colectiva</p>
      </div>
      <div class="tracking-header__controls">
        <select v-model="gameType" class="ctrl-select" @change="fetch()">
          <option value="pick3">Pick 3</option>
          <option value="pick4">Pick 4</option>
        </select>
        <select v-model="mode" class="ctrl-select" @change="fetch()">
          <option value="combined">Combined</option>
          <option value="midday">Midday</option>
          <option value="evening">Evening</option>
        </select>
        <label class="toggle-wrap">
          <input type="checkbox" v-model="deepMode" class="toggle-input" />
          <span class="toggle-track"><span class="toggle-thumb"></span></span>
          <span class="toggle-label">🧠 Deep</span>
        </label>
        <button class="btn-refresh" :disabled="loading" @click="fetch()">
          <span :class="{ spin: loading }">↻</span>
          {{ loading ? 'Cargando…' : 'Actualizar' }}
        </button>
      </div>
    </div>

    <div v-if="loading && !strategies.length" class="state-msg">
      <div class="spinner"></div> Analizando estrategias…
    </div>
    <div v-else-if="error" class="state-msg state-msg--error">
      ⚠ {{ error }} — <button @click="fetch()" class="link-btn">Reintentar</button>
    </div>

    <template v-else-if="strategies.length">

      <!-- ── HERO ─────────────────────────────────────────────── -->
      <div class="hero-strip" v-if="best">
        <div class="hero-card" :style="{ '--accent': best.color }">
          <div class="hero-card__badge">Mejor estrategia ahora</div>
          <div class="hero-card__main">
            <span class="hero-icon">{{ best.icon }}</span>
            <div>
              <div class="hero-name">{{ best.label }}</div>
              <div class="hero-cat" :class="`cat--${best.category}`">{{ best.category }}</div>
            </div>
          </div>
          <div class="hero-rate" :style="{ color: best.color }">{{ pct(best.hit_rate ?? best.win_rate) }}</div>
          <div class="hero-stats">
            <div class="hero-stat">
              <span class="hs-val">{{ best.trend?.label }} <span :class="trendClass(best.trend?.direction)">{{ best.trend?.direction }}</span></span>
              <span class="hs-lbl">tendencia</span>
            </div>
            <div class="hero-stat">
              <span class="hs-val">{{ best.strength }}/100</span>
              <span class="hs-lbl">señal</span>
            </div>
            <div class="hero-stat">
              <span class="hs-val">{{ best.adaptiveHealth }}%</span>
              <span class="hs-lbl">salud adapt.</span>
            </div>
          </div>
          <div class="hero-projection" v-if="best.projection?.values?.length">
            <span class="proj-lbl">Proyección →</span>
            <span v-for="(v, i) in best.projection.values" :key="i"
              class="proj-pill" :class="v > (best.hit_rate ?? best.win_rate) ? 'proj-pill--up' : 'proj-pill--dn'">
              S+{{ i+1 }}: {{ pct(v) }}
            </span>
          </div>
        </div>

        <div v-if="apex" class="apex-card">
          <div class="apex-card__label">🏆 APEX Adaptive</div>
          <div class="apex-rate" :style="{ color: apex.color }">{{ pct(apex.hit_rate ?? apex.win_rate) }}</div>
          <div class="apex-health">
            <div class="health-bar-bg">
              <div class="health-bar-fill" :style="{ width: apex.adaptiveHealth + '%', background: healthColor(apex.adaptiveHealth) }"></div>
            </div>
            <span class="health-val">{{ apex.adaptiveHealth }}% salud</span>
          </div>
          <div class="apex-meta">Meta-estrategia · pesos adaptativos</div>
          <div class="apex-projection" v-if="apex.projection?.values?.length">
            <span v-for="(v, i) in apex.projection.values" :key="i" class="proj-pill proj-pill--gold">
              S+{{ i+1 }}: {{ pct(v) }}
            </span>
          </div>
        </div>
      </div>

      <!-- ── COLLECTIVE INTELLIGENCE ────────────────────────────── -->
      <div class="section ci-section" v-if="collective">
        <div class="section-title-row">
          <span class="section-title">🧠 Inteligencia Colectiva</span>
          <span class="ci-ts">{{ generatedAt ? formatDate(generatedAt) : '' }}</span>
        </div>
        <div class="ci-grid">
          <div class="ci-card">
            <div class="ci-card__val" :style="{ color: '#60a5fa' }">{{ pct(collective.weightedMean) }}</div>
            <div class="ci-card__lbl">Consenso ponderado</div>
            <div class="ci-card__sub">media de {{ strategies.filter(s => !s.isApex).length }} estrategias</div>
          </div>
          <div class="ci-card">
            <div class="ci-card__val" :style="{ color: divergenceColor(collective.divergenceScore) }">{{ collective.divergenceScore }}/100</div>
            <div class="ci-card__lbl">Divergencia</div>
            <div class="ci-card__sub">{{ collective.divergenceScore < 30 ? 'Consenso fuerte' : collective.divergenceScore < 60 ? 'Divergencia moderada' : 'Alta incertidumbre' }}</div>
          </div>
          <div class="ci-card">
            <div class="ci-card__val" :style="{ color: collective.apexVsConsensus >= 0 ? '#22c55e' : '#f87171' }">
              {{ collective.apexVsConsensus >= 0 ? '+' : '' }}{{ collective.apexVsConsensus.toFixed(1) }}%
            </div>
            <div class="ci-card__lbl">APEX vs Consenso</div>
            <div class="ci-card__sub">{{ collective.apexVsConsensus >= 0 ? 'APEX supera el promedio' : 'APEX bajo promedio' }}</div>
          </div>
          <div class="ci-card">
            <div class="ci-card__val" :style="{ color: collective.learningActive ? '#22c55e' : '#475569' }">
              {{ collective.learningActive ? '🟢 Activo' : '⚪ Sin datos' }}
            </div>
            <div class="ci-card__lbl">Ciclo de aprendizaje</div>
            <div class="ci-card__sub">EMA α=0.2 post-sorteo</div>
          </div>
        </div>

        <!-- Weight distribution bar chart -->
        <div class="ci-weight-dist">
          <div class="ci-weight-title">Distribución de pesos adaptativos</div>
          <div class="ci-weight-rows">
            <div v-for="s in sortedByWeight" :key="s.name" class="ci-wr">
              <span class="ci-wr-icon">{{ s.icon }}</span>
              <span class="ci-wr-name">{{ s.label }}</span>
              <div class="ci-wr-bar-wrap">
                <div class="ci-wr-bar" :style="{ width: weightBarWidth(s.weight) + '%', background: s.color + 'cc' }"></div>
                <div class="ci-wr-neutral" :style="{ left: weightBarWidth(1.0) + '%' }"></div>
              </div>
              <span class="ci-wr-val" :class="weightClass(s.weight)">{{ s.weight?.toFixed(3) }}×</span>
              <span class="ci-wr-topn">N={{ s.top_n }}</span>
              <span class="ci-wr-health" :style="{ color: healthColor(s.adaptiveHealth) }">{{ s.adaptiveHealth }}%</span>
            </div>
          </div>
          <div class="ci-weight-legend">← Penalizado (0.5×) &emsp;|&emsp; Neutro (1.0×) &emsp;|&emsp; Amplificado (2.0×) →</div>
        </div>
      </div>

      <!-- ── RANKING TABLE ────────────────────────────────────────── -->
      <div class="section">
        <div class="section-title">Ranking · {{ gameType.toUpperCase() }} {{ mode }}</div>
        <div class="ranking-table">
          <div class="ranking-row ranking-row--header">
            <span>#</span>
            <span>Estrategia</span>
            <span>Hit Rate</span>
            <span>Vel. Aprendizaje</span>
            <span>Top-N</span>
            <span>Peso</span>
            <span>Señal</span>
            <span>Salud</span>
          </div>
          <div
            v-for="(s, i) in ranked"
            :key="s.name"
            class="ranking-row"
            :class="{ 'ranking-row--apex': s.isApex, 'ranking-row--top3': i < 3 && !s.isApex }"
            :style="{ '--row-color': s.color }"
            @click="toggleExpand(s.name)"
          >
            <span class="rank-num">
              <span v-if="i === 0 && !s.isApex">🥇</span>
              <span v-else-if="i === 1 && !s.isApex">🥈</span>
              <span v-else-if="i === 2 && !s.isApex">🥉</span>
              <span v-else class="rank-n">#{{ i + 1 }}</span>
            </span>
            <span class="rank-name">
              <span class="rank-icon">{{ s.icon }}</span>
              <span>{{ s.label }}</span>
              <span class="rank-cat" :class="`cat--${s.category}`">{{ s.category }}</span>
            </span>
            <span class="rank-rate">
              <span class="rate-bar-wrap">
                <span class="rate-bar" :style="{ width: pctRaw(s.hit_rate ?? s.win_rate, 0.40) + '%', background: s.color }"></span>
              </span>
              <span class="rate-val" :style="{ color: s.color }">{{ pct(s.hit_rate ?? s.win_rate) }}</span>
            </span>
            <span class="rank-vel" :style="{ color: s.velocity?.color }">{{ s.velocity?.label }}</span>
            <span class="rank-topn">
              <span class="topn-badge"
                :class="{ 'topn-badge--good': s.top_n <= 14, 'topn-badge--warn': s.top_n > 14 && s.top_n <= 22, 'topn-badge--poor': s.top_n > 22 }">
                {{ s.top_n }}
              </span>
            </span>
            <span class="rank-weight" :class="weightClass(s.weight)">{{ s.weight?.toFixed(2) }}×</span>
            <span class="rank-signal">
              <span class="signal-bar-wrap">
                <span class="signal-bar" :style="{ width: s.strength + '%', background: signalColor(s.strength) }"></span>
              </span>
              <span class="signal-val">{{ s.strength }}</span>
            </span>
            <span class="rank-health">
              <span class="health-dot" :style="{ background: healthColor(s.adaptiveHealth) }"></span>
              {{ s.adaptiveHealth }}%
            </span>
          </div>
        </div>
        <div class="ranking-hint">▶ Clic en una fila para ver análisis cognitivo</div>
      </div>

      <!-- ── EVOLUTION CHART ─────────────────────────────────────── -->
      <div class="section">
        <div class="section-title-row">
          <span class="section-title">Evolución de Hit Rate · con Proyección</span>
          <div class="chart-legend">
            <span class="legend-item">━ Histórico</span>
            <span class="legend-item legend-item--dashed">╌ Proyección</span>
            <span class="legend-item"><span style="color:#ef4444">━</span> Baseline {{ pct(RANDOM_BASELINE) }}</span>
          </div>
        </div>
        <div class="chart-wrap">
          <canvas ref="mainChartRef" class="main-chart"></canvas>
        </div>
        <div class="chart-toggles">
          <button
            v-for="s in strategies" :key="s.name"
            class="chart-toggle"
            :class="{ 'chart-toggle--off': hiddenStrategies.has(s.name) }"
            :style="{ '--tc': s.color }"
            @click="toggleStrategy(s.name)"
          >{{ s.icon }} {{ s.label }}</button>
        </div>
      </div>

      <!-- ── STRATEGY COGNITIVE CARDS ───────────────────────────── -->
      <div class="section">
        <div class="section-title-row">
          <span class="section-title">Análisis Cognitivo por Estrategia</span>
          <button class="btn-expand-all" @click="expandAll">{{ allExpanded ? 'Colapsar todo' : 'Expandir todo' }}</button>
        </div>
        <div class="strat-cards-list">
          <div
            v-for="s in displayStrategies"
            :key="s.name"
            class="strat-card"
            :class="{ 'strat-card--apex': s.isApex, 'strat-card--top': ranked.indexOf(s) < 3 && !s.isApex, 'strat-card--expanded': expandedCards.has(s.name) }"
            :style="{ '--sc': s.color }"
          >
            <!-- Card header (always visible) -->
            <div class="sc-head" @click="toggleExpand(s.name)">
              <div class="sc-head-left">
                <span class="sc-icon">{{ s.icon }}</span>
                <div>
                  <span class="sc-name">{{ s.label }}</span>
                  <span class="sc-cat" :class="`cat--${s.category}`">{{ s.category }}</span>
                </div>
                <span class="sc-rank-badge" v-if="ranked.indexOf(s) < 3 && !s.isApex">{{ ['🥇','🥈','🥉'][ranked.indexOf(s)] }}</span>
                <span class="sc-rank-badge sc-rank-badge--apex" v-if="s.isApex">META</span>
              </div>
              <div class="sc-head-right">
                <span class="sc-rate-big" :style="{ color: s.color }">{{ pct(s.hit_rate ?? s.win_rate) }}</span>
                <span class="sc-trend" :class="trendClass(s.trend?.direction)">{{ s.trend?.label }}</span>
                <span class="sc-vel" :style="{ color: s.velocity?.color }">{{ s.velocity?.label }}</span>
                <span class="sc-expand-icon">{{ expandedCards.has(s.name) ? '▲' : '▼' }}</span>
              </div>
            </div>

            <!-- Sparkline + base metrics (always visible) -->
            <div class="sc-summary">
              <div class="sc-sparkline-wrap">
                <svg :viewBox="`0 0 ${sparkW} ${sparkH}`" preserveAspectRatio="none" class="sparkline-svg">
                  <line :x1="0" :y1="sparkY(RANDOM_BASELINE)" :x2="sparkW" :y2="sparkY(RANDOM_BASELINE)"
                    stroke="#ef4444" stroke-width="1" stroke-dasharray="3,2" opacity="0.4"/>
                  <polyline :points="sparkPoints(s.hit_rate_display ?? [])" fill="none"
                    :stroke="s.color" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
                  <polyline :points="sparkProjectionPoints(s.hit_rate_display ?? [], s.projection?.values ?? [])"
                    fill="none" :stroke="s.color" stroke-width="1.5" stroke-dasharray="4,3" opacity="0.6"/>
                </svg>
              </div>
              <div class="sc-base-metrics">
                <div class="sc-bm">
                  <span class="sc-bm-val">{{ s.top_n }}</span>
                  <span class="sc-bm-lbl">top-N</span>
                </div>
                <div class="sc-bm">
                  <span class="sc-bm-val" :class="weightClass(s.weight)">{{ s.weight?.toFixed(2) }}×</span>
                  <span class="sc-bm-lbl">peso</span>
                </div>
                <div class="sc-bm">
                  <span class="sc-bm-val">{{ s.strength }}/100</span>
                  <span class="sc-bm-lbl">señal</span>
                </div>
                <div class="sc-bm">
                  <span class="sc-bm-val" :style="{ color: healthColor(s.adaptiveHealth) }">{{ s.adaptiveHealth }}%</span>
                  <span class="sc-bm-lbl">salud</span>
                </div>
                <div class="sc-bm" v-if="s.total_eval_pts">
                  <span class="sc-bm-val">{{ s.total_eval_pts }}</span>
                  <span class="sc-bm-lbl">sorteos eval.</span>
                </div>
              </div>

              <!-- Hit/miss timeline strip (last 30) -->
              <div class="sc-timeline-strip" v-if="s.timeline?.length">
                <div class="sc-dots">
                  <span v-for="(pt, j) in s.timeline.slice(-30)" :key="j"
                    class="sc-dot" :class="pt.hit ? 'sc-dot--hit' : 'sc-dot--miss'"
                    :title="pt.eval_date + ': ' + (pt.hit ? 'HIT ✓' : 'MISS ✗')"></span>
                </div>
                <div class="sc-streak-row">
                  <span class="sc-streak" :class="s.streakStats.streakType === 'hit' ? 'streak--hit' : 'streak--miss'">
                    {{ s.streakStats.streakType === 'hit' ? '🔥' : '❄️' }} Racha {{ s.streakStats.streakType }}: {{ s.streakStats.currentStreak }}
                  </span>
                  <span class="sc-recent-rate" :style="{ color: rateColor(s.streakStats.recentHitRate) }">
                    Últ. 20: {{ pct(s.streakStats.recentHitRate) }}
                  </span>
                </div>
              </div>
            </div>

            <!-- ── EXPANDED: Cognitive Brain Panel ─────────────── -->
            <div class="sc-brain" v-if="expandedCards.has(s.name) && s.brain">
              <div class="brain-section">
                <div class="brain-header">🧠 Lógica cognitiva</div>
                <div class="brain-grid">
                  <div class="brain-item">
                    <div class="brain-item__label">¿Qué detecta?</div>
                    <div class="brain-item__val">{{ s.brain.what }}</div>
                  </div>
                  <div class="brain-item">
                    <div class="brain-item__label">Fórmula matemática</div>
                    <div class="brain-item__val brain-item__val--mono">{{ s.brain.how }}</div>
                  </div>
                  <div class="brain-item brain-item--green">
                    <div class="brain-item__label">✓ Condiciones óptimas</div>
                    <div class="brain-item__val">{{ s.brain.optimal }}</div>
                  </div>
                  <div class="brain-item brain-item--red">
                    <div class="brain-item__label">✗ Fallos típicos</div>
                    <div class="brain-item__val">{{ s.brain.weak }}</div>
                  </div>
                  <div class="brain-item">
                    <div class="brain-item__label">Datos necesarios</div>
                    <div class="brain-item__val">{{ s.brain.dataNeeds }}</div>
                  </div>
                  <div class="brain-item brain-item--blue">
                    <div class="brain-item__label">📡 Aprendizaje adaptativo</div>
                    <div class="brain-item__val">{{ s.brain.learningNote }}</div>
                  </div>
                </div>
              </div>

              <!-- Adaptive state detail -->
              <div class="brain-section">
                <div class="brain-header">⚙️ Estado adaptativo actual</div>
                <div class="adaptive-state">
                  <div class="as-row">
                    <span class="as-label">Peso actual</span>
                    <div class="as-bar-wrap">
                      <div class="as-bar" :style="{ width: weightBarWidth(s.weight) + '%', background: s.color + 'aa' }"></div>
                      <div class="as-neutral-mark" :style="{ left: weightBarWidth(1.0) + '%' }"></div>
                    </div>
                    <span class="as-val" :class="weightClass(s.weight)">{{ s.weight?.toFixed(3) }}×</span>
                  </div>
                  <div class="as-row">
                    <span class="as-label">Top-N adaptativo</span>
                    <div class="as-bar-wrap">
                      <div class="as-bar" :style="{ width: (s.top_n / 50) * 100 + '%', background: topNColor(s.top_n, s.optimalTopN) + 'aa' }"></div>
                      <div class="as-opt-range"
                        :style="{ left: (s.optimalTopN[0] / 50) * 100 + '%', width: ((s.optimalTopN[1] - s.optimalTopN[0]) / 50) * 100 + '%' }">
                      </div>
                    </div>
                    <span class="as-val">{{ s.top_n }} <span class="as-opt">(ópt. {{ s.optimalTopN[0] }}–{{ s.optimalTopN[1] }})</span></span>
                  </div>
                  <div class="as-row">
                    <span class="as-label">Salud adaptativa</span>
                    <div class="as-bar-wrap">
                      <div class="as-bar" :style="{ width: s.adaptiveHealth + '%', background: healthColor(s.adaptiveHealth) + 'aa' }"></div>
                    </div>
                    <span class="as-val" :style="{ color: healthColor(s.adaptiveHealth) }">{{ s.adaptiveHealth }}%</span>
                  </div>
                  <div class="as-hit-rate-hist" v-if="s.hit_rate_history?.length">
                    <span class="as-hist-label">Historial de hit rate (ventanas de 10):</span>
                    <div class="as-hist-bars">
                      <div v-for="(r, i) in s.hit_rate_history.slice(-10)" :key="i"
                        class="as-hist-bar"
                        :style="{ height: Math.max(4, (r / 0.35) * 40) + 'px', background: rateColor(r) }"
                        :title="pct(r)">
                      </div>
                    </div>
                    <div class="as-hist-axis">
                      <span>{{ pct(s.hit_rate_history.at(-10) ?? 0) }}</span>
                      <span>→</span>
                      <span :style="{ color: rateColor(s.hit_rate_history.at(-1)) }">{{ pct(s.hit_rate_history.at(-1) ?? 0) }}</span>
                    </div>
                  </div>
                </div>
              </div>

              <!-- Streak analysis (deep mode) -->
              <div class="brain-section" v-if="deepMode">
                <div class="brain-header">📊 Análisis de rachas</div>
                <div class="streak-analysis">
                  <div class="sa-card" :class="s.streakStats.streakType === 'hit' ? 'sa-card--hit' : 'sa-card--miss'">
                    <div class="sa-val">{{ s.streakStats.currentStreak }}</div>
                    <div class="sa-lbl">Racha actual ({{ s.streakStats.streakType }})</div>
                  </div>
                  <div class="sa-card">
                    <div class="sa-val" style="color:#22c55e">{{ s.streakStats.longestHit }}</div>
                    <div class="sa-lbl">Racha hit máx.</div>
                  </div>
                  <div class="sa-card">
                    <div class="sa-val" style="color:#f87171">{{ s.streakStats.longestMiss }}</div>
                    <div class="sa-lbl">Racha miss máx.</div>
                  </div>
                  <div class="sa-card">
                    <div class="sa-val" :style="{ color: rateColor(s.streakStats.recentHitRate) }">{{ pct(s.streakStats.recentHitRate) }}</div>
                    <div class="sa-lbl">Hit rate últimos 20</div>
                  </div>
                  <div class="sa-card" v-if="s.hits_both != null">
                    <div class="sa-val">{{ s.hits_both }}</div>
                    <div class="sa-lbl">Hits confirmados</div>
                  </div>
                  <div class="sa-card" v-if="s.date_from">
                    <div class="sa-val sa-val--sm">{{ s.date_from?.slice(0,10) }}</div>
                    <div class="sa-lbl">Desde</div>
                  </div>
                </div>
              </div>

              <!-- Projection detail -->
              <div class="brain-section" v-if="s.projection?.values?.length">
                <div class="brain-header">🔮 Proyección (regresión lineal últimas 8 ventanas)</div>
                <div class="proj-detail">
                  <div v-for="(v, i) in s.projection.values" :key="i" class="pd-item">
                    <div class="pd-label">S+{{ i+1 }}</div>
                    <div class="pd-bar-wrap">
                      <div class="pd-bar" :style="{ width: (v / 0.35) * 100 + '%', background: rateColor(v) }"></div>
                      <div class="pd-baseline" :style="{ left: (RANDOM_BASELINE / 0.35) * 100 + '%' }"></div>
                    </div>
                    <div class="pd-val" :class="v > (s.hit_rate ?? s.win_rate) ? 'pd-val--up' : 'pd-val--dn'">{{ pct(v) }}</div>
                    <div class="pd-bounds">± {{ pct(s.projection.upper[i] - v) }}</div>
                  </div>
                </div>
              </div>
            </div>

          </div>
        </div>
      </div>

      <!-- ── DEEP: PRECISION METRICS TABLE ─────────────────────── -->
      <div class="section" v-if="deepMode">
        <div class="section-title">📐 Métricas de Precisión — Todas las Estrategias</div>
        <div class="precision-table">
          <div class="pt-row pt-row--header">
            <span>Estrategia</span>
            <span>Hit Rate</span>
            <span>Win Rate</span>
            <span>Top-N</span>
            <span>Peso</span>
            <span>Eval. pts</span>
            <span>Hits</span>
            <span>Período</span>
            <span>Señal</span>
          </div>
          <div v-for="s in ranked" :key="s.name" class="pt-row" :style="{ '--pc': s.color }">
            <span class="pt-name"><span>{{ s.icon }}</span> {{ s.label }}</span>
            <span class="pt-val" :style="{ color: s.color }">{{ pct(s.hit_rate ?? 0) }}</span>
            <span class="pt-val">{{ pct(s.win_rate ?? 0) }}</span>
            <span class="pt-topn">{{ s.top_n }}</span>
            <span class="pt-w" :class="weightClass(s.weight)">{{ s.weight?.toFixed(3) }}×</span>
            <span class="pt-eval">{{ s.total_eval_pts ?? '—' }}</span>
            <span class="pt-hits">{{ (s.hits_both ?? s.hits_exact) || '—' }}</span>
            <span class="pt-dates">{{ s.date_from?.slice(0,10) ?? '—' }}</span>
            <span class="pt-signal" :style="{ color: signalColor(s.strength) }">{{ s.strength }}/100</span>
          </div>
        </div>
      </div>

      <!-- ── LEARNING LOOP DIAGRAM ───────────────────────────────── -->
      <div class="section" v-if="deepMode">
        <div class="section-title">🔄 Ciclo de Autoaprendizaje</div>
        <div class="learning-loop">
          <div class="ll-step ll-step--1">
            <div class="ll-icon">📊</div>
            <div class="ll-title">Backtest histórico</div>
            <div class="ll-desc">PairBacktestEngine.runAll() — 10 estrategias × sliding window → hit_rate por ventana</div>
          </div>
          <div class="ll-arrow">→</div>
          <div class="ll-step ll-step--2">
            <div class="ll-icon">⚙️</div>
            <div class="ll-title">Adaptive Top-N</div>
            <div class="ll-desc">updateAdaptiveTopN() — escribe top_n + hit_rate_history en adaptive_weights</div>
          </div>
          <div class="ll-arrow">→</div>
          <div class="ll-step ll-step--3">
            <div class="ll-icon">🏆</div>
            <div class="ll-title">APEX Adaptive</div>
            <div class="ll-desc">Corre ÚLTIMO con pesos y top_n aprendidos → mayor precisión teórica</div>
          </div>
          <div class="ll-arrow">→</div>
          <div class="ll-step ll-step--4">
            <div class="ll-icon">📡</div>
            <div class="ll-title">Trigger pre-sorteo</div>
            <div class="ll-desc">HitdashAgent.run() → analyzePairs() lee top_n de DB → PairRecommender → Telegram</div>
          </div>
          <div class="ll-arrow">→</div>
          <div class="ll-step ll-step--5">
            <div class="ll-icon">🎯</div>
            <div class="ll-title">Sorteo real</div>
            <div class="ll-desc">PostDrawProcessor → detecta hit/miss → EMA(α=0.2) → actualiza pesos + top_n en vivo</div>
          </div>
          <div class="ll-arrow">→</div>
          <div class="ll-step ll-step--1">
            <div class="ll-icon">🔁</div>
            <div class="ll-title">Siguiente ciclo</div>
            <div class="ll-desc">Estrategias precisas → top_n se reduce (más selective). Imprecisas → top_n crece (más cobertura)</div>
          </div>
        </div>
      </div>

    </template>
  </div>
</template>

<script setup>
import { ref, computed, watch, onMounted, onUnmounted, nextTick } from 'vue';
import { Chart, registerables } from 'chart.js';
import { useStrategyTracking, STRATEGY_META } from '../../composables/agent/useStrategyTracking.js';

Chart.register(...registerables);

const {
  strategies, ranked, best, apex, collective,
  loading, error, generatedAt,
  gameType, mode,
  fetch,
  RANDOM_BASELINE,
} = useStrategyTracking();

// ─── UI state ───────────────────────────────────────────────────
const deepMode         = ref(false);
const hiddenStrategies = ref(new Set());
const expandedCards    = ref(new Set());
const mainChartRef     = ref(null);
let   chartInstance    = null;
const sparkW = 100, sparkH = 36;

// ─── Computed ───────────────────────────────────────────────────
const displayStrategies = computed(() => {
  if (deepMode.value) return ranked.value;
  return [
    ...ranked.value.filter(s => !s.isApex && s.name !== 'consensus_top').slice(0, 5),
    ...ranked.value.filter(s => s.isApex),
  ];
});

const sortedByWeight = computed(() =>
  [...strategies.value].sort((a, b) => (b.weight ?? 1) - (a.weight ?? 1))
);

const allExpanded = computed(() =>
  displayStrategies.value.every(s => expandedCards.value.has(s.name))
);

// ─── Expand/collapse ────────────────────────────────────────────
function toggleExpand(name) {
  const s = new Set(expandedCards.value);
  if (s.has(name)) s.delete(name);
  else s.add(name);
  expandedCards.value = s;
}

function expandAll() {
  if (allExpanded.value) {
    expandedCards.value = new Set();
  } else {
    expandedCards.value = new Set(displayStrategies.value.map(s => s.name));
  }
}

// ─── Helpers ────────────────────────────────────────────────────
function pct(v)         { return v != null ? (v * 100).toFixed(1) + '%' : '—'; }
function pctRaw(v, max) { return Math.min(100, (v / max) * 100).toFixed(1); }
function formatDate(iso) {
  return new Date(iso).toLocaleString('es-PR', { dateStyle: 'short', timeStyle: 'short' });
}
function trendClass(dir) {
  return { 'trend--up': dir === 'up', 'trend--dn': dir === 'down', 'trend--st': dir === 'stable' };
}
function weightClass(w) {
  if (w == null) return '';
  if (w >= 1.3) return 'weight--high';
  if (w <= 0.7) return 'weight--low';
  return 'weight--mid';
}
function signalColor(s) {
  if (s >= 70) return '#22c55e';
  if (s >= 45) return '#f59e0b';
  return '#ef4444';
}
function healthColor(h) {
  if (h >= 75) return '#22c55e';
  if (h >= 50) return '#f59e0b';
  return '#f87171';
}
function rateColor(r) {
  if (r >= 0.18) return '#22c55e';
  if (r >= 0.12) return '#f59e0b';
  return '#ef4444';
}
function divergenceColor(d) {
  if (d < 30) return '#22c55e';
  if (d < 60) return '#f59e0b';
  return '#f87171';
}
function topNColor(topN, optimalRange) {
  const [min, max] = optimalRange ?? [15, 20];
  if (topN >= min && topN <= max) return '#22c55e';
  if (topN < min) return '#60a5fa';
  return '#f59e0b';
}
function weightBarWidth(w) {
  return Math.max(0, Math.min(100, ((w - 0.5) / 1.5) * 100));
}
function optimalTopNRange(name) {
  const m = STRATEGY_META[name];
  return m ? `${m.optimalTopN[0]}–${m.optimalTopN[1]}` : '15–20';
}

// ─── Sparkline ───────────────────────────────────────────────────
function sparkY(v) {
  return sparkH - ((v - 0) / (0.40 - 0)) * sparkH;
}
function sparkPoints(history) {
  if (!history.length) return '';
  const all = history.slice(-12);
  return all.map((v, i) => {
    const x = (i / Math.max(all.length - 1, 1)) * sparkW;
    return `${x.toFixed(1)},${sparkY(v).toFixed(1)}`;
  }).join(' ');
}
function sparkProjectionPoints(history, proj) {
  if (!history.length || !proj.length) return '';
  const all = history.slice(-12);
  const lastIdx = all.length - 1;
  const lastX = (lastIdx / Math.max(all.length - 1, 1)) * sparkW;
  const lastY = sparkY(all[lastIdx]);
  const pts = [`${lastX.toFixed(1)},${lastY.toFixed(1)}`];
  const step = (sparkW - lastX) / (proj.length + 1);
  proj.forEach((v, i) => pts.push(`${(lastX + step * (i + 1)).toFixed(1)},${sparkY(v).toFixed(1)}`));
  return pts.join(' ');
}

// ─── Toggle strategy in main chart ──────────────────────────────
function toggleStrategy(name) {
  const h = new Set(hiddenStrategies.value);
  if (h.has(name)) h.delete(name);
  else h.add(name);
  hiddenStrategies.value = h;
  updateMainChart();
}

// ─── Chart.js ───────────────────────────────────────────────────
function buildChartData() {
  const visible = strategies.value.filter(s =>
    !hiddenStrategies.value.has(s.name) && (s.hit_rate_display?.length > 0 || s.timeline?.length > 0)
  );
  const maxLen = Math.max(...visible.map(s => (s.hit_rate_display?.length ?? 0) + 3), 5);

  const datasets = visible.map(s => {
    const hist = s.hit_rate_display ?? [];
    const proj = s.projection?.values ?? [];
    const full = [...hist.map(v => +(v * 100).toFixed(1)), ...proj.map(v => +(v * 100).toFixed(1))];
    while (full.length < maxLen) full.unshift(null);
    return {
      label:           s.label,
      data:            full,
      borderColor:     s.color,
      backgroundColor: s.color + '15',
      borderWidth:     s.isApex ? 2.5 : 1.5,
      tension:         0.4,
      pointRadius:     full.map((_, i) => i >= maxLen - proj.length - 1 ? 4 : 0),
      pointBackgroundColor: s.color,
      fill:            s.isApex,
      segment: {
        borderDash: (ctx) => ctx.p0DataIndex >= maxLen - proj.length - 1 ? [5, 4] : undefined,
      },
    };
  });

  datasets.push({
    label:       'Baseline Random',
    data:        Array(maxLen).fill(+(RANDOM_BASELINE * 100).toFixed(1)),
    borderColor: '#ef444460',
    borderWidth: 1,
    borderDash:  [4, 4],
    pointRadius: 0,
    fill:        false,
    tension:     0,
  });

  const projLen = visible[0]?.projection?.values?.length ?? 0;
  const labels = Array.from({ length: maxLen }, (_, i) => {
    const projStart = maxLen - projLen - 1;
    return i >= projStart ? `→S+${i - projStart + 1}` : `E${i + 1}`;
  });

  return { labels, datasets };
}

async function buildMainChart() {
  await nextTick();
  if (!mainChartRef.value) return;
  if (chartInstance) { chartInstance.destroy(); chartInstance = null; }
  const ctx = mainChartRef.value.getContext('2d');
  chartInstance = new Chart(ctx, {
    type: 'line',
    data: buildChartData(),
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      animation: { duration: 400 },
      plugins: {
        legend: { display: true, labels: { color: '#94a3b8', boxWidth: 12, font: { size: 11 } } },
        tooltip: {
          backgroundColor: '#0f1623ee',
          borderColor: '#1e2d40',
          borderWidth: 1,
          titleColor: '#e2e8f0',
          bodyColor: '#94a3b8',
          callbacks: { label: ctx => `${ctx.dataset.label}: ${ctx.parsed.y?.toFixed(1) ?? '—'}%` },
        },
      },
      scales: {
        x: { grid: { color: '#1e2d40' }, ticks: { color: '#64748b', font: { size: 10 }, maxTicksLimit: 12 } },
        y: {
          min: 0, max: 45,
          grid: { color: '#1e2d40' },
          ticks: { color: '#64748b', font: { size: 10 }, callback: v => v + '%' },
        },
      },
    },
  });
}

function updateMainChart() {
  if (!chartInstance) return;
  const { labels, datasets } = buildChartData();
  chartInstance.data.labels   = labels;
  chartInstance.data.datasets = datasets;
  chartInstance.update('active');
}

onMounted(async () => {
  await fetch();
  buildMainChart();
});

watch(strategies, () => {
  if (chartInstance) updateMainChart();
  else buildMainChart();
});

onUnmounted(() => chartInstance?.destroy());
</script>

<style scoped>
/* ── Layout ────────────────────────────────────────────────────── */
.tracking-view { max-width: 1400px; margin: 0 auto; color: #e2e8f0; }

/* ── Header ─────────────────────────────────────────────────────── */
.tracking-header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 1.5rem; gap: 1rem; flex-wrap: wrap; }
.tracking-title { font-size: 1.5rem; font-weight: 700; color: #f1f5f9; margin: 0 0 0.25rem; }
.tracking-subtitle { color: #64748b; font-size: 0.85rem; margin: 0; }
.tracking-header__controls { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }

.ctrl-select {
  background: #0f1623; border: 1px solid #1e2d40; color: #e2e8f0;
  padding: 0.4rem 0.6rem; border-radius: 6px; font-size: 0.8rem;
}
.btn-refresh {
  background: #1e2d40; border: 1px solid #334155; color: #e2e8f0;
  padding: 0.4rem 0.75rem; border-radius: 6px; font-size: 0.8rem; cursor: pointer;
  display: flex; align-items: center; gap: 0.35rem; transition: background 0.15s;
}
.btn-refresh:hover { background: #253447; }

.toggle-wrap { display: flex; align-items: center; gap: 0.4rem; cursor: pointer; }
.toggle-input { display: none; }
.toggle-track {
  width: 34px; height: 18px; background: #1e2d40; border-radius: 9px;
  position: relative; transition: background 0.2s;
}
.toggle-input:checked + .toggle-track { background: #3b82f6; }
.toggle-thumb {
  position: absolute; top: 2px; left: 2px;
  width: 14px; height: 14px; background: #94a3b8; border-radius: 50%; transition: transform 0.2s;
}
.toggle-input:checked + .toggle-track .toggle-thumb { transform: translateX(16px); background: #fff; }
.toggle-label { font-size: 0.8rem; color: #94a3b8; }

/* ── Section ─────────────────────────────────────────────────────── */
.section { margin-bottom: 2rem; }
.section-title { font-size: 0.85rem; font-weight: 600; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; }
.section-title-row { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }

/* ── State ─────────────────────────────────────────────────────── */
.state-msg { display: flex; align-items: center; gap: 0.75rem; color: #64748b; padding: 3rem; justify-content: center; }
.state-msg--error { color: #f87171; }
.spinner { width: 18px; height: 18px; border: 2px solid #1e2d40; border-top-color: #3b82f6; border-radius: 50%; animation: spin 0.7s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.spin { display: inline-block; animation: spin 0.7s linear infinite; }
.link-btn { background: none; border: none; color: #60a5fa; cursor: pointer; text-decoration: underline; font-size: inherit; }

/* ── Hero strip ─────────────────────────────────────────────────── */
.hero-strip { display: flex; gap: 1rem; margin-bottom: 2rem; flex-wrap: wrap; }

.hero-card {
  flex: 1; min-width: 280px;
  background: linear-gradient(135deg, #0f1623, #111c2e);
  border: 1px solid var(--accent, #3b82f6);
  border-radius: 14px; padding: 1.25rem;
  display: flex; flex-direction: column; gap: 0.75rem;
  box-shadow: 0 0 20px color-mix(in srgb, var(--accent, #3b82f6) 10%, transparent);
}
.hero-card__badge { font-size: 0.68rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.08em; }
.hero-card__main { display: flex; align-items: center; gap: 0.75rem; }
.hero-icon { font-size: 1.75rem; }
.hero-name { font-size: 1.15rem; font-weight: 700; color: #f1f5f9; }
.hero-rate { font-size: 2.5rem; font-weight: 800; letter-spacing: -0.02em; }
.hero-stats { display: flex; gap: 1.5rem; }
.hero-stat { display: flex; flex-direction: column; }
.hs-val { font-size: 0.95rem; font-weight: 700; color: #e2e8f0; }
.hs-lbl { font-size: 0.65rem; color: #475569; text-transform: uppercase; letter-spacing: 0.05em; }
.hero-projection { display: flex; align-items: center; gap: 0.5rem; flex-wrap: wrap; }
.proj-lbl { font-size: 0.7rem; color: #475569; }

.apex-card {
  width: 200px; background: linear-gradient(135deg, #0f1623, #1a1505);
  border: 1px solid #92400e55; border-radius: 14px; padding: 1.25rem;
  display: flex; flex-direction: column; gap: 0.5rem;
}
.apex-card__label { font-size: 0.75rem; font-weight: 700; color: #92400e; }
.apex-rate { font-size: 2rem; font-weight: 800; letter-spacing: -0.02em; }
.apex-meta { font-size: 0.7rem; color: #475569; }
.apex-projection { display: flex; flex-wrap: wrap; gap: 0.3rem; }
.health-bar-bg { height: 4px; background: #1e2d40; border-radius: 2px; overflow: hidden; }
.health-bar-fill { height: 100%; border-radius: 2px; transition: width 0.5s; }
.health-val { font-size: 0.65rem; color: #475569; }

.proj-pill {
  font-size: 0.68rem; padding: 0.15rem 0.45rem; border-radius: 4px;
  font-weight: 700; font-family: monospace;
}
.proj-pill--up   { background: #052e1633; color: #22c55e; }
.proj-pill--dn   { background: #450a0a33; color: #f87171; }
.proj-pill--gold { background: #451a0333; color: #f59e0b; }

/* ── Collective Intelligence ─────────────────────────────────────── */
.ci-section { margin-bottom: 2rem; }
.ci-ts { font-size: 0.72rem; color: #334155; }
.ci-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 0.75rem; margin-bottom: 1.25rem; }
.ci-card {
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 10px;
  padding: 1rem; display: flex; flex-direction: column; gap: 0.25rem;
}
.ci-card__val { font-size: 1.4rem; font-weight: 800; }
.ci-card__lbl { font-size: 0.72rem; font-weight: 600; color: #94a3b8; }
.ci-card__sub { font-size: 0.65rem; color: #475569; }

.ci-weight-dist { background: #0a1120; border: 1px solid #1e2d40; border-radius: 10px; padding: 1rem; }
.ci-weight-title { font-size: 0.72rem; color: #64748b; text-transform: uppercase; letter-spacing: 0.06em; margin-bottom: 0.75rem; }
.ci-weight-rows { display: flex; flex-direction: column; gap: 0.4rem; }
.ci-wr { display: grid; grid-template-columns: 20px 120px 1fr 60px 40px 40px; align-items: center; gap: 0.5rem; }
.ci-wr-icon { font-size: 0.9rem; }
.ci-wr-name { font-size: 0.75rem; color: #94a3b8; white-space: nowrap; }
.ci-wr-bar-wrap { position: relative; height: 6px; background: #1e2d40; border-radius: 3px; overflow: visible; }
.ci-wr-bar { height: 100%; border-radius: 3px; transition: width 0.4s; }
.ci-wr-neutral { position: absolute; top: -3px; bottom: -3px; width: 2px; background: #475569; border-radius: 1px; }
.ci-wr-val { font-size: 0.72rem; font-weight: 700; text-align: right; }
.ci-wr-topn { font-size: 0.65rem; color: #475569; }
.ci-wr-health { font-size: 0.65rem; font-weight: 600; }
.ci-weight-legend { font-size: 0.65rem; color: #334155; margin-top: 0.5rem; text-align: center; }

/* ── Ranking table ─────────────────────────────────────────────── */
.ranking-table { background: #0a1120; border: 1px solid #1e2d40; border-radius: 10px; overflow: hidden; }
.ranking-row {
  display: grid;
  grid-template-columns: 40px 1fr 140px 120px 60px 65px 110px 70px;
  gap: 0; padding: 0.5rem 0.75rem; align-items: center;
  border-bottom: 1px solid #0f1623; cursor: pointer; transition: background 0.15s;
}
.ranking-row:hover { background: #111c2e; }
.ranking-row--header {
  background: #0a1120; font-size: 0.65rem; color: #475569;
  text-transform: uppercase; letter-spacing: 0.06em; cursor: default;
  border-bottom: 1px solid #1e2d40;
}
.ranking-row--apex { background: linear-gradient(90deg, #1a120033, transparent); }
.ranking-row--top3 { border-left: 2px solid var(--row-color, #3b82f6); }
.ranking-row--header:hover { background: #0a1120; }

.rank-num { font-size: 0.85rem; }
.rank-n { font-size: 0.7rem; color: #475569; }
.rank-name { display: flex; align-items: center; gap: 0.4rem; font-size: 0.8rem; }
.rank-icon { font-size: 1rem; }
.rank-cat { font-size: 0.6rem; padding: 0.1rem 0.35rem; border-radius: 3px; }
.rank-rate { display: flex; align-items: center; gap: 0.4rem; }
.rate-bar-wrap { width: 60px; height: 4px; background: #1e2d40; border-radius: 2px; overflow: hidden; }
.rate-bar { height: 100%; border-radius: 2px; }
.rate-val { font-size: 0.78rem; font-weight: 700; width: 46px; }
.rank-vel { font-size: 0.7rem; font-weight: 600; }
.rank-topn { }
.topn-badge { font-size: 0.7rem; font-weight: 700; padding: 0.1rem 0.4rem; border-radius: 4px; }
.topn-badge--good { background: #052e1633; color: #22c55e; }
.topn-badge--warn { background: #451a0333; color: #f59e0b; }
.topn-badge--poor { background: #450a0a33; color: #f87171; }
.rank-weight { font-size: 0.78rem; font-weight: 700; }
.rank-signal { display: flex; align-items: center; gap: 0.4rem; }
.signal-bar-wrap { width: 50px; height: 4px; background: #1e2d40; border-radius: 2px; overflow: hidden; }
.signal-bar { height: 100%; border-radius: 2px; }
.signal-val { font-size: 0.72rem; color: #94a3b8; }
.rank-health { display: flex; align-items: center; gap: 0.35rem; font-size: 0.72rem; }
.health-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.ranking-hint { font-size: 0.65rem; color: #334155; margin-top: 0.4rem; padding-left: 0.25rem; }

/* ── Chart ─────────────────────────────────────────────────────── */
.chart-wrap { height: 260px; margin-bottom: 0.75rem; }
.main-chart { width: 100% !important; height: 100% !important; }
.chart-legend { display: flex; gap: 1rem; font-size: 0.7rem; color: #475569; }
.chart-toggles { display: flex; flex-wrap: wrap; gap: 0.4rem; margin-top: 0.75rem; }
.chart-toggle {
  font-size: 0.7rem; padding: 0.2rem 0.55rem; border-radius: 5px;
  border: 1px solid var(--tc, #3b82f6); background: transparent;
  color: var(--tc, #3b82f6); cursor: pointer; transition: all 0.15s;
}
.chart-toggle--off { opacity: 0.3; text-decoration: line-through; }
.btn-expand-all {
  font-size: 0.72rem; background: #1e2d40; border: 1px solid #334155;
  color: #94a3b8; padding: 0.3rem 0.65rem; border-radius: 6px; cursor: pointer;
}

/* ── Strategy cards ─────────────────────────────────────────────── */
.strat-cards-list { display: flex; flex-direction: column; gap: 0.75rem; }

.strat-card {
  background: #0a1120;
  border: 1px solid #1e2d40;
  border-radius: 12px;
  overflow: hidden;
  transition: border-color 0.2s;
}
.strat-card--apex  { border-color: #92400e44; }
.strat-card--top   { border-left: 3px solid var(--sc, #3b82f6); }
.strat-card--expanded { border-color: var(--sc, #3b82f6); }

/* Card header */
.sc-head {
  display: flex; justify-content: space-between; align-items: center;
  padding: 0.9rem 1rem; cursor: pointer; user-select: none;
  transition: background 0.15s;
}
.sc-head:hover { background: #111c2e; }
.sc-head-left  { display: flex; align-items: center; gap: 0.6rem; }
.sc-head-right { display: flex; align-items: center; gap: 1rem; }
.sc-icon  { font-size: 1.25rem; }
.sc-name  { font-size: 0.9rem; font-weight: 700; color: #e2e8f0; }
.sc-cat   { font-size: 0.6rem; padding: 0.1rem 0.4rem; border-radius: 3px; margin-left: 0.4rem; }
.sc-rank-badge { font-size: 0.9rem; }
.sc-rank-badge--apex { font-size: 0.6rem; font-weight: 700; background: #92400e55; color: #f59e0b; padding: 0.1rem 0.35rem; border-radius: 3px; }
.sc-rate-big { font-size: 1.3rem; font-weight: 800; }
.sc-trend, .sc-vel { font-size: 0.72rem; font-weight: 700; }
.sc-expand-icon { font-size: 0.65rem; color: #475569; }

/* Summary row */
.sc-summary { display: grid; grid-template-columns: 100px 1fr 1fr; gap: 0.75rem; padding: 0 1rem 0.9rem; align-items: start; }
.sc-sparkline-wrap { }
.sparkline-svg { width: 100%; height: 36px; display: block; }
.sc-base-metrics { display: flex; gap: 1rem; flex-wrap: wrap; align-items: center; }
.sc-bm { display: flex; flex-direction: column; gap: 0.1rem; }
.sc-bm-val { font-size: 0.82rem; font-weight: 700; color: #e2e8f0; }
.sc-bm-lbl { font-size: 0.6rem; color: #475569; text-transform: uppercase; }
.sc-timeline-strip { }
.sc-dots { display: flex; flex-wrap: wrap; gap: 2px; }
.sc-dot { width: 7px; height: 7px; border-radius: 50%; }
.sc-dot--hit  { background: #22c55e; }
.sc-dot--miss { background: #f87171; opacity: 0.5; }
.sc-streak-row { display: flex; justify-content: space-between; margin-top: 0.35rem; font-size: 0.65rem; }
.sc-streak { font-weight: 700; }
.streak--hit  { color: #22c55e; }
.streak--miss { color: #f87171; }
.sc-recent-rate { font-weight: 700; }

/* ── Brain panel ──────────────────────────────────────────────── */
.sc-brain { border-top: 1px solid #1e2d40; padding: 1rem; display: flex; flex-direction: column; gap: 1rem; }
.brain-section { }
.brain-header {
  font-size: 0.72rem; font-weight: 700; color: #64748b;
  text-transform: uppercase; letter-spacing: 0.06em;
  margin-bottom: 0.65rem; padding-bottom: 0.35rem;
  border-bottom: 1px solid #1e2d4066;
}
.brain-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0.5rem; }
.brain-item {
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 8px;
  padding: 0.65rem; display: flex; flex-direction: column; gap: 0.3rem;
}
.brain-item--green { border-color: #052e1655; background: #052e1622; }
.brain-item--red   { border-color: #450a0a55; background: #450a0a22; }
.brain-item--blue  { border-color: #1e3a5f55; background: #1e3a5f22; }
.brain-item__label { font-size: 0.6rem; font-weight: 700; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
.brain-item__val   { font-size: 0.78rem; color: #cbd5e1; line-height: 1.4; }
.brain-item__val--mono { font-family: monospace; font-size: 0.72rem; color: #93c5fd; }

/* Adaptive state bars */
.adaptive-state { display: flex; flex-direction: column; gap: 0.65rem; }
.as-row { display: grid; grid-template-columns: 100px 1fr 140px; align-items: center; gap: 0.5rem; }
.as-label { font-size: 0.72rem; color: #64748b; }
.as-bar-wrap { position: relative; height: 8px; background: #1e2d40; border-radius: 4px; overflow: visible; }
.as-bar { height: 100%; border-radius: 4px; transition: width 0.5s; }
.as-neutral-mark { position: absolute; top: -3px; bottom: -3px; width: 2px; background: #475569; border-radius: 1px; }
.as-opt-range { position: absolute; top: 0; bottom: 0; background: #22c55e22; border-radius: 4px; }
.as-val { font-size: 0.75rem; font-weight: 700; color: #e2e8f0; }
.as-opt { font-size: 0.65rem; color: #475569; font-weight: 400; }
.as-hit-rate-hist { margin-top: 0.5rem; }
.as-hist-label { font-size: 0.65rem; color: #475569; display: block; margin-bottom: 0.35rem; }
.as-hist-bars { display: flex; align-items: flex-end; gap: 3px; height: 42px; }
.as-hist-bar { min-width: 8px; border-radius: 2px 2px 0 0; flex: 1; transition: height 0.4s; }
.as-hist-axis { display: flex; justify-content: space-between; font-size: 0.6rem; color: #475569; margin-top: 0.2rem; }

/* Streak analysis */
.streak-analysis { display: flex; gap: 0.5rem; flex-wrap: wrap; }
.sa-card {
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 8px;
  padding: 0.6rem 0.85rem; display: flex; flex-direction: column; gap: 0.2rem; min-width: 90px;
}
.sa-card--hit  { border-color: #052e1655; }
.sa-card--miss { border-color: #450a0a55; }
.sa-val    { font-size: 1.1rem; font-weight: 800; color: #e2e8f0; }
.sa-val--sm { font-size: 0.75rem; }
.sa-lbl    { font-size: 0.6rem; color: #475569; text-transform: uppercase; }

/* Projection detail */
.proj-detail { display: flex; flex-direction: column; gap: 0.4rem; }
.pd-item { display: grid; grid-template-columns: 30px 1fr 60px 60px; align-items: center; gap: 0.5rem; }
.pd-label { font-size: 0.72rem; color: #64748b; font-weight: 700; }
.pd-bar-wrap { position: relative; height: 6px; background: #1e2d40; border-radius: 3px; overflow: visible; }
.pd-bar { height: 100%; border-radius: 3px; }
.pd-baseline { position: absolute; top: -2px; bottom: -2px; width: 2px; background: #ef444466; }
.pd-val { font-size: 0.72rem; font-weight: 700; }
.pd-val--up { color: #22c55e; }
.pd-val--dn { color: #f87171; }
.pd-bounds { font-size: 0.65rem; color: #475569; }

/* ── Precision metrics table ─────────────────────────────────────── */
.precision-table { background: #0a1120; border: 1px solid #1e2d40; border-radius: 10px; overflow: hidden; }
.pt-row {
  display: grid;
  grid-template-columns: 1.2fr 80px 80px 50px 70px 70px 60px 90px 70px;
  padding: 0.45rem 0.75rem; border-bottom: 1px solid #0f1623;
  font-size: 0.75rem; align-items: center;
}
.pt-row--header { font-size: 0.62rem; color: #475569; text-transform: uppercase; letter-spacing: 0.06em; border-bottom: 1px solid #1e2d40; }
.pt-name { display: flex; gap: 0.4rem; align-items: center; }
.pt-val  { font-weight: 700; }
.pt-topn { color: #94a3b8; }
.pt-w    { font-weight: 700; }
.pt-eval, .pt-hits { color: #64748b; }
.pt-dates { font-size: 0.65rem; color: #334155; font-family: monospace; }
.pt-signal { font-weight: 700; }

/* ── Learning loop diagram ─────────────────────────────────────── */
.learning-loop {
  display: flex; align-items: center; flex-wrap: wrap; gap: 0.25rem;
  background: #0a1120; border: 1px solid #1e2d40; border-radius: 12px; padding: 1.25rem;
}
.ll-step {
  flex: 1; min-width: 120px; max-width: 160px;
  background: #0f1623; border: 1px solid #1e2d40; border-radius: 8px;
  padding: 0.75rem; display: flex; flex-direction: column; gap: 0.35rem;
}
.ll-step--1 { border-color: #1e3a5f55; }
.ll-step--2 { border-color: #052e1655; }
.ll-step--3 { border-color: #451a0355; }
.ll-step--4 { border-color: #1e1a4655; }
.ll-step--5 { border-color: #450a0a55; }
.ll-icon  { font-size: 1.25rem; }
.ll-title { font-size: 0.72rem; font-weight: 700; color: #e2e8f0; }
.ll-desc  { font-size: 0.65rem; color: #64748b; line-height: 1.4; }
.ll-arrow { font-size: 1rem; color: #334155; flex-shrink: 0; }

/* ── Category badges ─────────────────────────────────────────────── */
.cat--momentum   { background: #451a0333; color: #f59e0b; }
.cat--reversal   { background: #450a0a33; color: #f87171; }
.cat--trend      { background: #1e3a5f33; color: #60a5fa; }
.cat--baseline   { background: #052e1633; color: #4ade80; }
.cat--structural { background: #1a2d1033; color: #a3e635; }
.cat--cyclic     { background: #1e1a4633; color: #818cf8; }
.cat--meta       { background: #2d1a0033; color: #fbbf24; }

/* ── Weight classes ─────────────────────────────────────────────── */
.weight--high { color: #22c55e; }
.weight--mid  { color: #94a3b8; }
.weight--low  { color: #f87171; }

/* ── Trend ─────────────────────────────────────────────────────── */
.trend--up { color: #22c55e; }
.trend--dn { color: #f87171; }
.trend--st { color: #f59e0b; }

/* ── Responsive ─────────────────────────────────────────────────── */
@media (max-width: 900px) {
  .ci-grid { grid-template-columns: 1fr 1fr; }
  .ranking-row { grid-template-columns: 30px 1fr 80px 80px 50px 55px; }
  .ranking-row > :nth-child(n+7) { display: none; }
  .brain-grid { grid-template-columns: 1fr; }
  .sc-summary { grid-template-columns: 80px 1fr; }
  .sc-summary > :nth-child(3) { grid-column: span 2; }
  .pt-row { grid-template-columns: 1fr 70px 60px 50px 80px; }
  .pt-row > :nth-child(n+6) { display: none; }
  .learning-loop { flex-direction: column; }
  .ll-step { max-width: 100%; }
  .ll-arrow { transform: rotate(90deg); }
}
</style>
