import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { MergeConflictError } from './merge.js';
import { Ontology, ProposalClosedError } from './ontology.js';
import { RevisionError } from './revise.js';
import { OntologyStore } from './store.js';

import type { ProposalDraft, RevisePatch, Submission, TraceInput } from './model.js';

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

function relationDraft(baseVersionId: string): ProposalDraft {
  return {
    kind: 'relation',
    key: `relation:${CUSTOMER_PK}|${ORDER_FK}`,
    patch: {
      summary: 'join',
      relations: [
        {
          name: 'places',
          fromTermId: 'customer',
          toTermId: 'order',
          fromColumnId: CUSTOMER_PK,
          toColumnId: ORDER_FK,
          join: 'proj.sales.customers.customer_id = proj.sales.orders.customer_id',
        },
      ],
    },
    baseVersionId,
    evidence: { summary: 'join', traceIds: ['t1'] },
    proposer: { id: 'agent' },
    sessions: ['s1'],
    users: ['agent'],
  };
}

function seeded(): Ontology {
  const ontology = new Ontology();
  ontology.submitScope(STRUCTURE);
  ontology.revise(TERMS);
  return ontology;
}

function revisionProblems(action: () => unknown): string[] {
  try {
    action();
  } catch (error) {
    if (error instanceof RevisionError) {
      return error.problems;
    }
    throw error;
  }
  throw new Error('Expected RevisionError');
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

  it('binds a column to its primary-key term when another term also maps it', () => {
    const ontology = seeded();
    ontology.revise({
      summary: 'buyer alias',
      terms: [{ termId: 'buyer', name: 'buyer', domainId: 'shop', definition: 'A buyer.' }],
      mappings: [{ termId: 'buyer', columnId: CUSTOMER_PK, role: 'attribute' }],
    });
    for (const session of ['s1', 's1', 's2']) {
      ontology.recordTrace(joinTrace(session));
    }
    const [proposal] = ontology.proposeRelations();
    expect(proposal.patch.relations?.[0]).toMatchObject({
      fromTermId: 'customer',
      toTermId: 'order',
      fromColumnId: CUSTOMER_PK,
      toColumnId: ORDER_FK,
    });
  });

  it('counts a repeated join in one statement as a single sighting', () => {
    const ontology = seeded();
    const duplicated = [ORDER_FK, CUSTOMER_PK] as [string, string];
    ontology.recordTrace(joinTrace('s1', { joins: [duplicated, duplicated] }));
    ontology.recordTrace(joinTrace('s2', { joins: [duplicated, duplicated] }));
    expect(ontology.proposeRelations()).toEqual([]);

    ontology.recordTrace(joinTrace('s3', { joins: [duplicated, [CUSTOMER_PK, ORDER_FK]] }));
    const [proposal] = ontology.proposeRelations();
    expect(proposal).toMatchObject({ support: 3, evidence: { traceIds: ['t1', 't2', 't3'] } });
  });

  it('does not collide when one term maps the same column name on two tables', () => {
    const ontology = seeded();
    ontology.revise({
      summary: 'customer on orders',
      mappings: [{ termId: 'customer', columnId: ORDER_FK, role: 'foreign_key' }],
    });
    const ids = ontology.store
      .list('mappings')
      .filter((mapping) => mapping.termId === 'customer')
      .map((mapping) => mapping.mappingId)
      .sort((a, b) => a.localeCompare(b));
    expect(ids).toEqual([`customer.${CUSTOMER_PK}`, `customer.${ORDER_FK}`].sort());
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

  it('leaves both contradictory constraint proposals open and writes nothing', () => {
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
    const versions = ontology.store.listVersions().length;
    expect(revisionProblems(() => ontology.acceptProposal(first.proposalId, CURATOR))).toEqual(
      expect.arrayContaining([expect.stringContaining('order')]),
    );
    expect(revisionProblems(() => ontology.acceptProposal(second.proposalId, CURATOR))).toEqual(
      expect.arrayContaining([expect.stringContaining('order')]),
    );
    expect(ontology.listProposals('open').map((proposal) => proposal.proposalId)).toEqual([
      first.proposalId,
      second.proposalId,
    ]);
    expect(ontology.snapshot().constraints).toEqual([]);
    expect(ontology.store.listVersions()).toHaveLength(versions);
  });

  it('still rejects an overlapping constraint revise from a stale base', () => {
    const ontology = seeded();
    const base = ontology.store.activeVersion?.versionId ?? '';
    const first = ontology.note({
      termId: 'order',
      statement: 'Exclude cancelled orders.',
      sessionId: 's1',
      actor: { id: 'agent-a' },
    });
    ontology.acceptProposal(first.proposalId, CURATOR);
    const second = ontology.propose({
      kind: 'constraint',
      key: 'constraint:order:include cancelled orders',
      patch: {
        summary: 'Include cancelled orders.',
        constraints: [{ termId: 'order', text: 'Include cancelled orders.' }],
      },
      baseVersionId: base,
      evidence: { summary: 'Include cancelled orders.', traceIds: [] },
      proposer: { id: 'agent-b' },
      sessions: ['s2'],
      users: ['agent-b'],
    });
    expect(() => ontology.acceptProposal(second.proposalId, CURATOR)).toThrow(MergeConflictError);
    expect(ontology.listProposals('open').map((proposal) => proposal.proposalId)).toEqual([
      second.proposalId,
    ]);
    expect(ontology.snapshot().constraints.map((constraint) => constraint.text)).toEqual([
      'Exclude cancelled orders.',
    ]);
  });

  it('rolls back the version when the accepted status cannot be stored', () => {
    let acceptTicks = 0;
    let armed = false;
    const store = new OntologyStore(() => {
      if (armed) {
        acceptTicks += 1;
        if (acceptTicks > 1) {
          throw new Error('clock failed after the version write');
        }
      }
      return new Date('2026-06-01T00:00:00.000Z');
    });
    const ontology = new Ontology(store);
    ontology.submitScope(STRUCTURE);
    ontology.revise(TERMS);
    const proposal = ontology.note({
      termId: 'order',
      statement: 'Exclude cancelled orders.',
      sessionId: 's1',
      actor: { id: 'agent' },
    });
    const versions = store.listVersions().length;
    armed = true;
    expect(() => ontology.acceptProposal(proposal.proposalId, CURATOR)).toThrow(
      'clock failed after the version write',
    );
    expect(ontology.listProposals('open').map((item) => item.proposalId)).toEqual([
      proposal.proposalId,
    ]);
    expect(ontology.snapshot().constraints).toEqual([]);
    expect(store.listVersions()).toHaveLength(versions);

    armed = false;
    const accepted = ontology.acceptProposal(proposal.proposalId, CURATOR);
    expect(accepted.status).toBe('accepted');
    expect(store.listVersions()).toHaveLength(versions + 1);
    expect(ontology.listProposals('open')).toEqual([]);
    expect(ontology.snapshot().constraints.map((constraint) => constraint.text)).toEqual([
      'Exclude cancelled orders.',
    ]);
  });

  it('leaves the proposal open when the term is missing', () => {
    const ontology = new Ontology();
    ontology.submitScope(STRUCTURE);
    const proposal = ontology.note({
      termId: 'missing',
      statement: 'Something.',
      sessionId: 's1',
      actor: { id: 'agent' },
    });
    const versions = ontology.store.listVersions().length;
    expect(revisionProblems(() => ontology.acceptProposal(proposal.proposalId, CURATOR))).toEqual([
      'Referenced term missing does not exist or is inactive',
    ]);
    expect(ontology.listProposals('open').map((item) => item.proposalId)).toEqual([
      proposal.proposalId,
    ]);
    expect(ontology.snapshot().constraints).toEqual([]);
    expect(ontology.store.listVersions()).toHaveLength(versions);
  });

  it('leaves the proposal open when a cited column is inactive', () => {
    const ontology = seeded();
    const proposal = ontology.propose(relationDraft(ontology.store.activeVersion?.versionId ?? ''));
    ontology.submitScope({
      ...STRUCTURE,
      columns: STRUCTURE.columns.filter(
        (column) => column.tablePath !== 'proj.sales.customers' || column.name !== 'customer_id',
      ),
    });
    expect(ontology.store.get('columns', CUSTOMER_PK)?.active).toBe(false);
    const versions = ontology.store.listVersions().length;
    expect(revisionProblems(() => ontology.acceptProposal(proposal.proposalId, CURATOR))).toEqual(
      expect.arrayContaining([`Referenced column ${CUSTOMER_PK} does not exist or is inactive`]),
    );
    expect(ontology.listProposals('open').map((item) => item.proposalId)).toEqual([
      proposal.proposalId,
    ]);
    expect(ontology.snapshot().relations).toEqual([]);
    expect(ontology.store.listVersions()).toHaveLength(versions);
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

  it('keeps trajectory evidence, including its trace ids, across reopening the file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ontology-evidence-')), 'ontology.lbdb');
    const store = new OntologyStore(() => new Date(), path);
    const ontology = new Ontology(store);
    ontology.submitScope(STRUCTURE);
    ontology.revise(TERMS);
    const proposal = ontology.note({
      termId: 'order',
      statement: 'Exclude tax.',
      sessionId: 's1',
      actor: { id: 'a' },
      traceIds: ['t9'],
    });
    ontology.acceptProposal(proposal.proposalId, CURATOR);
    store.close();

    const reopened = new Ontology(new OntologyStore(() => new Date(), path));
    expect(reopened.snapshot().evidence.filter((row) => row.source === 'trajectory')).toEqual([
      expect.objectContaining({
        targetId: 'order:exclude_tax',
        source: 'trajectory',
        traceIds: ['t9'],
      }),
    ]);
    reopened.store.close();
  });
});
