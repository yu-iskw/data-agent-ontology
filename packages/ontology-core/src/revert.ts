import { RECORD_KINDS } from './revision.js';
import { refreshDrift } from './submit.js';

import type { RecordKind } from './model.js';
import type { RecordTables } from './revision.js';
import type { Draft } from './store.js';

export interface RevertConflict {
  kind: RecordKind;
  id: string;
}

export class RevertConflictError extends Error {
  constructor(
    readonly versionId: string,
    readonly conflicts: RevertConflict[],
  ) {
    super(
      `Cannot revert ${versionId}: later versions changed ` +
        conflicts.map((conflict) => `${conflict.kind}:${conflict.id}`).join(', '),
    );
    this.name = 'RevertConflictError';
  }
}

export class RevertRootError extends Error {
  constructor(versionId: string) {
    super(`Cannot revert ${versionId}: it has no parent version`);
    this.name = 'RevertRootError';
  }
}

function idsOf(...tables: (ReadonlyMap<string, unknown> | undefined)[]): Set<string> {
  return new Set(tables.flatMap((table) => [...(table?.keys() ?? [])]));
}

function revertRecord(
  draft: Draft,
  kind: RecordKind,
  id: string,
  target: RecordTables,
  parent: RecordTables,
): RevertConflict | undefined {
  const introduced = target.get(kind)?.get(id)?.revisionId;
  const previous = parent.get(kind)?.get(id);
  if (introduced === previous?.revisionId) {
    return undefined;
  }
  if (draft.revisionIdOf(kind, id) !== introduced) {
    // Evidence follows its target, so a later evidence change alone is not a conflict.
    return kind === 'evidence' ? undefined : { kind, id };
  }
  if (previous) {
    draft.restore(kind, id, previous.value);
  } else {
    draft.remove(kind, id);
  }
  return undefined;
}

/**
 * Undoes what one version changed relative to its parent, leaving every later change alone.
 * A record that a later version changed again is a conflict and stops the revert.
 */
export function applyRevert(
  draft: Draft,
  versionId: string,
  target: RecordTables,
  parent: RecordTables,
): void {
  const conflicts: RevertConflict[] = [];
  for (const kind of RECORD_KINDS) {
    for (const id of idsOf(target.get(kind), parent.get(kind))) {
      const conflict = revertRecord(draft, kind, id, target, parent);
      if (conflict) {
        conflicts.push(conflict);
      }
    }
  }
  if (conflicts.length > 0) {
    throw new RevertConflictError(versionId, conflicts);
  }
  refreshDrift(draft);
}
