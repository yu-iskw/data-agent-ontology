import { isVisible } from './model.js';

import type {
  BrowseHit,
  Lifecycle,
  OntologyRecords,
  RecordKind,
  ResolveResult,
  SnapshotTable,
  Table,
  Term,
} from './model.js';

export const MAX_BROWSE_HITS = 6;
export const MAX_RESOLVE_TERMS = 5;

export class ResolveLimitError extends Error {
  constructor(count: number) {
    super(`resolve accepts at most ${MAX_RESOLVE_TERMS} terms, got ${count}`);
    this.name = 'ResolveLimitError';
  }
}

/** Read access to one version's records. */
export interface RecordReader {
  get<K extends RecordKind>(kind: K, id: string): OntologyRecords[K] | undefined;
  list<K extends RecordKind>(kind: K): OntologyRecords[K][];
}

function visible<T extends Lifecycle>(records: T[]): T[] {
  return records.filter(isVisible);
}

function tokens(text: string): string[] {
  const words = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return words.flatMap((word) => [word, ...word.split('_')]).map((word) => word.replace(/s$/, ''));
}

function score(question: Set<string>, fields: string[]): number {
  const haystack = new Set(fields.flatMap(tokens));
  return [...question].filter((token) => token.length > 1 && haystack.has(token)).length;
}

function termFields(reader: RecordReader, term: Term): string[] {
  const columns = visible(reader.list('mappings'))
    .filter((mapping) => mapping.termId === term.termId)
    .map((mapping) => reader.get('columns', mapping.columnId)?.name ?? '');
  return [term.termId, term.name, term.definition, ...columns];
}

/** Semantic routing (RFC section 8): a short list of visible domains and terms. */
export function browseRecords(reader: RecordReader, question: string): BrowseHit[] {
  const wanted = new Set(tokens(question));
  const hits: BrowseHit[] = [
    ...visible(reader.list('domains')).map((domain) => ({
      kind: 'domain' as const,
      id: domain.domainId,
      name: domain.name,
      domainId: domain.parentDomainId,
      score: score(wanted, [domain.domainId, domain.name]),
    })),
    ...visible(reader.list('terms')).map((term) => ({
      kind: 'term' as const,
      id: term.termId,
      name: term.name,
      domainId: term.domainId,
      score: score(wanted, termFields(reader, term)),
    })),
  ];
  return hits
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
    .slice(0, MAX_BROWSE_HITS);
}

export function withoutRevisionFlag(table: Table): SnapshotTable {
  const { membershipRevised, ...visible } = table;
  void membershipRevised;
  return visible;
}

function visibleById<K extends 'tables' | 'columns'>(
  reader: RecordReader,
  kind: K,
  ids: string[],
): OntologyRecords[K][] {
  return [...new Set(ids)]
    .map((id) => reader.get(kind, id))
    .filter((record): record is OntologyRecords[K] => record !== undefined && isVisible(record));
}

/** Grounds terms into warehouse knowledge (RFC section 8). Inactive and drifted records are omitted. */
export function resolveRecords(
  reader: RecordReader,
  termIds: string[],
): Omit<ResolveResult, 'versionId'> {
  if (termIds.length > MAX_RESOLVE_TERMS) {
    throw new ResolveLimitError(termIds.length);
  }
  const wanted = new Set(termIds);
  const terms = visible(reader.list('terms')).filter((term) => wanted.has(term.termId));
  const termSet = new Set(terms.map((term) => term.termId));
  const mappings = visible(reader.list('mappings')).filter((m) => termSet.has(m.termId));
  const columns = visibleById(
    reader,
    'columns',
    mappings.map((m) => m.columnId),
  );
  const tables = visibleById(
    reader,
    'tables',
    columns.map((c) => c.tableId),
  ).map(withoutRevisionFlag);
  const relations = visible(reader.list('relations')).filter(
    (r) => termSet.has(r.fromTermId) || termSet.has(r.toTermId),
  );
  const constraints = visible(reader.list('constraints')).filter((c) => termSet.has(c.termId));
  const targets = new Set([
    ...termSet,
    ...mappings.map((m) => m.mappingId),
    ...relations.map((r) => r.relationId),
    ...constraints.map((c) => c.constraintId),
  ]);
  const evidence = reader.list('evidence').filter((e) => targets.has(e.targetId));
  return { terms, mappings, tables, columns, relations, constraints, evidence };
}
