import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@data-agent-ontology/ontology-mastra',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
