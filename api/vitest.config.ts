import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    // Integration tests share one PostgreSQL database, so files run one at a time.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: {
      NODE_ENV: 'test',
      PBKDF2_ITERATIONS: '1000',
      AUTH_RATE_LIMIT_PER_MINUTE: '1000',
    },
    coverage: {
      provider: 'v8',
      include: ['src/domain/**', 'src/services/**', 'src/security/**'],
      reporter: ['text-summary', 'lcov'],
      // NFR-18: at least 70% of application and domain layer code is covered.
      thresholds: { lines: 70, functions: 70, statements: 70, branches: 60 },
    },
  },
});
