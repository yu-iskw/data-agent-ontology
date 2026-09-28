import type { OntologyRecords, RecordKind, Version, VersionReason } from './model.js';

interface Revision {
  readonly revisionId: string;
  readonly value: Readonly<OntologyRecords[RecordKind]>;
}

type RecordTable = ReadonlyMap<string, Revision>;

type RecordTables = ReadonlyMap<RecordKind, RecordTable>;

interface StoredVersion {
  readonly version: Version;
  readonly records: RecordTables;
}

const EMPTY_RECORDS: RecordTables = new Map();

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

/**
 * In-memory versioned record store (RFC sections 12 and 13).
 * Every commit creates an immutable version; rollback only moves the active pointer.
 */
export class OntologyStore {
  private activeVersionId: string | null = null;
  private revisionCounter = 0;
  private readonly versions = new Map<string, StoredVersion>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  get activeVersion(): Version | null {
    return this.activeVersionId === null ? null : this.stored(this.activeVersionId).version;
  }

  listVersions(): Version[] {
    return [...this.versions.values()].map((entry) => entry.version);
  }

  get<K extends RecordKind>(
    kind: K,
    id: string,
    versionId?: string,
  ): OntologyRecords[K] | undefined {
    return this.recordsOf(versionId).get(kind)?.get(id)?.value as OntologyRecords[K] | undefined;
  }

  list<K extends RecordKind>(kind: K, versionId?: string): OntologyRecords[K][] {
    const table = this.recordsOf(versionId).get(kind) ?? new Map<string, Revision>();
    return [...table.values()].map((revision) => revision.value as OntologyRecords[K]);
  }

  /** Revision id of a record in a version. Equal ids across versions mean a shared revision. */
  revisionIdOf(kind: RecordKind, id: string, versionId?: string): string | undefined {
    return this.recordsOf(versionId).get(kind)?.get(id)?.revisionId;
  }

  /** Runs `stage` against a draft of the active version. If it throws, nothing is committed. */
  commit(reason: VersionReason, stage: (draft: Draft) => void): Version {
    const draft = new Draft(this.recordsOf(), () => {
      this.revisionCounter += 1;
      return `r${this.revisionCounter}`;
    });
    stage(draft);
    const version: Version = {
      versionId: `v${this.versions.size + 1}`,
      parentVersionId: this.activeVersionId,
      createdAt: this.now().toISOString(),
      reason,
    };
    this.versions.set(version.versionId, { version, records: draft.toRecords() });
    this.activeVersionId = version.versionId;
    return version;
  }

  activate(versionId: string): Version {
    const target = this.stored(versionId);
    this.activeVersionId = versionId;
    return target.version;
  }

  private recordsOf(versionId?: string): RecordTables {
    const id = versionId ?? this.activeVersionId;
    return id === null ? EMPTY_RECORDS : this.stored(id).records;
  }

  private stored(versionId: string): StoredVersion {
    const entry = this.versions.get(versionId);
    if (!entry) {
      throw new UnknownVersionError(versionId);
    }
    return entry;
  }
}
