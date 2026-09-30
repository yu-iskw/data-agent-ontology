import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { Ontology, OntologyStore } from '@data-agent-ontology/ontology-core';

interface OpenedOntology {
  client: LocalOntologyClient;
  close(): void;
}

/** One process owns the Ladybug file. Close the store on shutdown. */
export function openLocalOntology(file: string): OpenedOntology {
  const store = new OntologyStore(() => new Date(), file);
  const ontology = new Ontology(store);
  let closed = false;
  return {
    client: new LocalOntologyClient(ontology),
    close() {
      if (closed) {
        return;
      }
      closed = true;
      store.close();
    },
  };
}
