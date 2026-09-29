import { columnIdOf, tableIdOf } from '@data-agent-ontology/ontology-core';
import { z } from 'zod';

import type {
  Engine,
  MappingInput,
  MappingRole,
  OntologySnapshot,
  RevisePatch,
} from '@data-agent-ontology/ontology-core';

const evidence = z.string().describe('The SQL check or observation that supports this record.');

/** What the agent returns. The extract process turns it into one `revise` patch. */
export const proposalSchema = z.object({
  domains: z.array(
    z.object({
      domainId: z.string().describe('snake_case id'),
      name: z.string(),
      parentDomainId: z.string().nullable(),
      tables: z.array(z.string()).describe('schema.table paths that belong to this domain'),
    }),
  ),
  terms: z.array(
    z.object({
      termId: z.string().describe('snake_case id, also used as the term name'),
      domainId: z.string(),
      table: z.string().describe('schema.table whose grain this term names'),
      definition: z.string(),
      primaryKey: z.array(z.string()).describe('column names of the table that form its key'),
      foreignKeys: z.array(z.string()).describe('column names that reference another term key'),
      evidence,
    }),
  ),
  relations: z.array(
    z.object({
      name: z.string().describe('snake_case verb phrase read from fromTermId to toTermId'),
      fromTermId: z.string(),
      toTermId: z.string(),
      fromColumn: z.string().describe('schema.table.column on the fromTermId table'),
      toColumn: z.string().describe('schema.table.column on the toTermId table'),
      join: z.string().describe('SQL join condition using schema.table.column references'),
      evidence,
    }),
  ),
  constraints: z.array(
    z.object({
      termId: z.string(),
      text: z.string().describe('A rule an analyst must follow to get correct results'),
      evidence,
    }),
  ),
});

export type Proposal = z.infer<typeof proposalSchema>;

interface PatchResult {
  patch: RevisePatch;
  problems: string[];
}

function splitColumn(reference: string): { table: string; column: string } {
  const cut = reference.lastIndexOf('.');
  return { table: reference.slice(0, cut), column: reference.slice(cut + 1) };
}

function roleOf(name: string, primaryKey: string[], foreignKeys: string[]): MappingRole {
  if (primaryKey.includes(name)) {
    return 'primary_key';
  }
  return foreignKeys.includes(name) ? 'foreign_key' : 'attribute';
}

function termMappings(
  term: Proposal['terms'][number],
  snapshot: OntologySnapshot,
  engine: Engine,
  problems: string[],
): MappingInput[] {
  const tableId = tableIdOf(engine, term.table);
  const columns = snapshot.columns.filter((column) => column.tableId === tableId);
  if (columns.length === 0) {
    problems.push(`Term ${term.termId} names table ${term.table}, which has no observed columns`);
  }
  const tableName = term.table.slice(term.table.lastIndexOf('.') + 1);
  if (term.termId === tableName && tableName.endsWith('s')) {
    problems.push(
      `Term ${term.termId} reuses the plural table name; use the singular noun for one row`,
    );
  }
  const names = new Set(columns.map((column) => column.name));
  for (const key of [...term.primaryKey, ...term.foreignKeys].filter((k) => !names.has(k))) {
    problems.push(`Term ${term.termId} key column ${key} is not a column of ${term.table}`);
  }
  return columns.map((column) => ({
    termId: term.termId,
    columnId: column.columnId,
    role: roleOf(column.name, term.primaryKey, term.foreignKeys),
    evidence: `Column ${term.table}.${column.name} belongs to term ${term.termId}. ${term.evidence}`,
  }));
}

/**
 * Expands a proposal into a revise patch. A term maps every column of its grain table;
 * key roles come from the agent. Unknown paths are returned as problems for the agent to fix.
 */
export function toRevisePatch(
  proposal: Proposal,
  snapshot: OntologySnapshot,
  engine: Engine = 'duckdb',
): PatchResult {
  const problems: string[] = [];
  const membership = new Map<string, string[]>();
  for (const domain of proposal.domains) {
    for (const path of domain.tables) {
      membership.set(path, [...(membership.get(path) ?? []), domain.domainId]);
    }
  }
  const columnId = (reference: string): string => {
    const { table, column } = splitColumn(reference);
    return columnIdOf(tableIdOf(engine, table), column);
  };
  const patch: RevisePatch = {
    summary: 'Proposed by the Mastra ontology agent from read-only SQL over the warehouse.',
    domains: proposal.domains.map(({ domainId, name, parentDomainId }) => ({
      domainId,
      name,
      parentDomainId,
    })),
    memberships: [...membership].map(([path, domainIds]) => ({
      tableId: tableIdOf(engine, path),
      domainIds,
    })),
    terms: proposal.terms.map((term) => ({
      termId: term.termId,
      name: term.termId,
      domainId: term.domainId,
      definition: term.definition,
      evidence: term.evidence,
    })),
    mappings: proposal.terms.flatMap((term) => termMappings(term, snapshot, engine, problems)),
    relations: proposal.relations.map((relation) => ({
      name: relation.name,
      fromTermId: relation.fromTermId,
      toTermId: relation.toTermId,
      fromColumnId: columnId(relation.fromColumn),
      toColumnId: columnId(relation.toColumn),
      join: relation.join,
      evidence: relation.evidence,
    })),
    constraints: proposal.constraints.map(({ termId, text, evidence: summary }) => ({
      termId,
      text,
      evidence: summary,
    })),
  };
  return { patch, problems };
}
