import { defineConfig } from 'vitest/config';

// Conformance suite for the Proleptic chain service. Hits a live instance at
// PROLEPTIC_BASE_URL; skips cleanly when that env var is unset.
export default defineConfig({
  test: {
    include: ['tests/contract/**/*.test.ts'],
    testTimeout: 30000,
  },
});
