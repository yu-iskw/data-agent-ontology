import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SEMANTICS, STRUCTURE } from '@data-agent-ontology/ontology-client/testing';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it } from 'vitest';

import { openLocalOntology } from './open.js';
import { createOntologyMcpServer } from './server.js';
import { PROPOSALS_DO_NOT_CHANGE_TRUSTED_KNOWLEDGE } from './tools.js';

import type { Submission } from '@data-agent-ontology/ontology-core';

const MINIMAL_SCOPE: Submission = {
  scope: [{ engine: 'duckdb', path: 'main', completeness: 'partial' }],
  tables: [{ engine: 'duckdb', path: 'main.orders', kind: 'table' }],
  columns: [
    {
      engine: 'duckdb',
      tablePath: 'main.orders',
      name: 'order_id',
      dataType: 'INTEGER',
      ordinalPosition: 1,
    },
  ],
};

const FORBIDDEN = [
  'acceptProposal',
  'rejectProposal',
  'revise',
  'revert',
  'rollback',
  'submitScope',
];

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ontology-mcp-')), 'ontology.lbdb');
}

function textOf(result: unknown): string {
  if (typeof result !== 'object' || result === null || !('content' in result)) {
    throw new Error('Expected a text tool result');
  }
  const { content } = result;
  if (!Array.isArray(content)) {
    throw new Error('Expected a text tool result');
  }
  const block: unknown = content[0];
  if (
    typeof block !== 'object' ||
    block === null ||
    !('type' in block) ||
    !('text' in block) ||
    block.type !== 'text' ||
    typeof block.text !== 'string'
  ) {
    throw new Error('Expected a text tool result');
  }
  return block.text;
}

async function connect(file: string): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const opened = openLocalOntology(file);
  const server = createOntologyMcpServer(opened.client);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'ontology-mcp-test', version: '0.0.0' });
  await client.connect(clientTransport);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
      opened.close();
    },
  };
}

describe('ontology mcp tools', () => {
  it('lists only the read and propose tools', async () => {
    const session = await connect(databasePath());
    try {
      const listed = await session.client.listTools();
      const names = listed.tools.map((tool) => tool.name);
      expect(names).toEqual([
        'context',
        'lookup',
        'check_sql',
        'record_sql',
        'note',
        'list_proposals',
      ]);
      for (const name of FORBIDDEN) {
        expect(names).not.toContain(name);
      }
      const byName = new Map(listed.tools.map((tool) => [tool.name, tool.description]));
      expect(byName.get('note')).toContain(PROPOSALS_DO_NOT_CHANGE_TRUSTED_KNOWLEDGE);
      expect(byName.get('record_sql')).toContain(PROPOSALS_DO_NOT_CHANGE_TRUSTED_KNOWLEDGE);
    } finally {
      await session.close();
    }
  });

  it('files a note as an open proposal that survives close and reopen', async () => {
    const file = databasePath();
    const seeded = openLocalOntology(file);
    await seeded.client.submitScope(MINIMAL_SCOPE);
    seeded.close();

    const filing = await connect(file);
    try {
      const noted = await filing.client.callTool({
        name: 'note',
        arguments: {
          termId: 'order',
          statement: 'Exclude cancelled orders.',
          evidenceSql: 'SELECT 1',
          sessionId: 'session-1',
          actor: { id: 'analyst' },
        },
      });
      expect(noted.isError).not.toBe(true);
      const proposal = JSON.parse(textOf(noted)) as { status: string; proposalId: string };
      expect(proposal.status).toBe('open');
    } finally {
      await filing.close();
    }

    const reopened = await connect(file);
    try {
      const listed = await reopened.client.callTool({
        name: 'list_proposals',
        arguments: { status: 'open' },
      });
      expect(listed.isError).not.toBe(true);
      const proposals = JSON.parse(textOf(listed)) as {
        status: string;
        patch: { constraints?: { text: string }[] };
      }[];
      expect(proposals).toHaveLength(1);
      expect(proposals[0]?.status).toBe('open');
      expect(proposals[0]?.patch.constraints?.[0]?.text).toBe('Exclude cancelled orders.');
    } finally {
      await reopened.close();
    }
  });

  it('returns the seeded term from context and lookup', async () => {
    const file = databasePath();
    const seeded = openLocalOntology(file);
    await seeded.client.submitScope(STRUCTURE);
    await seeded.client.revise(SEMANTICS);
    seeded.close();

    const session = await connect(file);
    try {
      const context = await session.client.callTool({
        name: 'context',
        arguments: { question: 'total order amount' },
      });
      const lookup = await session.client.callTool({
        name: 'lookup',
        arguments: { question: 'total order amount' },
      });
      expect(context.isError).not.toBe(true);
      expect(lookup.isError).not.toBe(true);
      const resolved = JSON.parse(textOf(context)) as { text: string; termIds: string[] };
      const browsed = JSON.parse(textOf(lookup)) as { hits: { id: string; kind: string }[] };
      expect(resolved.termIds).toContain('order');
      expect(resolved.text).toContain('order');
      expect(browsed.hits).toContainEqual(expect.objectContaining({ id: 'order', kind: 'term' }));
    } finally {
      await session.close();
    }
  });

  it('does not submit a scope when check_sql has no active version', async () => {
    const session = await connect(databasePath());
    try {
      const checked = await session.client.callTool({
        name: 'check_sql',
        arguments: { sql: 'SELECT 1' },
      });
      expect(checked.isError).toBe(true);
      expect(textOf(checked)).toContain('submit a scope first');
    } finally {
      await session.close();
    }
  });
});
