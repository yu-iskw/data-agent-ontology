import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { Ontology } from '@data-agent-ontology/ontology-core';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { RevisePatch, Submission } from '@data-agent-ontology/ontology-core';

const ORDERS = 'bigquery:proj.sales.orders';
const CUSTOMERS = 'bigquery:proj.sales.customers';
const REFUNDS = 'bigquery:proj.sales.refunds';

const STRUCTURE: Submission = {
  scope: [{ engine: 'bigquery', path: 'proj.sales', completeness: 'full' }],
  tables: [
    { engine: 'bigquery', path: 'proj.sales.orders', kind: 'table' },
    { engine: 'bigquery', path: 'proj.sales.customers', kind: 'table' },
    { engine: 'bigquery', path: 'proj.sales.refunds', kind: 'table' },
  ],
  columns: [
    ['orders', 'order_id', 'INT64'],
    ['orders', 'customer_id', 'INT64'],
    ['orders', 'amount', 'NUMERIC'],
    ['customers', 'customer_id', 'INT64'],
    ['customers', 'name', 'STRING'],
    ['refunds', 'refund_id', 'INT64'],
    ['refunds', 'order_id', 'INT64'],
  ].map(([table, name, dataType], index) => ({
    engine: 'bigquery' as const,
    tablePath: `proj.sales.${table}`,
    name,
    dataType,
    ordinalPosition: index + 1,
  })),
};

/** Terms and one known join. The refund-to-order join is left for the curate loop to learn. */
const SEMANTICS: RevisePatch = {
  summary: 'fixture',
  domains: [
    { domainId: 'sales', name: 'Sales', parentDomainId: null },
    { domainId: 'crm', name: 'CRM', parentDomainId: null },
  ],
  memberships: [
    { tableId: ORDERS, domainIds: ['sales'] },
    { tableId: CUSTOMERS, domainIds: ['crm'] },
    { tableId: REFUNDS, domainIds: ['sales'] },
  ],
  terms: [
    { termId: 'order', name: 'order', domainId: 'sales', definition: 'One purchase.' },
    { termId: 'customer', name: 'customer', domainId: 'crm', definition: 'A buyer.' },
    { termId: 'refund', name: 'refund', domainId: 'sales', definition: 'Money returned.' },
  ],
  mappings: [
    { termId: 'order', columnId: `${ORDERS}.order_id`, role: 'primary_key' },
    { termId: 'order', columnId: `${ORDERS}.customer_id`, role: 'foreign_key' },
    { termId: 'order', columnId: `${ORDERS}.amount`, role: 'attribute' },
    { termId: 'customer', columnId: `${CUSTOMERS}.customer_id`, role: 'primary_key' },
    { termId: 'refund', columnId: `${REFUNDS}.refund_id`, role: 'primary_key' },
    { termId: 'refund', columnId: `${REFUNDS}.order_id`, role: 'foreign_key' },
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
};

/** A local client over a small shop ontology. Any other host uses the same `OntologyClient` methods. */
export function shopClient(): OntologyClient {
  const ontology = new Ontology();
  ontology.submitScope(STRUCTURE);
  ontology.revise(SEMANTICS);
  return new LocalOntologyClient(ontology);
}
