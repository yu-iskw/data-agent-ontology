# @data-agent-ontology/ontology-mastra

`withOntology(config, client, { sqlTools })` attaches an ontology to a Mastra agent config you already have. The result goes to `new Agent(...)`. `ontology-core` stays free of Mastra; this package holds the only Mastra import.

What it changes: it appends a short usage note to `instructions`, adds `ontology_lookup` and `ontology_note` tools, adds an input processor that injects the resolved ontology slice (with its version id) for the latest user question, and wraps the tools named in `sqlTools`. A wrapped tool's statement is checked with the client's advisory `checkSql` before it runs and recorded as a trace after. Findings are added to the result as `ontology_check`; a statement is never blocked, and an unreachable ontology never breaks the tool.

Options: `sqlField` (input field holding the SQL, default `sql`), `actor` (default `{ id: 'analyst-agent' }`), `sessionId(context)` (default: thread id, else one id per process; the relation proposer counts sessions).

The instructions must be a string. `ontology_note` takes a `termId` because a note is filed as a constraint proposal on a term.

`src/with-ontology.test.ts` covers the use loop with no model and no network.
