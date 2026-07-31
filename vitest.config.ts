import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['src/**/*.ts'],
      exclude: [
        'dist/**',
        'examples/**',
        '**/*.test.ts',
        '**/vitest.config.ts',
      ],
      // Coverage thresholds — CI will fail when the codebase regresses below
      // these numbers. Bump upwards as coverage improves; do not lower them
      // without a very good reason.
      thresholds: {
        statements: 70,
        branches: 65,
        functions: 70,
        lines: 70,
      },
    },
  },
});
