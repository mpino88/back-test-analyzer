import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { fileURLToPath, URL } from 'node:url'

const proxyConfig = {
  target: 'http://127.0.0.1:3001',
  changeOrigin: true,
  configure: (proxy) => {
    proxy.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') {
        // Silenciar ECONNREFUSED mientras el backend arranca (Fallo de inicio inofensivo)
        return;
      }
    });
  }
};

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': proxyConfig,
      '/events': proxyConfig,
      '/health': proxyConfig,
    },
  },
})
