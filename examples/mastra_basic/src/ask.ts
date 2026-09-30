import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { Ontology, OntologyStore } from '@data-agent-ontology/ontology-core';

import { createAnalystAgent } from './agent.js';
import { DEFAULT_MODEL } from './model.js';
import { Warehouse } from './warehouse.js';

import type { StoreJson } from '@data-agent-ontology/ontology-core';

const MAX_STEPS = 20;

/* eslint-disable security/detect-non-literal-fs-filename -- the store path comes from --ontology */
async function loadOntology(path: string | undefined): Promise<Ontology> {
  if (!path) {
    return new Ontology();
  }
  const json = JSON.parse(await readFile(path, 'utf8')) as StoreJson;
  return new Ontology(OntologyStore.fromJSON(json));
}
/* eslint-enable security/detect-non-literal-fs-filename */

/**
 * Asks the analyst agent one question. With `--ontology` (a store written by `pnpm seed`) the
 * agent reads it and files notes and traces; without it the agent runs with an empty ontology.
 */
async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: { ontology: { type: 'string' }, model: { type: 'string' } },
  });
  const question = positionals.join(' ').trim();
  if (question === '') {
    throw new Error('Usage: pnpm ask [--ontology out/ontology-store.json] "<question>"');
  }
  const ontology = await loadOntology(
    values.ontology === undefined ? undefined : resolve(values.ontology),
  );
  const warehouse = await Warehouse.open();
  try {
    const model = values.model ?? process.env.ONTOLOGY_AGENT_MODEL ?? DEFAULT_MODEL;
    const agent = createAnalystAgent(warehouse, new LocalOntologyClient(ontology), { model });
    const result = await agent.generate(question, { maxSteps: MAX_STEPS });
    console.log(result.text);
    console.error(
      `[ontology] ${ontology.listTraces().length} traces, ` +
        `${ontology.listProposals('open').length} open proposals`,
    );
  } finally {
    warehouse.close();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
