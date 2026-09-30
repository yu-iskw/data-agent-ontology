import { columnIdOf } from '@data-agent-ontology/ontology-core';
import { describe, expect, it } from 'vitest';

import { shapeOfSql } from './check-sql.js';
import { LocalOntologyClient } from './local.js';
import { seededOntology } from './testing.js';

const ORDERS = 'bigquery:proj.sales.orders';
const CUSTOMERS = 'bigquery:proj.sales.customers';

function client(): LocalOntologyClient {
  return new LocalOntologyClient(seededOntology());
}

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

  it('matches join columns case-insensitively and keeps the stored column ids', async () => {
    const snapshot = seededOntology().snapshot();
    const matched =
      'SELECT c.name FROM sales.customers c JOIN sales.orders o ON c.CUSTOMER_ID = o.CUSTOMER_ID';
    const mismatched =
      'SELECT c.name FROM sales.customers c JOIN sales.orders o ON c.CUSTOMER_ID = o.ORDER_ID';
    expect(shapeOfSql(matched, snapshot).joins).toEqual([
      [columnIdOf(CUSTOMERS, 'customer_id'), columnIdOf(ORDERS, 'customer_id')],
    ]);
    expect(
      (await client().checkSql(matched)).issues.filter((issue) => issue.code === 'join_mismatch'),
    ).toEqual([]);
    expect(shapeOfSql(mismatched, snapshot).joins).toEqual([
      [columnIdOf(CUSTOMERS, 'customer_id'), columnIdOf(ORDERS, 'order_id')],
    ]);
    expect((await client().checkSql(mismatched)).issues.map((issue) => issue.code)).toContain(
      'join_mismatch',
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
