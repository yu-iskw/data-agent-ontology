import type {
  OntologyClient,
  OntologyContext,
  SqlCheck,
} from '@data-agent-ontology/ontology-client';

interface UseLoopResult {
  context: OntologyContext;
  check: SqlCheck;
}

/**
 * What an analytics agent does with the ontology on one question: pull a small slice into
 * context, then check the SQL it is about to run. The check is advisory.
 */
export async function useOntology(
  client: OntologyClient,
  question: string,
  sql: string,
): Promise<UseLoopResult> {
  const context = await client.contextFor(question);
  const check = await client.checkSql(sql);
  return { context, check };
}
