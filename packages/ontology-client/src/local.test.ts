import { Ontology } from '@data-agent-ontology/ontology-core';
import { describe, expect, it } from 'vitest';

import { LocalOntologyClient } from './local.js';

import type { RevisePatch, Submission } from '@data-agent-ontology/ontology-core';

const ORDERS = 'bigquery:proj.sales.orders';
const CUSTOMERS = 'bigquery:proj.sales.customers';

const STRUCTURE: Submission = {
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

const SEMANTICS: RevisePatch = {
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

function client(): LocalOntologyClient {
  const ontology = new Ontology();
  ontology.submitScope(STRUCTURE);
  ontology.revise(SEMANTICS);
  return new LocalOntologyClient(ontology);
}

describe('contextFor', () => {
  it('formats the resolved slice with its version', async () => {
    const context = await client().contextFor('total order amount per customer');
    expect(context.versionId).toBe('v2');
    expect(context.termIds).toEqual(['order', 'customer']);
    expect(context.text).toContain('- order [sales]: One purchase.');
    expect(context.text).toContain('column proj.sales.orders.customer_id INT64 (fk)');
    expect(context.text).toContain('relation customer places order: customers.customer_id');
    expect(context.text).toContain('constraint Exclude cancelled orders.');
  });

  it('injects nothing when no term matches', async () => {
    const context = await client().contextFor('weather in paris');
    expect(context).toEqual({ versionId: 'v2', text: '', termIds: [] });
  });
});

describe('checkSql', () => {
  const join =
    'SELECT c.name FROM sales.customers c JOIN sales.orders o ON c.customer_id = o.customer_id';

  it('accepts a statement that matches the ontology', async () => {
    const { issues } = await client().checkSql(
      'SELECT o.amount FROM proj.sales.orders o WHERE o.order_id > 1',
    );
    expect(issues.filter((issue) => issue.severity !== 'note')).toEqual([]);
  });

  it('rejects an unknown table with the nearest name', async () => {
    const { issues } = await client().checkSql('SELECT * FROM orderz');
    expect(issues).toEqual([
      {
        code: 'unknown_table',
        severity: 'error',
        message: 'Table orderz is not in the ontology; did you mean orders?',
      },
    ]);
  });

  it('rejects an unknown column on an aliased table', async () => {
    const { issues } = await client().checkSql('SELECT o.ammount FROM proj.sales.orders AS o');
    expect(issues.map((issue) => issue.message)).toEqual([
      'Column ammount is not on proj.sales.orders; did you mean amount?',
      'order: Exclude cancelled orders.',
    ]);
  });

  it('accepts the known join and warns on a different one', async () => {
    expect((await client().checkSql(join)).issues.map((issue) => issue.code)).toEqual([
      'constraint',
    ]);
    const wrong = join.replace('o.customer_id', 'o.order_id');
    const { issues } = await client().checkSql(wrong);
    expect(issues.find((issue) => issue.code === 'join_mismatch')?.message).toContain(
      'customers.customer_id = orders.customer_id',
    );
  });

  it('ignores names inside comments and strings, CTEs, and system schemas', async () => {
    const { issues } = await client().checkSql(
      `WITH recent AS (SELECT 1 AS x) -- from ghosts
       SELECT 'from ghosts' FROM recent, information_schema.tables`,
    );
    expect(issues).toEqual([]);
  });
});
