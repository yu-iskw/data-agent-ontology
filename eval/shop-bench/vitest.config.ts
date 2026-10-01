import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: '@data-agent-ontology/eval-shop-bench',
    include: ['src/**/*.{test,spec}.ts'],
    exclude: ['dist/**'],
  },
});
