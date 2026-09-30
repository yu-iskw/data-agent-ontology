# @data-agent-ontology/ontology-mcp

Optional MCP host adapter beside `withOntology`. It is not a replacement for the library or `ontology-server`. One process owns one Ladybug file: the binary opens `new Ontology(new OntologyStore(() => new Date(), file))` and serves it through `LocalOntologyClient`. Close that process before another one opens the file.

STDIO is for one local process a host starts. It takes no port and no token. HTTP is for when a remote MCP host must connect. HTTP requires a non-empty bearer token and binds port **8788** by default so it does not collide with `ontology-server` on 8787.

```bash
pnpm --filter @data-agent-ontology/ontology-mcp start -- \
  --transport stdio --file ./ontology.lbdb

ONTOLOGY_FILE=./ontology.lbdb ONTOLOGY_TOKEN=secret \
  pnpm --filter @data-agent-ontology/ontology-mcp start -- --transport http --port 8788
```

Flags: `--transport stdio|http` (required), `--file` or `ONTOLOGY_FILE` (a `.lbdb` path, required), `--token` or `ONTOLOGY_TOKEN` (HTTP only), `--port` (HTTP, default `8788`), `--host` or `HOST` (HTTP, default `127.0.0.1`). The HTTP endpoint is `POST /mcp` (Streamable HTTP). Send `Authorization: Bearer <token>`.

Tools, and only these: `context`, `lookup`, `check_sql`, `record_sql`, `note`, `list_proposals`. `note` and `record_sql` file proposals. They do not change trusted knowledge. `check_sql` is advisory. There is no `submitScope`, `revise`, `revert`, `rollback`, `acceptProposal`, or `rejectProposal`. Curator accept stays on the library or the existing HTTP service. If the file has no active version, `check_sql` and `record_sql` report that a scope must be submitted first; this server does not submit one.
