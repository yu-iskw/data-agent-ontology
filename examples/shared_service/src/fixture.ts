import { Ontology } from '@data-agent-ontology/ontology-core';

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
    { termId: 'customer', columnId: `${CUSTOMERS}.customer_id`, role: 'primary_key' },
  ],
};

/** One ontology both remote clients will share. The caller closes `store` when the server stops. */
export function shopOntology(): Ontology {
  const ontology = new Ontology();
  ontology.submitScope(STRUCTURE);
  ontology.revise(SEMANTICS);
  return ontology;
}
