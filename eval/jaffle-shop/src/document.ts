import { z } from 'zod';

import { readText } from './files.js';

const lifecycle = { active: z.boolean(), drifted: z.boolean() };

/** The ontology JSON shape shared by the answer file and the example's artifact. */
export const ontologyDocumentSchema = z.object({
  domains: z.array(
    z.object({
      domainId: z.string(),
      name: z.string(),
      parentDomainId: z.string().nullable(),
      ...lifecycle,
    }),
  ),
  tables: z.array(
    z.object({
      tableId: z.string(),
      engine: z.string(),
      path: z.string(),
      kind: z.string(),
      domainIds: z.array(z.string()),
      ...lifecycle,
    }),
  ),
  columns: z.array(
    z.object({
      columnId: z.string(),
      tableId: z.string(),
      name: z.string(),
      dataType: z.string(),
      ordinalPosition: z.number(),
      ...lifecycle,
    }),
  ),
  terms: z.array(
    z.object({
      termId: z.string(),
      name: z.string(),
      domainId: z.string(),
      definition: z.string(),
      ...lifecycle,
    }),
  ),
  mappings: z.array(
    z.object({
      mappingId: z.string(),
      termId: z.string(),
      columnId: z.string(),
      role: z.string(),
      ...lifecycle,
    }),
  ),
  relations: z.array(
    z.object({
      relationId: z.string(),
      name: z.string(),
      fromTermId: z.string(),
      toTermId: z.string(),
      fromColumnId: z.string(),
      toColumnId: z.string(),
      join: z.string(),
      ...lifecycle,
    }),
  ),
  constraints: z.array(
    z.object({ constraintId: z.string(), termId: z.string(), text: z.string(), ...lifecycle }),
  ),
  evidence: z.array(
    z.object({
      evidenceId: z.string(),
      targetId: z.string(),
      source: z.string(),
      summary: z.string(),
    }),
  ),
});

export type OntologyDocument = z.infer<typeof ontologyDocumentSchema>;

export async function loadDocument(path: string): Promise<OntologyDocument> {
  const parsed: unknown = JSON.parse(await readText(path));
  return ontologyDocumentSchema.parse(parsed);
}
