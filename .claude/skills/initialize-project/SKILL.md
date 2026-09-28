---
name: initialize-project
description: Initialize a new project from the TypeScript template by updating package metadata, package names, and README placeholders while preserving repository invariants such as the existing license unless the user explicitly requests a change.
---

# Initialize Project

## Purpose

Bootstrap a repository created from this template without relying on editor-specific tool names or silently changing legal/project metadata. This skill is intended to work as a portable Agent Skill, including when discovered by Cursor through the repository's shared skills surface.

## Workflow

### 1. Inspect the template state

Before editing, read the current values from:

- `package.json`
- `packages/*/package.json`
- `README.md`
- `LICENSE`
- `pnpm-workspace.yaml`

Treat those files as the source of truth. Do not assume package names, license identifiers, workspace paths, or placeholder values from this skill.

### 2. Resolve project metadata

Use values already supplied by the user. Only ask for information that is required and cannot be safely inferred.

Relevant fields are:

- Project/package name
- Project description
- Author, when the user wants it populated
- Repository URL, when the user supplies one or asks for repository metadata
- License, only when the user explicitly wants to change the template's current license

### 3. Preserve the license by default

**Never change the license implicitly during initialization.**

- Keep the existing SPDX identifier from the package manifests.
- Keep the existing `LICENSE` file unchanged.
- Use the same SPDX identifier when replacing the README's `{LICENSE}` placeholder.

If the user explicitly requests a different license, update all affected package manifests, the README, and `LICENSE` consistently. Use canonical license text; if that cannot be done safely, report the unresolved license change instead of leaving inconsistent metadata.

### 4. Update project metadata

Use the editing capabilities available on the current agent surface; do not depend on a specific editor/tool command name.

At minimum:

1. Update root `package.json`:
   - `name`
   - `description`
   - `author` when supplied
   - repository metadata when explicitly supplied or requested
2. Update workspace package manifests:
   - Replace template-specific package names with names consistent with the new project.
   - For the existing `common` package, an unscoped project named `my-project` normally maps to `@my-project/common` unless the user specifies a different package scope.
   - Keep license metadata aligned with the root package.
3. Replace README placeholders:
   - `{PROJECT_NAME}` → project name
   - `{PROJECT_DESCRIPTION}` → project description
   - `{LICENSE}` → current SPDX license identifier
4. Update other direct references to the old template/package name only when they semantically refer to the initialized project's identity. Do not rewrite historical documentation, URLs, tool names, or unrelated occurrences blindly.

### 5. Refresh dependencies

Run from the repository root:

```bash
pnpm install
```

Commit the resulting `pnpm-lock.yaml` changes when initialization changes workspace package identities or dependency metadata.

### 6. Validate the initialized repository

Check for unresolved template placeholders and stale package identities, then run the normal project gates:

```bash
pnpm lint
pnpm test
pnpm build
```

Do not claim initialization succeeded if package manifests, README/license metadata, or these required gates are inconsistent. If a required external tool is unavailable, report that validation step as blocked rather than silently skipping it.

### 7. Cleanup policy

Do **not** delete this skill automatically. Remove template/bootstrap tooling only when the user explicitly asks to remove it from the initialized repository.

## Example

For a user request such as:

> Initialize this repository as `json-fixer`, a CLI tool that repairs malformed JSON.

A typical result is:

- Root package name: `json-fixer`
- Root description: `A CLI tool that repairs malformed JSON.`
- Existing `common` package renamed consistently, for example `@json-fixer/common`
- README placeholders replaced
- Existing Apache-2.0 license preserved unless the user requested another license
- Lockfile refreshed
- `pnpm lint`, `pnpm test`, and `pnpm build` verified
