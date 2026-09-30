import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@data-agent-ontology/example-shared-service',
    include: ['src/**/*.{test,spec}.ts'],
  },
});
