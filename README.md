# data-agent-ontology

A versioned ontology that an existing data analytics agent uses while it analyzes data. The agent keeps its instructions, tools, workspace, skills, and its A2A or MCP host. [`withOntology`](packages/ontology-mastra/src/with-ontology.ts) only appends a short usage note, adds `ontology_lookup` and `ontology_note`, appends the `ontology-context` input processor, and wraps the SQL tools you name. The SQL check is advisory and never blocks a statement.

## One process, one file

One process, one file, no port. Open the Ladybug file in this process:

```ts
const ontology = new LocalOntologyClient(
  new Ontology(new OntologyStore(() => new Date(), './ontology.lbdb')),
);
```

Build the agent config the way you do today, then pass it through `withOntology`. `instructions` must be a string.

```ts
import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { Ontology, OntologyStore } from '@data-agent-ontology/ontology-core';
import { withOntology } from '@data-agent-ontology/ontology-mastra';
import { Agent } from '@mastra/core/agent';

const ontology = new LocalOntologyClient(
  new Ontology(new OntologyStore(() => new Date(), './ontology.lbdb')),
);

export const agent = new Agent(
  withOntology({ id: 'analyst', instructions, model, tools: { run_sql } }, ontology, {
    sqlTools: ['run_sql'],
  }),
);
```

The same loops without Mastra are in [`examples/client_loops`](examples/client_loops/README.md).

## Shared file

[Ladybug](https://docs.ladybugdb.com/concurrency) allows one writer process per file. When several processes share one `.lbdb`, one [`ontology-server`](packages/ontology-server) process owns the file and the others call it over HTTP. Use one file per workspace, and point that workspace's agents at its server.

```ts
import { RemoteOntologyClient } from '@data-agent-ontology/ontology-client';
import { withOntology } from '@data-agent-ontology/ontology-mastra';
import { Agent } from '@mastra/core/agent';

const ontology = new RemoteOntologyClient({
  url: process.env.ONTOLOGY_URL ?? '',
  token: process.env.ONTOLOGY_TOKEN ?? '',
});

export const agent = new Agent(
  withOntology({ id: 'analyst', instructions, model, tools: { run_sql } }, ontology, {
    sqlTools: ['run_sql'],
  }),
);
```

Two clients on one HTTP service are in [`examples/shared_service`](examples/shared_service/README.md).

Start the service with:

```bash
ONTOLOGY_FILE=./ontology.lbdb ONTOLOGY_TOKEN=secret PORT=8787 \
  pnpm --filter @data-agent-ontology/ontology-server start
```

## MCP

[`ontology-mcp`](packages/ontology-mcp) is optional. It is a host adapter beside `withOntology`, not a replacement for the library or [`ontology-server`](packages/ontology-server).

One process owns the `.lbdb` file. Use STDIO when that process is the local MCP server a host starts (no port, no token). Use HTTP when a remote MCP host must connect. HTTP requires a bearer token and defaults to port `8788` so it does not collide with `ontology-server`.

The MCP tools can read context, check SQL, and file notes and traces as proposals. They do not accept, revise, or submit a scope. Curator accept stays on the library or the existing HTTP service.

```bash
pnpm --filter @data-agent-ontology/ontology-mcp start -- --transport stdio --file ./ontology.lbdb

ONTOLOGY_FILE=./ontology.lbdb ONTOLOGY_TOKEN=secret \
  pnpm --filter @data-agent-ontology/ontology-mcp start -- --transport http --port 8788
```

## Getting started

### Prerequisites

- [pnpm](https://pnpm.io/) **11.x** (see `packageManager` in `package.json`; use [Corepack](https://nodejs.org/api/corepack.html): `corepack enable`)
- Node.js **22+** (see `engines` in `package.json`; `.node-version` pins the version used for local dev and CI)

Dependency installs follow pnpm 11 supply-chain settings in [`pnpm-workspace.yaml`](pnpm-workspace.yaml): **minimum release age** (this repo uses a **7-day** quarantine, stricter than pnpm’s built-in 24-hour default), **blocking exotic transitive dependencies**, and an **`allowBuilds`** allowlist for packages that run install scripts. See [pnpm 11 release notes](https://pnpm.io/blog/releases/11.0) and [Supply-chain defaults (Socket)](https://socket.dev/blog/pnpm-11-adds-new-supply-chain-protection-defaults).

Linting and formatting use [Trunk](https://trunk.io/) (ESLint, Prettier, and more). The Trunk **launcher** is installed with project dependencies—you do not need a separate Trunk install for the default workflow.

### Installation

```bash
pnpm install
```

Optional: prefetch Trunk’s hermetic tools (helpful for offline work or CI images):

```bash
pnpm exec trunk install
```

If you prefer a global `trunk` on your PATH, see the [Trunk installation guide](https://docs.trunk.io/code-quality/overview/getting-started/install) (e.g. `brew install trunk-io` on macOS).

### Supply-chain protections

This repo uses **pnpm 11** with settings in [`pnpm-workspace.yaml`](pnpm-workspace.yaml): a **7-day** [`minimumReleaseAge`](https://pnpm.io/settings#minimumreleaseage) (10080 minutes, stricter than pnpm’s default 1 day), [`blockExoticSubdeps`](https://pnpm.io/settings#blockexoticsubdeps) enabled, and an [`allowBuilds`](https://pnpm.io/settings#allowbuilds) map for dependencies that must run install scripts (pnpm 11 requires this for native toolchain packages such as esbuild). See the [pnpm 11 release notes](https://pnpm.io/blog/releases/11.0).

CI: pull requests and `main` run `pnpm lint:security` then generate/scan an SPDX SBOM (`.github/workflows/sbom.yml`). Publish re-checks `pnpm lint:security` before npm publish.

### Build

```bash
pnpm build
```

### Test

```bash
pnpm test
```

### Linting and formatting

```bash
pnpm lint
pnpm format
```

## Project structure

- `packages/`
  - [`ontology-core`](packages/ontology-core): versioned store, `browse`, `resolve`, `submitScope`, `revise`, `rollback`
  - [`ontology-client`](packages/ontology-client): `contextFor`, advisory `checkSql`, `LocalOntologyClient`, and `RemoteOntologyClient`
  - [`ontology-mastra`](packages/ontology-mastra): `withOntology`, which attaches a client to an existing Mastra agent
  - [`ontology-server`](packages/ontology-server): one process that owns one `.lbdb` file and serves it over HTTP with a static bearer token
  - [`ontology-mcp`](packages/ontology-mcp): optional MCP adapter, STDIO or Streamable HTTP, one process per `.lbdb` file
  - [`common`](packages/common): shared utilities and types
- [`examples/mastra_basic`](examples/mastra_basic): a Mastra analytics agent with the ontology attached, plus a one-time seeder for an empty ontology
- [`examples/client_loops`](examples/client_loops): the use loop and the propose-and-curate loop on `OntologyClient`, with no Mastra
- [`examples/shared_service`](examples/shared_service): two users sharing one ontology HTTP service, including a merge and a conflict
- [`eval/jaffle-shop`](eval/jaffle-shop): evaluator and answer set. Examples do not import it.

## One-time seeding and evaluation

Seeding fills an empty ontology. It is not how an agent uses the ontology. Grading is a second process. The seeder writes `examples/mastra_basic/out/ontology.json`; the evaluator reads that file together with the answer files.

```bash
# Application Default Credentials. Vertex project ubie-yu-sandbox, location global.
pnpm example:extract
pnpm eval:jaffle-shop
```

## License

Apache-2.0
