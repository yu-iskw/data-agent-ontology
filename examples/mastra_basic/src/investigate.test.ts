import { Ontology } from '@data-agent-ontology/ontology-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { applyProposal } from './apply.js';
import { investigateWarehouse } from './investigate.js';
import { observeWarehouse } from './observe.js';
import { Warehouse } from './warehouse.js';

import type { Proposal } from './proposal.js';
import type { OntologySnapshot } from '@data-agent-ontology/ontology-core';

describe('investigateWarehouse', () => {
  let warehouse: Warehouse;
  let proposal: Proposal;
  let problems: string[];
  let snapshot: OntologySnapshot;

  beforeAll(async () => {
    warehouse = await Warehouse.open();
    proposal = await investigateWarehouse(warehouse);
    const ontology = new Ontology();
    ontology.submitScope(await observeWarehouse(warehouse));
    problems = applyProposal(ontology, proposal);
    snapshot = ontology.snapshot();
  }, 30_000);

  afterAll(() => {
    warehouse.close();
  });

  it('proposes domains, terms, and relations from the warehouse', () => {
    expect(proposal.domains.map((domain) => [domain.domainId, domain.parentDomainId])).toEqual([
      ['jaffle_shop', null],
      ['calendar', 'jaffle_shop'],
      ['catalog', 'jaffle_shop'],
      ['customers', 'jaffle_shop'],
      ['locations', 'jaffle_shop'],
      ['orders', 'jaffle_shop'],
    ]);
    expect(proposal.domains.find((domain) => domain.domainId === 'orders')?.tables).toEqual([
      'main.order_items',
      'main.orders',
    ]);
    expect(
      proposal.terms.map((term) => [term.termId, term.domainId, term.primaryKey, term.foreignKeys]),
    ).toEqual([
      ['calendar_day', 'calendar', ['date_day'], []],
      ['customer', 'customers', ['customer_id'], []],
      ['location', 'locations', ['location_id'], []],
      ['order', 'orders', ['order_id'], ['location_id', 'customer_id']],
      ['order_item', 'orders', ['order_item_id'], ['order_id', 'product_id']],
      ['product', 'catalog', ['product_id'], []],
      ['supply', 'catalog', ['supply_uuid'], ['product_id']],
    ]);
    expect(
      proposal.relations.map((relation) => [relation.name, relation.fromTermId, relation.toTermId]),
    ).toEqual([
      ['contains', 'order', 'order_item'],
      ['for_product', 'order_item', 'product'],
      ['occurs_on', 'order', 'calendar_day'],
      ['occurs_on', 'order_item', 'calendar_day'],
      ['placed_at', 'order', 'location'],
      ['places', 'customer', 'order'],
      ['used_by', 'supply', 'product'],
    ]);
    expect(
      proposal.relations
        .filter((relation) => relation.name === 'occurs_on')
        .map((relation) => relation.join),
    ).toEqual([
      'CAST(main.orders.ordered_at AS DATE) = main.metricflow_time_spine.date_day',
      'CAST(main.order_items.ordered_at AS DATE) = main.metricflow_time_spine.date_day',
    ]);
  });

  it('revises the observed catalog into an active ontology', () => {
    expect(problems).toEqual([]);
    expect(snapshot.terms).toHaveLength(7);
    expect(snapshot.relations).toHaveLength(7);
    expect(snapshot.evidence.every((item) => item.source === 'revise')).toBe(true);
    expect(snapshot.tables.find((table) => table.path === 'raw.raw_orders')?.domainIds).toEqual([]);
    expect(snapshot.tables.find((table) => table.path === 'main.stg_orders')?.domainIds).toEqual(
      [],
    );
  });
});
