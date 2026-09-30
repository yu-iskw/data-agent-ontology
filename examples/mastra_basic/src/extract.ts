import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { Ontology } from '@data-agent-ontology/ontology-core';

import { createOntologyAgent, DEFAULT_MODEL } from './agent.js';
import { applyProposal } from './apply.js';
import { observeWarehouse } from './observe.js';
import { proposalSchema } from './proposal.js';
import { RECORDING_FORMAT, readRecording, writeRecording } from './recording.js';
import { Warehouse } from './warehouse.js';

import type { Proposal } from './proposal.js';
import type { Recording } from './recording.js';
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

async function extractSemantics(
  agent: Agent,
  ontology: Ontology,
  databaseName: string,
): Promise<Proposal> {
  const messages: Message[] = [
    { role: 'user', content: taskPrompt(databaseName, ontology.snapshot()) },
  ];
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    const proposal = await propose(agent, messages);
    const problems = applyProposal(ontology, proposal);
    if (problems.length === 0) {
      return proposal;
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

interface Run {
  proposal: Proposal;
  sql: Recording['sql'];
  model: string;
}

/** Runs the agent against the warehouse and returns the accepted proposal with the SQL it ran. */
async function runLive(warehouse: Warehouse, ontology: Ontology, model: string): Promise<Run> {
  const sql: Recording['sql'] = [];
  const agent = createOntologyAgent(warehouse, {
    model,
    onQuery: (statement, error) => {
      sql.push({ sql: statement, ...(error && { error }) });
      console.error(`[run_sql ${sql.length}] ${statement.replaceAll(/\s+/g, ' ').slice(0, 160)}`);
    },
  });
  const proposal = await extractSemantics(agent, ontology, warehouse.databaseName);
  return { proposal, sql, model };
}

/** Applies a recorded proposal without a model, so a run can be repeated offline. */
async function runReplay(ontology: Ontology, path: string): Promise<Run> {
  const recording = await readRecording(path);
  const problems = applyProposal(ontology, recording.proposal);
  if (problems.length > 0) {
    throw new Error(`The recorded proposal no longer applies:\n- ${problems.join('\n- ')}`);
  }
  return { proposal: recording.proposal, sql: recording.sql, model: recording.model };
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      out: { type: 'string' },
      model: { type: 'string' },
      'scope-only': { type: 'boolean', default: false },
      record: { type: 'string' },
      replay: { type: 'string' },
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
    const run = values.replay
      ? await runReplay(ontology, resolve(values.replay))
      : await runLive(warehouse, ontology, model);
    if (values.record) {
      await writeRecording(resolve(values.record), {
        format: RECORDING_FORMAT,
        model: run.model,
        sql: run.sql,
        proposal: run.proposal,
      });
    }
    const snapshot = await writeArtifact(out, ontology);
    console.log(
      `Wrote ${out}: ${snapshot.domains.length} domains, ${snapshot.tables.length} tables, ` +
        `${snapshot.terms.length} terms, ${snapshot.mappings.length} mappings, ` +
        `${snapshot.relations.length} relations, ${snapshot.constraints.length} constraints ` +
        `(${values.replay ? 'replayed' : `model ${run.model}`}, ${run.sql.length} SQL queries)`,
    );
  } finally {
    warehouse.close();
  }
}

function isMissingCredentials(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${String(error.cause)}` : String(error);
  return text.includes('Could not load the default credentials');
}

main().catch((error: unknown) => {
  if (isMissingCredentials(error)) {
    console.error(
      'No Google Application Default Credentials: run `gcloud auth application-default login` ' +
        'or set GOOGLE_APPLICATION_CREDENTIALS for project ubie-yu-sandbox (Vertex, location global). ' +
        'Use --replay <recording.json> to run without a model.',
    );
  } else {
    console.error(error);
  }
  process.exitCode = 1;
});
