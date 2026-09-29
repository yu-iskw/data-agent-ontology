import type {
  Column,
  OntologySnapshot,
  Relation,
  SnapshotTable,
} from '@data-agent-ontology/ontology-core';

export type SqlIssueCode = 'unknown_table' | 'unknown_column' | 'join_mismatch' | 'constraint';

export interface SqlIssue {
  code: SqlIssueCode;
  severity: 'error' | 'warning' | 'note';
  message: string;
}

const KEYWORDS = new Set([
  'on',
  'using',
  'where',
  'group',
  'order',
  'limit',
  'having',
  'union',
  'intersect',
  'except',
  'join',
  'inner',
  'left',
  'right',
  'full',
  'outer',
  'cross',
  'natural',
  'window',
  'qualify',
  'offset',
  'fetch',
  'lateral',
  'tablesample',
]);

const SYSTEM_SCHEMAS = new Set(['information_schema', 'pg_catalog']);
const IDENT = String.raw`(?:"[^"]+"|[A-Za-z_][\w$]*)`;
const TABLE_REF = new RegExp(
  String.raw`\b(?:from|join)\s+(${IDENT}(?:\.${IDENT})*)(?:\s+(?:as\s+)?(${IDENT}))?`,
  'gi',
);
const CTE_NAME = new RegExp(String.raw`(${IDENT})\s+as\s*\(`, 'gi');
const QUALIFIED = new RegExp(String.raw`(${IDENT})\.(${IDENT})`, 'g');
const JOIN_ON = new RegExp(
  String.raw`\bon\s+\(?\s*(${IDENT})\.(${IDENT})\s*=\s*(${IDENT})\.(${IDENT})`,
  'gi',
);
const MAX_SUGGESTION_DISTANCE = 3;
const MAX_CONSTRAINT_NOTES = 8;

interface TableRef {
  table: SnapshotTable;
  alias: string;
}

function unquote(identifier: string): string {
  return identifier.startsWith('"') ? identifier.slice(1, -1) : identifier;
}

/** Comments and string literals cannot hold table references; blank them so regexes ignore them. */
function stripLiterals(sql: string): string {
  return sql
    .replaceAll(/--[^\n]*/g, ' ')
    .replaceAll(/\/\*[\s\S]*?\*\//g, ' ')
    .replaceAll(/'(?:[^']|'')*'/g, "''");
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    const row = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      row.push(Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + cost));
    }
    previous = row;
  }
  return previous[b.length];
}

function nearest(name: string, candidates: string[]): string | undefined {
  let best: { candidate: string; cost: number } | undefined;
  for (const candidate of candidates) {
    const cost = distance(name.toLowerCase(), candidate.toLowerCase());
    if (cost <= MAX_SUGGESTION_DISTANCE && (!best || cost < best.cost)) {
      best = { candidate, cost };
    }
  }
  return best?.candidate;
}

function lastSegment(path: string): string {
  return path.slice(path.lastIndexOf('.') + 1);
}

/** Tables whose path equals `reference`, or ends with it on a segment boundary. */
function matchTables(snapshot: OntologySnapshot, reference: string): SnapshotTable[] {
  const wanted = reference.toLowerCase();
  const exact = snapshot.tables.filter((table) => table.path.toLowerCase() === wanted);
  if (exact.length > 0) {
    return exact;
  }
  return snapshot.tables.filter((table) => table.path.toLowerCase().endsWith(`.${wanted}`));
}

function cteNames(sql: string): Set<string> {
  return new Set([...sql.matchAll(CTE_NAME)].map((match) => unquote(match[1]).toLowerCase()));
}

interface Resolution {
  refs: TableRef[];
  issues: SqlIssue[];
}

function isSkipped(segments: string[], ctes: Set<string>): boolean {
  return (
    (segments.length === 1 && ctes.has(segments[0].toLowerCase())) ||
    SYSTEM_SCHEMAS.has(segments[0].toLowerCase())
  );
}

function unknownTable(reference: string, known: string[]): SqlIssue {
  const suggestion = nearest(lastSegment(reference), known);
  return {
    code: 'unknown_table',
    severity: 'error',
    message: `Table ${reference} is not in the ontology${suggestion ? `; did you mean ${suggestion}?` : ''}`,
  };
}

function resolveTables(sql: string, snapshot: OntologySnapshot): Resolution {
  const ctes = cteNames(sql);
  const refs: TableRef[] = [];
  const issues: SqlIssue[] = [];
  const known = snapshot.tables.map((table) => lastSegment(table.path));
  for (const match of sql.matchAll(TABLE_REF)) {
    const segments = match[1].split('.').map(unquote);
    if (isSkipped(segments, ctes)) {
      continue;
    }
    const reference = segments.join('.');
    const alias = match[2] ? unquote(match[2]) : undefined;
    const matches = matchTables(snapshot, reference);
    if (matches.length === 0) {
      issues.push(unknownTable(reference, known));
    } else if (matches.length === 1) {
      const usable = alias && !KEYWORDS.has(alias.toLowerCase()) ? alias : undefined;
      refs.push({ table: matches[0], alias: usable ?? lastSegment(reference) });
    }
  }
  return { refs, issues };
}

function columnsOf(snapshot: OntologySnapshot, table: SnapshotTable): Column[] {
  return snapshot.columns.filter((column) => column.tableId === table.tableId);
}

function refFor(refs: TableRef[], qualifier: string): TableRef | undefined {
  const wanted = qualifier.toLowerCase();
  return refs.find((ref) => ref.alias.toLowerCase() === wanted);
}

function checkColumns(sql: string, snapshot: OntologySnapshot, refs: TableRef[]): SqlIssue[] {
  const issues: SqlIssue[] = [];
  const seen = new Set<string>();
  for (const match of sql.matchAll(QUALIFIED)) {
    const ref = refFor(refs, unquote(match[1]));
    const name = unquote(match[2]);
    const key = `${ref?.table.tableId ?? ''}.${name.toLowerCase()}`;
    if (!ref || seen.has(key)) {
      continue;
    }
    seen.add(key);
    const columns = columnsOf(snapshot, ref.table);
    if (columns.some((column) => column.name.toLowerCase() === name.toLowerCase())) {
      continue;
    }
    const suggestion = nearest(
      name,
      columns.map((column) => column.name),
    );
    issues.push({
      code: 'unknown_column',
      severity: 'error',
      message: `Column ${name} is not on ${ref.table.path}${suggestion ? `; did you mean ${suggestion}?` : ''}`,
    });
  }
  return issues;
}

function tableOfColumn(columnId: string): string {
  return columnId.slice(0, columnId.lastIndexOf('.'));
}

function samePair(relation: Relation, a: string, b: string): boolean {
  return (
    (relation.fromColumnId === a && relation.toColumnId === b) ||
    (relation.fromColumnId === b && relation.toColumnId === a)
  );
}

function checkJoins(sql: string, snapshot: OntologySnapshot, refs: TableRef[]): SqlIssue[] {
  const issues: SqlIssue[] = [];
  for (const match of sql.matchAll(JOIN_ON)) {
    const left = refFor(refs, unquote(match[1]));
    const right = refFor(refs, unquote(match[3]));
    if (!left || !right || left.table.tableId === right.table.tableId) {
      continue;
    }
    const a = `${left.table.tableId}.${unquote(match[2])}`;
    const b = `${right.table.tableId}.${unquote(match[4])}`;
    const between = snapshot.relations.filter((relation) => {
      const tables = [tableOfColumn(relation.fromColumnId), tableOfColumn(relation.toColumnId)];
      return tables.includes(left.table.tableId) && tables.includes(right.table.tableId);
    });
    if (between.length > 0 && !between.some((relation) => samePair(relation, a, b))) {
      const known = between.map((relation) => relation.join).join(' or ');
      issues.push({
        code: 'join_mismatch',
        severity: 'warning',
        message: `Join ${unquote(match[1])}.${unquote(match[2])} = ${unquote(match[3])}.${unquote(match[4])} differs from the known join: ${known}`,
      });
    }
  }
  return issues;
}

function constraintNotes(snapshot: OntologySnapshot, refs: TableRef[]): SqlIssue[] {
  const tableIds = new Set(refs.map((ref) => ref.table.tableId));
  const columnTables = new Map(snapshot.columns.map((c) => [c.columnId, c.tableId]));
  const termIds = new Set(
    snapshot.mappings
      .filter((mapping) => tableIds.has(columnTables.get(mapping.columnId) ?? ''))
      .map((mapping) => mapping.termId),
  );
  return snapshot.constraints
    .filter((constraint) => termIds.has(constraint.termId))
    .slice(0, MAX_CONSTRAINT_NOTES)
    .map((constraint) => ({
      code: 'constraint' as const,
      severity: 'note' as const,
      message: `${constraint.termId}: ${constraint.text}`,
    }));
}

/**
 * Advisory check of one statement against the visible ontology. It reads table and column
 * references with patterns, not a full SQL parser, so it can miss issues; it never rejects
 * a statement on its own.
 */
export function checkSqlAgainst(sql: string, snapshot: OntologySnapshot): SqlIssue[] {
  const cleaned = stripLiterals(sql);
  const { refs, issues } = resolveTables(cleaned, snapshot);
  return [
    ...issues,
    ...checkColumns(cleaned, snapshot, refs),
    ...checkJoins(cleaned, snapshot, refs),
    ...constraintNotes(snapshot, refs),
  ];
}
