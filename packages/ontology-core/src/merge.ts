import { isDeepStrictEqual } from 'node:util';

import { diffRecords } from './revision.js';

import type { RecordKind } from './model.js';
import type { RecordDelta, RecordTables, RecordValue } from './revision.js';

/** One record both sides changed in different ways. */
export interface MergeConflict {
  kind: RecordKind;
  id: string;
  /** The record at the version the writer read. Missing if the writer's change created it. */
  base: RecordValue | undefined;
  /** What the active head holds now for the contested key. */
  theirs: RecordValue | undefined;
  /** What the writer's patch would leave. Missing if the patch removes it. */
  mine: RecordValue | undefined;
}

export class MergeConflictError extends Error {
  constructor(
    readonly baseVersionId: string,
    readonly headVersionId: string | null,
    readonly conflicts: MergeConflict[],
  ) {
    super(
      `Write based on ${baseVersionId} conflicts with ${headVersionId ?? 'the empty ontology'} on ` +
        conflicts.map((conflict) => `${conflict.kind}:${conflict.id}`).join(', '),
    );
    this.name = 'MergeConflictError';
  }
}

export class ActiveVersionChangedError extends Error {
  constructor(
    readonly expected: string | null,
    readonly actual: string | null,
  ) {
    super(`Expected active version ${expected ?? 'none'} but it is ${actual ?? 'none'}`);
    this.name = 'ActiveVersionChangedError';
  }
}

/**
 * Two writers touch the same thing when they hit the same record, with one exception:
 * constraints on one term compete as a set, so a second writer cannot add a rule beside
 * one the first writer added without having seen it.
 */
function conflictKey(kind: RecordKind, id: string, value: RecordValue | undefined): string {
  if (kind === 'constraints' && value !== undefined && 'termId' in value) {
    return `constraint-set:${value.termId}`;
  }
  return `${kind}:${id}`;
}

function keyOf(delta: RecordDelta): string {
  return conflictKey(delta.kind, delta.id, delta.after ?? delta.before);
}

/**
 * Compares what the writer changed relative to `base` with what everyone else changed
 * between `base` and `head`. Evidence follows its target, so it never conflicts alone.
 * A change the head already holds verbatim is not a conflict.
 */
export function findConflicts(
  base: RecordTables,
  head: RecordTables,
  mine: RecordDelta[],
): MergeConflict[] {
  const others = new Map<string, RecordDelta>();
  for (const delta of diffRecords(base, head)) {
    if (delta.kind !== 'evidence') {
      others.set(keyOf(delta), delta);
    }
  }
  const conflicts: MergeConflict[] = [];
  for (const change of mine) {
    const theirs = others.get(keyOf(change));
    if (change.kind === 'evidence' || !theirs) {
      continue;
    }
    const held = head.get(change.kind)?.get(change.id)?.value;
    if (isDeepStrictEqual(held, change.after)) {
      continue;
    }
    conflicts.push({
      kind: change.kind,
      id: change.id,
      base: change.before,
      theirs: theirs.after,
      mine: change.after,
    });
  }
  return conflicts;
}
