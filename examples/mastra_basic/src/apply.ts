import { RevisionError } from '@data-agent-ontology/ontology-core';

import { toRevisePatch } from './proposal.js';

import type { Proposal } from './proposal.js';
import type { Actor, Ontology } from '@data-agent-ontology/ontology-core';

export const EXTRACTION_ACTOR: Actor = { id: 'mastra-basic-extractor' };

/** Applies a proposal as one revise. Returns the problems to show the agent, or none on success. */
export function applyProposal(ontology: Ontology, proposal: Proposal): string[] {
  const { patch, problems } = toRevisePatch(proposal, ontology.snapshot());
  if (problems.length > 0) {
    return problems;
  }
  try {
    ontology.revise(patch, { actor: EXTRACTION_ACTOR });
    return [];
  } catch (error) {
    if (error instanceof RevisionError) {
      return error.problems;
    }
    throw error;
  }
}
