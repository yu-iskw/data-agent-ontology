import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MergeConflictError } from './merge.js';
import { Ontology, ProposalClosedError } from './ontology.js';
import { OntologyStore } from './store.js';

import type { RevisePatch, Submission, TraceInput } from './model.js';

const ORDERS = 'bigquery:proj.sales.orders';
const CUSTOMERS = 'bigquery:proj.sales.customers';
const ORDER_FK = `${ORDERS}.customer_id`;
const CUSTOMER_PK = `${CUSTOMERS}.customer_id`;
const CURATOR = { id: 'curator', onBehalfOf: 'yu' };

const STRUCTURE: Submission = {
  scope: [{ engine: 'bigquery', path: 'proj.sales', completeness: 'full' }],
  tables: [
    { engine: 'bigquery', path: 'proj.sales.orders', kind: 'table' },
    { engine: 'bigquery', path: 'proj.sales.customers', kind: 'table' },
  ],
  columns: [
    ['orders', 'order_id'],
    ['orders', 'customer_id'],
    ['customers', 'customer_id'],
  ].map(([table, name], index) => ({
    engine: 'bigquery' as const,
    tablePath: `proj.sales.${table}`,
    name,
    dataType: 'INT64',
    ordinalPosition: index + 1,
  })),
};

const TERMS: RevisePatch = {
  summary: 'terms only',
  domains: [{ domainId: 'shop', name: 'Shop', parentDomainId: null }],
  memberships: [
    { tableId: ORDERS, domainIds: ['shop'] },
    { tableId: CUSTOMERS, domainIds: ['shop'] },
  ],
  terms: [
    { termId: 'order', name: 'order', domainId: 'shop', definition: 'One purchase.' },
    { termId: 'customer', name: 'customer', domainId: 'shop', definition: 'A buyer.' },
  ],
  mappings: [
    { termId: 'order', columnId: `${ORDERS}.order_id`, role: 'primary_key' },
    { termId: 'order', columnId: ORDER_FK, role: 'foreign_key' },
    { termId: 'customer', columnId: CUSTOMER_PK, role: 'primary_key' },
  ],
};

function seeded(): Ontology {
  const ontology = new Ontology();
  ontology.submitScope(STRUCTURE);
  ontology.revise(TERMS);
  return ontology;
}

function joinTrace(session: string, overrides: Partial<TraceInput> = {}): TraceInput {
  return {
    sessionId: session,
    actor: { id: 'agent', onBehalfOf: `user-${session}` },
    versionId: 'v2',
    sql: 'SELECT 1 FROM orders o JOIN customers c ON o.customer_id = c.customer_id',
    outcome: 'ok',
    tableIds: [ORDERS, CUSTOMERS],
    joins: [[ORDER_FK, CUSTOMER_PK]],
    ...overrides,
  };
}

describe('deterministic relation proposer', () => {
  it('proposes nothing below the support and session thresholds', () => {
    const ontology = seeded();
    ontology.recordTrace(joinTrace('s1'));
    ontology.recordTrace(joinTrace('s1'));
    ontology.recordTrace(joinTrace('s1'));
    expect(ontology.proposeRelations()).toEqual([]);
    ontology.recordTrace(joinTrace('s2', { outcome: 'error', error: 'binder error' }));
    expect(ontology.proposeRelations()).toEqual([]);
  });

  it('proposes a parent-to-child relation once replays cross both thresholds', () => {
    const ontology = seeded();
    for (const session of ['s1', 's1', 's2']) {
      ontology.recordTrace(joinTrace(session));
    }
    const [proposal, ...rest] = ontology.proposeRelations();
    expect(rest).toEqual([]);
    expect(proposal).toMatchObject({
      proposalId: 'p1',
      kind: 'relation',
      status: 'open',
      support: 3,
      baseVersionId: 'v2',
      sessions: ['s1', 's2'],
      users: ['user-s1', 'user-s2'],
    });
    expect(proposal.patch.relations?.[0]).toMatchObject({
      fromTermId: 'customer',
      toTermId: 'order',
      fromColumnId: CUSTOMER_PK,
      toColumnId: ORDER_FK,
      join: 'proj.sales.customers.customer_id = proj.sales.orders.customer_id',
    });
    expect(proposal.evidence.traceIds).toEqual(['t1', 't2', 't3']);
  });

  it('raises support on a rerun instead of creating a second proposal', () => {
    const ontology = seeded();
    for (const session of ['s1', 's2', 's3']) {
      ontology.recordTrace(joinTrace(session));
    }
    ontology.proposeRelations();
    ontology.recordTrace(joinTrace('s4'));
    const [again] = ontology.proposeRelations();
    expect(again).toMatchObject({ proposalId: 'p1', support: 4 });
    expect(ontology.listProposals()).toHaveLength(1);
  });

  it('skips a join the ontology already holds as a relation', () => {
    const ontology = seeded();
    ontology.revise({
      summary: 'known',
      relations: [
        {
          name: 'places',
          fromTermId: 'customer',
          toTermId: 'order',
          fromColumnId: CUSTOMER_PK,
          toColumnId: ORDER_FK,
          join: 'customers.customer_id = orders.customer_id',
        },
      ],
    });
    for (const session of ['s1', 's2', 's3']) {
      ontology.recordTrace(joinTrace(session));
    }
    expect(ontology.proposeRelations()).toEqual([]);
  });
});

describe('accepting and rejecting', () => {
  function withProposal(): Ontology {
    const ontology = seeded();
    for (const session of ['s1', 's2', 's3']) {
      ontology.recordTrace(joinTrace(session));
    }
    ontology.proposeRelations();
    return ontology;
  }

  it('revises the patch with the curator, the proposal id, and the curator name', () => {
    const ontology = withProposal();
    const accepted = ontology.acceptProposal('p1', CURATOR, { name: 'places' });
    expect(accepted).toMatchObject({
      status: 'accepted',
      decidedBy: CURATOR,
      resolvedVersionId: 'v3',
    });
    expect(ontology.store.activeVersion).toMatchObject({
      reason: 'revise',
      actor: CURATOR,
      proposalId: 'p1',
    });
    expect(ontology.snapshot().relations).toMatchObject([
      { name: 'places', fromTermId: 'customer', toTermId: 'order' },
    ]);
    expect(() => ontology.acceptProposal('p1', CURATOR)).toThrow(ProposalClosedError);
  });

  it('keeps a rejected proposal so the proposer does not raise it again', () => {
    const ontology = withProposal();
    ontology.rejectProposal('p1', CURATOR);
    ontology.recordTrace(joinTrace('s4'));
    const [again] = ontology.proposeRelations();
    expect(again).toMatchObject({ proposalId: 'p1', status: 'rejected', support: 3 });
    expect(ontology.listProposals('open')).toEqual([]);
    expect(ontology.snapshot().relations).toEqual([]);
  });

  it('leaves the proposal open when a change since its base overlaps', () => {
    const ontology = seeded();
    const first = ontology.note({
      termId: 'order',
      statement: 'Exclude cancelled orders.',
      evidenceSql: 'SELECT status FROM orders',
      sessionId: 's1',
      actor: { id: 'agent-a' },
    });
    const second = ontology.note({
      termId: 'order',
      statement: 'Include cancelled orders.',
      sessionId: 's2',
      actor: { id: 'agent-b' },
    });
    ontology.acceptProposal(first.proposalId, CURATOR);
    expect(() => ontology.acceptProposal(second.proposalId, CURATOR)).toThrow(MergeConflictError);
    expect(ontology.listProposals('open').map((proposal) => proposal.proposalId)).toEqual([
      second.proposalId,
    ]);
    expect(ontology.snapshot().constraints.map((constraint) => constraint.text)).toEqual([
      'Exclude cancelled orders.',
    ]);
  });
});

describe('notes', () => {
  it('deduplicates the same statement and counts each sighting', () => {
    const ontology = seeded();
    const note = (session: string, statement: string) =>
      ontology.note({ termId: 'order', statement, sessionId: session, actor: { id: 'agent' } });
    note('s1', 'Exclude cancelled orders.');
    const again = note('s2', 'exclude cancelled orders');
    expect(again).toMatchObject({ proposalId: 'p1', support: 2, sessions: ['s1', 's2'] });
    expect(ontology.listProposals()).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('keeps traces and proposals across reopening the file, outside the versions', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ontology-work-')), 'ontology.lbdb');
    const store = new OntologyStore(undefined, path);
    const ontology = new Ontology(store);
    ontology.submitScope(STRUCTURE);
    ontology.revise(TERMS);
    ontology.recordTrace(joinTrace('s1'));
    ontology.note({
      termId: 'order',
      statement: 'Exclude tax.',
      sessionId: 's1',
      actor: { id: 'a' },
    });
    const versions = store.listVersions().length;
    store.close();

    const reopened = new Ontology(new OntologyStore(undefined, path));
    expect(reopened.listTraces()).toHaveLength(1);
    expect(reopened.listProposals()).toMatchObject([{ proposalId: 'p1', status: 'open' }]);
    expect(reopened.store.listVersions()).toHaveLength(versions);
    reopened.store.close();
  });
});
