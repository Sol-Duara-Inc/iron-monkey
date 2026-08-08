import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    exclude: ['tests/integration/**', 'tests/contract/**'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        'src/cli/**',
        'src/index.ts',
        'src/config/types.ts',
        'src/expressions/types.ts',
        'src/manifest/types.ts',
        // Administrative adapter, not a pitching path: kafka.ts exists so IM
        // can clean up after itself during JB tests/demos (purge queues, reset
        // consumer-group offsets, status checks). Excluded from unit-coverage
        // goals by decision (2026-08-07); real-broker behavior belongs to an
        // integration harness if/when a Kafka-backed target appears. See the
        // note in tests/bus/interface.test.ts.
        'src/bus/kafka.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 75,
        branches: 75,
        statements: 80,
      },
    },
  },
});
