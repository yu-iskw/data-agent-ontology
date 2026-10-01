import { describe, expect, it } from 'vitest';

import { formatContext } from './format.js';

import type { ResolveResult } from '@data-agent-ontology/ontology-core';

const LIVE = { active: true, drifted: false };

const RESULT: ResolveResult = {
  versionId: 'v3',
  terms: [
    { ...LIVE, termId: 'order', name: 'order', domainId: 'sales', definition: 'One purchase.' },
  ],
  mappings: [],
  tables: [],
  columns: [],
  relations: [
    {
      ...LIVE,
      relationId: 'rel-places',
      name: 'places',
      fromTermId: 'customer',
      toTermId: 'order',
      fromColumnId: 'customers.customer_id',
      toColumnId: 'orders.customer_id',
      join: 'customers.customer_id = orders.customer_id',
    },
  ],
  constraints: [
    { ...LIVE, constraintId: 'c-cancel', termId: 'order', text: 'Exclude cancelled orders.' },
    { ...LIVE, constraintId: 'c-bare', termId: 'order', text: 'Ship from the warehouse.' },
  ],
  evidence: [
    {
      evidenceId: 'evidence:rel-places',
      targetId: 'rel-places',
      source: 'revise',
      summary: 'fixture',
    },
    {
      evidenceId: 'evidence:c-cancel',
      targetId: 'c-cancel',
      source: 'trajectory',
      summary: 'Agent note, shown by: SELECT amount FROM orders',
    },
  ],
};

const EXPECTED = [
  'Known warehouse semantics (ontology version v3); verify with SQL before relying on them:',
  '- order [sales]: One purchase.',
  '  relation customer places order: customers.customer_id = orders.customer_id',
  '  evidence revise: fixture',
  '  constraint Exclude cancelled orders.',
  '  evidence trajectory: Agent note, shown by: SELECT amount FROM orders',
  '  constraint Ship from the warehouse.',
].join('\n');

describe('formatContext', () => {
  it('prints evidence for a relation and a constraint and skips a constraint with none', () => {
    expect(formatContext(RESULT)).toBe(EXPECTED);
  });

  it('returns an empty string when no term resolved', () => {
    expect(formatContext({ ...RESULT, terms: [] })).toBe('');
  });
});
