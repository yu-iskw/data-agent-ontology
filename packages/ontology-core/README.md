# @data-agent-ontology/ontology-core

The deterministic ontology core from [`docs/rfc/ontology-service.md`](https://github.com/yu-iskw/data-agent-ontology/pull/1). Plain TypeScript with no Mastra import, no warehouse SDK, and no runtime dependencies.

```ts
import { Ontology } from '@data-agent-ontology/ontology-core';

const ontology = new Ontology();
ontology.submitScope(submission); // structural observation, full or partial scope
ontology.revise(patch); // authoritative semantic change
ontology.browse('revenue by store'); // at most 6 domains and terms
ontology.resolve(['order', 'location']); // at most 5 terms, grounded to columns
ontology.rollback('v2'); // moves the active pointer only
ontology.snapshot(); // visible records of the active version

const json = ontology.store.toJSON(); // whole history as JSON, shared revisions written once
const restored = new Ontology(OntologyStore.fromJSON(json));
```

## What is implemented

- Records: domain, table, column, term, mapping, relation, constraint, and evidence. The engine union adds `duckdb` for local fixtures.
- Versions: every successful mutation commits an immutable version in a Ladybug file (`*.lbdb`). Unchanged records keep their `Revision` node; the next version adds another `Includes` edge. Rollback updates the single `ActivePointer`. A failed mutation rolls the transaction back and commits nothing.
- JSON export: `toJSON()` writes every revision once and lists, for each version, the revisions it holds. `fromJSON()` restores that export into a store. The example file `out/ontology-store.json` is this export, not the database.
- Authority: `revise` owns semantic records and table membership. `submitScope` cannot change them. When a mapped column or a revised table disappears, the record stays stored with `drifted: true` and `active: false`.
- Scopes: objects outside the declared scope are rejected. A full scope inactivates missing tables and columns. A partial scope changes only what it names. `removed` inactivates objects in either mode. A rename is a new identity.
- Mapping integrity: a term maps only to tables in its domain. Relations may cross domains.

`src/ontology.test.ts` covers each required test in RFC section 18.

## Not yet implemented

- MCP and HTTP transports, `queryShapes`, trajectories, and write trust.
