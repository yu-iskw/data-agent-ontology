import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Ontology, RevisionError } from '@data-agent-ontology/ontology-core';

import { createOntologyAgent, DEFAULT_MODEL } from './agent.js';
import { observeWarehouse } from './observe.js';
import { proposalSchema, toRevisePatch } from './proposal.js';
import { Warehouse } from './warehouse.js';

import type { Proposal } from './proposal.js';
import type { OntologySnapshot } from '@data-agent-ontology/ontology-core';
import type { Agent } from '@mastra/core/agent';

const DEFAULT_OUT = fileURLToPath(new URL('../out/ontology.json', import.meta.url));
const MAX_ATTEMPTS = 3;
const MAX_STEPS = 80;

type Message = { role: 'user'; content: string } | { role: 'assistant'; content: string };

function catalogText(snapshot: OntologySnapshot): string {
  return snapshot.tables
    .map((table) => {
      const columns = snapshot.columns
        .filter((column) => column.tableId === table.tableId)
        .sort((a, b) => a.ordinalPosition - b.ordinalPosition)
        .map((column) => `${column.name} ${column.dataType}`);
      return `- ${table.path} (${table.kind}): ${columns.join(', ')}`;
    })
    .join('\n');
}

function taskPrompt(databaseName: string, snapshot: OntologySnapshot): string {
  return [
    `Database: ${databaseName} (DuckDB).`,
    'Catalog, already recorded as a full-scope observation of every schema:',
    catalogText(snapshot),
    '',
    'Investigate the data with run_sql, then return the ontology proposal.',
  ].join('\n');
}

async function propose(agent: Agent, messages: Message[]): Promise<Proposal> {
  const result = await agent.generate(messages, {
    maxSteps: MAX_STEPS,
    structuredOutput: { schema: proposalSchema },
  });
  return proposalSchema.parse(result.object);
}

function applyProposal(ontology: Ontology, proposal: Proposal): string[] {
  const { patch, problems } = toRevisePatch(proposal, ontology.snapshot());
  if (problems.length > 0) {
    return problems;
  }
  try {
    ontology.revise(patch);
    return [];
  } catch (error) {
    if (error instanceof RevisionError) {
      return error.problems;
    }
    throw error;
  }
}

async function extractSemantics(
  agent: Agent,
  ontology: Ontology,
  databaseName: string,
): Promise<void> {
  const messages: Message[] = [
    { role: 'user', content: taskPrompt(databaseName, ontology.snapshot()) },
  ];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const proposal = await propose(agent, messages);
    const problems = applyProposal(ontology, proposal);
    if (problems.length === 0) {
      return;
    }
    console.error(`Attempt ${attempt} rejected:\n- ${problems.join('\n- ')}`);
    messages.push(
      { role: 'assistant', content: JSON.stringify(proposal) },
      {
        role: 'user',
        content: `The ontology rejected that proposal:\n- ${problems.join('\n- ')}\nReturn a corrected, complete proposal.`,
      },
    );
  }
  throw new Error(`The agent produced no valid proposal in ${MAX_ATTEMPTS} attempts`);
}

/* eslint-disable security/detect-non-literal-fs-filename -- the artifact path comes from --out */
/** Writes the visible ontology to `out` and the whole versioned JSON store beside it. */
async function writeArtifact(out: string, ontology: Ontology): Promise<OntologySnapshot> {
  const snapshot = ontology.snapshot();
  await mkdir(dirname(out), { recursive: true });
  await writeFile(out, `${JSON.stringify(snapshot, null, 2)}\n`);
  await writeFile(
    join(dirname(out), 'ontology-store.json'),
    `${JSON.stringify(ontology.store.toJSON(), null, 2)}\n`,
  );
  return snapshot;
}
/* eslint-enable security/detect-non-literal-fs-filename */

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      model: { type: 'string' },
      'scope-only': { type: 'boolean', default: false },
    },
  });
  const out = resolve(values.out ?? DEFAULT_OUT);
  const model = values.model ?? process.env.ONTOLOGY_AGENT_MODEL ?? DEFAULT_MODEL;
  const warehouse = await Warehouse.open();
  try {
    const ontology = new Ontology();
    ontology.submitScope(await observeWarehouse(warehouse));
    if (values['scope-only']) {
      const observed = await writeArtifact(out, ontology);
      console.log(`Wrote ${out}: structure only, ${observed.tables.length} tables, no semantics`);
      return;
    }
    let queries = 0;
    const agent = createOntologyAgent(warehouse, {
      model,
      onQuery: (sql) => {
        queries += 1;
        console.error(`[run_sql ${queries}] ${sql.replaceAll(/\s+/g, ' ').slice(0, 160)}`);
      },
    });
    await extractSemantics(agent, ontology, warehouse.databaseName);
    const snapshot = await writeArtifact(out, ontology);
    console.log(
      `Wrote ${out}: ${snapshot.domains.length} domains, ${snapshot.tables.length} tables, ` +
        `${snapshot.terms.length} terms, ${snapshot.mappings.length} mappings, ` +
        `${snapshot.relations.length} relations, ${snapshot.constraints.length} constraints ` +
        `(model ${model}, ${queries} SQL queries)`,
    );
  } finally {
    warehouse.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
