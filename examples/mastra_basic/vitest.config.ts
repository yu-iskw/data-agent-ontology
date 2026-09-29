import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@data-agent-ontology/example-mastra-basic',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**', 'out/**'],
  },
});
