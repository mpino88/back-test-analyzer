import { createApp } from 'vue';
import { createRouter, createWebHistory } from 'vue-router';
import App from './App.vue';
import './assets/styles/global.css';

// ─── Routes ──────────────────────────────────────────────────────
const router = createRouter({
  history: createWebHistory(),
  routes: [
    {
      path: '/',
      component: () => import('./views/AnalyzerView.vue'),
    },
    {
      path: '/agent',
      component: () => import('./views/agent/AgentLayout.vue'),
      children: [
        { path: '',                redirect: '/agent/dashboard' },
        { path: 'dashboard',       component: () => import('./views/agent/DashboardView.vue') },
        { path: 'rendimiento',     component: () => import('./views/agent/RendimientoView.vue') },
        { path: 'backtest',        component: () => import('./views/agent/BacktestView.vue') },
        { path: 'backtest-control',component: () => import('./views/agent/BacktestControlView.vue') },
        { path: 'momentum',        component: () => import('./views/agent/MomentumView.vue') },
        { path: 'tracking',        component: () => import('./views/agent/StrategyTrackingView.vue') },
        { path: 'ballbot-strategies', component: () => import('./views/agent/BallbotStrategiesView.vue') },
        { path: 'alerts',          component: () => import('./views/agent/AlertsView.vue') },
        { path: 'chat',            component: () => import('./views/agent/ChatView.vue') },
        { path: 'strategies',  component: () => import('./views/agent/StrategiesView.vue') },
        { path: 'progressive', component: () => import('./views/agent/ProgressiveView.vue') },
        // Rutas legadas — redirect a equivalente activo
        { path: 'cartones',    redirect: '/agent/rendimiento' },
        { path: 'accuracy',    redirect: '/agent/rendimiento' },
      ],
    },
  ],
});

const app = createApp(App);

// ─── Router error handler ────────────────────────────────────────
// Si un chunk de un componente falla al cargar (404 por deploy nuevo →
// hash de archivo cambió → browser cachó el index.html viejo), recarga
// la página UNA vez para forzar index.html fresco.
router.onError((err, to) => {
  const isChunkLoadError =
    err instanceof Error &&
    (err.message.includes('Failed to fetch dynamically imported module') ||
     err.message.includes('Importing a module script failed') ||
     err.message.includes('Unable to preload CSS for') ||
     err.name === 'ChunkLoadError');

  if (isChunkLoadError) {
    // Marcar que ya intentamos recargar para evitar loop infinito
    const reloaded = sessionStorage.getItem('chunk_reload');
    if (!reloaded) {
      sessionStorage.setItem('chunk_reload', '1');
      window.location.assign(to.fullPath);
    } else {
      sessionStorage.removeItem('chunk_reload');
      console.error('[HELIX] Chunk load error tras recarga — ruta destino:', to.fullPath, err);
    }
  }
});

// ─── Vue global error handler ───────────────────────────────────
app.config.errorHandler = (err, instance, info) => {
  console.error('[HELIX] Vue error en componente:', info, err, instance);
};

app.use(router).mount('#app');
