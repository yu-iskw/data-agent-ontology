import { columnIdOf, scopePathOf, tableIdOf } from './model.js';

import type {
  Column,
  ColumnObservation,
  Engine,
  Scope,
  Submission,
  Table,
  TableObservation,
  WarehouseObject,
} from './model.js';
import type { Draft } from './store.js';

export class ScopeViolationError extends Error {
  constructor(engine: Engine, path: string) {
    super(`${engine}:${path} is outside the declared submission scope`);
    this.name = 'ScopeViolationError';
  }
}

export class SubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionError';
  }
}

function inScope(scope: Scope, engine: Engine, path: string): boolean {
  return scope.engine === engine && scope.path === scopePathOf(path);
}

function assertInScope(submission: Submission, engine: Engine, path: string): void {
  if (!submission.scope.some((scope) => inScope(scope, engine, path))) {
    throw new ScopeViolationError(engine, path);
  }
}

function validateScope(submission: Submission): void {
  if (submission.scope.length === 0) {
    throw new SubmissionError('A submission must declare at least one scope');
  }
  for (const table of submission.tables) {
    assertInScope(submission, table.engine, table.path);
  }
  for (const column of submission.columns) {
    assertInScope(submission, column.engine, column.tablePath);
  }
  for (const removed of submission.removed ?? []) {
    assertInScope(submission, removed.engine, removed.path);
  }
}

function upsertTable(draft: Draft, observation: TableObservation): string {
  const tableId = tableIdOf(observation.engine, observation.path);
  const existing = draft.get('tables', tableId);
  const membershipRevised = existing?.membershipRevised ?? false;
  const submitted = observation.domainIds ?? existing?.domainIds ?? [];
  for (const domainId of membershipRevised ? [] : submitted) {
    if (!draft.get('domains', domainId)) {
      throw new SubmissionError(`Unknown domain ${domainId} for ${tableId}`);
    }
  }
  draft.put('tables', tableId, {
    tableId,
    engine: observation.engine,
    path: observation.path,
    kind: observation.kind,
    domainIds: membershipRevised && existing ? existing.domainIds : [...submitted],
    membershipRevised,
    active: true,
    drifted: false,
  });
  return tableId;
}

function upsertColumn(draft: Draft, observation: ColumnObservation, observed: Set<string>): string {
  const tableId = tableIdOf(observation.engine, observation.tablePath);
  if (!observed.has(tableId) && !draft.get('tables', tableId)?.active) {
    throw new SubmissionError(`Column ${observation.name} references unobserved table ${tableId}`);
  }
  const columnId = columnIdOf(tableId, observation.name);
  draft.put('columns', columnId, {
    columnId,
    tableId,
    name: observation.name,
    dataType: observation.dataType,
    ordinalPosition: observation.ordinalPosition,
    active: true,
    drifted: false,
  });
  return columnId;
}

function deactivateTable(draft: Draft, table: Table): void {
  draft.put('tables', table.tableId, { ...table, active: false });
  for (const column of draft.list('columns')) {
    if (column.tableId === table.tableId && column.active) {
      draft.put('columns', column.columnId, { ...column, active: false });
    }
  }
}

/** Records that another version added or changed after `observedAt` were not part of that observation. */
function unseen(
  draft: Draft,
  kind: 'tables' | 'columns',
  id: string,
  observedAt?: string,
): boolean {
  return observedAt !== undefined && draft.changedSince(kind, id, observedAt);
}

function deactivateMissing(
  draft: Draft,
  scope: Scope,
  observed: { tables: Set<string>; columns: Set<string>; at?: string },
): void {
  for (const table of draft.list('tables')) {
    if (!table.active || !inScope(scope, table.engine, table.path)) {
      continue;
    }
    if (!observed.tables.has(table.tableId)) {
      if (!unseen(draft, 'tables', table.tableId, observed.at)) {
        deactivateTable(draft, table);
      }
      continue;
    }
    const missing = draft
      .list('columns')
      .filter(
        (c) =>
          c.tableId === table.tableId &&
          c.active &&
          !observed.columns.has(c.columnId) &&
          !unseen(draft, 'columns', c.columnId, observed.at),
      );
    for (const column of missing) {
      draft.put('columns', column.columnId, { ...column, active: false });
    }
  }
}

function applyRemoval(draft: Draft, removed: WarehouseObject): void {
  const tableId = tableIdOf(removed.engine, removed.path);
  if (removed.column === undefined) {
    const table = draft.get('tables', tableId);
    if (table) {
      deactivateTable(draft, table);
    }
    return;
  }
  const column: Column | undefined = draft.get('columns', columnIdOf(tableId, removed.column));
  if (column) {
    draft.put('columns', column.columnId, { ...column, active: false });
  }
}

function columnIsLive(draft: Draft, columnId: string): boolean {
  return draft.get('columns', columnId)?.active ?? false;
}

/**
 * Human-maintained records whose warehouse objects disappeared stay stored but become
 * drifted and inactive (RFC section 7). They recover if the objects are observed again.
 */
export function refreshDrift(draft: Draft): void {
  for (const table of draft.list('tables')) {
    draft.put('tables', table.tableId, {
      ...table,
      drifted: !table.active && table.membershipRevised,
    });
  }
  for (const mapping of draft.list('mappings')) {
    const drifted = !columnIsLive(draft, mapping.columnId);
    draft.put('mappings', mapping.mappingId, { ...mapping, drifted, active: !drifted });
  }
  for (const relation of draft.list('relations')) {
    const drifted =
      !columnIsLive(draft, relation.fromColumnId) || !columnIsLive(draft, relation.toColumnId);
    draft.put('relations', relation.relationId, { ...relation, drifted, active: !drifted });
  }
}

/** Applies a structural observation (RFC sections 9 and 10) to a draft. */
export function applySubmission(draft: Draft, submission: Submission): void {
  validateScope(submission);
  const observedTables = new Set(submission.tables.map((table) => upsertTable(draft, table)));
  const observedColumns = new Set(
    submission.columns.map((column) => upsertColumn(draft, column, observedTables)),
  );
  for (const scope of submission.scope.filter((entry) => entry.completeness === 'full')) {
    deactivateMissing(draft, scope, {
      tables: observedTables,
      columns: observedColumns,
      at: submission.observedAt,
    });
  }
  for (const removed of submission.removed ?? []) {
    applyRemoval(draft, removed);
  }
  refreshDrift(draft);
}
