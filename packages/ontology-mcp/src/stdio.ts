import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';

import { createOntologyMcpServer } from './server.js';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { Readable, Writable } from 'node:stream';

interface StdioStreams {
  stdin: Readable;
  stdout: Writable;
}

export interface StdioOptions {
  /** Replaces process stdin and stdout. Tests use this for an in-process pair. */
  streams?: StdioStreams;
  /** Runs when the client disconnects. Set before connect so the SDK chains it. */
  onClose?: () => void;
}

export interface RunningStdio {
  close(): Promise<void>;
}

/** Speaks MCP on stdio. No port and no token. */
export async function startStdioServer(
  client: OntologyClient,
  options: StdioOptions = {},
): Promise<RunningStdio> {
  const mcp = createOntologyMcpServer(client);
  const transport = options.streams
    ? new StdioServerTransport(options.streams.stdin, options.streams.stdout)
    : new StdioServerTransport();
  transport.onclose = () => {
    options.onClose?.();
  };
  await mcp.connect(transport);
  return {
    close: () => mcp.close(),
  };
}
