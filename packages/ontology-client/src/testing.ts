import { Ontology } from '@data-agent-ontology/ontology-core';
import { describe, expect, it } from 'vitest';

import type { OntologyClient } from './client.js';
import type { RevisePatch, Submission } from '@data-agent-ontology/ontology-core';

export const ORDERS = 'bigquery:proj.sales.orders';
export const CUSTOMERS = 'bigquery:proj.sales.customers';

export const STRUCTURE: Submission = {
  scope: [{ engine: 'bigquery', path: 'proj.sales', completeness: 'full' }],
  tables: [
    { engine: 'bigquery', path: 'proj.sales.orders', kind: 'table' },
    { engine: 'bigquery', path: 'proj.sales.customers', kind: 'table' },
  ],
  columns: [
    ['orders', 'order_id', 'INT64'],
    ['orders', 'customer_id', 'INT64'],
    ['orders', 'amount', 'NUMERIC'],
    ['customers', 'customer_id', 'INT64'],
    ['customers', 'name', 'STRING'],
  ].map(([table, name, dataType], index) => ({
    engine: 'bigquery' as const,
    tablePath: `proj.sales.${table}`,
    name,
    dataType,
    ordinalPosition: index + 1,
  })),
};

export const SEMANTICS: RevisePatch = {
  summary: 'fixture',
  domains: [
    { domainId: 'sales', name: 'Sales', parentDomainId: null },
    { domainId: 'crm', name: 'CRM', parentDomainId: null },
  ],
  memberships: [
    { tableId: ORDERS, domainIds: ['sales'] },
    { tableId: CUSTOMERS, domainIds: ['crm'] },
  ],
  terms: [
    { termId: 'order', name: 'order', domainId: 'sales', definition: 'One purchase.' },
    { termId: 'customer', name: 'customer', domainId: 'crm', definition: 'A buyer.' },
  ],
  mappings: [
    { termId: 'order', columnId: `${ORDERS}.order_id`, role: 'primary_key' },
    { termId: 'order', columnId: `${ORDERS}.customer_id`, role: 'foreign_key' },
    { termId: 'order', columnId: `${ORDERS}.amount`, role: 'attribute' },
    { termId: 'customer', columnId: `${CUSTOMERS}.customer_id`, role: 'primary_key' },
  ],
  relations: [
    {
      name: 'places',
      fromTermId: 'customer',
      toTermId: 'order',
      fromColumnId: `${CUSTOMERS}.customer_id`,
      toColumnId: `${ORDERS}.customer_id`,
      join: 'customers.customer_id = orders.customer_id',
    },
  ],
  constraints: [{ termId: 'order', text: 'Exclude cancelled orders.' }],
};

/** An ontology with the fixture structure and semantics, at version `v2`. */
export function seededOntology(): Ontology {
  const ontology = new Ontology();
  ontology.submitScope(STRUCTURE);
  ontology.revise(SEMANTICS);
  return ontology;
}

export interface ContractTarget {
  client: OntologyClient;
  close?: () => Promise<void> | void;
}

const ALICE = { id: 'agent-a', onBehalfOf: 'alice' };
const BOB = { id: 'agent-b', onBehalfOf: 'bob' };

function definition(termId: string, text: string): RevisePatch {
  const domainId = termId === 'order' ? 'sales' : 'crm';
  return { summary: text, terms: [{ termId, name: termId, domainId, definition: text }] };
}

const ALICE_TEXT = 'Alice: gross';

async function failureOf(action: Promise<unknown>): Promise<unknown> {
  return action.then(
    () => undefined,
    (error: unknown) => error,
  );
}

async function contextAndSql(client: OntologyClient): Promise<void> {
  const context = await client.contextFor('total order amount per customer');
  expect(context.versionId).toBe('v2');
  expect(context.text).toContain('relation customer places order');
  const { issues } = await client.checkSql('SELECT * FROM orderz');
  expect(issues.map((issue) => issue.code)).toEqual(['unknown_table']);
}

async function disjointMerge(client: OntologyClient): Promise<void> {
  await client.revise(definition('order', ALICE_TEXT), { baseVersionId: 'v2', actor: ALICE });
  const merged = await client.revise(definition('customer', 'Bob: a buyer'), {
    baseVersionId: 'v2',
    actor: BOB,
  });
  expect(merged).toMatchObject({ mergedFromVersionId: 'v2', actor: BOB });
  const versions = await client.listVersions();
  expect(versions.map((version) => version.actor)).toEqual([undefined, undefined, ALICE, BOB]);
  const snapshot = await client.snapshot();
  expect(snapshot.terms.map((term) => term.definition).sort()).toEqual([
    ALICE_TEXT,
    'Bob: a buyer',
  ]);
}

async function overlappingConflict(client: OntologyClient): Promise<void> {
  await client.revise(definition('order', ALICE_TEXT), { baseVersionId: 'v2' });
  const failure = await failureOf(
    client.revise(definition('order', 'Bob: net'), { baseVersionId: 'v2' }),
  );
  expect(failure).toMatchObject({ name: 'MergeConflictError' });
  expect(failure).toHaveProperty('conflicts.0.id', 'order');
  expect(await client.listVersions()).toHaveLength(3);
}

async function moveAndRevert(client: OntologyClient): Promise<void> {
  await client.revise(definition('order', ALICE_TEXT));
  const stale = await failureOf(client.rollback('v1', { expectedActive: 'v2' }));
  expect(stale).toMatchObject({ name: 'ActiveVersionChangedError' });
  const reverted = await client.revert('v3', { expectedActive: 'v3' });
  expect(reverted.reason).toBe('revert');
  const order = (await client.snapshot()).terms.find((term) => term.termId === 'order');
  expect(order?.definition).toBe('One purchase.');
}

async function rejectedRevision(client: OntologyClient): Promise<void> {
  const failure = await failureOf(
    client.revise({ summary: 'bad', constraints: [{ termId: 'missing', text: 'x' }] }),
  );
  expect(failure).toMatchObject({ name: 'RevisionError' });
  expect(failure).toHaveProperty('problems.0', 'Constraint targets unknown term missing');
}

const CASES: [string, (client: OntologyClient) => Promise<void>][] = [
  ['builds context and checks SQL against the active version', contextAndSql],
  ['records the actor and merges a disjoint write from an older base', disjointMerge],
  [
    'throws a merge conflict for an overlapping stale write and writes nothing',
    overlappingConflict,
  ],
  ['rejects a move from the wrong active version and reverts a change', moveAndRevert],
  ['reports a rejected revision with its problems', rejectedRevision],
];

/**
 * Behavior every `OntologyClient` must share, local or remote. `make` returns a client over a
 * fresh ontology seeded by `seededOntology()`.
 */
export function describeClientContract(name: string, make: () => Promise<ContractTarget>): void {
  describe(`${name} client contract`, () => {
    for (const [title, body] of CASES) {
      it(title, async () => {
        const target = await make();
        try {
          await body(target.client);
        } finally {
          await target.close?.();
        }
      });
    }
  });
}
