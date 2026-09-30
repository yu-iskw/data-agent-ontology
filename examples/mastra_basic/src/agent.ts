import { withOntology } from '@data-agent-ontology/ontology-mastra';
import { Agent } from '@mastra/core/agent';

import { DEFAULT_MODEL, resolveModel } from './model.js';
import { createRunSqlTool } from './sql-tool.js';

import type { Warehouse } from './warehouse.js';
import type { OntologyClient } from '@data-agent-ontology/ontology-client';

/** What a user's own analytics agent says. Nothing here is specific to a warehouse or to the ontology. */
const ANALYST_INSTRUCTIONS = `
You are a data analytics agent. You answer questions about the data in a SQL database.
Your tool is run_sql, which runs read-only SQL.

- Answer the question that was asked. Use run_sql to get the numbers; never invent or estimate one.
- Explore the schema with information_schema, DESCRIBE, or a small SELECT when you are unsure
  which table or column to use.
- Prefer the simplest query that answers the question, and check totals and row counts.
- Say which tables and columns your answer came from, and state any assumption you made.
- If the data cannot answer the question, say so instead of guessing.
`.trim();

interface AnalystOptions {
  model?: string;
}

/**
 * The analytics agent with the ontology attached. Everything above the `withOntology` call is
 * what a user already has; the wrapper is the whole integration.
 */
export function createAnalystAgent(
  warehouse: Warehouse,
  ontology: OntologyClient,
  options: AnalystOptions = {},
): Agent {
  return new Agent(
    withOntology(
      {
        id: 'analyst',
        name: 'Analytics agent',
        instructions: ANALYST_INSTRUCTIONS,
        model: resolveModel(options.model ?? DEFAULT_MODEL),
        tools: { run_sql: createRunSqlTool(warehouse) },
      },
      ontology,
      { sqlTools: ['run_sql'] },
    ),
  );
}
