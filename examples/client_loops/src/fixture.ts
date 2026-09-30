import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { SEMANTICS, STRUCTURE } from '@data-agent-ontology/ontology-client/testing';
import { Ontology } from '@data-agent-ontology/ontology-core';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';

/** A local client over the shared shop fixture, without the constraint the curate loop adds. */
export function shopClient(): OntologyClient {
  const ontology = new Ontology();
  ontology.submitScope(STRUCTURE);
  ontology.revise({ ...SEMANTICS, constraints: [] });
  return new LocalOntologyClient(ontology);
}
