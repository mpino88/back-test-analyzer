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

createApp(App).use(router).mount('#app');
