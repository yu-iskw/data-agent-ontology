# Client loops

The ontology attached to an analytics agent that is not Mastra. The host keeps its own agent and calls `OntologyClient`. This example uses `LocalOntologyClient` in-process. A hosted ontology uses `RemoteOntologyClient` with the same calls; see [`examples/shared_service`](../shared_service/README.md).

The Mastra wrapper that does these calls for you is [`examples/mastra_basic`](../mastra_basic/README.md).

## Use loop

`src/use-loop.ts` pulls a small slice of the ontology into the prompt, then checks the SQL the agent is about to run.

```ts
const { context, check } = await useOntology(client, question, sql);
// context.text goes in front of the model. context.versionId is the base for a later write.
// check.issues lists unknown tables and columns, joins that differ from a known relation,
// and constraint notes. The check never blocks the statement.
```

## Propose and curate loop

`src/curate-loop.ts` records the SQL the agent ran. Joins that succeed often enough become a relation proposal. An explicit note becomes a constraint proposal. A curator accepts them, and only then do they enter the ontology.

```ts
const { relation, note } = await curateFromUsage(client);
```

## Run

```bash
pnpm --filter @data-agent-ontology/example-client-loops test
```

No model and no warehouse credentials. The shop in `src/fixture.ts` is built with the core API.
