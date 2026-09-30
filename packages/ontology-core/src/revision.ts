import type { OntologyRecords, RecordKind } from './model.js';

export interface Revision {
  readonly revisionId: string;
  readonly value: Readonly<OntologyRecords[RecordKind]>;
}

export type RecordTable = ReadonlyMap<string, Revision>;

export type RecordTables = ReadonlyMap<RecordKind, RecordTable>;

export type RecordValue = Readonly<OntologyRecords[RecordKind]>;

/** One record that differs between two versions. A missing side means the record does not exist there. */
export interface RecordDelta {
  kind: RecordKind;
  id: string;
  before: RecordValue | undefined;
  after: RecordValue | undefined;
}

export const RECORD_KINDS = [
  'domains',
  'tables',
  'columns',
  'terms',
  'mappings',
  'relations',
  'constraints',
  'evidence',
] as const satisfies readonly RecordKind[];

/**
 * Records whose revision differs between two versions. Unchanged records share a revision
 * id, so this compares ids only and never record contents.
 */
export function diffRecords(before: RecordTables, after: RecordTables): RecordDelta[] {
  const deltas: RecordDelta[] = [];
  for (const kind of RECORD_KINDS) {
    const from = before.get(kind);
    const to = after.get(kind);
    const ids = new Set([...(from?.keys() ?? []), ...(to?.keys() ?? [])]);
    for (const id of ids) {
      const a = from?.get(id);
      const b = to?.get(id);
      if (a?.revisionId !== b?.revisionId) {
        deltas.push({ kind, id, before: a?.value, after: b?.value });
      }
    }
  }
  return deltas;
}
