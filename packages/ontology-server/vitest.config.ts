import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@data-agent-ontology/ontology-server',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
