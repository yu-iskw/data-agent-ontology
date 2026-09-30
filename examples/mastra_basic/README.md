# Mastra basic example

A [Mastra](https://mastra.ai/) data analytics agent over the local DuckDB warehouse `data/jaffle_shop.duckdb`, with a shared ontology attached through [`@data-agent-ontology/ontology-mastra`](../../packages/ontology-mastra/src/with-ontology.ts). The agent answers questions with its own SQL tool. The ontology helps it answer, and grows from what it does.

## The integration: `withOntology`

`src/agent.ts` is the agent a user would copy. Everything except the `withOntology` call is an ordinary Mastra agent with one SQL tool:

```ts
import { withOntology } from '@data-agent-ontology/ontology-mastra';

export const agent = new Agent(
  withOntology(
    { id: 'analyst', instructions, model, tools: { run_sql } }, // the user's own config
    ontology, // an OntologyClient: local (in-process) or remote (HTTP)
    { sqlTools: ['run_sql'] },
  ),
);
```

`withOntology` leaves the user's instructions, model, and tools as they are, and:

- adds `ontology_lookup(question)`, which browses and resolves in one call;
- adds `ontology_note(termId, statement, evidence)`, which files a proposal. Nothing changes until a curator accepts it;
- adds an input processor that puts the resolved slice, with its version id, in front of the model. It adds nothing when the question matches no term;
- wraps `run_sql`: each statement is checked against the ontology (unknown table or column, a join that differs from a known relation, constraint notes) and recorded as a trace. Findings ride along with the result as `ontology_check`. They are advisory and never block a statement;
- appends about ten lines of usage guidance to the instructions.

`src/with-ontology.test.ts` (in the package) proves the use loop with no model and no network, on a fixture ontology built with the core API.

```bash
pnpm --filter @data-agent-ontology/example-mastra-basic ask --ontology out/ontology-store.json "<question>"
```

`ask` needs a model (Vertex, below). It loads a copy of the store, so notes and traces last for that process only; for shared use, point the agent at an `ontology-server` with `RemoteOntologyClient`.

## One-time seeding

An empty ontology helps nobody, so `src/seed.ts` fills it once with a separate, extraction-only agent (`src/seed-agent.ts`). It is not something a user integrates.

1. `src/observe.ts` reads `information_schema` and submits a full-scope structural observation for every schema (RFC section 9).
2. The seed agent investigates the data. Its only tool is `run_sql`, which runs read-only SQL against the DuckDB file.
3. It returns a proposal of domains, terms, key columns, relations, and constraints. `src/proposal.ts` turns it into one `revise` patch. Each term maps every column of its grain table. If the ontology rejects the patch, the agent gets the problems and tries again.
4. `src/seed.ts` writes the visible ontology to `out/ontology.json` and the whole versioned JSON store to `out/ontology-store.json`.

The seed instructions describe a generic extraction method. They name no table, column, domain, or term of this warehouse. The analyst instructions in `src/agent.ts` are separate, generic analytics instructions.

## Run

```bash
# Application Default Credentials. No API key.
# Vertex project ubie-yu-sandbox, location global.
pnpm --filter @data-agent-ontology/example-mastra-basic seed   # `extract` is an alias
```

`ONTOLOGY_AGENT_MODEL` also sets the model. The default is `google-vertex/gemini-3.8-flash`.

| Flag              | Effect                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `--scope-only`    | Writes the structure-only ontology (no model, no credentials). Use it as the baseline the evaluator diff starts from.             |
| `--record <file>` | After a live run, saves the accepted proposal, the model id, and every SQL statement the seed agent ran (with database errors).   |
| `--replay <file>` | Applies a recording instead of calling a model, so an extraction can be repeated offline and byte-for-byte. Needs no credentials. |

Without Application Default Credentials the live run stops with `Could not load the default credentials`; replay still works. A recording is a saved model output, so it belongs outside `examples/` if you keep it (the isolation test scans this directory).

## Isolation

- DuckDB opens the file with `access_mode=READ_ONLY`, `enable_external_access=false`, extension autoinstall and autoload off, and `lock_configuration=true`. File functions, `glob`, `ATTACH`, `COPY`, `INSTALL`, `SET`, and writes all fail. `src/warehouse.test.ts` checks each one.
- The agent has no file system tool, and this package depends on no grading code. ESLint (`import-x/no-restricted-paths`) rejects any import of grading code from example code.
- Grading runs in a separate process that reads `out/ontology.json`. See the repository README.
