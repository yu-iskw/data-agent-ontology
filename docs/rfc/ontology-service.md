# RFC: Ontology service for analytics agents

Status: proposed implementation design

## 1. Summary

Build a small ontology service that analytics agents read and update while they work.

The service stores a versioned graph of:

- domains
- tables and columns
- terms
- mappings
- relations
- constraints
- evidence

Agents already have their own BigQuery or Snowflake access. They inspect warehouse metadata and submit observations to the ontology service.

The ontology service does not:

- connect to warehouses;
- store warehouse credentials;
- execute analyst SQL;
- run a scheduler;
- automatically rewrite semantic knowledge with an LLM.

The first version answers one question:

> Can a small shared ontology help analytics agents find the right data and generate better-grounded SQL while remaining easy to maintain?

Mastra is the reference analytics agent and host. Other agents use the same MCP or HTTP operations.

---

## 2. Goals

V1 must:

1. Give an analytics agent a small, relevant semantic context for a question instead of exposing thousands of tables and columns.

2. Represent semantic knowledge across BigQuery and Snowflake without merging warehouse identities.

3. Let agents report structural changes they observe while doing normal analytics work.

4. Let people explicitly revise semantic knowledge.

5. Ensure agent observations cannot silently overwrite human revisions.

6. Preserve enough history to inspect changes and roll back mistakes.

7. Run locally or remotely as one process using the same code.

8. Expose the same ontology operations to Mastra, Cursor, Codex, and other MCP or HTTP clients.

---

## 3. Non-goals

V1 does not provide:

- automatic ontology evolution;
- an LLM ontology proposer;
- an LLM judge;
- automatic semantic promotion;
- trajectory-based train/test splitting;
- automatic domain clustering;
- a product scheduler;
- warehouse credentials inside the ontology service;
- analyst SQL execution inside the ontology core;
- one agent or tool per table/domain;
- a graphical ontology editor;
- multi-workspace isolation;
- full RBAC;
- a generic storage abstraction.

Trajectory collection may be added as passive telemetry, but trajectories do not mutate the ontology in V1.

---

## 4. Architecture

```text
                 ┌─────────────────────────┐
                 │ Analytics Agent         │
                 │ Mastra / Cursor / etc.  │
                 └───────────┬─────────────┘
                             │
                ┌────────────┴────────────┐
                │                         │
                ▼                         ▼
        ┌───────────────┐          ┌───────────────┐
        │ BigQuery /    │          │ MCP / HTTP    │
        │ Snowflake     │          │ ontology API  │
        └───────────────┘          └───────┬───────┘
                                           │
                                           ▼
                                   ┌───────────────┐
                                   │ Ontology Core │
                                   └───────┬───────┘
                                           │
                                           ▼
                                   ┌───────────────┐
                                   │ Ladybug       │
                                   │ ontology.lbdb │
                                   └───────────────┘
```

The agent reads the warehouse.

The ontology service reads only observations submitted by agents.

Analyst SQL remains entirely outside the ontology core.

One process owns the ontology database file.

---

## 5. Software architecture

Use two packages:

```text
packages/
  ontology-core/
  ontology-mastra/
  common/
```

### `ontology-core`

Plain TypeScript.

No Mastra imports.

No warehouse SDK.

Responsibilities:

```text
model/
store/
read/
submit/
revision/
```

Core API:

```ts
browse(query): BrowseResult

resolve(termIds): ResolveResult

submitScope(submission): Version

revise(patch): Version

rollback(versionId): Version
```

Optional telemetry:

```ts
recordTrajectory(trajectory): TrajectoryId
```

`recordTrajectory` has no side effects on ontology state.

### `ontology-mastra`

Contains:

- reference analytics agent;
- MCP tools;
- HTTP routes;
- Mastra integration.

It translates agent-facing requests into calls to `ontology-core`.

---

## 6. Knowledge model

```text
Domain
  │
  ├──── member ──── Table
  │                    │
  │                    └── Column
  │
  └──── Term
          │
          ├── Mapping ─────→ Column
          │
          ├── Relation ────→ Term
          │
          └── Constraint

Evidence ─────────────→ semantic records
```

### Domain

A domain has:

```ts
{
  domainId: string
  name: string
  parentDomainId?: string
}
```

Domain membership is explicit.

Children do not automatically inherit parent tables.

A table may belong to multiple domains.

V1 does not automatically create domains by clustering warehouse objects.

### Table identity

A table is identified by:

```text
(engine, path)
```

BigQuery:

```text
project.dataset.table
```

Snowflake:

```text
database.schema.table
```

A BigQuery table and Snowflake table are never the same physical object even if they represent equivalent concepts.

### Term

A term belongs to exactly one domain.

The same word in two domains represents two different terms.

### Mapping

A mapping connects a term to a warehouse column.

The mapped table must belong to the term's domain.

### Relation

Relations may connect terms across domains.

### Constraint

Constraints record semantic or usage rules.

Examples include:

```text
Do not include cancelled orders.

Use event_time rather than ingestion_time.

Revenue is already net of refunds.
```

### Evidence

Evidence records why the ontology contains a semantic assertion.

Minimal provenance:

```ts
type Evidence = {
  evidenceId: string;
  targetId: string;
  source: 'submission' | 'revise' | 'trajectory';
  summary: string;
};
```

Records exposed through `resolve` should retain enough provenance for an agent to distinguish human-maintained semantics from observed or inferred information.

---

## 7. Authority

V1 uses one simple precedence rule:

```text
human revision > agent observation
```

`revise` marks the fields it changes as human-controlled.

Later `submit_scope` calls may update structural lifecycle information but cannot overwrite human-controlled semantic fields.

If the underlying table or column disappears, the human-maintained semantic record remains stored but becomes:

```text
drifted = true
active = false
```

This preserves human intent without presenting stale knowledge to agents.

Field-level pins may be used if required by the implementation, but V1 should not introduce more authority states than necessary.

---

## 8. Reads

V1 exposes two read operations.

### `browse`

Input:

```ts
{
  question: string;
}
```

Returns a small shortlist of relevant domains and terms.

Maximum:

```text
6 hits
```

The purpose of `browse` is semantic routing.

It should not return the entire ontology.

### `resolve`

Input:

```ts
{
  termIds: string[]
}
```

Maximum:

```text
5 terms
```

Returns the grounded knowledge needed to analyze those terms:

- mappings;
- tables;
- columns;
- relations;
- constraints;
- evidence.

Inactive and drifted records are omitted.

The expected agent flow is:

```text
question
   │
   ▼
 browse
   │
   ▼
 resolve
   │
   ▼
warehouse metadata / SQL
   │
   ▼
 answer
```

---

## 9. Structural observations

Agents report warehouse structure using `submit_scope`.

A submission contains:

```ts
{
  scope: Scope[]
  tables: TableObservation[]
  columns: ColumnObservation[]
  removed?: WarehouseObject[]
  queryShapes?: QueryShape[]
}
```

Each scope explicitly states whether the observation is complete:

```ts
type Scope = {
  engine: 'bigquery' | 'snowflake';
  path: string;
  completeness: 'full' | 'partial';
};
```

This distinction is important.

### Full scope

A full scope means:

> The caller inspected the complete current contents of this dataset or schema.

Therefore:

```text
object absent from submission
→ object is no longer present
→ mark inactive
```

### Partial scope

A partial scope means:

> The caller observed these objects but does not claim that unmentioned objects are absent.

Therefore:

```text
object absent from submission
→ no change
```

An explicit `removed` entry may mark an object absent in either mode.

A submission may never modify warehouse objects outside its declared scope.

Such a request is rejected.

---

## 10. Structural lifecycle

Structural observations take effect immediately.

```text
submit_scope
     │
     ▼
validate scope
     │
     ▼
compare with active ontology
     │
     ├── new object ───────→ add
     │
     ├── changed object ───→ update revision
     │
     ├── removed object ───→ inactive
     │
     └── human semantic data
                 │
                 └─────────→ preserve
```

A rename is treated as:

```text
old identity → inactive
new identity → new object
```

V1 does not attempt to infer that arbitrary warehouse renames preserve semantic identity.

Agents or people may repair semantic mappings afterward.

---

## 11. Semantic changes

V1 has one authoritative semantic mutation mechanism:

```text
revise
```

A person, or an agent explicitly acting for a person, uses `revise` to:

- define terms;
- change definitions;
- create mappings;
- change mappings;
- create relations;
- add constraints;
- assign domain membership.

A revision creates a new ontology version.

The revised semantic fields become human-controlled.

There is no automatic semantic promotion in V1.

---

## 12. Versioning

Every successful mutation creates an immutable ontology version.

```text
V0
 │
 ▼
V1
 │
 ▼
V2

ActivePointer ──→ V2
```

Versions have:

```ts
{
  versionId: string
  parentVersionId?: string
  createdAt: string
  reason: "scope" | "revise"
}
```

Unchanged record revisions should be shared between versions if Ladybug can represent this efficiently.

Changed records receive new revisions.

The storage representation must be proven before feature implementation.

If Ladybug cannot efficiently support the required version semantics, switch to SQLite rather than introducing a generic storage abstraction.

---

## 13. Rollback

Rollback changes the active version pointer:

```text
ActivePointer

V3 → V2
```

Rollback does not copy ontology records and does not delete history.

It is an activation operation, not a new semantic ontology version.

An unknown target version is rejected.

---

## 14. Domain assignment

V1 does not automatically cluster tables into domains.

Domain membership comes from:

1. existing membership;
2. explicit agent submission;
3. human revision.

Unknown tables may remain unclassified.

For example:

```text
domain = unclassified
```

or equivalent absence of membership.

Future systems may suggest domain membership based on:

- query co-occurrence;
- names;
- descriptions;
- warehouse tags;
- historical trajectories.

Suggestions are outside V1.

---

## 15. Reference agent behavior

The Mastra reference agent follows this sequence:

```text
1. browse(question)
2. resolve(termIds)
3. inspect warehouse
4. if structural knowledge is stale:
       submit_scope(...)
       resolve(...) again
5. execute read-only SQL
6. answer user
```

Optional:

```text
7. record trajectory
```

Trajectory recording must not block the user answer and must not modify ontology semantics.

When explicitly asked to mend a dataset or schema:

```text
1. inspect requested warehouse scope
2. submit_scope(...)
```

No internal scheduler is required.

---

## 16. Tool contract

V1 exposes:

| Tool           | Purpose                                  |
| -------------- | ---------------------------------------- |
| `browse`       | Find relevant semantic concepts          |
| `resolve`      | Ground concepts into warehouse knowledge |
| `submit_scope` | Report observed warehouse structure      |
| `revise`       | Apply authoritative semantic changes     |
| `rollback`     | Restore an earlier ontology version      |

Optional:

| Tool                | Purpose                      |
| ------------------- | ---------------------------- |
| `submit_trajectory` | Passive evaluation telemetry |

MCP and HTTP expose equivalent operations.

---

## 17. Write trust

For local development, all operations may be reachable from the local process.

For a remotely reachable deployment, V1 should distinguish ordinary reads from authoritative writes.

Minimum acceptable protection:

```text
browse        read
resolve       read

submit_scope  trusted agent write
revise        administrative write
rollback      administrative write
```

A static deployment secret is sufficient for the first remote slice.

V1 does not require RBAC, OAuth, workspace ACLs, or an IAM subsystem.

---

## 18. Testing

Core tests require no network and no Mastra.

Required tests:

### Scope isolation

A submission cannot modify objects outside its declared scope.

### Partial observations

Objects missing from a partial scope remain unchanged.

### Full observations

Objects missing from a full scope become inactive.

### Explicit removal

An explicitly removed unpinned warehouse object becomes inactive.

### Human authority

A structural submission cannot overwrite human-maintained semantic fields.

### Drift

If the warehouse object behind a human-maintained mapping disappears, the semantic record remains stored but becomes drifted and inactive.

### Rename

A renamed warehouse path creates a new identity and inactivates the old identity.

### Mapping integrity

A term cannot map to a table outside its domain.

### Cross-domain relations

Relations may connect terms belonging to different domains.

### Reads

`browse` and `resolve` omit inactive and drifted records.

### Rollback

Rollback restores the previous visible ontology.

---

## 19. Implementation order

### Phase 0 — storage proof

Before implementing product behavior, prove:

- database initialization;
- transactions;
- immutable record revisions;
- version IDs;
- shared unchanged revisions;
- active pointer;
- rollback.

If Ladybug cannot support the required version representation cleanly, switch to SQLite.

Do not build a storage abstraction.

### Phase 1 — ontology core

Implement:

```text
Domain
Table
Column
Term
Mapping
Relation
Constraint
Evidence
```

Then implement:

```text
browse
resolve
submit_scope
revise
rollback
```

Use fixtures rather than live warehouses.

### Phase 2 — reference agent

Add the Mastra reference agent.

Expose the five core operations through MCP and HTTP.

Test against:

- one BigQuery dataset;
- one Snowflake schema.

### Phase 3 — validate product value

Build a representative analytics evaluation set.

Compare:

```text
agent without ontology

vs.

agent with browse → resolve
```

Measure at minimum:

- SQL correctness;
- correct table selection;
- tables inspected;
- metadata calls;
- token usage;
- latency;
- semantic/mapping errors.

This evaluation determines whether the ontology architecture provides enough value to justify additional intelligence.

### Phase 4 — passive learning data

If useful, record trajectories containing:

```text
question
ontology version
terms resolved
tools used
tables queried
outcome
human correction
timestamp
```

Trajectory recording remains passive.

Do not automatically change the ontology.

---

## 20. V1 completion criteria

V1 is complete when:

1. Core tests run without network access.

2. MCP and HTTP expose the same ontology operations.

3. One BigQuery dataset and one Snowflake schema have been submitted successfully.

4. `browse → resolve` grounds an analytics agent to relevant warehouse objects.

5. A full-scope submission correctly detects a removed column.

6. A partial-scope submission does not accidentally remove unseen objects.

7. Human revisions survive later structural submissions.

8. Drifted mappings are retained historically but excluded from `resolve`.

9. Rollback restores a previous ontology view.

10. An evaluation compares analytics-agent behavior with and without ontology grounding.

---

## 21. V2: semantic evolution

V2 is intentionally not designed in detail until V1 generates real usage data.

Potential V2 capabilities include:

```text
trajectory analysis
        │
        ▼
semantic proposal
        │
        ▼
candidate ontology
        │
        ▼
evaluation
        │
        ▼
promotion / rejection
```

Possible capabilities include:

- automatic domain suggestions;
- mapping suggestions;
- term-definition improvements;
- constraint discovery;
- candidate ontology versions;
- offline evaluation;
- automatic promotion.

The implementation must be driven by observed V1 failure modes.

For example:

```text
If agents repeatedly choose wrong domains
→ investigate domain learning.

If mappings repeatedly require human correction
→ investigate mapping proposals.

If ontology wording causes poor retrieval
→ investigate definition optimization.
```

V2 must not assume that a generic LLM judge is sufficient.

Before automatic promotion is introduced, the project must define measurable ontology quality objectives such as:

- SQL correctness;
- table-selection accuracy;
- mapping correctness;
- semantic retrieval quality;
- analyst acceptance.

---

## 22. Design principle

The service should remain simpler than the agents using it.

The ontology is shared semantic infrastructure.

It should provide:

```text
small context
stable identity
explicit provenance
safe updates
human authority
history
```

Agents provide intelligence around it.

V1 therefore optimizes for:

> deterministic core, intelligent clients.

Only introduce intelligence into ontology mutation when production evidence demonstrates that doing so solves a real problem.
