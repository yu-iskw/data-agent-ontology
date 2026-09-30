# Mastra basic example

A [Mastra](https://mastra.ai/) data analytics agent that extracts an ontology from the local DuckDB warehouse `data/jaffle_shop.duckdb`, using [`@data-agent-ontology/ontology-core`](../../packages/ontology-core/README.md).

## How it works

1. `src/observe.ts` reads `information_schema` and submits a full-scope structural observation for every schema (RFC section 9).
2. The agent in `src/agent.ts` investigates the data. Its only tool is `run_sql`, which runs read-only SQL against the DuckDB file.
3. The agent returns a proposal of domains, terms, key columns, relations, and constraints. `src/proposal.ts` turns it into one `revise` patch. Each term maps every column of its grain table. If the ontology rejects the patch, the agent gets the problems and tries again.
4. `src/extract.ts` writes the visible ontology to `out/ontology.json` and the whole versioned JSON store to `out/ontology-store.json`.

The agent instructions describe a generic extraction method. They name no table, column, domain, or term of this warehouse.

## Run

```bash
# Application Default Credentials. No API key.
# Vertex project ubie-yu-sandbox, location global.
pnpm --filter @data-agent-ontology/example-mastra-basic extract
```

`ONTOLOGY_AGENT_MODEL` also sets the model. The default is `google-vertex/gemini-3.8-flash`.

| Flag              | Effect                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--scope-only`    | Writes the structure-only ontology (no model, no credentials). Use it as the baseline the evaluator diff starts from.             |
| `--record <file>` | After a live run, saves the accepted proposal, the model id, and every SQL statement the agent ran (with database errors).        |
| `--replay <file>` | Applies a recording instead of calling a model, so an extraction can be repeated offline and byte-for-byte. Needs no credentials. |

Without Application Default Credentials the live run stops with `Could not load the default credentials`; replay still works. A recording is a saved model output, so it belongs outside `examples/` if you keep it (the isolation test scans this directory).

## Isolation

- DuckDB opens the file with `access_mode=READ_ONLY`, `enable_external_access=false`, extension autoinstall and autoload off, and `lock_configuration=true`. File functions, `glob`, `ATTACH`, `COPY`, `INSTALL`, `SET`, and writes all fail. `src/warehouse.test.ts` checks each one.
- The agent has no file system tool, and this package depends on no grading code. ESLint (`import-x/no-restricted-paths`) rejects any import of grading code from example code.
- Grading runs in a separate process that reads `out/ontology.json`. See the repository README.
