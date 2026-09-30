import { Ontology, OntologyStore } from '@data-agent-ontology/ontology-core';

import { startServer } from './http.js';
import { OntologyService } from './service.js';

const DEFAULT_PORT = 8787;

/**
 * One process per database file: Ladybug allows a single read-write process, so agent
 * replicas must call this server instead of opening the file.
 */
async function main(): Promise<void> {
  const file = process.env.ONTOLOGY_FILE;
  const token = process.env.ONTOLOGY_TOKEN;
  if (!file || !token) {
    throw new Error(
      'Set ONTOLOGY_FILE (path of the .lbdb file) and ONTOLOGY_TOKEN (bearer secret)',
    );
  }
  const store = new OntologyStore(undefined, file);
  const server = await startServer({
    service: new OntologyService(new Ontology(store)),
    token,
    port: Number(process.env.PORT ?? DEFAULT_PORT),
    host: process.env.HOST ?? '127.0.0.1',
  });
  console.log(`ontology service on ${server.url}, database ${file}`);
  const stop = (): void => {
    void server.close().finally(() => {
      store.close();
      process.exit(0);
    });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
