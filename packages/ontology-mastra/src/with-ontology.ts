import { randomUUID } from 'node:crypto';

import { createContextProcessor } from './context-processor.js';
import { wrapSqlTool } from './sql-wrapper.js';
import { createLookupTool, createNoteTool } from './tools.js';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { Actor } from '@data-agent-ontology/ontology-core';
import type { ToolsInput } from '@mastra/core/agent';
import type { InputProcessor } from '@mastra/core/processors';

export interface OntologyOptions {
  /** Names of the user's tools that run SQL. Each is checked before it runs and traced after. */
  sqlTools: string[];
  /** Input field of those tools that holds the statement. Default `sql`. */
  sqlField?: string;
  /** Recorded on every trace, note, and proposal. Default `{ id: 'analyst-agent' }`. */
  actor?: Actor;
  /**
   * Groups traces into sessions, which the proposer needs to tell a habit from one long
   * conversation. Receives the tool context. Default: the thread id, else one id per process.
   */
  sessionId?: (context: unknown) => string;
}

/** The parts of a Mastra agent config that `withOntology` reads and extends. */
export interface UserAgentConfig {
  instructions: string;
  tools?: ToolsInput;
  inputProcessors?: InputProcessor[];
}

type Extended<C extends UserAgentConfig> = Omit<C, 'instructions' | 'tools' | 'inputProcessors'> & {
  instructions: string;
  tools: ToolsInput;
  inputProcessors: InputProcessor[];
};

export const USAGE_NOTE = `
Shared ontology
- A shared ontology describes this warehouse: terms, the tables and columns they map to, known
  joins, and rules for correct numbers. Relevant parts may appear in a system message with a
  version id. Treat them as leads to verify with SQL, not as facts.
- Call ontology_lookup when a question names a business concept and no context was given.
- Prefer the tables and joins the ontology names. If it is missing or wrong, say so in your answer.
- A tool result may carry ontology_check findings. They are advisory; fix real mistakes.
- When SQL shows a rule that future analysts need, record it with ontology_note. That files a
  proposal for review; it does not change the ontology.
`.trim();

function threadOf(context: unknown): string | undefined {
  const agent = (context as { agent?: { threadId?: unknown } } | undefined)?.agent;
  return typeof agent?.threadId === 'string' ? agent.threadId : undefined;
}

/**
 * Attaches the ontology to the user's agent config. The result goes to `new Agent(...)`.
 * The user's instructions, tools, and model stay as they were; the ontology adds two tools,
 * an input processor, SQL-tool wrapping, and a short usage note.
 */
export function withOntology<C extends UserAgentConfig>(
  config: C,
  client: OntologyClient,
  options: OntologyOptions,
): Extended<C> {
  const actor = options.actor ?? { id: 'analyst-agent' };
  const processSession = randomUUID();
  const sessionId = (context: unknown): string =>
    options.sessionId?.(context) ?? threadOf(context) ?? processSession;
  const sqlField = options.sqlField ?? 'sql';
  const wrapped = new Set(options.sqlTools);
  const tools: ToolsInput = {};
  for (const [name, tool] of Object.entries(config.tools ?? {})) {
    // eslint-disable-next-line security/detect-object-injection -- `name` comes from the agent's own tool map
    tools[name] = wrapped.has(name)
      ? wrapSqlTool(tool, { client, sqlField, actor, sessionId })
      : tool;
  }
  const unknown = options.sqlTools.filter((name) => !(name in tools));
  if (unknown.length > 0) {
    throw new Error(`sqlTools names tools the agent does not have: ${unknown.join(', ')}`);
  }
  return {
    ...config,
    instructions: `${config.instructions}\n\n${USAGE_NOTE}`,
    tools: {
      ...tools,
      ontology_lookup: createLookupTool(client),
      ontology_note: createNoteTool(client, actor, () => sessionId(undefined)),
    },
    inputProcessors: [...(config.inputProcessors ?? []), createContextProcessor(client)],
  };
}
