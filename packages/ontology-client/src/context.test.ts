import { MAX_RESOLVE_TERMS } from '@data-agent-ontology/ontology-core';
import { describe, expect, it } from 'vitest';

import { contextFor } from './context.js';

import type { ResolveResult } from '@data-agent-ontology/ontology-core';

const EMPTY: Omit<ResolveResult, 'versionId'> = {
  terms: [],
  mappings: [],
  tables: [],
  columns: [],
  relations: [],
  constraints: [],
  evidence: [],
};

describe('contextFor', () => {
  it('slices term hits with the resolve limit and ignores other hit kinds', async () => {
    const hits = [
      { kind: 'domain' as const, id: 'sales', name: 'Sales', domainId: null, score: 2 },
      ...Array.from({ length: MAX_RESOLVE_TERMS + 2 }, (_, index) => ({
        kind: 'term' as const,
        id: `t${index}`,
        name: `t${index}`,
        domainId: 'sales',
        score: 1,
      })),
    ];
    let resolved: string[] = [];
    const context = await contextFor(
      {
        browse: () => Promise.resolve({ versionId: 'v1', hits }),
        resolve: (termIds) => {
          resolved = termIds;
          return Promise.resolve({ versionId: 'v9', ...EMPTY });
        },
      },
      'orders',
    );
    expect(resolved).toEqual(
      hits
        .filter((hit) => hit.kind === 'term')
        .slice(0, MAX_RESOLVE_TERMS)
        .map((hit) => hit.id),
    );
    expect(context).toEqual({ versionId: 'v9', text: '', termIds: resolved });
  });
});
