import { OntologyService, startServer } from '@data-agent-ontology/ontology-server';

import { shopOntology } from './fixture.js';

interface SharedHost {
  url: string;
  token: string;
  close(): Promise<void>;
}

/**
 * One process owns the database file and serves it over HTTP. Agent replicas use
 * `RemoteOntologyClient` and never open the file. Ladybug allows a single writer process.
 */
export async function startSharedOntology(token: string): Promise<SharedHost> {
  const ontology = shopOntology();
  const server = await startServer({
    service: new OntologyService(ontology),
    token,
  });
  return {
    url: server.url,
    token,
    close: async () => {
      await server.close();
      ontology.store.close();
    },
  };
}
