import { Ontology } from '@data-agent-ontology/ontology-core';
import { describe, expect, it } from 'vitest';

import { LocalOntologyClient } from './local.js';
import { describeClientContract, SEMANTICS, seededOntology, STRUCTURE } from './testing.js';

function client(): LocalOntologyClient {
  return new LocalOntologyClient(seededOntology());
}

describeClientContract('local', () => Promise.resolve({ client: client() }));

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

describe('cache', () => {
  it('serves checks from a snapshot that follows the active version', async () => {
    const ontology = new Ontology();
    ontology.submitScope(STRUCTURE);
    const local = new LocalOntologyClient(ontology);
    expect((await local.checkSql('SELECT 1 FROM orders')).versionId).toBe('v1');
    ontology.revise(SEMANTICS);
    expect((await local.checkSql('SELECT 1 FROM orders')).versionId).toBe('v2');
  });
});
