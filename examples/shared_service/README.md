# Shared ontology service

Several analytics agents, possibly for several users, read and amend one ontology. One process owns the Ladybug file and serves it over HTTP. Agents use `RemoteOntologyClient` and do not open the file.

```ts
const host = await startSharedOntology(process.env.ONTOLOGY_TOKEN ?? '');
const { alice, bob } = clientsFor(host.url, host.token);

await disjointEdits(alice, bob); // different terms, both kept
await overlappingEdits(alice, bob); // same term from the same base, the second throws MergeConflictError
```

`startSharedOntology` listens on `127.0.0.1` with an ephemeral port and a bearer token. For a long-running process, use `pnpm --filter @data-agent-ontology/ontology-server start` with `ONTOLOGY_FILE` and `ONTOLOGY_TOKEN`.

A Mastra agent points at the same URL by constructing `RemoteOntologyClient` and passing it to `withOntology`. See [`examples/mastra_basic`](../mastra_basic/README.md).

## Run

```bash
pnpm --filter @data-agent-ontology/example-shared-service test
```
