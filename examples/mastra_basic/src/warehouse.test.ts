import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { Ontology } from '@data-agent-ontology/ontology-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createAnalystAgent } from './agent.js';
import { DEFAULT_MODEL } from './model.js';
import { createSeedAgent } from './seed-agent.js';
import { createRunSqlTool } from './sql-tool.js';
import { Warehouse } from './warehouse.js';

let warehouse: Warehouse;

beforeAll(async () => {
  warehouse = await Warehouse.open();
});

afterAll(() => {
  warehouse.close();
});

describe('Warehouse', () => {
  it('opens the copied DuckDB file and sees its schemas', async () => {
    const result = await warehouse.query(
      "SELECT table_schema, count(*) AS n FROM information_schema.tables WHERE table_schema NOT IN ('information_schema', 'pg_catalog') GROUP BY 1 ORDER BY 1",
    );
    expect(warehouse.databaseName).toBe('jaffle_shop');
    expect(result.rows).toEqual([
      { table_schema: 'main', n: '13' },
      { table_schema: 'raw', n: '6' },
    ]);
  });

  it('returns every row of a small result and keeps aggregates', async () => {
    const rows = await warehouse.query('SELECT i FROM range(5) t(i)', 10);
    expect(rows.rows).toHaveLength(5);
    expect(rows.rowCount).toBe(5);
    expect(rows.truncated).toBe(false);
    const aggregate = await warehouse.query('SELECT count(*) AS n FROM range(1000)');
    expect(aggregate).toMatchObject({ rows: [{ n: '1000' }], rowCount: 1, truncated: false });
  });

  it('stops a finite read at maxRows and still marks a longer result truncated', async () => {
    const capped = await warehouse.query('SELECT i FROM range(10) t(i)', 3);
    expect(capped.rows).toHaveLength(3);
    expect(capped.rowCount).toBe(10);
    expect(capped.truncated).toBe(true);

    const huge = await warehouse.query('SELECT i FROM range(5000) t(i)', 10);
    expect(huge.rows).toHaveLength(10);
    expect(huge.truncated).toBe(true);
    expect(huge.rowCount).toBeGreaterThan(10);
    expect(huge.rowCount).toBeLessThan(5000);

    const all = await warehouse.query('SELECT i FROM range(250) t(i)', Number.MAX_SAFE_INTEGER);
    expect(all.rows).toHaveLength(250);
    expect(all.rowCount).toBe(250);
    expect(all.truncated).toBe(false);
  });

  it.each([
    ["SELECT * FROM read_text('package.json')", 'file system operations are disabled'],
    ["SELECT * FROM read_csv('package.json')", 'file system operations are disabled'],
    ["SELECT * FROM glob('*')", 'file system operations are disabled'],
    ["ATTACH 'other.duckdb' AS other", 'file system operations are disabled'],
    ["COPY (SELECT 1) TO 'leak.csv'", 'file system operations are disabled'],
    ['INSTALL httpfs', 'file system operations are disabled'],
    ['SET enable_external_access = true', 'configuration has been locked'],
    ['CREATE TABLE scratch (a INTEGER)', 'read-only'],
  ])('rejects %s', async (sql, message) => {
    await expect(warehouse.query(sql)).rejects.toThrow(message);
  });
});

describe('run_sql tool', () => {
  it('is the only tool the seeder has', async () => {
    const agent = createSeedAgent(warehouse, { model: 'openai/gpt-5.5' });
    expect(agent.model).toBe('openai/gpt-5.5');
    expect(Object.keys(await agent.listTools())).toEqual(['run_sql']);
  });

  it("is the analyst's only SQL tool, next to the two ontology tools", async () => {
    const agent = createAnalystAgent(warehouse, new LocalOntologyClient(new Ontology()), {
      model: 'openai/gpt-5.5',
    });
    expect(Object.keys(await agent.listTools()).sort()).toEqual([
      'ontology_lookup',
      'ontology_note',
      'run_sql',
    ]);
  });

  it('opens the suffix of a google-vertex id and leaves the api key unset', () => {
    const previous = process.env.GOOGLE_VERTEX_API_KEY;
    process.env.GOOGLE_VERTEX_API_KEY = 'express-key';
    try {
      expect(DEFAULT_MODEL).toBe('google-vertex/gemini-3.8-flash');
      const chosen = createSeedAgent(warehouse, { model: 'google-vertex/gemini-2.5-pro' });
      expect(chosen.model).toMatchObject({ modelId: 'gemini-2.5-pro' });
      const fallback = createSeedAgent(warehouse);
      expect(fallback.model).toMatchObject({ modelId: 'gemini-3.8-flash' });
      expect(process.env.GOOGLE_VERTEX_API_KEY).toBeUndefined();
    } finally {
      if (previous === undefined) {
        delete process.env.GOOGLE_VERTEX_API_KEY;
      } else {
        process.env.GOOGLE_VERTEX_API_KEY = previous;
      }
    }
  });

  it('returns errors to the agent instead of throwing', async () => {
    const tool = createRunSqlTool(warehouse);
    const context = {} as Parameters<NonNullable<typeof tool.execute>>[1];
    const output: unknown = await tool.execute?.(
      { sql: "SELECT * FROM read_text('package.json')" },
      context,
    );
    expect(output).toMatchObject({ error: expect.stringContaining('disabled') as unknown });
  });
});
