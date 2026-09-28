import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createOntologyAgent } from './agent.js';
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
  it('is the only tool the agent has', async () => {
    const agent = createOntologyAgent(warehouse, { model: 'openai/gpt-5.5' });
    expect(Object.keys(await agent.listTools())).toEqual(['run_sql']);
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
