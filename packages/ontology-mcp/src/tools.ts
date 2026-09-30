import { z } from 'zod';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

/** Shown on the tools that file work for a curator. */
export const PROPOSALS_DO_NOT_CHANGE_TRUSTED_KNOWLEDGE =
  'Notes and traces file proposals and do not change trusted knowledge.';

const actorSchema = z.object({
  id: z.string().describe('Actor id.'),
  onBehalfOf: z.string().optional().describe('User the actor acts for, when there is one.'),
});

const proposalStatusSchema = z.enum(['open', 'accepted', 'rejected']);

/**
 * Keeps an optional-field object visible to the MCP SDK after `.default({})`.
 *
 * The SDK parses `arguments` with the tool schema and passes `undefined` when
 * the client omits the field. `.default({})` turns that into `{}`. The SDK
 * publishes a schema only when `def.type` is `"object"` or `def.shape` is set.
 * A default wrapper is type `"default"`, so the object shape is copied onto it
 * and the optional `status` filter stays in the published schema.
 */
function keepPublishedShape<Shape extends z.ZodRawShape>(
  schema: z.ZodDefault<z.ZodObject<Shape>>,
  shape: z.ZodObject<Shape>['shape'],
): z.ZodDefault<z.ZodObject<Shape>> {
  Object.assign(schema.def, { shape });
  return schema;
}

const listProposalsArguments = z.object({
  status: proposalStatusSchema.optional().describe('Filter by status. Omit for every status.'),
});

function textResult(value: unknown): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

/** Registers the analyst tools. Accept, revise, and submit stay off this server. */
export function registerOntologyTools(server: McpServer, client: OntologyClient): void {
  server.registerTool(
    'context',
    {
      description:
        'Read the prompt-ready ontology context for a question (terms, mappings, joins, constraints). Does not change trusted knowledge.',
      inputSchema: {
        question: z.string().describe('The question or topic to resolve.'),
      },
    },
    async ({ question }) => textResult(await client.contextFor(question)),
  );

  server.registerTool(
    'lookup',
    {
      description:
        'Browse terms and domains that match a question. Same job as ontology_lookup. Read-only. Does not change trusted knowledge.',
      inputSchema: {
        question: z.string().describe('The question or topic to look up.'),
      },
    },
    async ({ question }) => textResult(await client.browse(question)),
  );

  server.registerTool(
    'check_sql',
    {
      description:
        'Advisory check of one SQL statement against the active ontology version. Findings do not block the statement and do not change trusted knowledge.',
      inputSchema: {
        sql: z.string().describe('One SQL statement.'),
      },
    },
    async ({ sql }) => textResult(await client.checkSql(sql)),
  );

  server.registerTool(
    'record_sql',
    {
      description: `Record one SQL statement as a trace. ${PROPOSALS_DO_NOT_CHANGE_TRUSTED_KNOWLEDGE}`,
      inputSchema: {
        sql: z.string().describe('The SQL statement that ran.'),
        sessionId: z.string().describe('Session that ran the statement.'),
        outcome: z.enum(['ok', 'error']).describe('Whether the statement succeeded.'),
        question: z.string().optional().describe('Question the statement answered.'),
        error: z.string().optional().describe('Engine error, when outcome is error.'),
        actor: actorSchema.optional().describe('Who ran the statement.'),
      },
    },
    async ({ sql, sessionId, outcome, question, error, actor }) =>
      textResult(await client.recordSql({ sql, sessionId, outcome, question, error, actor })),
  );

  server.registerTool(
    'note',
    {
      description: `File a note about a term as a proposal. ${PROPOSALS_DO_NOT_CHANGE_TRUSTED_KNOWLEDGE}`,
      inputSchema: {
        termId: z.string().describe('Id of the term the note is about.'),
        statement: z.string().describe('The rule, in one sentence.'),
        evidenceSql: z.string().optional().describe('SQL that shows the statement holds.'),
        sessionId: z.string().describe('Session that filed the note.'),
        actor: actorSchema.describe('Who filed the note.'),
      },
    },
    async ({ termId, statement, evidenceSql, sessionId, actor }) =>
      textResult(await client.note({ termId, statement, evidenceSql, sessionId, actor })),
  );

  server.registerTool(
    'list_proposals',
    {
      description:
        'List proposals filed from notes and traces. Read-only. Accepting a proposal stays on the library or the ontology HTTP service.',
      inputSchema: keepPublishedShape(
        listProposalsArguments.default({}),
        listProposalsArguments.shape,
      ),
    },
    async ({ status }) => textResult(await client.listProposals(status)),
  );
}
