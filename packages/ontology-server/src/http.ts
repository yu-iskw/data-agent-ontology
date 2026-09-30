import { timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';

import { ServiceError, toFailure } from './errors.js';

import type { OntologyService } from './service.js';
import type { Envelope } from '@data-agent-ontology/ontology-client';
import type { IncomingMessage, Server } from 'node:http';

const MAX_BODY_BYTES = 8 * 1024 * 1024;
const ROUTE = /^\/v1\/([A-Za-z]+)$/;

export interface ServerOptions {
  service: OntologyService;
  /** Static bearer secret (RFC section 17). Requests without it get 401. */
  token: string;
  port?: number;
  host?: string;
}

export interface RunningServer {
  url: string;
  close(): Promise<void>;
}

function authorized(request: IncomingMessage, token: string): boolean {
  const header = request.headers.authorization ?? '';
  const given = Buffer.from(header.startsWith('Bearer ') ? header.slice('Bearer '.length) : '');
  const wanted = Buffer.from(token);
  return given.length === wanted.length && timingSafeEqual(given, wanted);
}

async function readJson(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) {
      throw new ServiceError(400, 'bad_request', 'The request body is too large');
    }
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  try {
    return text === '' ? {} : (JSON.parse(text) as unknown);
  } catch {
    throw new ServiceError(400, 'bad_request', 'The request body is not valid JSON');
  }
}

async function handle(
  request: IncomingMessage,
  options: ServerOptions,
): Promise<{ status: number; envelope: Envelope<unknown> }> {
  try {
    if (!authorized(request, options.token)) {
      throw new ServiceError(401, 'unauthorized', 'Missing or wrong bearer token');
    }
    const method = ROUTE.exec(request.url ?? '')?.[1];
    if (request.method !== 'POST' || method === undefined) {
      throw new ServiceError(404, 'unknown_method', 'Use POST /v1/<method>');
    }
    const result = options.service.call(method, await readJson(request));
    return { status: 200, envelope: { ok: true, result } };
  } catch (error) {
    const { status, body } = toFailure(error);
    return { status, envelope: { ok: false, error: body } };
  }
}

/** Starts the HTTP server. The caller owns the database file for as long as the server runs. */
export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const server: Server = createServer((request, response) => {
    void handle(request, options).then(({ status, envelope }) => {
      response.writeHead(status, { 'content-type': 'application/json' });
      response.end(JSON.stringify(envelope));
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host ?? '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('The server has no TCP address');
  }
  return {
    url: `http://${address.address}:${address.port}`,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
        server.closeAllConnections();
      }),
  };
}
