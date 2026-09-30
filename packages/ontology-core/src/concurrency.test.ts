import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection, Database } from '@ladybugdb/core';
import { describe, expect, it } from 'vitest';

import { ActiveVersionChangedError, MergeConflictError } from './merge.js';
import { Ontology } from './ontology.js';
import { RevertConflictError, RevertRootError } from './revert.js';
import { OntologyStore } from './store.js';

import type { MergeConflict } from './merge.js';
import type { RevisePatch, Submission } from './model.js';

const ORDERS = 'bigquery:proj.sales.orders';
const ALICE = { id: 'agent-a', onBehalfOf: 'alice' };
const BOB = { id: 'agent-b', onBehalfOf: 'bob' };

function structure(
  completeness: 'full' | 'partial',
  tables: Record<string, string[]>,
  observedAt?: string,
): Submission {
  return {
    ...(observedAt && { observedAt }),
    scope: [{ engine: 'bigquery', path: 'proj.sales', completeness }],
    tables: Object.keys(tables).map((name) => ({
      engine: 'bigquery' as const,
      path: `proj.sales.${name}`,
      kind: 'table' as const,
    })),
    columns: Object.entries(tables).flatMap(([name, columns]) =>
      columns.map((column, index) => ({
        engine: 'bigquery' as const,
        tablePath: `proj.sales.${name}`,
        name: column,
        dataType: 'STRING',
        ordinalPosition: index + 1,
      })),
    ),
  };
}

const BASE_PATCH: RevisePatch = {
  summary: 'seed',
  domains: [{ domainId: 'sales', name: 'Sales', parentDomainId: null }],
  memberships: [{ tableId: ORDERS, domainIds: ['sales'] }],
  terms: [
    { termId: 'order', name: 'order', domainId: 'sales', definition: 'One purchase.' },
    { termId: 'refund', name: 'refund', domainId: 'sales', definition: 'Money returned.' },
  ],
};

class Clock {
  private tick = 0;

  now = (): Date => new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick++));

  /** The instant of the latest commit: an observation read after it predates every later commit. */
  latest(): string {
    return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick - 1)).toISOString();
  }
}

function seeded(clock = new Clock()): { ontology: Ontology; clock: Clock } {
  const ontology = new Ontology(new OntologyStore(clock.now));
  ontology.submitScope(structure('full', { orders: ['order_id', 'amount'] }));
  ontology.revise(BASE_PATCH);
  return { ontology, clock };
}

function reviseTerm(termId: string, definition: string): RevisePatch {
  return {
    summary: definition,
    terms: [{ termId, name: termId, domainId: 'sales', definition }],
  };
}

function conflictsOf(action: () => unknown): MergeConflict[] {
  try {
    action();
  } catch (error) {
    if (error instanceof MergeConflictError) {
      return error.conflicts;
    }
    throw error;
  }
  throw new Error('Expected a merge conflict');
}

describe('two writers revise from the same base', () => {
  it('rejects the second write to the same term instead of replacing the first', () => {
    const { ontology } = seeded();
    const base = ontology.browse('order').versionId;
    ontology.revise(reviseTerm('order', 'Alice: gross of refunds'), {
      baseVersionId: base,
      actor: ALICE,
    });

    const conflicts = conflictsOf(() =>
      ontology.revise(reviseTerm('order', 'Bob: net of refunds'), {
        baseVersionId: base,
        actor: BOB,
      }),
    );

    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ kind: 'terms', id: 'order' });
    expect(conflicts[0].theirs).toMatchObject({ definition: 'Alice: gross of refunds' });
    expect(conflicts[0].mine).toMatchObject({ definition: 'Bob: net of refunds' });
    expect(ontology.store.get('terms', 'order')?.definition).toBe('Alice: gross of refunds');
    expect(ontology.store.listVersions()).toHaveLength(3);
  });

  it('merges a disjoint write onto the head and records both actors and the base', () => {
    const { ontology } = seeded();
    const base = ontology.browse('order').versionId;
    ontology.revise(reviseTerm('order', 'Alice: gross of refunds'), {
      baseVersionId: base,
      actor: ALICE,
    });
    const merged = ontology.revise(reviseTerm('refund', 'Bob: money returned to the buyer'), {
      baseVersionId: base,
      actor: BOB,
    });

    expect(merged).toMatchObject({
      parentVersionId: 'v3',
      mergedFromVersionId: base,
      actor: BOB,
    });
    expect(ontology.store.get('terms', 'order')?.definition).toBe('Alice: gross of refunds');
    expect(ontology.store.get('terms', 'refund')?.definition).toBe(
      'Bob: money returned to the buyer',
    );
    expect(ontology.store.listVersions().map((version) => version.actor)).toEqual([
      undefined,
      undefined,
      ALICE,
      BOB,
    ]);
  });

  it('rejects a stale write that puts the base value back over a newer edit', () => {
    const { ontology } = seeded();
    const base = ontology.browse('order').versionId;
    ontology.revise(reviseTerm('order', 'Alice'), { baseVersionId: base, actor: ALICE });

    const conflicts = conflictsOf(() =>
      ontology.revise(reviseTerm('order', 'One purchase.'), { baseVersionId: base, actor: BOB }),
    );

    expect(conflicts.map((conflict) => `${conflict.kind}:${conflict.id}`)).toEqual(['terms:order']);
    expect(ontology.store.get('terms', 'order')?.definition).toBe('Alice');
    expect(ontology.store.listVersions()).toHaveLength(3);
  });

  it('treats a stale write the head already holds as no conflict', () => {
    const { ontology } = seeded();
    const base = ontology.browse('order').versionId;
    ontology.revise(reviseTerm('order', 'Same words'), { baseVersionId: base });
    expect(() =>
      ontology.revise(reviseTerm('order', 'Same words'), { baseVersionId: base }),
    ).not.toThrow();
    expect(ontology.store.get('terms', 'order')?.definition).toBe('Same words');
  });

  it('rejects opposite constraints added to one term from the same base', () => {
    const { ontology } = seeded();
    const base = ontology.browse('order').versionId;
    ontology.revise(
      { summary: 'a', constraints: [{ termId: 'order', text: 'Include cancelled orders.' }] },
      { baseVersionId: base, actor: ALICE },
    );

    const conflicts = conflictsOf(() =>
      ontology.revise(
        { summary: 'b', constraints: [{ termId: 'order', text: 'Exclude cancelled orders.' }] },
        { baseVersionId: base, actor: BOB },
      ),
    );

    expect(conflicts[0]).toMatchObject({ kind: 'constraints' });
    expect(ontology.store.list('constraints').map((constraint) => constraint.text)).toEqual([
      'Include cancelled orders.',
    ]);
  });

  it('applies a rebased constraint after the writer has read the head', () => {
    const { ontology } = seeded();
    const first = ontology.revise(
      { summary: 'a', constraints: [{ termId: 'order', text: 'Include cancelled orders.' }] },
      { actor: ALICE },
    );
    ontology.revise(
      { summary: 'b', constraints: [{ termId: 'order', text: 'Exclude tax lines.' }] },
      { baseVersionId: first.versionId, actor: BOB },
    );
    expect(ontology.store.list('constraints')).toHaveLength(2);
  });
});

describe('compare-and-set on the active pointer', () => {
  it('rejects a write when the active version is not the expected one', () => {
    const { ontology } = seeded();
    const stale = ontology.browse('order').versionId;
    ontology.revise(reviseTerm('order', 'moved on'));
    expect(() =>
      ontology.revise(reviseTerm('refund', 'late'), { baseVersionId: stale, actor: BOB }),
    ).not.toThrow();
    expect(() => ontology.revert('v3', { expectedActive: stale })).toThrow(
      ActiveVersionChangedError,
    );
    expect(() => ontology.rollback('v1', { expectedActive: stale })).toThrow(
      ActiveVersionChangedError,
    );
    expect(ontology.store.activeVersion?.versionId).toBe('v4');
  });

  it('rejects a base version that does not exist', () => {
    const { ontology } = seeded();
    expect(() => ontology.revise(reviseTerm('order', 'x'), { baseVersionId: 'v99' })).toThrow(
      'Unknown ontology version: v99',
    );
  });
});

describe('a stale full-scope submission', () => {
  it('does not deactivate a table another agent added after it was observed', () => {
    const { ontology, clock } = seeded();
    const observedAt = clock.latest();
    ontology.submitScope(structure('partial', { refunds: ['refund_id'] }), { actor: BOB });

    ontology.submitScope(structure('full', { orders: ['order_id', 'amount'] }, observedAt), {
      actor: ALICE,
    });

    expect(ontology.store.get('tables', 'bigquery:proj.sales.refunds')?.active).toBe(true);
    expect(ontology.store.get('columns', 'bigquery:proj.sales.refunds.refund_id')?.active).toBe(
      true,
    );
  });

  it('still deactivates a table that vanished before it was observed', () => {
    const { ontology, clock } = seeded();
    ontology.submitScope(structure('partial', { refunds: ['refund_id'] }));
    const observedAt = clock.latest();

    ontology.submitScope(structure('full', { orders: ['order_id', 'amount'] }, observedAt));

    expect(ontology.store.get('tables', 'bigquery:proj.sales.refunds')?.active).toBe(false);
  });

  it('deactivates a column an abandoned version removed when a fresh full snapshot omits it', () => {
    const clock = new Clock();
    const ontology = new Ontology(new OntologyStore(clock.now));
    ontology.submitScope(structure('full', { orders: ['order_id', 'legacy'] }));
    ontology.submitScope(structure('full', { orders: ['order_id'] }));
    ontology.rollback('v1');
    const legacy = `${ORDERS}.legacy`;
    expect(ontology.store.get('columns', legacy)?.active).toBe(true);

    ontology.submitScope(structure('full', { orders: ['order_id'] }, clock.latest()));

    expect(ontology.store.get('columns', legacy)?.active).toBe(false);
  });

  it('keeps a column another agent added to a table the stale scope did observe', () => {
    const { ontology, clock } = seeded();
    const observedAt = clock.latest();
    ontology.submitScope(structure('partial', { orders: ['order_id', 'amount', 'currency'] }));

    ontology.submitScope(structure('full', { orders: ['order_id', 'amount'] }, observedAt));

    expect(ontology.store.get('columns', `${ORDERS}.currency`)?.active).toBe(true);
  });
});

describe('rollback and revert', () => {
  function threeChanges(): Ontology {
    const { ontology } = seeded();
    ontology.revise(reviseTerm('order', 'change one'), { actor: ALICE });
    ontology.revise(reviseTerm('refund', 'change two'), { actor: BOB });
    ontology.revise(
      { summary: 'three', constraints: [{ termId: 'order', text: 'Exclude cancelled orders.' }] },
      { actor: ALICE },
    );
    return ontology;
  }

  it('drops later changes on rollback but keeps them on revert', () => {
    const rolledBack = threeChanges();
    rolledBack.rollback('v3');
    expect(rolledBack.store.list('constraints')).toHaveLength(0);
    expect(rolledBack.store.get('terms', 'refund')?.definition).toBe('Money returned.');

    const reverted = threeChanges();
    const version = reverted.revert('v4', { expectedActive: 'v5', actor: BOB });
    expect(version).toMatchObject({ reason: 'revert', parentVersionId: 'v5', actor: BOB });
    expect(reverted.store.get('terms', 'refund')?.definition).toBe('Money returned.');
    expect(reverted.store.get('terms', 'order')?.definition).toBe('change one');
    expect(reverted.store.list('constraints')).toHaveLength(1);
  });

  it('removes records the reverted version created', () => {
    const { ontology } = seeded();
    ontology.revise({
      summary: 'a note',
      constraints: [{ termId: 'order', text: 'Exclude cancelled orders.' }],
    });
    ontology.revert('v3');
    expect(ontology.store.list('constraints')).toEqual([]);
    expect(ontology.snapshot().evidence.map((item) => item.targetId)).not.toContain(
      'order:exclude_cancelled_orders',
    );
  });

  it('refuses to revert a change a later version changed again', () => {
    const { ontology } = seeded();
    ontology.revise(reviseTerm('order', 'first'));
    ontology.revise(reviseTerm('order', 'second'));
    expect(() => ontology.revert('v3')).toThrow(RevertConflictError);
    expect(ontology.store.get('terms', 'order')?.definition).toBe('second');
  });

  it('refuses to revert the first version', () => {
    const { ontology } = seeded();
    expect(() => ontology.revert('v1')).toThrow(RevertRootError);
  });

  it('reports a stale write after a rollback instead of losing it silently', () => {
    const ontology = threeChanges();
    const readByAlice = ontology.store.activeVersion?.versionId;
    ontology.rollback('v3', { expectedActive: readByAlice });

    const conflicts = conflictsOf(() =>
      ontology.revise(reviseTerm('refund', 'Alice again'), {
        baseVersionId: readByAlice,
        actor: ALICE,
      }),
    );
    expect(conflicts.map((conflict) => `${conflict.kind}:${conflict.id}`)).toEqual([
      'terms:refund',
    ]);
  });
});

describe('version metadata', () => {
  it('survives reopening the database file and a JSON round trip', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ontology-actor-')), 'ontology.lbdb');
    const first = new OntologyStore(undefined, path);
    const ontology = new Ontology(first);
    ontology.submitScope(structure('full', { orders: ['order_id'] }), { actor: ALICE });
    ontology.revise(BASE_PATCH, { actor: BOB, proposalId: 'p-1' });
    const before = first.listVersions();
    first.close();

    const reopened = new OntologyStore(undefined, path);
    expect(reopened.listVersions()).toEqual(before);
    expect(before[1]).toMatchObject({ actor: BOB, proposalId: 'p-1' });
    const copy = OntologyStore.fromJSON(reopened.toJSON());
    expect(copy.listVersions()).toEqual(before);
    copy.close();
    reopened.close();
  });

  it('adds the metadata column to a database created before it existed', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'ontology-legacy-')), 'ontology.lbdb');
    const legacy = new Database(path, 64 * 1024 * 1024, true, false, 256 * 1024 * 1024);
    const connection = new Connection(legacy);
    connection.initSync();
    for (const ddl of [
      'CREATE NODE TABLE Revision(revisionId STRING, kind STRING, recordId STRING, payload STRING, PRIMARY KEY (revisionId))',
      'CREATE NODE TABLE OntologyVersion(versionId STRING, parentVersionId STRING, createdAt STRING, reason STRING, PRIMARY KEY (versionId))',
      'CREATE REL TABLE Includes(FROM OntologyVersion TO Revision)',
      'CREATE NODE TABLE ActivePointer(pointerId STRING, versionId STRING, PRIMARY KEY (pointerId))',
      "CREATE (:OntologyVersion {versionId: 'v1', parentVersionId: NULL, createdAt: '2026-01-01T00:00:00.000Z', reason: 'scope'})",
      "CREATE (:ActivePointer {pointerId: 'active', versionId: 'v1'})",
    ]) {
      connection.querySync(ddl);
    }
    connection.closeSync();
    legacy.closeSync();

    const store = new OntologyStore(undefined, path);
    const ontology = new Ontology(store);
    ontology.submitScope(structure('full', { orders: ['order_id'] }), { actor: ALICE });
    expect(store.listVersions().map((version) => version.actor)).toEqual([undefined, ALICE]);
    store.close();
  });
});

function wideStructure(tableCount: number, columnCount: number): Submission {
  const tables = Array.from({ length: tableCount }, (_, index) => `main.t${index}`);
  const columnsOf = (tablePath: string): Submission['columns'] =>
    Array.from({ length: columnCount }, (_, index) => ({
      engine: 'duckdb' as const,
      tablePath,
      name: `c${index}`,
      dataType: 'INTEGER',
      ordinalPosition: index + 1,
    }));
  return {
    scope: [{ engine: 'duckdb', path: 'main', completeness: 'full' }],
    tables: tables.map((path) => ({ engine: 'duckdb' as const, path, kind: 'table' as const })),
    columns: tables.flatMap(columnsOf),
  };
}

describe('commit cost', () => {
  it('does not scale a one-record commit with the size of the ontology', () => {
    const ontology = new Ontology();
    const started = Date.now();
    ontology.submitScope(wideStructure(300, 10));
    const firstCommit = Date.now() - started;

    const revised = Date.now();
    ontology.revise({
      summary: 'one record',
      domains: [{ domainId: 'd', name: 'D', parentDomainId: null }],
    });
    const oneRecord = Date.now() - revised;

    expect(ontology.store.list('columns')).toHaveLength(3000);
    // Per-record lookups took about 5 s and 3.7 s on the same input.
    expect(firstCommit).toBeLessThan(2500);
    expect(oneRecord).toBeLessThan(1000);
  });
});
