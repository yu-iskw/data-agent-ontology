import type {
  Column,
  Mapping,
  ResolveResult,
  SnapshotTable,
  Term,
} from '@data-agent-ontology/ontology-core';

const ROLE_LABEL: Record<Mapping['role'], string> = {
  primary_key: 'pk',
  foreign_key: 'fk',
  attribute: '',
};

function columnLine(
  column: Column,
  table: SnapshotTable | undefined,
  role: Mapping['role'],
): string {
  const label = ROLE_LABEL[role];
  const owner = table?.path ?? column.tableId;
  return `${owner}.${column.name} ${column.dataType}${label ? ` (${label})` : ''}`;
}

function termBlock(result: ResolveResult, term: Term): string[] {
  const tables = new Map(result.tables.map((table) => [table.tableId, table]));
  const columns = new Map(result.columns.map((column) => [column.columnId, column]));
  const lines = [`- ${term.name} [${term.domainId}]: ${term.definition}`];
  for (const mapping of result.mappings.filter((m) => m.termId === term.termId)) {
    const column = columns.get(mapping.columnId);
    if (column) {
      lines.push(`  column ${columnLine(column, tables.get(column.tableId), mapping.role)}`);
    }
  }
  for (const relation of result.relations.filter(
    (r) => r.fromTermId === term.termId || r.toTermId === term.termId,
  )) {
    lines.push(
      `  relation ${relation.fromTermId} ${relation.name} ${relation.toTermId}: ${relation.join}`,
    );
  }
  for (const constraint of result.constraints.filter((c) => c.termId === term.termId)) {
    lines.push(`  constraint ${constraint.text}`);
  }
  return lines;
}

/** A short, deterministic block for the model. Returns an empty string when no term resolved. */
export function formatContext(result: ResolveResult): string {
  if (result.terms.length === 0) {
    return '';
  }
  const terms = [...result.terms].sort((a, b) => a.termId.localeCompare(b.termId));
  return [
    `Known warehouse semantics (ontology version ${result.versionId}); verify with SQL before relying on them:`,
    ...terms.flatMap((term) => termBlock(result, term)),
  ].join('\n');
}
