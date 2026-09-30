# @data-agent-ontology/ontology-client

The interface an agent host uses to read and write the ontology, with two implementations: `LocalOntologyClient` (in-process core) and `RemoteOntologyClient` (HTTP to `ontology-server`). Both throw the core's error classes (`MergeConflictError`, `ActiveVersionChangedError`, `RevisionError`, ...).

```ts
const client = new LocalOntologyClient(ontology);
const { text, versionId } = await client.contextFor('revenue by store'); // prompt block, or '' if nothing matched
const { issues } = await client.checkSql(sql); // advisory: unknown table or column, join that differs from a known relation, constraint notes
await client.revise(patch, {
  baseVersionId: versionId,
  actor: { id: 'agent-a', onBehalfOf: 'alice' },
});
```

`checkSql` reads table and column references with patterns, not a SQL parser. It can miss issues and never blocks a statement. It runs against a snapshot cached per version.

`@data-agent-ontology/ontology-client/testing` exports `describeClientContract`, the suite both implementations pass.
