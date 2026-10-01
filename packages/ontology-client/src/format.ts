import type {
  Column,
  Mapping,
  ResolveResult,
  SnapshotTable,
  Term,
} from '@data-agent-ontology/ontology-core';

function roleLabel(role: Mapping['role']): string {
  switch (role) {
    case 'primary_key':
      return 'pk';
    case 'foreign_key':
      return 'fk';
    case 'attribute':
      return '';
    default: {
      const unreachable: never = role;
      throw new Error(`Unhandled role ${String(unreachable)}`);
    }
  }
}

function columnLine(
  column: Column,
  table: SnapshotTable | undefined,
  role: Mapping['role'],
): string {
  const label = roleLabel(role);
  const owner = table?.path ?? column.tableId;
  return `${owner}.${column.name} ${column.dataType}${label ? ` (${label})` : ''}`;
}

function evidenceLine(result: ResolveResult, targetId: string): string | undefined {
  const evidence = result.evidence.find((entry) => entry.targetId === targetId);
  if (evidence === undefined) {
    return undefined;
  }
  return `  evidence ${evidence.source}: ${evidence.summary}`;
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
    const evidence = evidenceLine(result, relation.relationId);
    if (evidence !== undefined) {
      lines.push(evidence);
    }
  }
  for (const constraint of result.constraints.filter((c) => c.termId === term.termId)) {
    lines.push(`  constraint ${constraint.text}`);
    const evidence = evidenceLine(result, constraint.constraintId);
    if (evidence !== undefined) {
      lines.push(evidence);
    }
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
