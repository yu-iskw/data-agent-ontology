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
ontology.revert('v3'); // new version that undoes v3 and keeps later changes
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

## Concurrent writers

The store is single-writer per file, but several agents can still hold stale reads. Every write can name the version it read and who wrote it:

```ts
ontology.revise(patch, { baseVersionId: 'v7', actor: { id: 'agent-a', onBehalfOf: 'alice' } });
```

- **Compare-and-set.** The active pointer moves only if it still holds the version the commit started from. `expectedActive` on `revise`, `revert`, and `rollback` fails with `ActiveVersionChangedError` when it does not.
- **Record-level merge.** A `baseVersionId` older than the active head merges when the patch touches no record the others changed between the two (compared by shared revision id). Otherwise `MergeConflictError` carries `{ kind, id, base, theirs, mine }` per record and nothing is written. A change the head already holds is not a conflict. Constraints on one term compete as a set, so a second writer cannot add a rule beside one it has not seen.
- **Stale full scopes.** A full `Submission` may carry `observedAt`. Records another version added or changed after that instant are not deactivated.
- **Revert.** `revert(versionId)` commits a version that restores what that version changed, unless a later version changed the same record (`RevertConflictError`).
- **Actor.** `Version` records `actor`, `mergedFromVersionId`, and `proposalId`. Files created before this field existed gain the column on open.
- **Commit cost.** A commit writes only new revisions and links a version's records in one statement. A one-record revise on 3,300 records takes about 35 ms (it took 3.7 s).

`src/concurrency.test.ts` covers each case.

## Not yet implemented

- MCP and HTTP transports, `queryShapes`, trajectories, and write trust.
