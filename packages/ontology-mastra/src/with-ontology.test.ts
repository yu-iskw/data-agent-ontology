import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { seededOntology, STRUCTURE } from '@data-agent-ontology/ontology-client/testing';
import { Ontology } from '@data-agent-ontology/ontology-core';
import { createTool } from '@mastra/core/tools';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { USAGE_NOTE, withOntology } from './with-ontology.js';

import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { InputProcessor } from '@mastra/core/processors';

type InputArgs = Parameters<NonNullable<InputProcessor['processInput']>>[0];
type Executable = {
  execute: (input: Record<string, unknown>, context: unknown) => Promise<Record<string, unknown>>;
};

const INSTRUCTIONS = 'You answer data questions with read-only SQL.';

function runSqlTool(behavior: (sql: string) => unknown = () => ({ rows: [] })) {
  return createTool({
    id: 'run_sql',
    description: 'Run SQL.',
    inputSchema: z.object({ sql: z.string() }),
    execute: async ({ sql }) => {
      await Promise.resolve();
      return behavior(sql);
    },
  });
}

function setup(ontology = seededOntology(), behavior?: (sql: string) => unknown) {
  const client = new LocalOntologyClient(ontology);
  const userTool = runSqlTool(behavior);
  const config = withOntology(
    { instructions: INSTRUCTIONS, tools: { run_sql: userTool } },
    client,
    {
      sqlTools: ['run_sql'],
    },
  );
  return { ontology, client, config, userTool };
}

async function injected(client: OntologyClient, question: string): Promise<string[]> {
  const [processor] = withOntology({ instructions: INSTRUCTIONS }, client, {
    sqlTools: [],
  }).inputProcessors;
  const args = {
    messages: [
      {
        id: 'm1',
        role: 'user',
        createdAt: new Date(),
        content: { format: 2, parts: [{ type: 'text', text: question }] },
      },
    ],
    systemMessages: [{ role: 'system', content: 'existing' }],
  } as unknown as InputArgs;
  const result = (await processor.processInput?.(args)) as unknown as {
    systemMessages: { content: string }[];
  };
  return result.systemMessages.map((message) => message.content);
}

function tool(config: ReturnType<typeof setup>['config'], name: string): Executable {
  // eslint-disable-next-line security/detect-object-injection -- fixed names in this test
  return config.tools[name] as unknown as Executable;
}

describe('withOntology config', () => {
  it('keeps the instructions and tools and adds the note, tools, and processor', () => {
    const { config, userTool } = setup();
    expect(config.instructions.startsWith(INSTRUCTIONS)).toBe(true);
    expect(config.instructions.endsWith(USAGE_NOTE)).toBe(true);
    expect(USAGE_NOTE.split('\n').length).toBeLessThanOrEqual(12);
    expect(Object.keys(config.tools).sort()).toEqual([
      'ontology_lookup',
      'ontology_note',
      'run_sql',
    ]);
    expect(config.tools.run_sql).not.toBe(userTool);
    expect(config.inputProcessors.map((processor) => processor.id)).toEqual(['ontology-context']);
  });

  it('does not touch tools that are not named as SQL tools', () => {
    const client = new LocalOntologyClient(seededOntology());
    const other = runSqlTool();
    const config = withOntology({ instructions: INSTRUCTIONS, tools: { other } }, client, {
      sqlTools: [],
    });
    expect(config.tools.other).toBe(other);
  });

  it('refuses a SQL tool name the agent does not have', () => {
    const client = new LocalOntologyClient(seededOntology());
    expect(() =>
      withOntology({ instructions: INSTRUCTIONS }, client, { sqlTools: ['run_sql'] }),
    ).toThrow('run_sql');
  });
});

describe('use loop, offline', () => {
  const QUESTIONS: [string, string[]][] = [
    ['total order amount per customer', ['proj.sales.orders', 'proj.sales.customers']],
    ['how many refunds were issued last week', ['proj.sales.refunds']],
  ];

  it.each(QUESTIONS)(
    'injects context that names the right tables for: %s',
    async (question, tables) => {
      const { client } = setup();
      const messages = await injected(client, question);
      expect(messages[0]).toBe('existing');
      expect(messages).toHaveLength(2);
      expect(messages[1]).toContain('ontology version v2');
      for (const table of tables) {
        expect(messages[1]).toContain(table);
      }
    },
  );

  it('injects nothing when the question matches no term', async () => {
    const { client } = setup();
    expect(await injected(client, 'what is the weather in paris')).toEqual(['existing']);
  });

  it('has no context to inject without an ontology, or without the wrapper', async () => {
    const structureOnly = new Ontology();
    structureOnly.submitScope(STRUCTURE);
    const bare = new LocalOntologyClient(structureOnly);
    for (const [question] of QUESTIONS) {
      expect(await injected(bare, question)).toEqual(['existing']);
    }
    const plain = { instructions: INSTRUCTIONS, tools: { run_sql: runSqlTool() } };
    expect('inputProcessors' in plain).toBe(false);
    expect(Object.keys(plain.tools)).toEqual(['run_sql']);
  });

  it('flags an unknown column and a wrong join on the wrapped SQL tool, and still runs the SQL', async () => {
    const ran: string[] = [];
    const { config } = setup(undefined, (sql) => {
      ran.push(sql);
      return { rows: [] };
    });
    const runSql = tool(config, 'run_sql');

    const column = (await runSql.execute(
      { sql: 'SELECT o.ammount FROM proj.sales.orders o' },
      {},
    )) as { ontology_check: string[] };
    expect(column.ontology_check).toContain(
      'error: Column ammount is not on proj.sales.orders; did you mean amount?',
    );

    const join = (await runSql.execute(
      {
        sql: 'SELECT 1 FROM proj.sales.customers c JOIN proj.sales.orders o ON c.customer_id = o.order_id',
      },
      {},
    )) as { ontology_check: string[] };
    expect(join.ontology_check.join('\n')).toContain(
      'warning: Join c.customer_id = o.order_id differs from the known join: customers.customer_id = orders.customer_id',
    );
    expect(ran).toHaveLength(2);
  });

  it('adds nothing to a result for a statement that matches the ontology', async () => {
    const { config } = setup(undefined, () => ({ rows: [{ n: 1 }] }));
    const result = await tool(config, 'run_sql').execute(
      { sql: 'SELECT o.amount FROM proj.sales.orders o WHERE o.order_id = 1' },
      {},
    );
    expect(result.ontology_check).toEqual(['note: order: Exclude cancelled orders.']);
  });
});

describe('traces', () => {
  it('records each statement with its outcome, actor, and session', async () => {
    const { config, ontology } = setup(undefined, (sql) =>
      sql.includes('bad') ? { error: 'Binder Error' } : { rows: [] },
    );
    const runSql = tool(config, 'run_sql');
    await runSql.execute(
      { sql: 'SELECT 1 FROM proj.sales.orders' },
      { agent: { threadId: 't-1' } },
    );
    await runSql.execute(
      { sql: 'SELECT bad FROM proj.sales.orders' },
      { agent: { threadId: 't-2' } },
    );
    const traces = ontology.listTraces();
    expect(traces.map((trace) => [trace.outcome, trace.sessionId])).toEqual([
      ['ok', 't-1'],
      ['error', 't-2'],
    ]);
    expect(traces[1]).toMatchObject({
      error: 'Binder Error',
      actor: { id: 'analyst-agent' },
      versionId: 'v2',
      tableIds: ['bigquery:proj.sales.orders'],
    });
  });

  it('records a thrown failure and rethrows it', async () => {
    const { config, ontology } = setup(undefined, () => {
      throw new Error('connection lost');
    });
    await expect(
      tool(config, 'run_sql').execute({ sql: 'SELECT 1 FROM proj.sales.orders' }, {}),
    ).rejects.toThrow('connection lost');
    expect(ontology.listTraces()).toMatchObject([{ outcome: 'error', error: 'connection lost' }]);
  });

  it('turns replayed joins into a relation proposal for a curator', async () => {
    const { config, client } = setup();
    const runSql = tool(config, 'run_sql');
    for (const thread of ['t-1', 't-1', 't-2']) {
      await runSql.execute(
        {
          sql: 'SELECT 1 FROM proj.sales.refunds r JOIN proj.sales.orders o ON r.order_id = o.order_id',
        },
        { agent: { threadId: thread } },
      );
    }
    const [proposal] = await client.proposeRelations();
    expect(proposal).toMatchObject({ kind: 'relation', support: 3, sessions: ['t-1', 't-2'] });
  });

  it('still runs the SQL when the ontology is unreachable', async () => {
    const down: OntologyClient = Object.assign(
      Object.create(new LocalOntologyClient(seededOntology())) as OntologyClient,
      {
        checkSql: () => Promise.reject(new Error('down')),
        recordSql: () => Promise.reject(new Error('down')),
      },
    );
    const config = withOntology(
      { instructions: INSTRUCTIONS, tools: { run_sql: runSqlTool(() => ({ rows: [1] })) } },
      down,
      { sqlTools: ['run_sql'] },
    );
    expect(await tool(config, 'run_sql').execute({ sql: 'SELECT 1' }, {})).toEqual({ rows: [1] });
  });
});

describe('ontology tools', () => {
  it('ontology_lookup browses and resolves in one call', async () => {
    const { config } = setup();
    const result = await tool(config, 'ontology_lookup').execute(
      { question: 'refunds per order' },
      {},
    );
    expect(result).toMatchObject({ versionId: 'v2' });
    expect(result.context).toContain('refund');
    expect(
      await tool(config, 'ontology_lookup').execute({ question: 'weather' }, {}),
    ).toMatchObject({
      termIds: [],
      context: '',
    });
  });

  it('ontology_note files a proposal without changing the ontology', async () => {
    const { config, ontology } = setup();
    const result = await tool(config, 'ontology_note').execute(
      {
        termId: 'order',
        statement: 'Amounts are in dollars.',
        evidence: 'SELECT max(amount) FROM proj.sales.orders',
      },
      {},
    );
    expect(result).toEqual({ proposalId: 'p1', status: 'open', support: 1 });
    expect(ontology.listProposals()).toMatchObject([
      { kind: 'constraint', proposer: { id: 'analyst-agent' } },
    ]);
    expect(ontology.store.listVersions()).toHaveLength(2);
  });
});
