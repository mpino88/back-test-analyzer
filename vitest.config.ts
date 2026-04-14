// ═══════════════════════════════════════════════════════════════
// HITDASH — Vitest configuration
// Self-contained unit tests (no DB, no live server dependencies)
// ═══════════════════════════════════════════════════════════════
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/tests/**/*.test.ts'],
    reporters: ['verbose'],
    coverage: {
      reporter: ['text', 'lcov'],
      include: ['src/agent/**/*.ts'],
      exclude: ['src/agent/db/**', 'src/server/**'],
    },
  },
});
