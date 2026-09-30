import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

import { createOntologyMcpServer } from './server.js';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';

const MCP_PATH = '/mcp';
export const DEFAULT_HTTP_PORT = 8788;
export const DEFAULT_HTTP_HOST = '127.0.0.1';

const JSON_HEADERS = { 'content-type': 'application/json' };

interface HttpListenOptions {
  client: OntologyClient;
  /** Non-empty bearer secret. Missing or wrong tokens are rejected. */
  token: string;
  port?: number;
  host?: string;
}

interface RunningMcpHttp {
  url: string;
  close(): Promise<void>;
}

function bearer(request: IncomingMessage): string {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) {
    return '';
  }
  return header.slice('Bearer '.length);
}

function authorized(request: IncomingMessage, token: string): boolean {
  const given = Buffer.from(bearer(request));
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

function pathname(url: string | undefined): string {
  return new URL(url ?? '/', 'http://127.0.0.1').pathname;
}

function writeJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, JSON_HEADERS);
  response.end(JSON.stringify(body));
}

async function dispatch(
  request: IncomingMessage,
  response: ServerResponse,
  client: OntologyClient,
): Promise<void> {
  const mcp = createOntologyMcpServer(client);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.on('close', () => {
    void transport.close();
    void mcp.close();
  });
  await mcp.connect(transport);
  await transport.handleRequest(request, response);
}

async function handle(
  request: IncomingMessage,
  response: ServerResponse,
  options: HttpListenOptions,
): Promise<void> {
  if (!authorized(request, options.token)) {
    writeJson(response, 401, { error: 'unauthorized' });
    return;
  }
  if (pathname(request.url) !== MCP_PATH) {
    writeJson(response, 404, { error: 'not_found' });
    return;
  }
  // Standalone GET SSE is optional. POST is Streamable HTTP with a JSON body.
  if (request.method !== 'POST' && request.method !== 'DELETE') {
    response.writeHead(405, { allow: 'POST, DELETE' });
    response.end();
    return;
  }
  await dispatch(request, response, options.client);
}

/** Streamable HTTP on `/mcp`. One process, bearer token required. */
export async function startHttpServer(options: HttpListenOptions): Promise<RunningMcpHttp> {
  if (options.token.length === 0) {
    throw new Error('HTTP transport requires a non-empty bearer token');
  }
  const server: Server = createServer((request, response) => {
    void handle(request, response, options).catch((error: unknown) => {
      console.error(error);
      if (!response.headersSent) {
        writeJson(response, 500, { error: 'internal' });
      }
    });
  });
  const host = options.host ?? DEFAULT_HTTP_HOST;
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? DEFAULT_HTTP_PORT, host, resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server has no TCP address');
  }
  return {
    url: `http://${address.address}:${address.port}${MCP_PATH}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
