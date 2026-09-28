import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

import type { Warehouse } from './warehouse.js';

const SQL_TOOL_ROW_LIMIT = 200;

/** The agent's only tool: one read-only SQL statement against the locked-down DuckDB file. */
export function createRunSqlTool(warehouse: Warehouse, onQuery?: (sql: string) => void) {
  return createTool({
    id: 'run_sql',
    description:
      `Run one read-only DuckDB SQL statement against the ${warehouse.databaseName} warehouse and ` +
      `return up to ${SQL_TOOL_ROW_LIMIT} rows as JSON. Use information_schema, DESCRIBE, SUMMARIZE, ` +
      'or SELECT. Writes, file access, ATTACH, COPY, SET, and extensions are rejected.',
    inputSchema: z.object({
      sql: z.string().describe('A single DuckDB SQL statement.'),
    }),
    execute: async ({ sql }) => {
      onQuery?.(sql);
      try {
        return await warehouse.query(sql, SQL_TOOL_ROW_LIMIT);
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) };
      }
    },
  });
}
