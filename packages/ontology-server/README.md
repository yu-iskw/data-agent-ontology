# @data-agent-ontology/ontology-server

One process that owns one Ladybug database file and serves `ontology-core` over HTTP.

```bash
ONTOLOGY_FILE=./ontology.lbdb ONTOLOGY_TOKEN=secret PORT=8787 \
  pnpm --filter @data-agent-ontology/ontology-server start
```

Ladybug allows one read-write process per file, so agent replicas call this server through `RemoteOntologyClient` from `@data-agent-ontology/ontology-client` and never open the file. A second process that opens the file fails with Ladybug's lock error (`src/service.test.ts` checks it).

- `POST /v1/<method>` with a JSON body and `Authorization: Bearer <token>`. Methods: `browse`, `resolve`, `snapshot`, `listVersions`, `submitScope`, `revise`, `revert`, `rollback`. Bodies are typed in the client package (`Requests`, `Responses`).
- Replies are `{ ok: true, result }` or `{ ok: false, error: { code, message, details } }`. Merge conflicts, wrong active version, and revert conflicts are 409 with the conflicting records in `details`; rejected revisions are 422; a missing or wrong token is 401.
- Calls run to completion on the event loop, so writes are serialized. Write callers pass `baseVersionId` (the version they read) and `actor`.
- Auth is one static bearer secret. Roles and per-user tokens are not implemented.
