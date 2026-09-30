import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@data-agent-ontology/example-client-loops',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
