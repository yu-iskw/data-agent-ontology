---
name: manage-adr
description: Manage Architecture Decision Records (ADRs) with follow / challenge / accept. Use when initializing, creating, listing, linking, proposing supersession, or accepting/rejecting ADRs. Requires adr-tools.
---

# Manage Architecture Decision Records (ADRs)

ADRs are durable architecture memory for coding agents. **Accepted** ADRs bind implementation. Better approaches use **Challenge** (Proposed supersession), not silent rewrites or `adr new -s` at proposal time.

Script path (all commands below): `.claude/skills/manage-adr/scripts/create-adr.sh`

## When to Use

- Significant architectural change or choosing among approaches.
- Standardizing a pattern across the codebase.
- Understanding previous design decisions (`adr list` / index).
- Challenging an Accepted ADR when Context is stale.

Status meanings and the Nygard re-litigation rule: `references/adr-concepts.md`.

## Modes: follow / challenge / accept

### Follow (default feature work)

1. If the task touches architecture, run `adr list` or read `docs/adr/README.md` (if present).
2. Load **Accepted** ADR bodies that match the task. Do not load the whole tree or superseded bodies unless researching history.
3. Implement against those Accepted decisions.

### Challenge (better approach with evidence)

Triggers (any one):

- User asked for a different approach.
- New requirement absent from the old Context.
- Measured failure (tests, ops, security).
- Constraints in the old Context no longer exist.

Steps:

1. **Stop** implementing the old decision. Do **not** edit its Decision section.
2. Create a Proposed ADR (do **not** use `adr new -s`). `--proposes` targets must be **Accepted** (validated before `adr new`):

```bash
.claude/skills/manage-adr/scripts/create-adr.sh --proposes <old-adr-number> "New Decision Title"
# or without a supersede target:
.claude/skills/manage-adr/scripts/create-adr.sh "New Decision Title"
```

3. Fill Context (why the old Context is wrong), Decision, and Consequences.
4. Leave Status **Proposed**. Open or update a **draft PR** and wait for human Accept.

### Accept (human gate only)

Only when the user (or review) explicitly accepts the proposal:

```bash
.claude/skills/manage-adr/scripts/create-adr.sh accept <adr-number-or-file>
```

Transactional Accept: re-checks propose targets are still Accepted, applies Supercedes via `adr link` + `_adr_remove_status` (adr-tools spelling), then sets Status Accepted and strips Status-only `<!-- adr-proposes:… -->` markers. On link failure, restores backups. Refreshes the existing TOC path (`README.md` or `index.md`) atomically.

Regression harness: `.claude/skills/manage-adr/scripts/test-create-adr.sh`.

If a gotcha in root agent instructions encoded the old decision, update that copy in the **same change**.

### Reject

```bash
.claude/skills/manage-adr/scripts/create-adr.sh reject <adr-number-or-file>
```

Sets Status to Rejected. Old Accepted records stay Accepted.

## Initialization

```bash
adr init docs/adr
```

## Creating a new ADR (Proposed)

```bash
.claude/skills/manage-adr/scripts/create-adr.sh "Title of the ADR"
```

The script runs `adr new` then rewrites Status from Accepted → **Proposed** (adr-tools always substitutes Accepted). Then edit Context, Decision, and Consequences.

**Never** pass `-s` / `--supercedes` to create a challenge. That immediately unbinds the old ADR.

## Linking (non-supersession)

```bash
adr link 12 Amends 10 "Amended by"
```

## Listing and viewing

- List: `adr list`
- Index: `docs/adr/README.md` when present
- Read one: `docs/adr/NNNN-title.md`

## Reports

- TOC: `adr generate toc`
- Graph: `adr generate graph | dot -Tpng -o adr-graph.png` (requires Graphviz)

## Best Practices

- One decision per ADR. Write for future maintainers.
- Do not copy ADR bodies into always-on `AGENTS.md` / `CLAUDE.md`. Point to the index instead.
- Do not `@import` `docs/adr/**` into Claude memory files (token cost; expands at launch).
- Refer to `references/adr-concepts.md` and `assets/template.md`.
- Optional Mermaid diagrams for the decision or system shape.
