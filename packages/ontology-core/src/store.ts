import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection, Database } from '@ladybugdb/core';

import type { OntologyRecords, RecordKind, Version, VersionReason } from './model.js';
import type { LbugValue, QueryResult } from '@ladybugdb/core';

interface Revision {
  readonly revisionId: string;
  readonly value: Readonly<OntologyRecords[RecordKind]>;
}

type RecordTable = ReadonlyMap<string, Revision>;

type RecordTables = ReadonlyMap<RecordKind, RecordTable>;

type SqlParams = Record<string, LbugValue>;

type SqlRow = Record<string, LbugValue>;

const ACTIVE_POINTER_ID = 'active';

/** Default Ladybug mmap is 8 TiB, which fails once a process opens more than a few databases. */
const BUFFER_POOL_BYTES = 64 * 1024 * 1024;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;

const RECORD_KINDS = [
  'domains',
  'tables',
  'columns',
  'terms',
  'mappings',
  'relations',
  'constraints',
  'evidence',
] as const satisfies readonly RecordKind[];

const EMPTY_RECORDS: RecordTables = new Map();

const SCHEMA = [
  {
    name: 'Revision',
    ddl: `CREATE NODE TABLE Revision(
      revisionId STRING,
      kind STRING,
      recordId STRING,
      payload STRING,
      PRIMARY KEY (revisionId)
    )`,
  },
  {
    name: 'OntologyVersion',
    ddl: `CREATE NODE TABLE OntologyVersion(
      versionId STRING,
      parentVersionId STRING,
      createdAt STRING,
      reason STRING,
      PRIMARY KEY (versionId)
    )`,
  },
  {
    name: 'Includes',
    ddl: 'CREATE REL TABLE Includes(FROM OntologyVersion TO Revision)',
  },
  {
    name: 'ActivePointer',
    ddl: `CREATE NODE TABLE ActivePointer(
      pointerId STRING,
      versionId STRING,
      PRIMARY KEY (pointerId)
    )`,
  },
] as const;

const SHOW_TABLES = 'CALL show_tables() RETURN name';
const READ_POINTER =
  'MATCH (p:ActivePointer {pointerId: $pointerId}) RETURN p.versionId AS versionId';
const SET_POINTER = 'MATCH (p:ActivePointer {pointerId: $pointerId}) SET p.versionId = $versionId';
const INSERT_POINTER = 'CREATE (:ActivePointer {pointerId: $pointerId, versionId: NULL})';
const INSERT_VERSION = `CREATE (:OntologyVersion {
  versionId: $versionId,
  parentVersionId: $parentVersionId,
  createdAt: $createdAt,
  reason: $reason
})`;
const INSERT_REVISION = `CREATE (:Revision {
  revisionId: $revisionId,
  kind: $kind,
  recordId: $recordId,
  payload: $payload
})`;
const FIND_REVISION =
  'MATCH (r:Revision {revisionId: $revisionId}) RETURN r.revisionId AS revisionId';
const LINK_REVISION = `MATCH (v:OntologyVersion {versionId: $versionId}), (r:Revision {revisionId: $revisionId})
CREATE (v)-[:Includes]->(r)`;
const LIST_VERSIONS = `MATCH (v:OntologyVersion)
RETURN v.versionId AS versionId, v.parentVersionId AS parentVersionId,
  v.createdAt AS createdAt, v.reason AS reason`;
const READ_VERSION = `MATCH (v:OntologyVersion {versionId: $versionId})
RETURN v.versionId AS versionId, v.parentVersionId AS parentVersionId,
  v.createdAt AS createdAt, v.reason AS reason`;
const READ_RECORDS = `MATCH (v:OntologyVersion {versionId: $versionId})-[:Includes]->(r:Revision)
RETURN r.revisionId AS revisionId, r.kind AS kind, r.recordId AS recordId, r.payload AS payload`;
const READ_KIND = `MATCH (v:OntologyVersion {versionId: $versionId})-[:Includes]->(r:Revision)
WHERE r.kind = $kind
RETURN r.revisionId AS revisionId, r.recordId AS recordId, r.payload AS payload`;
const READ_ONE = `MATCH (v:OntologyVersion {versionId: $versionId})-[:Includes]->(r:Revision)
WHERE r.kind = $kind AND r.recordId = $recordId
RETURN r.revisionId AS revisionId, r.payload AS payload`;
const LIST_REVISION_IDS = 'MATCH (r:Revision) RETURN r.revisionId AS revisionId';

export class UnknownVersionError extends Error {
  constructor(versionId: string) {
    super(`Unknown ontology version: ${versionId}`);
    this.name = 'UnknownVersionError';
  }
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, inner: unknown) => {
    if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) {
      return inner;
    }
    return Object.fromEntries(
      Object.entries(inner as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)),
    );
  });
}

function defaultDatabasePath(): string {
  return join(mkdtempSync(join(tmpdir(), 'ontology-store-')), 'ontology.lbdb');
}

function oneResult(result: QueryResult | QueryResult[]): QueryResult {
  if (!Array.isArray(result)) {
    return result;
  }
  if (result.length !== 1) {
    throw new Error('Expected one Ladybug query result');
  }
  return result[0];
}

function firstRow(result: readonly SqlRow[]): SqlRow | undefined {
  if (result.length === 0) {
    return undefined;
  }
  return result[0];
}

function requireString(value: LbugValue | undefined, label: string): string {
  if (typeof value !== 'string') {
    throw new Error(`Expected ${label} to be a string`);
  }
  return value;
}

function optionalString(value: LbugValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

function recordKind(value: string): RecordKind {
  const kind = RECORD_KINDS.find((item) => item === value);
  if (!kind) {
    throw new Error(`Unexpected record kind: ${value}`);
  }
  return kind;
}

function versionReason(value: string): VersionReason {
  if (value === 'scope' || value === 'revise') {
    return value;
  }
  throw new Error(`Unexpected version reason: ${value}`);
}

function versionFromRow(row: SqlRow): Version {
  return {
    versionId: requireString(row.versionId, 'versionId'),
    parentVersionId: optionalString(row.parentVersionId),
    createdAt: requireString(row.createdAt, 'createdAt'),
    reason: versionReason(requireString(row.reason, 'reason')),
  };
}

function parsePayload(payload: string): OntologyRecords[RecordKind] {
  const value: unknown = JSON.parse(payload) as unknown;
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Revision payload is not a record');
  }
  return Object.freeze(structuredClone(value)) as OntologyRecords[RecordKind];
}

function revisionNumber(revisionId: string): number {
  return Number(revisionId.slice(1)) || 0;
}

function versionNumber(versionId: string): number {
  return Number(versionId.slice(1)) || 0;
}

/**
 * Staged writes for one mutation. Unchanged records keep their existing revision,
 * so versions share every record the mutation did not touch.
 */
export class Draft {
  private readonly written = new Map<RecordKind, Map<string, Revision>>();

  constructor(
    private readonly base: RecordTables,
    private readonly nextRevisionId: () => string,
  ) {}

  get<K extends RecordKind>(kind: K, id: string): OntologyRecords[K] | undefined {
    return this.table(kind).get(id)?.value as OntologyRecords[K] | undefined;
  }

  list<K extends RecordKind>(kind: K): OntologyRecords[K][] {
    return [...this.table(kind).values()].map((revision) => revision.value as OntologyRecords[K]);
  }

  put<K extends RecordKind>(kind: K, id: string, value: OntologyRecords[K]): void {
    const current = this.table(kind).get(id);
    if (current && stableJson(current.value) === stableJson(value)) {
      return;
    }
    let target = this.written.get(kind);
    if (!target) {
      target = new Map(this.base.get(kind) ?? []);
      this.written.set(kind, target);
    }
    target.set(id, {
      revisionId: this.nextRevisionId(),
      value: Object.freeze(structuredClone(value)),
    });
  }

  toRecords(): RecordTables {
    const merged = new Map<RecordKind, RecordTable>(this.base);
    for (const [kind, table] of this.written) {
      merged.set(kind, table);
    }
    return merged;
  }

  private table(kind: RecordKind): RecordTable {
    return this.written.get(kind) ?? this.base.get(kind) ?? new Map<string, Revision>();
  }
}

export const STORE_FORMAT = 'data-agent-ontology/store@1';

/** JSON form of the whole store. Each revision is written once and listed by every version sharing it. */
export interface StoreJson {
  /** `STORE_FORMAT` when written by this package; checked on load because files may come from elsewhere. */
  format: string;
  activeVersionId: string | null;
  revisions: {
    revisionId: string;
    kind: RecordKind;
    id: string;
    value: OntologyRecords[RecordKind];
  }[];
  versions: { version: Version; revisionIds: string[] }[];
}

/**
 * Versioned record store (RFC sections 12 and 13) persisted in one Ladybug database.
 * Every commit creates an immutable version; rollback only moves the active pointer.
 * `toJSON` / `fromJSON` are the example export, not the database.
 */
export class OntologyStore {
  private readonly database: Database;
  private readonly connection: Connection;
  private revisionCounter = 0;

  constructor(
    private readonly now: () => Date = () => new Date(),
    databasePath: string = defaultDatabasePath(),
  ) {
    this.database = new Database(databasePath, BUFFER_POOL_BYTES, true, false, MAX_DATABASE_BYTES);
    this.connection = new Connection(this.database);
    this.connection.initSync();
    this.ensureSchema();
    this.revisionCounter = this.maxRevisionNumber();
  }

  get activeVersion(): Version | null {
    const versionId = this.pointerVersionId();
    return versionId === null ? null : this.requireVersion(versionId);
  }

  static fromJSON(json: StoreJson, now?: () => Date): OntologyStore {
    if (json.format !== STORE_FORMAT) {
      throw new Error(`Unsupported store format: ${json.format}`);
    }
    const store = new OntologyStore(now);
    try {
      OntologyStore.importInto(store, json);
    } catch (error) {
      store.close();
      throw error;
    }
    return store;
  }

  private static importInto(store: OntologyStore, json: StoreJson): void {
    store.importJson(json);
  }

  listVersions(): Version[] {
    return this.rows(LIST_VERSIONS)
      .map((row) => versionFromRow(row))
      .sort(
        (a, b) =>
          versionNumber(a.versionId) - versionNumber(b.versionId) ||
          a.versionId.localeCompare(b.versionId),
      );
  }

  get<K extends RecordKind>(
    kind: K,
    id: string,
    versionId?: string,
  ): OntologyRecords[K] | undefined {
    return this.record(kind, id, versionId)?.value as OntologyRecords[K] | undefined;
  }

  list<K extends RecordKind>(kind: K, versionId?: string): OntologyRecords[K][] {
    const id = this.resolveVersionId(versionId);
    if (id === null) {
      return [];
    }
    return this.rows(READ_KIND, { versionId: id, kind })
      .map((row) => ({
        recordId: requireString(row.recordId, 'recordId'),
        value: parsePayload(requireString(row.payload, 'payload')) as OntologyRecords[K],
      }))
      .sort((a, b) => a.recordId.localeCompare(b.recordId))
      .map((entry) => entry.value);
  }

  /** Revision id of a record in a version. Equal ids across versions mean a shared revision. */
  revisionIdOf(kind: RecordKind, id: string, versionId?: string): string | undefined {
    return this.record(kind, id, versionId)?.revisionId;
  }

  /** Runs `stage` against a draft of the active version. If it throws, nothing is committed. */
  commit(reason: VersionReason, stage: (draft: Draft) => void): Version {
    const counter = this.revisionCounter;
    let created: Version | undefined;
    try {
      this.transaction(() => {
        const draft = new Draft(this.recordsOf(), () => {
          this.revisionCounter += 1;
          return `r${this.revisionCounter}`;
        });
        stage(draft);
        created = {
          versionId: `v${this.listVersions().length + 1}`,
          parentVersionId: this.pointerVersionId(),
          createdAt: this.now().toISOString(),
          reason,
        };
        this.insertVersion(created, draft.toRecords());
      });
    } catch (error) {
      this.revisionCounter = counter;
      throw error;
    }
    if (!created) {
      throw new Error('Commit did not create a version');
    }
    return created;
  }

  activate(versionId: string): Version {
    const version = this.requireVersion(versionId);
    this.transaction(() => {
      this.run(SET_POINTER, { pointerId: ACTIVE_POINTER_ID, versionId });
    });
    return version;
  }

  toJSON(): StoreJson {
    const revisions = new Map<string, StoreJson['revisions'][number]>();
    const versions = this.listVersions().map((version) => {
      const revisionIds: string[] = [];
      for (const [kind, table] of this.recordsOf(version.versionId)) {
        for (const [id, revision] of table) {
          revisions.set(revision.revisionId, {
            revisionId: revision.revisionId,
            kind,
            id,
            value: revision.value,
          });
          revisionIds.push(revision.revisionId);
        }
      }
      return { version, revisionIds };
    });
    return {
      format: STORE_FORMAT,
      activeVersionId: this.pointerVersionId(),
      revisions: [...revisions.values()],
      versions,
    };
  }

  /** Releases the database so another store can open the same `*.lbdb` file. */
  close(): void {
    this.connection.closeSync();
    this.database.closeSync();
  }

  private ensureSchema(): void {
    const existing = new Set(this.rows(SHOW_TABLES).map((row) => requireString(row.name, 'name')));
    for (const table of SCHEMA) {
      if (!existing.has(table.name)) {
        this.connection.querySync(table.ddl);
      }
    }
    const pointer = this.rows(READ_POINTER, { pointerId: ACTIVE_POINTER_ID });
    if (pointer.length === 0) {
      this.run(INSERT_POINTER, { pointerId: ACTIVE_POINTER_ID });
    }
  }

  private importJson(json: StoreJson): void {
    this.transaction(() => {
      this.loadJson(json);
    });
    this.revisionCounter = this.maxRevisionNumber();
  }

  private loadJson(json: StoreJson): void {
    const known = new Set(json.revisions.map((revision) => revision.revisionId));
    for (const revision of json.revisions) {
      this.run(INSERT_REVISION, {
        revisionId: revision.revisionId,
        kind: revision.kind,
        recordId: revision.id,
        payload: JSON.stringify(revision.value),
      });
    }
    for (const { version, revisionIds } of json.versions) {
      this.run(INSERT_VERSION, {
        versionId: version.versionId,
        parentVersionId: version.parentVersionId,
        createdAt: version.createdAt,
        reason: version.reason,
      });
      for (const revisionId of revisionIds) {
        if (!known.has(revisionId)) {
          throw new Error(`Store JSON lists unknown revision ${revisionId}`);
        }
        this.run(LINK_REVISION, { versionId: version.versionId, revisionId });
      }
    }
    if (json.activeVersionId !== null) {
      this.requireVersion(json.activeVersionId);
      this.run(SET_POINTER, { pointerId: ACTIVE_POINTER_ID, versionId: json.activeVersionId });
    }
  }

  private insertVersion(version: Version, records: RecordTables): void {
    this.run(INSERT_VERSION, {
      versionId: version.versionId,
      parentVersionId: version.parentVersionId,
      createdAt: version.createdAt,
      reason: version.reason,
    });
    for (const [kind, table] of records) {
      for (const [recordId, revision] of table) {
        this.ensureRevision(kind, recordId, revision);
        this.run(LINK_REVISION, { versionId: version.versionId, revisionId: revision.revisionId });
      }
    }
    this.run(SET_POINTER, { pointerId: ACTIVE_POINTER_ID, versionId: version.versionId });
  }

  private ensureRevision(kind: RecordKind, recordId: string, revision: Revision): void {
    const existing = this.rows(FIND_REVISION, { revisionId: revision.revisionId });
    if (existing.length > 0) {
      return;
    }
    this.run(INSERT_REVISION, {
      revisionId: revision.revisionId,
      kind,
      recordId,
      payload: JSON.stringify(revision.value),
    });
  }

  private recordsOf(versionId?: string): RecordTables {
    const id = this.resolveVersionId(versionId);
    if (id === null) {
      return EMPTY_RECORDS;
    }
    const records = new Map<RecordKind, Map<string, Revision>>();
    for (const row of this.rows(READ_RECORDS, { versionId: id })) {
      const kind = recordKind(requireString(row.kind, 'kind'));
      const table = records.get(kind) ?? new Map<string, Revision>();
      table.set(requireString(row.recordId, 'recordId'), {
        revisionId: requireString(row.revisionId, 'revisionId'),
        value: parsePayload(requireString(row.payload, 'payload')),
      });
      records.set(kind, table);
    }
    return records;
  }

  private record(kind: RecordKind, recordId: string, versionId?: string): Revision | undefined {
    const id = this.resolveVersionId(versionId);
    if (id === null) {
      return undefined;
    }
    const row = firstRow(this.rows(READ_ONE, { versionId: id, kind, recordId }));
    if (!row) {
      return undefined;
    }
    return {
      revisionId: requireString(row.revisionId, 'revisionId'),
      value: parsePayload(requireString(row.payload, 'payload')),
    };
  }

  private resolveVersionId(versionId?: string): string | null {
    if (versionId === undefined) {
      return this.pointerVersionId();
    }
    this.requireVersion(versionId);
    return versionId;
  }

  private requireVersion(versionId: string): Version {
    const row = firstRow(this.rows(READ_VERSION, { versionId }));
    if (!row) {
      throw new UnknownVersionError(versionId);
    }
    return versionFromRow(row);
  }

  private pointerVersionId(): string | null {
    const row = firstRow(this.rows(READ_POINTER, { pointerId: ACTIVE_POINTER_ID }));
    return optionalString(row?.versionId);
  }

  private maxRevisionNumber(): number {
    const numbers = this.rows(LIST_REVISION_IDS).map((row) =>
      revisionNumber(requireString(row.revisionId, 'revisionId')),
    );
    return numbers.length === 0 ? 0 : Math.max(...numbers);
  }

  private transaction(work: () => void): void {
    this.connection.querySync('BEGIN TRANSACTION');
    try {
      work();
      this.connection.querySync('COMMIT');
    } catch (error) {
      try {
        this.connection.querySync('ROLLBACK');
      } catch {
        // A failed statement inside the transaction already aborted it.
      }
      throw error;
    }
  }

  private rows(statement: string, params?: SqlParams): SqlRow[] {
    const result = this.execute(statement, params);
    try {
      return result.getAllSync();
    } finally {
      result.close();
    }
  }

  private run(statement: string, params?: SqlParams): void {
    this.execute(statement, params).close();
  }

  private execute(statement: string, params?: SqlParams): QueryResult {
    const result = params
      ? this.connection.executeSync(this.connection.prepareSync(statement), params)
      : this.connection.querySync(statement);
    return oneResult(result);
  }
}
