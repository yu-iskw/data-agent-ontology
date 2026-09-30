import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { Ontology } from '@data-agent-ontology/ontology-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAnalystAgent } from './agent.js';
import { createSeedAgent } from './seed-agent.js';
import { Warehouse } from './warehouse.js';

let warehouse: Warehouse;

beforeAll(async () => {
  warehouse = await Warehouse.open();
});

afterAll(() => {
  warehouse.close();
});

async function instructionsOf(agent: { getInstructions(): unknown }): Promise<string> {
  return String(await agent.getInstructions());
}

describe('analyst agent', () => {
  it('carries generic analytics instructions, not the seeder method', async () => {
    const analyst = createAnalystAgent(warehouse, new LocalOntologyClient(new Ontology()), {
      model: 'openai/gpt-5.5',
    });
    const seeder = createSeedAgent(warehouse, { model: 'openai/gpt-5.5' });
    const text = await instructionsOf(analyst);
    expect(text).toContain('Answer the question that was asked');
    expect(text).toContain('Shared ontology');
    for (const hint of ['menu', 'restaurant', 'occur', 'analysisLayer']) {
      expect(text.toLowerCase()).not.toContain(hint.toLowerCase());
    }
    const seedLines = new Set(
      (await instructionsOf(seeder)).split('\n').filter((line) => line.length > 40),
    );
    expect(text.split('\n').filter((line) => seedLines.has(line))).toEqual([]);
  });
});
