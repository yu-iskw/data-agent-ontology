import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { Actor, Proposal } from '@data-agent-ontology/ontology-core';

const ANALYST: Actor = { id: 'analyst-agent', onBehalfOf: 'analyst' };
const CURATOR: Actor = { id: 'curator' };

/** A join the fixture does not yet record. Replayed often enough, it becomes a relation proposal. */
const LEARNED_JOIN =
  'SELECT amount FROM proj.sales.refunds r JOIN proj.sales.orders o ON r.order_id = o.order_id';

interface CurateLoopResult {
  relation: Proposal;
  note: Proposal;
}

/**
 * What analysis leaves behind. Repeated successful joins become a relation proposal, an explicit
 * note becomes a constraint proposal, and a curator accepts both. Nothing is written into the
 * ontology until accept.
 */
export async function curateFromUsage(client: OntologyClient): Promise<CurateLoopResult> {
  for (const sessionId of ['session-a', 'session-a', 'session-b']) {
    await client.recordSql({
      sql: LEARNED_JOIN,
      sessionId,
      actor: ANALYST,
      question: 'refund totals',
      outcome: 'ok',
    });
  }
  const proposals = await client.proposeRelations();
  if (proposals.length === 0) {
    throw new Error('The replayed join did not become a proposal');
  }
  const relation = proposals[0];
  const note = await client.note({
    termId: 'order',
    statement: 'Exclude cancelled orders.',
    evidenceSql: LEARNED_JOIN,
    sessionId: 'session-a',
    actor: ANALYST,
  });
  return {
    relation: await client.acceptProposal(relation.proposalId, CURATOR, { name: 'refunded_by' }),
    note: await client.acceptProposal(note.proposalId, CURATOR),
  };
}
