import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { RemoteOntologyClient } from '@data-agent-ontology/ontology-client';
import {
  describeClientContract,
  seededOntology,
  STRUCTURE,
  SEMANTICS,
} from '@data-agent-ontology/ontology-client/testing';
import { Ontology, OntologyStore } from '@data-agent-ontology/ontology-core';
import { describe, expect, it } from 'vitest';

import { ServiceError, toFailure } from './errors.js';
import { startServer } from './http.js';
import { OntologyService } from './service.js';

import type { RunningServer } from './http.js';
import type { RevisePatch } from '@data-agent-ontology/ontology-core';

const TOKEN = 'test-secret';
const run = promisify(execFile);

interface Running {
  server: RunningServer;
  client: RemoteOntologyClient;
  ontology: Ontology;
}

async function start(ontology = seededOntology()): Promise<Running> {
  const server = await startServer({ service: new OntologyService(ontology), token: TOKEN });
  return { server, ontology, client: new RemoteOntologyClient({ url: server.url, token: TOKEN }) };
}

describeClientContract('remote', async () => {
  const { server, client } = await start();
  return { client, close: () => server.close() };
});

function newTerm(index: number): RevisePatch {
  return {
    summary: `term ${index}`,
    terms: [
      { termId: `t${index}`, name: `t${index}`, domainId: 'sales', definition: `Term ${index}.` },
    ],
  };
}

function editOrder(index: number): RevisePatch {
  return {
    summary: `edit ${index}`,
    terms: [{ termId: 'order', name: 'order', domainId: 'sales', definition: `Edit ${index}.` }],
  };
}

describe('parallel clients', () => {
  it('merges disjoint writes from many clients without losing an update', async () => {
    const { server, client, ontology } = await start();
    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, index) =>
          client.revise(newTerm(index), { baseVersionId: 'v2', actor: { id: `agent-${index}` } }),
        ),
      );
      expect(new Set(results.map((version) => version.versionId)).size).toBe(10);
      const names = ontology.snapshot().terms.map((term) => term.termId);
      for (let index = 0; index < 10; index += 1) {
        expect(names).toContain(`t${index}`);
      }
      expect(ontology.store.listVersions()).toHaveLength(12);
    } finally {
      await server.close();
    }
  });

  it('lets exactly one of many overlapping writers win and rejects the rest with 409', async () => {
    const { server, client, ontology } = await start();
    try {
      const outcomes = await Promise.allSettled(
        Array.from({ length: 8 }, (_, index) =>
          client.revise(editOrder(index), { baseVersionId: 'v2' }),
        ),
      );
      const winners = outcomes.flatMap((outcome, index) =>
        outcome.status === 'fulfilled' ? [index] : [],
      );
      const losers = outcomes.filter((outcome) => outcome.status === 'rejected');
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(7);
      for (const loser of losers) {
        expect(loser.reason).toMatchObject({ name: 'MergeConflictError' });
      }
      expect(ontology.store.get('terms', 'order')?.definition).toBe(`Edit ${winners[0]}.`);
      expect(ontology.store.listVersions()).toHaveLength(3);
    } finally {
      await server.close();
    }
  });
});

describe('http surface', () => {
  it('keeps 401 and 404 on service errors', () => {
    expect(toFailure(new ServiceError(401, 'unauthorized', 'no'))).toMatchObject({
      status: 401,
      body: { code: 'unauthorized' },
    });
    expect(toFailure(new ServiceError(404, 'unknown_method', 'missing'))).toMatchObject({
      status: 404,
      body: { code: 'unknown_method' },
    });
  });

  it('sends the unknown version id in details', async () => {
    const { server, client } = await start();
    try {
      const response = await fetch(`${server.url}/v1/rollback`, {
        method: 'POST',
        headers: { authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
        body: JSON.stringify({ versionId: 'v999' }),
      });
      expect(response.status).toBe(404);
      expect(await response.json()).toMatchObject({
        ok: false,
        error: { code: 'unknown_version', details: { versionId: 'v999' } },
      });
      await expect(client.rollback('v999')).rejects.toMatchObject({
        name: 'UnknownVersionError',
        versionId: 'v999',
      });
    } finally {
      await server.close();
    }
  });

  it('rejects a request without the bearer token', async () => {
    const { server } = await start();
    try {
      const response = await fetch(`${server.url}/v1/snapshot`, { method: 'POST', body: '{}' });
      expect(response.status).toBe(401);
      expect(await response.json()).toMatchObject({ ok: false, error: { code: 'unauthorized' } });
      const wrong = new RemoteOntologyClient({ url: server.url, token: 'nope' });
      await expect(wrong.snapshot()).rejects.toMatchObject({ name: 'RemoteError', status: 401 });
    } finally {
      await server.close();
    }
  });

  it('answers unknown methods and malformed bodies with 404 and 400', async () => {
    const { server } = await start();
    const headers = { authorization: `Bearer ${TOKEN}` };
    try {
      const unknown = await fetch(`${server.url}/v1/drop`, { method: 'POST', headers, body: '{}' });
      expect(unknown.status).toBe(404);
      const broken = await fetch(`${server.url}/v1/browse`, { method: 'POST', headers, body: '{' });
      expect(broken.status).toBe(400);
      const missing = await fetch(`${server.url}/v1/browse`, {
        method: 'POST',
        headers,
        body: '{}',
      });
      expect(missing.status).toBe(400);
    } finally {
      await server.close();
    }
  });
});

describe('one process per database file', () => {
  it('makes a second process fail to open the file the service holds', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ontology-lock-')), 'ontology.lbdb');
    const store = new OntologyStore(undefined, path);
    const ontology = new Ontology(store);
    ontology.submitScope(STRUCTURE);
    ontology.revise(SEMANTICS);
    const { server } = await start(ontology);
    try {
      const child = `
        const { Database, Connection } = require('@ladybugdb/core');
        const db = new Database(${JSON.stringify(path)}, 64 * 1024 * 1024, true, false, 256 * 1024 * 1024);
        new Connection(db).initSync();
      `;
      const failure: unknown = await run(process.execPath, ['-e', child]).catch(
        (error: unknown) => error,
      );
      expect(failure).toHaveProperty('code', 1);
      expect(String((failure as { stderr: string }).stderr)).toMatch(/lock/i);
    } finally {
      await server.close();
      store.close();
    }
  });
});
