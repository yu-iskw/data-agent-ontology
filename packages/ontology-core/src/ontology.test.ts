import { describe, expect, it } from 'vitest';

import { Ontology } from './ontology.js';
import { ResolveLimitError } from './read.js';
import { RevisionError } from './revise.js';
import { OntologyStore, UnknownVersionError } from './store.js';
import { ScopeViolationError } from './submit.js';

import type { Completeness, RevisePatch, Submission, TableObservation } from './model.js';
import type { StoreJson } from './store.js';

const SCOPE = 'proj.sales';
const ORDERS = 'bigquery:proj.sales.orders';
const CUSTOMERS = 'bigquery:proj.sales.customers';

function table(path: string): TableObservation {
  return { engine: 'bigquery', path: `${SCOPE}.${path}`, kind: 'table' };
}

function submission(
  completeness: Completeness,
  columns: Record<string, string[]>,
  extra: Partial<Submission> = {},
): Submission {
  return {
    scope: [{ engine: 'bigquery', path: SCOPE, completeness }],
    tables: Object.keys(columns).map(table),
    columns: Object.entries(columns).flatMap(([path, names]) =>
      names.map((name, index) => ({
        engine: 'bigquery' as const,
        tablePath: `${SCOPE}.${path}`,
        name,
        dataType: 'STRING',
        ordinalPosition: index + 1,
      })),
    ),
    ...extra,
  };
}

const FULL = { orders: ['order_id', 'customer_id', 'amount'], customers: ['customer_id', 'name'] };

const SEMANTICS: RevisePatch = {
  summary: 'Defined by an analyst',
  domains: [
    { domainId: 'shop', name: 'Shop', parentDomainId: null },
    { domainId: 'sales', name: 'Sales', parentDomainId: 'shop' },
    { domainId: 'crm', name: 'CRM', parentDomainId: 'shop' },
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

function seeded(): Ontology {
  const ontology = new Ontology();
  ontology.submitScope(submission('full', FULL));
  ontology.revise(SEMANTICS);
  return ontology;
}

describe('submitScope', () => {
  it('rejects objects outside the declared scope and commits nothing', () => {
    const ontology = seeded();
    const before = ontology.store.listVersions().length;
    const outside = submission('partial', {}, { tables: [table('orders')] });
    outside.tables.push({ engine: 'bigquery', path: 'proj.other.orders', kind: 'table' });
    expect(() => ontology.submitScope(outside)).toThrow(ScopeViolationError);
    expect(ontology.store.listVersions()).toHaveLength(before);
    expect(ontology.store.get('tables', 'bigquery:proj.other.orders')).toBeUndefined();
  });

  it('leaves objects missing from a partial scope unchanged', () => {
    const ontology = seeded();
    ontology.submitScope(submission('partial', { orders: ['order_id'] }));
    expect(ontology.store.get('tables', CUSTOMERS)?.active).toBe(true);
    expect(ontology.store.get('columns', `${ORDERS}.amount`)?.active).toBe(true);
  });

  it('inactivates tables and columns missing from a full scope', () => {
    const ontology = seeded();
    ontology.submitScope(submission('full', { orders: ['order_id', 'customer_id'] }));
    expect(ontology.store.get('tables', CUSTOMERS)?.active).toBe(false);
    expect(ontology.store.get('columns', `${CUSTOMERS}.name`)?.active).toBe(false);
    expect(ontology.store.get('columns', `${ORDERS}.amount`)?.active).toBe(false);
    expect(ontology.store.get('columns', `${ORDERS}.order_id`)?.active).toBe(true);
  });

  it('inactivates an explicitly removed unpinned object', () => {
    const ontology = new Ontology();
    ontology.submitScope(submission('full', FULL));
    ontology.submitScope(
      submission('partial', {}, { removed: [{ engine: 'bigquery', path: `${SCOPE}.customers` }] }),
    );
    expect(ontology.store.get('tables', CUSTOMERS)).toMatchObject({
      active: false,
      drifted: false,
    });
  });

  it('cannot overwrite human-maintained semantic fields', () => {
    const ontology = seeded();
    const agentView = submission('full', FULL);
    agentView.tables = agentView.tables.map((t) => ({ ...t, domainIds: [] }));
    ontology.submitScope(agentView);
    expect(ontology.store.get('tables', ORDERS)?.domainIds).toEqual(['sales']);
    expect(ontology.store.get('terms', 'order')?.definition).toBe('One purchase.');
  });

  it('keeps a human mapping whose column disappeared, drifted and out of resolve', () => {
    const ontology = seeded();
    ontology.submitScope(
      submission('full', { orders: ['order_id', 'customer_id'], customers: FULL.customers }),
    );
    expect(ontology.store.get('mappings', 'order.amount')).toMatchObject({
      active: false,
      drifted: true,
    });
    const resolved = ontology.resolve(['order']);
    expect(resolved.mappings.map((m) => m.mappingId)).toEqual(['order.order_id']);
    expect(ontology.snapshot().mappings.map((m) => m.mappingId)).not.toContain('order.amount');
  });

  it('treats a rename as a new identity and inactivates the old one', () => {
    const ontology = seeded();
    ontology.submitScope(submission('full', { orders_v2: FULL.orders, customers: FULL.customers }));
    expect(ontology.store.get('tables', ORDERS)).toMatchObject({ active: false, drifted: true });
    expect(ontology.store.get('tables', `${ORDERS}_v2`)).toMatchObject({
      active: true,
      domainIds: [],
    });
  });

  it('shares unchanged record revisions between versions', () => {
    const ontology = seeded();
    const before = ontology.store.activeVersion?.versionId;
    const after = ontology.submitScope(submission('partial', { orders: ['order_id'] })).versionId;
    const revision = (id: string): string | undefined =>
      ontology.store.revisionIdOf('columns', `${ORDERS}.order_id`, id);
    expect(revision(after)).toBe(revision(before ?? ''));
    expect(ontology.store.revisionIdOf('terms', 'order', after)).toBe(
      ontology.store.revisionIdOf('terms', 'order', before),
    );
  });
});

describe('revise', () => {
  it('rejects a mapping onto a table outside the term domain', () => {
    const ontology = seeded();
    const patch: RevisePatch = {
      summary: 'bad mapping',
      mappings: [{ termId: 'order', columnId: `${CUSTOMERS}.name`, role: 'attribute' }],
    };
    expect(() => ontology.revise(patch)).toThrow(RevisionError);
    expect(ontology.store.get('mappings', 'order.name')).toBeUndefined();
  });

  it('allows relations across domains and records revise evidence', () => {
    const ontology = seeded();
    const snapshot = ontology.snapshot();
    expect(snapshot.relations.map((r) => r.relationId)).toEqual(['customer_places_order']);
    const sources = new Set(snapshot.evidence.map((e) => e.source));
    expect(sources).toEqual(new Set(['revise']));
    expect(snapshot.evidence.map((e) => e.targetId)).toContain('customer_places_order');
  });
});

describe('reads', () => {
  it('routes a question to a short list of domains and terms', () => {
    const hits = seeded().browse('How many orders did each customer place?').hits;
    expect(hits.length).toBeLessThanOrEqual(6);
    expect(hits.map((hit) => hit.id)).toEqual(expect.arrayContaining(['order', 'customer']));
  });

  it('limits resolve to five terms', () => {
    expect(() => seeded().resolve(['a', 'b', 'c', 'd', 'e', 'f'])).toThrow(ResolveLimitError);
  });

  it('omits a drifted relation from resolve', () => {
    const ontology = seeded();
    ontology.submitScope(
      submission('full', { orders: ['order_id', 'amount'], customers: FULL.customers }),
    );
    expect(ontology.resolve(['customer', 'order']).relations).toEqual([]);
  });
});

describe('rollback', () => {
  it('restores the previous visible ontology without creating a version', () => {
    const ontology = seeded();
    const good = ontology.store.activeVersion?.versionId ?? '';
    const expected = ontology.snapshot();
    ontology.submitScope(submission('full', { orders: ['order_id'] }));
    const count = ontology.store.listVersions().length;
    ontology.rollback(good);
    expect(ontology.snapshot()).toEqual(expected);
    expect(ontology.store.listVersions()).toHaveLength(count);
  });

  it('rejects an unknown version', () => {
    expect(() => seeded().rollback('v999')).toThrow(UnknownVersionError);
  });
});

describe('JSON store', () => {
  it('restores versions, shared revisions, and the active pointer', () => {
    const ontology = seeded();
    ontology.submitScope(submission('partial', { orders: ['order_id'] }));
    ontology.rollback('v2');
    const json = JSON.parse(JSON.stringify(ontology.store.toJSON())) as StoreJson;
    const restored = new Ontology(OntologyStore.fromJSON(json));
    expect(restored.snapshot()).toEqual(ontology.snapshot());
    expect(restored.store.listVersions()).toEqual(ontology.store.listVersions());
    expect(restored.store.revisionIdOf('terms', 'order', 'v3')).toBe(
      restored.store.revisionIdOf('terms', 'order', 'v2'),
    );
    expect(json.revisions.length).toBeLessThan(
      json.versions.reduce((sum, v) => sum + v.revisionIds.length, 0),
    );
    const next = restored.revise({
      ...SEMANTICS,
      constraints: [{ termId: 'order', text: 'New.' }],
    });
    expect(next).toMatchObject({ versionId: 'v4', parentVersionId: 'v2' });
    expect(restored.store.revisionIdOf('constraints', 'order:new', 'v4')).not.toBe(
      restored.store.revisionIdOf('terms', 'order', 'v2'),
    );
  });

  it('rejects an unknown format', () => {
    const json: StoreJson = { ...seeded().store.toJSON(), format: 'other' };
    expect(() => OntologyStore.fromJSON(json)).toThrow('Unsupported store format');
  });
});
