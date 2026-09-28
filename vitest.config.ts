import { defineConfig } from 'vitest/config';

const WORKSPACES = ['packages/*', 'examples/*', 'eval/*'];

export default defineConfig({
  test: {
    projects: WORKSPACES.map((workspace) => `${workspace}/vitest.config.ts`),
    coverage: {
      provider: 'v8',
      include: WORKSPACES.map((workspace) => `${workspace}/src/**/*.ts`),
      exclude: [
        '*/*/src/**/*.{test,spec}.ts',
        '*/*/src/**/*.d.ts',
        '*/*/dist/**',
        '**/*.config.{js,mjs,cjs,ts}',
      ],
      reporter: ['text', 'html', 'lcov', 'json-summary'],
      thresholds: {
        lines: 80,
        functions: 80,
        statements: 80,
        branches: 70,
      },
    },
  },
});
