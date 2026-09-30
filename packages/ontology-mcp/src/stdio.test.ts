import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ReadBuffer, serializeMessage } from '@modelcontextprotocol/sdk/shared/stdio.js';
import { describe, expect, it } from 'vitest';

import { openLocalOntology } from './open.js';
import { startStdioServer } from './stdio.js';

import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js';

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ontology-mcp-stdio-')), 'ontology.lbdb');
}

/** Client end of a stdio pair. The server transport reads `toServer` and writes `fromServer`. */
class LineClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  private readonly buffer = new ReadBuffer();

  constructor(
    private readonly toServer: PassThrough,
    private readonly fromServer: PassThrough,
  ) {}

  start(): Promise<void> {
    this.fromServer.on('data', (chunk: Buffer | string) => {
      const bytes = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      this.buffer.append(bytes);
      this.drain();
    });
    return Promise.resolve();
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const written = this.toServer.write(Buffer.from(serializeMessage(message)));
    if (written) {
      return;
    }
    await new Promise<void>((resolve) => {
      this.toServer.once('drain', resolve);
    });
  }

  close(): Promise<void> {
    this.toServer.end();
    this.onclose?.();
    return Promise.resolve();
  }

  private drain(): void {
    const deliver = this.onmessage;
    if (deliver === undefined) {
      return;
    }
    let message = this.buffer.readMessage();
    while (message !== null) {
      deliver(message);
      message = this.buffer.readMessage();
    }
  }
}

describe('stdio transport', () => {
  it('constructs and lists tools over an in-process stdio pair', async () => {
    expect(new StdioServerTransport(new PassThrough(), new PassThrough())).toBeInstanceOf(
      StdioServerTransport,
    );
    const toServer = new PassThrough();
    const fromServer = new PassThrough();
    const opened = openLocalOntology(databasePath());
    const running = await startStdioServer(opened.client, {
      streams: { stdin: toServer, stdout: fromServer },
    });
    const client = new Client({ name: 'ontology-mcp-test', version: '0.0.0' });
    const transport = new LineClientTransport(toServer, fromServer);
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        'context',
        'lookup',
        'check_sql',
        'record_sql',
        'note',
        'list_proposals',
      ]);
    } finally {
      await client.close();
      await running.close();
      opened.close();
    }
  });
});
