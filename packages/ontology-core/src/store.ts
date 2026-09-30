import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Connection, Database } from '@ladybugdb/core';

import { ActiveVersionChangedError, findConflicts, MergeConflictError } from './merge.js';
import { diffRecords, RECORD_KINDS } from './revision.js';

import type { OntologyRecords, RecordKind, Version, VersionReason, WriteOptions } from './model.js';
import type { RecordDelta, RecordTable, RecordTables, RecordValue, Revision } from './revision.js';
import type { LbugValue, QueryResult } from '@ladybugdb/core';

type SqlParams = Record<string, LbugValue>;

type SqlRow = Record<string, LbugValue>;

const ACTIVE_POINTER_ID = 'active';

/** Default Ladybug mmap is 8 TiB, which fails once a process opens more than a few databases. */
const BUFFER_POOL_BYTES = 64 * 1024 * 1024;
const MAX_DATABASE_BYTES = 256 * 1024 * 1024;

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
      meta STRING,
      PRIMARY KEY (versionId)
    )`,
  },
  {
    name: 'Includes',
    ddl: 'CREATE REL TABLE Includes(FROM OntologyVersion TO Revision)',
  },
  {
    name: 'WorkItem',
    ddl: `CREATE NODE TABLE WorkItem(
      itemId STRING,
      kind STRING,
      payload STRING,
      PRIMARY KEY (itemId)
    )`,
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
const ADD_META_COLUMN = "ALTER TABLE OntologyVersion ADD meta STRING DEFAULT ''";
const VERSION_COLUMNS = `v.versionId AS versionId, v.parentVersionId AS parentVersionId,
  v.createdAt AS createdAt, v.reason AS reason, v.meta AS meta`;
const INSERT_VERSION = `CREATE (:OntologyVersion {
  versionId: $versionId,
  parentVersionId: $parentVersionId,
  createdAt: $createdAt,
  reason: $reason,
  meta: $meta
})`;
const COMPARE_AND_SET_POINTER = `MATCH (p:ActivePointer {pointerId: $pointerId})
WHERE p.versionId = $expected
SET p.versionId = $versionId
RETURN p.pointerId AS pointerId`;
const COMPARE_AND_SET_EMPTY_POINTER = `MATCH (p:ActivePointer {pointerId: $pointerId})
WHERE p.versionId IS NULL
SET p.versionId = $versionId
RETURN p.pointerId AS pointerId`;
const INSERT_REVISIONS = `UNWIND $rows AS row
CREATE (:Revision {
  revisionId: row.revisionId,
  kind: row.kind,
  recordId: row.recordId,
  payload: row.payload
})`;
const LINK_REVISIONS = `UNWIND $revisionIds AS revisionId
MATCH (v:OntologyVersion {versionId: $versionId}), (r:Revision {revisionId: revisionId})
CREATE (v)-[:Includes]->(r)`;
const LIST_VERSIONS = `MATCH (v:OntologyVersion) RETURN ${VERSION_COLUMNS}`;
const READ_VERSION = `MATCH (v:OntologyVersion {versionId: $versionId}) RETURN ${VERSION_COLUMNS}`;
const UPSERT_WORK_ITEM = `MERGE (w:WorkItem {itemId: $itemId})
SET w.kind = $kind, w.payload = $payload`;
const LIST_WORK_ITEMS =
  'MATCH (w:WorkItem {kind: $kind}) RETURN w.itemId AS itemId, w.payload AS payload';
const TABLE_INFO = "CALL table_info('OntologyVersion') RETURN name";
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
  if (value === 'scope' || value === 'revise' || value === 'revert') {
    return value;
  }
  throw new Error(`Unexpected version reason: ${value}`);
}

type VersionMeta = Pick<Version, 'actor' | 'mergedFromVersionId' | 'proposalId'>;

function versionMeta(version: Version): string {
  const meta: VersionMeta = {
    ...(version.actor && { actor: version.actor }),
    ...(version.mergedFromVersionId && { mergedFromVersionId: version.mergedFromVersionId }),
    ...(version.proposalId && { proposalId: version.proposalId }),
  };
  return Object.keys(meta).length === 0 ? '' : JSON.stringify(meta);
}

function parseMeta(meta: string | null): VersionMeta {
  return meta ? (JSON.parse(meta) as VersionMeta) : {};
}

function versionFromRow(row: SqlRow): Version {
  return {
    versionId: requireString(row.versionId, 'versionId'),
    parentVersionId: optionalString(row.parentVersionId),
    createdAt: requireString(row.createdAt, 'createdAt'),
    reason: versionReason(requireString(row.reason, 'reason')),
    ...parseMeta(optionalString(row.meta)),
  };
}

function versionParams(version: Version): SqlParams {
  return {
    versionId: version.versionId,
    parentVersionId: version.parentVersionId,
    createdAt: version.createdAt,
    reason: version.reason,
    meta: versionMeta(version),
  };
}

function revisionRow(kind: RecordKind, recordId: string, revision: Revision): SqlParams {
  return {
    revisionId: revision.revisionId,
    kind,
    recordId,
    payload: JSON.stringify(revision.value),
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

function workItemNumber(itemId: string): number {
  return Number(itemId.replaceAll(/\D/g, '')) || 0;
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
  private readonly created = new Set<string>();
  private readonly baselines = new Map<string, RecordTables>();

  constructor(
    private readonly base: RecordTables,
    private readonly nextRevisionId: () => string,
    private readonly recordsAsOf: (instant: string) => RecordTables = () => EMPTY_RECORDS,
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
    const revisionId = this.nextRevisionId();
    this.created.add(revisionId);
    this.writable(kind).set(id, {
      revisionId,
      value: Object.freeze(structuredClone(value)),
    });
  }

  /** Writes a record read from another version; the kind and value must already belong together. */
  restore(kind: RecordKind, id: string, value: RecordValue): void {
    this.put(kind, id, value);
  }

  remove(kind: RecordKind, id: string): void {
    if (this.table(kind).has(id)) {
      this.writable(kind).delete(id);
    }
  }

  /** Revision id of a record in this draft. Equal ids across versions mean the record is unchanged. */
  revisionIdOf(kind: RecordKind, id: string): string | undefined {
    return this.table(kind).get(id)?.revisionId;
  }

  /** True if the record was added or changed in a version created after `instant`. */
  changedSince(kind: RecordKind, id: string, instant: string): boolean {
    let baseline = this.baselines.get(instant);
    if (!baseline) {
      baseline = this.recordsAsOf(instant);
      this.baselines.set(instant, baseline);
    }
    return baseline.get(kind)?.get(id)?.revisionId !== this.revisionIdOf(kind, id);
  }

  /** What this draft changed relative to the records it started from. */
  changes(): RecordDelta[] {
    return diffRecords(this.base, this.toRecords());
  }

  toRecords(): RecordTables {
    const merged = new Map<RecordKind, RecordTable>(this.base);
    for (const [kind, table] of this.written) {
      merged.set(kind, table);
    }
    return merged;
  }

  /** Revisions this draft created and still holds; every other revision is already stored. */
  newRevisions(): { kind: RecordKind; id: string; revision: Revision }[] {
    const fresh: { kind: RecordKind; id: string; revision: Revision }[] = [];
    for (const [kind, table] of this.written) {
      for (const [id, revision] of table) {
        if (this.created.has(revision.revisionId)) {
          fresh.push({ kind, id, revision });
        }
      }
    }
    return fresh;
  }

  private writable(kind: RecordKind): Map<string, Revision> {
    let target = this.written.get(kind);
    if (!target) {
      target = new Map(this.base.get(kind) ?? []);
      this.written.set(kind, target);
    }
    return target;
  }

  private table(kind: RecordKind): RecordTable {
    return this.written.get(kind) ?? this.base.get(kind) ?? new Map<string, Revision>();
  }
}

type WorkItemKind = 'trace' | 'proposal';

interface CommitOptions extends WriteOptions {
  baseVersionId?: string;
  expectedActive?: string;
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
    readonly now: () => Date = () => new Date(),
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

  /** Every record of a version (default: the active one) with its revision id. */
  recordsOf(versionId?: string): RecordTables {
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

  /**
   * Runs `stage` against a draft of the active version. If it throws, nothing is committed.
   * With `baseVersionId` older than the active version, the write merges onto the head when it
   * touches nothing the other writers changed, and throws `MergeConflictError` otherwise.
   */
  commit(
    reason: VersionReason,
    stage: (draft: Draft) => void,
    options: CommitOptions = {},
  ): Version {
    const counter = this.revisionCounter;
    let created: Version | undefined;
    try {
      this.transaction(() => {
        created = this.commitInTransaction(reason, stage, options);
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

  /** Moves the active pointer. With `expectedActive`, fails unless that version is still active. */
  activate(versionId: string, expectedActive?: string): Version {
    const version = this.requireVersion(versionId);
    this.transaction(() => {
      const head = this.pointerVersionId();
      if (expectedActive !== undefined && expectedActive !== head) {
        throw new ActiveVersionChangedError(expectedActive, head);
      }
      this.compareAndSetPointer(head, versionId);
    });
    return version;
  }

  /** Traces and proposals live beside the versions, outside them, so they never add to a commit. */
  putWorkItem(kind: WorkItemKind, itemId: string, value: object): void {
    this.transaction(() => {
      this.run(UPSERT_WORK_ITEM, { itemId, kind, payload: JSON.stringify(value) });
    });
  }

  listWorkItems<T>(kind: WorkItemKind): T[] {
    return this.rows(LIST_WORK_ITEMS, { kind })
      .map((row) => ({
        itemId: requireString(row.itemId, 'itemId'),
        value: JSON.parse(requireString(row.payload, 'payload')) as T,
      }))
      .sort((a, b) => workItemNumber(a.itemId) - workItemNumber(b.itemId))
      .map((entry) => entry.value);
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
    const versionColumns = this.rows(TABLE_INFO).map((row) => requireString(row.name, 'name'));
    if (!versionColumns.includes('meta')) {
      this.connection.querySync(ADD_META_COLUMN);
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
    this.insertRevisionRows(
      json.revisions.map((revision) =>
        revisionRow(revision.kind, revision.id, {
          revisionId: revision.revisionId,
          value: revision.value,
        }),
      ),
    );
    for (const { version, revisionIds } of json.versions) {
      this.run(INSERT_VERSION, versionParams(version));
      for (const revisionId of revisionIds) {
        if (!known.has(revisionId)) {
          throw new Error(`Store JSON lists unknown revision ${revisionId}`);
        }
      }
      this.linkRevisions(version.versionId, revisionIds);
    }
    if (json.activeVersionId !== null) {
      this.requireVersion(json.activeVersionId);
      this.run(SET_POINTER, { pointerId: ACTIVE_POINTER_ID, versionId: json.activeVersionId });
    }
  }

  private commitInTransaction(
    reason: VersionReason,
    stage: (draft: Draft) => void,
    options: CommitOptions,
  ): Version {
    const head = this.pointerVersionId();
    if (options.expectedActive !== undefined && options.expectedActive !== head) {
      throw new ActiveVersionChangedError(options.expectedActive, head);
    }
    const mergedFrom = this.checkMerge(options.baseVersionId, head, stage);
    const draft = new Draft(
      this.recordsOf(),
      () => {
        this.revisionCounter += 1;
        return `r${this.revisionCounter}`;
      },
      (instant) => this.recordsAsOf(instant),
    );
    stage(draft);
    const version: Version = {
      versionId: `v${this.listVersions().length + 1}`,
      parentVersionId: head,
      createdAt: this.now().toISOString(),
      reason,
      ...(options.actor && { actor: options.actor }),
      ...(mergedFrom && { mergedFromVersionId: mergedFrom }),
      ...(options.proposalId && { proposalId: options.proposalId }),
    };
    this.insertVersion(version, draft, head);
    return version;
  }

  /** Returns the base version when the write must merge, or undefined when it applies directly. */
  private checkMerge(
    baseVersionId: string | undefined,
    head: string | null,
    stage: (draft: Draft) => void,
  ): string | undefined {
    if (baseVersionId === undefined || baseVersionId === head) {
      return undefined;
    }
    this.requireVersion(baseVersionId);
    const base = this.recordsOf(baseVersionId);
    let probeCounter = 0;
    const probe = new Draft(
      base,
      () => `probe${(probeCounter += 1)}`,
      (instant) => this.recordsAsOf(instant),
    );
    stage(probe);
    const conflicts = findConflicts(base, this.recordsOf(), probe.changes());
    if (conflicts.length > 0) {
      throw new MergeConflictError(baseVersionId, head, conflicts);
    }
    return baseVersionId;
  }

  private insertVersion(version: Version, draft: Draft, expectedHead: string | null): void {
    this.run(INSERT_VERSION, versionParams(version));
    this.insertRevisionRows(
      draft.newRevisions().map(({ kind, id, revision }) => revisionRow(kind, id, revision)),
    );
    const revisionIds: string[] = [];
    for (const table of draft.toRecords().values()) {
      for (const revision of table.values()) {
        revisionIds.push(revision.revisionId);
      }
    }
    this.linkRevisions(version.versionId, revisionIds);
    this.compareAndSetPointer(expectedHead, version.versionId);
  }

  private insertRevisionRows(rows: SqlParams[]): void {
    if (rows.length > 0) {
      this.run(INSERT_REVISIONS, { rows: rows as unknown as LbugValue });
    }
  }

  private linkRevisions(versionId: string, revisionIds: string[]): void {
    if (revisionIds.length > 0) {
      this.run(LINK_REVISIONS, { versionId, revisionIds });
    }
  }

  private compareAndSetPointer(expected: string | null, versionId: string): void {
    const params = { pointerId: ACTIVE_POINTER_ID, versionId };
    const moved =
      expected === null
        ? this.rows(COMPARE_AND_SET_EMPTY_POINTER, params)
        : this.rows(COMPARE_AND_SET_POINTER, { ...params, expected });
    if (moved.length === 0) {
      throw new ActiveVersionChangedError(expected, this.pointerVersionId());
    }
  }

  private recordsAsOf(instant: string): RecordTables {
    const seen = this.listVersions().filter((version) => version.createdAt <= instant);
    const latest = seen.at(-1);
    return latest ? this.recordsOf(latest.versionId) : EMPTY_RECORDS;
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
