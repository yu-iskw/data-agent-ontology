import { CONSTRAINT_RULES, satisfiesRule } from './constraint-rules.js';

import type { OntologyDocument } from './document.js';

export type Area =
  | 'domains'
  | 'tables'
  | 'columns'
  | 'terms'
  | 'mappings'
  | 'relations'
  | 'constraints'
  | 'lifecycle'
  | 'evidence';

export interface Finding {
  area: Area;
  key: string;
  detail: string;
}

export interface AreaScore {
  area: Area;
  expected: number;
  matched: number;
}

export interface Report {
  match: boolean;
  scores: AreaScore[];
  /** Differences that break a "What must match" rule of answer/README.md. */
  hard: Finding[];
  /** Differences the README allows, reported for review. */
  soft: Finding[];
}

type Check<T> = (expected: T, actual: T) => string[];

const DATE_CAST = /cast\s*\([^)]*\bas\s+date\s*\)|::\s*date\b|\bdate\s*\(|date_trunc\s*\(\s*'day'/i;

class Names {
  readonly columnKey = new Map<string, string>();
  readonly tablePath = new Map<string, string>();
  readonly termName = new Map<string, string>();

  constructor(doc: OntologyDocument) {
    for (const table of doc.tables) {
      this.tablePath.set(table.tableId, table.path);
    }
    for (const column of doc.columns) {
      this.columnKey.set(column.columnId, `${this.path(column.tableId)}.${column.name}`);
    }
    for (const term of doc.terms) {
      this.termName.set(term.termId, term.name);
    }
  }

  column(columnId: string): string {
    return this.columnKey.get(columnId) ?? `?${columnId}`;
  }

  path(tableId: string): string {
    return this.tablePath.get(tableId) ?? `?${tableId}`;
  }

  term(termId: string): string {
    return this.termName.get(termId) ?? `?${termId}`;
  }
}

class Collector {
  readonly hard: Finding[] = [];
  readonly scores: AreaScore[] = [];
  readonly soft: Finding[] = [];

  keyed<T>(
    area: Area,
    expected: Map<string, T>,
    actual: Map<string, T>,
    checks: { hard?: Check<T>; soft?: Check<T> } = {},
  ): void {
    let matched = 0;
    for (const [key, want] of expected) {
      const got = actual.get(key);
      if (got === undefined) {
        this.hard.push({ area, key, detail: 'missing' });
        continue;
      }
      const problems = checks.hard?.(want, got) ?? [];
      for (const detail of problems) {
        this.hard.push({ area, key, detail });
      }
      for (const detail of checks.soft?.(want, got) ?? []) {
        this.soft.push({ area, key, detail });
      }
      matched += problems.length === 0 ? 1 : 0;
    }
    for (const key of actual.keys()) {
      if (!expected.has(key)) {
        this.hard.push({ area, key, detail: 'unexpected' });
      }
    }
    this.scores.push({ area, expected: expected.size, matched });
  }
}

function differs(label: string, want: unknown, got: unknown): string[] {
  return JSON.stringify(want) === JSON.stringify(got)
    ? []
    : [`${label}: expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`];
}

function keyBy<T>(records: T[], key: (record: T) => string): Map<string, T> {
  return new Map(records.map((record) => [key(record), record]));
}

function compareStructure(c: Collector, want: OntologyDocument, got: OntologyDocument): void {
  const [wn, gn] = [new Names(want), new Names(got)];
  const domainKey = (d: OntologyDocument['domains'][number]): string => d.domainId;
  c.keyed('domains', keyBy(want.domains, domainKey), keyBy(got.domains, domainKey), {
    hard: (e, a) => differs('parent', e.parentDomainId, a.parentDomainId),
    soft: (e, a) => differs('name', e.name, a.name),
  });
  const tableKey = (t: OntologyDocument['tables'][number]): string => `${t.engine}:${t.path}`;
  c.keyed('tables', keyBy(want.tables, tableKey), keyBy(got.tables, tableKey), {
    hard: (e, a) => [
      ...differs('kind', e.kind, a.kind),
      ...differs('domainIds', [...e.domainIds].sort(), [...a.domainIds].sort()),
    ],
  });
  c.keyed(
    'columns',
    keyBy(want.columns, (col) => wn.column(col.columnId)),
    keyBy(got.columns, (col) => gn.column(col.columnId)),
    {
      hard: (e, a) => differs('dataType', e.dataType, a.dataType),
      soft: (e, a) => differs('ordinalPosition', e.ordinalPosition, a.ordinalPosition),
    },
  );
}

function compareSemantics(c: Collector, want: OntologyDocument, got: OntologyDocument): void {
  const [wn, gn] = [new Names(want), new Names(got)];
  const termKey = (t: OntologyDocument['terms'][number]): string => t.name;
  c.keyed('terms', keyBy(want.terms, termKey), keyBy(got.terms, termKey), {
    hard: (e, a) => differs('domainId', e.domainId, a.domainId),
  });
  const mappingKey =
    (names: Names) =>
    (m: OntologyDocument['mappings'][number]): string =>
      `${names.term(m.termId)} -> ${names.column(m.columnId)}`;
  c.keyed('mappings', keyBy(want.mappings, mappingKey(wn)), keyBy(got.mappings, mappingKey(gn)), {
    hard: (e, a) => differs('role', e.role, a.role),
  });
  type RelationView = { name: string; from: string; to: string; join: string };
  const relations = (doc: OntologyDocument, names: Names): Map<string, RelationView> =>
    new Map(
      doc.relations.map((r) => [
        [names.column(r.fromColumnId), names.column(r.toColumnId)].sort().join(' = '),
        { name: r.name, from: names.term(r.fromTermId), to: names.term(r.toTermId), join: r.join },
      ]),
    );
  c.keyed('relations', relations(want, wn), relations(got, gn), {
    hard: (e, a) => [
      ...differs('name', e.name, a.name),
      ...differs('direction', `${e.from} -> ${e.to}`, `${a.from} -> ${a.to}`),
      ...(DATE_CAST.test(e.join) && !DATE_CAST.test(a.join)
        ? [`join must use the calendar date: ${a.join}`]
        : []),
    ],
    soft: (e, a) => differs('join', e.join, a.join),
  });
}

function compareConstraints(c: Collector, want: OntologyDocument, got: OntologyDocument): void {
  const [wn, gn] = [new Names(want), new Names(got)];
  let matched = 0;
  for (const expected of want.constraints) {
    const rule = CONSTRAINT_RULES.get(expected.constraintId);
    const term = wn.term(expected.termId);
    const single = got.constraints.filter((k) => rule && satisfiesRule(k.text, rule));
    const onTerm = got.constraints.filter((k) => gn.term(k.termId) === term);
    const combined = rule !== undefined && satisfiesRule(onTerm.map((k) => k.text).join(' '), rule);
    if (!rule || (single.length === 0 && !combined)) {
      c.hard.push({
        area: 'constraints',
        key: expected.constraintId,
        detail: `missing: ${expected.text}`,
      });
      continue;
    }
    matched += 1;
    if (single.length === 0) {
      c.soft.push({
        area: 'constraints',
        key: expected.constraintId,
        detail: 'rule split across constraints',
      });
    } else if (!single.some((k) => gn.term(k.termId) === term)) {
      const terms = single.map((k) => gn.term(k.termId)).join(', ');
      c.soft.push({
        area: 'constraints',
        key: expected.constraintId,
        detail: `attached to ${terms}, answer uses ${term}`,
      });
    }
  }
  c.scores.push({ area: 'constraints', expected: want.constraints.length, matched });
}

function compareLifecycle(c: Collector, got: OntologyDocument): void {
  const records: [string, { active: boolean; drifted: boolean }][] = [
    ...got.domains.map((r) => [r.domainId, r] as [string, typeof r]),
    ...got.tables.map((r) => [r.tableId, r] as [string, typeof r]),
    ...got.columns.map((r) => [r.columnId, r] as [string, typeof r]),
    ...got.terms.map((r) => [r.termId, r] as [string, typeof r]),
    ...got.mappings.map((r) => [r.mappingId, r] as [string, typeof r]),
    ...got.relations.map((r) => [r.relationId, r] as [string, typeof r]),
    ...got.constraints.map((r) => [r.constraintId, r] as [string, typeof r]),
  ];
  const bad = records.filter(([, r]) => !r.active || r.drifted);
  for (const [key, record] of bad) {
    c.hard.push({
      area: 'lifecycle',
      key,
      detail: `active=${record.active} drifted=${record.drifted}`,
    });
  }
  c.scores.push({
    area: 'lifecycle',
    expected: records.length,
    matched: records.length - bad.length,
  });
}

function compareEvidence(c: Collector, got: OntologyDocument): void {
  const cited = new Set(got.evidence.filter((e) => e.source === 'revise').map((e) => e.targetId));
  const targets = [
    ...got.terms.map((r) => r.termId),
    ...got.mappings.map((r) => r.mappingId),
    ...got.relations.map((r) => r.relationId),
    ...got.constraints.map((r) => r.constraintId),
  ];
  const uncited = targets.filter((id) => !cited.has(id));
  for (const key of uncited) {
    c.hard.push({ area: 'evidence', key, detail: 'no evidence with source "revise"' });
  }
  for (const e of got.evidence.filter((entry) => entry.source !== 'revise')) {
    c.hard.push({ area: 'evidence', key: e.evidenceId, detail: `source is "${e.source}"` });
  }
  c.scores.push({
    area: 'evidence',
    expected: targets.length,
    matched: targets.length - uncited.length,
  });
}

/** Compares an extracted ontology with the answer under the rules of answer/README.md. */
export function compareOntologies(want: OntologyDocument, got: OntologyDocument): Report {
  const c = new Collector();
  compareStructure(c, want, got);
  compareSemantics(c, want, got);
  compareConstraints(c, want, got);
  compareLifecycle(c, got);
  compareEvidence(c, got);
  return { match: c.hard.length === 0, scores: c.scores, hard: c.hard, soft: c.soft };
}
