import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';

import { PROPOSALS_DO_NOT_CHANGE_TRUSTED_KNOWLEDGE, registerOntologyTools } from './tools.js';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';

/** An MCP server bound to one ontology client. The caller owns the database file. */
export function createOntologyMcpServer(client: OntologyClient): McpServer {
  const server = new McpServer(
    { name: 'ontology-mcp', version: '0.1.0' },
    {
      instructions: `${PROPOSALS_DO_NOT_CHANGE_TRUSTED_KNOWLEDGE} Curator accept stays on the ontology library or ontology-server.`,
    },
  );
  registerOntologyTools(server, client);
  return server;
}
