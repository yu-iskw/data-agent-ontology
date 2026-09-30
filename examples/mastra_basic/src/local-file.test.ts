import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { Ontology, OntologyStore } from '@data-agent-ontology/ontology-core';
import { describe, expect, it } from 'vitest';

describe('local ontology file', () => {
  it('keeps a recorded statement after the file is closed and reopened', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ontology-local-')), 'ontology.lbdb');
    const ontology = new Ontology(new OntologyStore(() => new Date(), path));
    const client = new LocalOntologyClient(ontology);
    await client.submitScope({
      scope: [{ engine: 'duckdb', path: 'main', completeness: 'full' }],
      tables: [],
      columns: [],
    });
    const trace = await client.recordSql({ sql: 'SELECT 1', sessionId: 's1', outcome: 'ok' });
    ontology.store.close();

    const reopened = new Ontology(new OntologyStore(() => new Date(), path));
    expect(reopened.listTraces()).toMatchObject([
      { traceId: trace.traceId, sql: 'SELECT 1', sessionId: 's1', outcome: 'ok' },
    ]);
    reopened.store.close();
  });
});
