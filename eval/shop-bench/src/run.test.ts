import { describe, expect, it } from 'vitest';

import { runBench } from './arms.js';
import { expectedScores, passed } from './score.js';
import { AFTER, BEFORE } from './tasks.js';

describe('shop bench', () => {
  it('gives the learning arm later facts the static fixture does not have, with no poison', async () => {
    const report = await runBench();
    expect(report).toEqual({
      empty: [...expectedScores(BEFORE, false), ...expectedScores(AFTER, false)],
      static: [...expectedScores(BEFORE, true), ...expectedScores(AFTER, false)],
      learning: [...expectedScores(BEFORE, true), ...expectedScores(AFTER, true)],
      dependentTraces: 1,
      poison: [],
    });
    expect(passed(report)).toBe(true);
  });
});
