import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/__tests__/**', 'src/**/*.test.ts'],
      // Ratchet floor - set safely below current (~85% lines) so CI gates
      // without flaking. Raise further as Phase 2 fetchers land.
      thresholds: {
        statements: 80,
        branches: 72,
        functions: 70,
        lines: 80,
      },
    },
  },
});
