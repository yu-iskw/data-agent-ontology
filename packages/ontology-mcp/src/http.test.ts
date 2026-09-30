import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { describe, expect, it } from 'vitest';

import { startHttpServer } from './http.js';
import { openLocalOntology } from './open.js';

const TOKEN = 'test-secret';
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MCP_HEADERS = {
  authorization: `Bearer ${TOKEN}`,
  'content-type': 'application/json',
  accept: 'application/json, text/event-stream',
};

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ontology-mcp-http-')), 'ontology.lbdb');
}

describe('streamable http', () => {
  it('rejects a missing or wrong bearer token and lists tools with the right one', async () => {
    const opened = openLocalOntology(databasePath());
    const running = await startHttpServer({ client: opened.client, token: TOKEN, port: 0 });
    try {
      const missing = await fetch(running.url, { method: 'POST', body: '{}' });
      expect(missing.status).toBe(401);
      const wrong = await fetch(running.url, {
        method: 'POST',
        headers: { authorization: 'Bearer nope' },
        body: '{}',
      });
      expect(wrong.status).toBe(401);
      const empty = await fetch(running.url, {
        method: 'POST',
        headers: { authorization: 'Bearer ' },
        body: '{}',
      });
      expect(empty.status).toBe(401);

      const rejected = new Client({ name: 'ontology-mcp-test', version: '0.0.0' });
      const bad = new StreamableHTTPClientTransport(new URL(running.url), {
        requestInit: { headers: { Authorization: 'Bearer nope' } },
      });
      await expect(rejected.connect(bad)).rejects.toThrow();
      await bad.close().catch(() => undefined);

      const client = new Client({ name: 'ontology-mcp-test', version: '0.0.0' });
      const transport = new StreamableHTTPClientTransport(new URL(running.url), {
        requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
      });
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain('context');
      expect(listed.tools.map((tool) => tool.name)).not.toContain('submitScope');
      await client.close();
    } finally {
      await running.close();
      opened.close();
    }
  });

  it('rejects a POST body over 8 MiB with 400 after the bearer check', async () => {
    const opened = openLocalOntology(databasePath());
    const running = await startHttpServer({ client: opened.client, token: TOKEN, port: 0 });
    const oversized = Buffer.alloc(MAX_BODY_BYTES + 1);
    try {
      const missing = await fetch(running.url, { method: 'POST', body: oversized });
      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({ error: 'unauthorized' });

      const rejected = await fetch(running.url, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: oversized,
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.json()).toEqual({
        error: 'bad_request',
        message: 'The request body is too large',
      });

      const atCap = await fetch(running.url, {
        method: 'POST',
        headers: MCP_HEADERS,
        body: Buffer.alloc(MAX_BODY_BYTES, 0x7b),
      });
      expect(atCap.status).not.toBe(401);
      expect(await atCap.json()).not.toMatchObject({ message: 'The request body is too large' });
    } finally {
      await running.close();
      opened.close();
    }
  });
});
