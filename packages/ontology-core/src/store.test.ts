import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection, Database } from '@ladybugdb/core';
import { describe, expect, it } from 'vitest';

import { Draft, OntologyStore, UnknownVersionError } from './store.js';

import type { Term } from './model.js';
import type { LbugValue } from '@ladybugdb/core';

const NOW = (): Date => new Date('2026-01-01T00:00:00.000Z');

const ORDER: Term = {
  termId: 'order',
  name: 'order',
  domainId: 'sales',
  definition: 'One purchase.',
  active: true,
  drifted: false,
};

const CUSTOMER: Term = {
  termId: 'customer',
  name: 'customer',
  domainId: 'crm',
  definition: 'A buyer.',
  active: true,
  drifted: false,
};

const SCHEMA = ['ActivePointer', 'Includes', 'OntologyVersion', 'Revision', 'WorkItem'];

function databasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ontology-store-')), 'ontology.lbdb');
}

function open(path: string): OntologyStore {
  return new OntologyStore(NOW, path);
}

function rows(path: string, statement: string): Record<string, LbugValue>[] {
  const database = new Database(path, 64 * 1024 * 1024, true, false, 256 * 1024 * 1024);
  const connection = new Connection(database);
  try {
    const result = connection.querySync(statement);
    if (Array.isArray(result)) {
      throw new Error('Expected one Ladybug query result');
    }
    try {
      return result.getAllSync();
    } finally {
      result.close();
    }
  } finally {
    connection.closeSync();
    database.closeSync();
  }
}

function text(value: LbugValue | undefined): string {
  if (typeof value !== 'string') {
    throw new Error('Expected a string column');
  }
  return value;
}

function tableNames(path: string): string[] {
  return rows(path, 'CALL show_tables() RETURN name')
    .map((row) => text(row.name))
    .sort((a, b) => a.localeCompare(b));
}

interface GraphFacts {
  pointer: string | null;
  versions: string[];
  revisions: string[];
  includes: string[];
}

function stageThatThrows(draft: Draft): void {
  draft.put('terms', ORDER.termId, { ...ORDER, definition: 'Should not persist.' });
  throw new Error('stage failed');
}

function facts(path: string): GraphFacts {
  const pointerRows = rows(path, 'MATCH (p:ActivePointer) RETURN p.versionId AS versionId');
  const pointer = pointerRows.length === 0 ? null : pointerRows[0].versionId;
  return {
    pointer: typeof pointer === 'string' ? pointer : null,
    versions: rows(path, 'MATCH (v:OntologyVersion) RETURN v.versionId AS versionId')
      .map((row) => text(row.versionId))
      .sort((a, b) => a.localeCompare(b)),
    revisions: rows(path, 'MATCH (r:Revision) RETURN r.revisionId AS revisionId')
      .map((row) => text(row.revisionId))
      .sort((a, b) => a.localeCompare(b)),
    includes: rows(
      path,
      'MATCH (v:OntologyVersion)-[:Includes]->(r:Revision) RETURN v.versionId AS versionId, r.revisionId AS revisionId',
    )
      .map((row) => `${text(row.versionId)}->${text(row.revisionId)}`)
      .sort((a, b) => a.localeCompare(b)),
  };
}

describe('Ladybug ontology store', () => {
  it('creates the schema once', () => {
    const path = databasePath();
    const created = open(path);
    created.close();
    expect(tableNames(path)).toEqual(SCHEMA);

    const again = open(path);
    again.close();
    expect(tableNames(path)).toEqual(SCHEMA);
  });

  it('keeps a committed version after the file is closed and reopened', () => {
    const path = databasePath();
    const store = open(path);
    const version = store.commit('scope', (draft) => {
      draft.put('terms', ORDER.termId, ORDER);
    });
    store.close();

    const reopened = open(path);
    expect(reopened.activeVersion).toEqual(version);
    expect(reopened.get('terms', ORDER.termId)).toEqual(ORDER);
    expect(reopened.listVersions()).toEqual([version]);
    reopened.close();
  });

  it('keeps one Revision node when a later version does not touch a record', () => {
    const path = databasePath();
    const store = open(path);
    const first = store.commit('scope', (draft) => {
      draft.put('terms', ORDER.termId, ORDER);
      draft.put('terms', CUSTOMER.termId, CUSTOMER);
    });
    const orderRevision = store.revisionIdOf('terms', ORDER.termId);
    const second = store.commit('revise', (draft) => {
      draft.put('terms', CUSTOMER.termId, { ...CUSTOMER, definition: 'A person who buys.' });
    });
    expect(store.revisionIdOf('terms', ORDER.termId, second.versionId)).toBe(orderRevision);
    expect(store.revisionIdOf('terms', ORDER.termId, first.versionId)).toBe(orderRevision);
    store.close();

    const reopened = open(path);
    expect(reopened.revisionIdOf('terms', ORDER.termId, second.versionId)).toBe(orderRevision);
    expect(reopened.revisionIdOf('terms', ORDER.termId, first.versionId)).toBe(orderRevision);
    reopened.close();

    const graph = facts(path);
    const orderEdges = graph.includes.filter((edge) => edge.endsWith(`->${orderRevision ?? ''}`));
    expect(orderEdges).toEqual([
      `${first.versionId}->${orderRevision ?? ''}`,
      `${second.versionId}->${orderRevision ?? ''}`,
    ]);
    expect(graph.revisions.filter((revisionId) => revisionId === orderRevision)).toEqual([
      orderRevision,
    ]);
  });

  it('moves only the active pointer when an older version is activated', () => {
    const path = databasePath();
    const store = open(path);
    const first = store.commit('scope', (draft) => {
      draft.put('terms', ORDER.termId, ORDER);
    });
    store.commit('revise', (draft) => {
      draft.put('terms', ORDER.termId, { ...ORDER, definition: 'Changed.' });
    });
    store.close();
    const before = facts(path);

    const reopened = open(path);
    const restored = reopened.activate(first.versionId);
    expect(restored.versionId).toBe(first.versionId);
    expect(reopened.listVersions().map((version) => version.versionId)).toEqual(before.versions);
    expect(reopened.get('terms', ORDER.termId)?.definition).toBe('One purchase.');
    reopened.close();

    const after = facts(path);
    expect(after.pointer).toBe(first.versionId);
    expect(after.versions).toEqual(before.versions);
    expect(after.revisions).toEqual(before.revisions);
    expect(after.includes).toEqual(before.includes);
    expect(before.pointer).not.toBe(after.pointer);
  });

  it('rejects an unknown version without moving the pointer', () => {
    const path = databasePath();
    const store = open(path);
    const version = store.commit('scope', (draft) => {
      draft.put('terms', ORDER.termId, ORDER);
    });
    expect(() => store.activate('v999')).toThrow(UnknownVersionError);
    try {
      store.activate('v999');
    } catch (error) {
      expect(error).toMatchObject({ name: 'UnknownVersionError', versionId: 'v999' });
    }
    expect(store.activeVersion?.versionId).toBe(version.versionId);
    store.close();
    expect(facts(path).pointer).toBe(version.versionId);
  });

  it('leaves the previous active version when a stage throws', () => {
    const path = databasePath();
    const store = open(path);
    const version = store.commit('scope', (draft) => {
      draft.put('terms', ORDER.termId, ORDER);
    });
    expect(() => store.commit('revise', stageThatThrows)).toThrow('stage failed');
    expect(store.activeVersion).toEqual(version);
    expect(store.get('terms', ORDER.termId)?.definition).toBe('One purchase.');
    expect(store.listVersions()).toEqual([version]);
    store.close();

    const reopened = open(path);
    expect(reopened.activeVersion).toEqual(version);
    expect(reopened.get('terms', ORDER.termId)?.definition).toBe('One purchase.');
    expect(reopened.listVersions()).toEqual([version]);
    reopened.close();
    expect(facts(path).versions).toEqual([version.versionId]);
  });
});

describe('Draft.put', () => {
  it('keeps a revision when a field is present and undefined', () => {
    let next = 0;
    const draft = new Draft(new Map(), () => {
      next += 1;
      return `r${next}`;
    });
    draft.put('terms', ORDER.termId, ORDER);
    draft.put('terms', ORDER.termId, { ...ORDER, alias: undefined } as Term);
    expect(draft.revisionIdOf('terms', ORDER.termId)).toBe('r2');
  });
});
