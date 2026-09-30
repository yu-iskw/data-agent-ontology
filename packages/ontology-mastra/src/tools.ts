import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { Actor } from '@data-agent-ontology/ontology-core';

export const LOOKUP_TOOL = 'ontology_lookup';
export const NOTE_TOOL = 'ontology_note';

/** Browses and resolves in one call. Read-only. */
export function createLookupTool(client: OntologyClient) {
  return createTool({
    id: LOOKUP_TOOL,
    description:
      'Look up what the shared ontology knows about a question: matching terms, the tables and ' +
      'columns they map to, known joins, and rules for getting correct numbers. Returns an ' +
      'empty context when nothing matches.',
    inputSchema: z.object({ question: z.string().describe('The question or topic to look up.') }),
    execute: async ({ question }) => {
      const context = await client.contextFor(question);
      return { versionId: context.versionId, termIds: context.termIds, context: context.text };
    },
  });
}

/** Files what the agent learned as a proposal. A curator decides; nothing changes until then. */
export function createNoteTool(client: OntologyClient, actor: Actor, sessionId: () => string) {
  return createTool({
    id: NOTE_TOOL,
    description:
      'Record a rule you verified with SQL that an analyst needs for correct numbers, attached ' +
      'to an ontology term (use a term id from ontology_lookup). It is filed as a proposal for ' +
      'review and does not change the ontology by itself.',
    inputSchema: z.object({
      termId: z.string().describe('Id of the term the rule governs.'),
      statement: z.string().describe('The rule, in one sentence.'),
      evidence: z.string().describe('The SQL that shows the rule holds.'),
    }),
    execute: async ({ termId, statement, evidence }) => {
      const proposal = await client.note({
        termId,
        statement,
        evidenceSql: evidence,
        sessionId: sessionId(),
        actor,
      });
      return {
        proposalId: proposal.proposalId,
        status: proposal.status,
        support: proposal.support,
      };
    },
  });
}
