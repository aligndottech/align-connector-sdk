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
      // Ratchet floor - raise as Phase 2 fetchers + CommandParser/TelemetryClient
      // tests land. Set safely below current so CI gates without flaking.
      thresholds: {
        statements: 30,
        branches: 18,
        functions: 40,
        lines: 30,
      },
    },
  },
});
