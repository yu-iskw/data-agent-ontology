import { RemoteOntologyClient } from '@data-agent-ontology/ontology-client';
import { MergeConflictError } from '@data-agent-ontology/ontology-core';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { Actor, RevisePatch } from '@data-agent-ontology/ontology-core';

const ALICE: Actor = { id: 'agent', onBehalfOf: 'alice' };
const BOB: Actor = { id: 'agent', onBehalfOf: 'bob' };

function definition(termId: string, text: string): RevisePatch {
  const domainId = termId === 'order' ? 'sales' : 'crm';
  return {
    summary: text,
    terms: [{ termId, name: termId, domainId, definition: text }],
  };
}

interface SharedEditResult {
  definitions: string[];
}

/**
 * Two users edit different terms from the same base version. The second write merges onto
 * the head, and both definitions stay.
 */
export async function disjointEdits(
  alice: OntologyClient,
  bob: OntologyClient,
): Promise<SharedEditResult> {
  const base = (await alice.snapshot()).version.versionId;
  await alice.revise(definition('order', 'Alice: one purchase, gross'), {
    baseVersionId: base,
    actor: ALICE,
  });
  await bob.revise(definition('customer', 'Bob: a person who buys'), {
    baseVersionId: base,
    actor: BOB,
  });
  const snapshot = await alice.snapshot();
  return { definitions: snapshot.terms.map((term) => term.definition) };
}

/**
 * Two users edit the same term from the same base. The second write conflicts and changes nothing.
 */
export async function overlappingEdits(
  alice: OntologyClient,
  bob: OntologyClient,
): Promise<MergeConflictError> {
  const base = (await alice.snapshot()).version.versionId;
  await alice.revise(definition('order', 'Alice: gross'), { baseVersionId: base, actor: ALICE });
  try {
    await bob.revise(definition('order', 'Bob: net of refunds'), {
      baseVersionId: base,
      actor: BOB,
    });
  } catch (error) {
    if (error instanceof MergeConflictError) {
      return error;
    }
    throw error;
  }
  throw new Error('The overlapping edit was accepted');
}

/** Two clients of one hosted ontology. They share the file only through the service. */
export function clientsFor(
  url: string,
  token: string,
): { alice: OntologyClient; bob: OntologyClient } {
  return {
    alice: new RemoteOntologyClient({ url, token }),
    bob: new RemoteOntologyClient({ url, token }),
  };
}
