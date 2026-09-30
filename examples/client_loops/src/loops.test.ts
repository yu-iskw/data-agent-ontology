import { describe, expect, it } from 'vitest';

import { curateFromUsage } from './curate-loop.js';
import { shopClient } from './fixture.js';
import { useOntology } from './use-loop.js';

const QUESTION = 'order amount by customer';
const GOOD_SQL =
  'SELECT amount FROM proj.sales.orders o JOIN proj.sales.customers c ON o.customer_id = c.customer_id';
const UNKNOWN_SQL = 'SELECT o.ghost FROM proj.sales.orders o';
const WRONG_JOIN =
  'SELECT amount FROM proj.sales.orders o JOIN proj.sales.customers c ON o.amount = c.name';

describe('use loop', () => {
  it('puts the matching terms in context and flags a bad statement', async () => {
    const client = shopClient();
    const { context, check } = await useOntology(client, QUESTION, GOOD_SQL);
    expect(context.versionId).toBe('v2');
    expect(context.termIds).toEqual(expect.arrayContaining(['order', 'customer']));
    expect(context.text).toContain('places');
    expect(check.issues).toEqual([]);

    const unknown = await useOntology(client, QUESTION, UNKNOWN_SQL);
    expect(unknown.check.issues.map((issue) => issue.code)).toContain('unknown_column');

    const mismatch = await useOntology(client, QUESTION, WRONG_JOIN);
    expect(mismatch.check.issues.map((issue) => issue.code)).toContain('join_mismatch');
  });

  it('adds no context when the question matches nothing', async () => {
    const { context } = await useOntology(shopClient(), 'satellite orbits', 'SELECT 1');
    expect(context.text).toBe('');
    expect(context.termIds).toEqual([]);
  });
});

describe('propose and curate loop', () => {
  it('accepts a learned relation and a note into the ontology', async () => {
    const client = shopClient();
    const before = (await client.snapshot()).relations.map((relation) => relation.name);
    expect(before).not.toContain('refunded_by');

    const { relation, note } = await curateFromUsage(client);
    expect(relation).toMatchObject({ status: 'accepted', kind: 'relation' });
    expect(note).toMatchObject({ status: 'accepted', kind: 'constraint' });

    const snapshot = await client.snapshot();
    expect(snapshot.relations.map((row) => row.name)).toContain('refunded_by');
    expect(snapshot.constraints.map((row) => row.text)).toContain('Exclude cancelled orders.');
    expect(await client.listProposals('open')).toEqual([]);
  });
});
