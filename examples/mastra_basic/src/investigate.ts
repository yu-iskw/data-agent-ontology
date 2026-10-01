import type { Proposal } from './proposal.js';
import type { Warehouse } from './warehouse.js';

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;
const GENERIC_NOUNS = new Set(['day', 'date', 'item', 'line', 'entry', 'event']);
const PARTY_TERMS = new Set(['customer', 'user', 'person', 'account', 'organization']);
const SITE_TERMS = new Set(['location', 'store', 'site', 'shop']);
const GOODS_TERMS = new Set(['product', 'good', 'sku']);
const COMPONENT_TABLES = new Set(['supplies', 'parts', 'components', 'ingredients']);
const SUMMARY_TIMESTAMP = /^(first|last|min|max|earliest|latest|opened|created|updated|closed)_/;
const CALENDAR_DOMAIN = 'calendar';
const CATALOG_DOMAIN = 'catalog';
const LINE_SUFFIXES = ['_items', '_lines', '_entries'] as const;
const NO_LIMIT = Number.MAX_SAFE_INTEGER;

interface ColumnInfo {
  name: string;
  dataType: string;
  ordinal: number;
}

interface TableInfo {
  schema: string;
  name: string;
  path: string;
  kind: 'table' | 'view';
  columns: ColumnInfo[];
}

interface ForeignKey {
  column: string;
  parentPath: string;
  parentColumn: string;
}

interface KeyedTable {
  table: TableInfo;
  primaryKey: string;
  foreignKeys: ForeignKey[];
}

interface Mart extends KeyedTable {
  termId: string;
  domainId: string;
}

interface DraftRelation {
  name: string;
  fromTermId: string;
  toTermId: string;
  fromColumn: string;
  toColumn: string;
  join: string;
  evidence: string;
}

interface DraftConstraint {
  termId: string;
  text: string;
  evidence: string;
  layer: boolean;
}

type Family = 'char' | 'number' | 'time' | 'other';

function ident(value: string): string {
  if (!IDENTIFIER.test(value)) {
    throw new Error(`Refusing a warehouse identifier: ${value}`);
  }
  return value;
}

function qualify(path: string): string {
  const parts = path.split('.');
  const schema = parts.at(0);
  const table = parts.at(1);
  if (schema === undefined || table === undefined || parts.length !== 2) {
    throw new Error(`Expected schema.table, got ${path}`);
  }
  return `${ident(schema)}.${ident(table)}`;
}

function columnRef(path: string, column: string): string {
  return `${qualify(path)}.${ident(column)}`;
}

function singular(name: string): string {
  if (name.endsWith('ies')) {
    return `${name.slice(0, -3)}y`;
  }
  if (name.endsWith('s') && !name.endsWith('ss')) {
    return name.slice(0, -1);
  }
  return name;
}

function titleName(id: string): string {
  return id
    .split('_')
    .map((part) => (part.length === 0 ? part : `${part.charAt(0).toUpperCase()}${part.slice(1)}`))
    .join(' ');
}

function includesAny(value: string, needles: readonly string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function typeFamily(dataType: string): Family {
  const upper = dataType.toUpperCase();
  if (includesAny(upper, ['CHAR', 'TEXT', 'STRING'])) {
    return 'char';
  }
  if (includesAny(upper, ['INT', 'DECIMAL', 'DOUBLE', 'FLOAT', 'NUMERIC', 'REAL'])) {
    return 'number';
  }
  if (includesAny(upper, ['TIMESTAMP', 'DATETIME', 'DATE'])) {
    return 'time';
  }
  return 'other';
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  if (
    typeof value === 'string' ||
    typeof value === 'number' ||
    typeof value === 'boolean' ||
    typeof value === 'bigint'
  ) {
    return String(value);
  }
  throw new Error('Unexpected SQL cell');
}

function cells(row: Record<string, unknown>): Map<string, string> {
  return new Map(Object.entries(row).map(([key, value]) => [key, cellText(value)]));
}

async function oneRow(warehouse: Warehouse, sql: string): Promise<Map<string, string>> {
  const result = await warehouse.query(sql, NO_LIMIT);
  const row = result.rows.at(0);
  if (row === undefined) {
    throw new Error(`Query returned no row: ${sql}`);
  }
  return cells(row);
}

async function rowsOf(warehouse: Warehouse, sql: string): Promise<Map<string, string>[]> {
  const result = await warehouse.query(sql, NO_LIMIT);
  return result.rows.map((row) => cells(row));
}

function numberValue(row: Map<string, string>, key: string): number {
  const raw = row.get(key);
  if (raw === undefined || raw === '') {
    throw new Error(`Missing numeric cell ${key}`);
  }
  const value = Number(raw);
  if (Number.isNaN(value)) {
    throw new Error(`Cell ${key} is not a number: ${raw}`);
  }
  return value;
}

async function readCatalog(warehouse: Warehouse): Promise<TableInfo[]> {
  const objects = await rowsOf(
    warehouse,
    `SELECT table_schema, table_name, table_type
     FROM information_schema.tables
     WHERE table_catalog = current_database()
       AND table_schema NOT IN ('information_schema', 'pg_catalog')
     ORDER BY table_schema, table_name`,
  );
  const columns = await rowsOf(
    warehouse,
    `SELECT table_schema, table_name, column_name, data_type, ordinal_position
     FROM information_schema.columns
     WHERE table_catalog = current_database()
       AND table_schema NOT IN ('information_schema', 'pg_catalog')
     ORDER BY table_schema, table_name, ordinal_position`,
  );
  return objects.map((object) => {
    const schema = object.get('table_schema') ?? '';
    const name = object.get('table_name') ?? '';
    const path = `${schema}.${name}`;
    const tableColumns = columns
      .filter(
        (column) => column.get('table_schema') === schema && column.get('table_name') === name,
      )
      .map((column) => ({
        name: column.get('column_name') ?? '',
        dataType: column.get('data_type') ?? '',
        ordinal: numberValue(column, 'ordinal_position'),
      }));
    const kind = object.get('table_type') === 'VIEW' ? 'view' : 'table';
    return { schema, name, path, kind, columns: tableColumns };
  });
}

function analysisTables(tables: TableInfo[]): TableInfo[] {
  return tables.filter(
    (table) => table.kind === 'table' && table.schema !== 'raw' && !table.name.startsWith('stg_'),
  );
}

async function uniqueColumns(warehouse: Warehouse, table: TableInfo): Promise<string[]> {
  const measures = table.columns.flatMap((column) => {
    const name = ident(column.name);
    return [
      `COUNT(DISTINCT ${name}) AS ${name}_distinct`,
      `SUM(CASE WHEN ${name} IS NULL THEN 1 ELSE 0 END) AS ${name}_nulls`,
    ];
  });
  const row = await oneRow(
    warehouse,
    `SELECT COUNT(*) AS n, ${measures.join(', ')} FROM ${qualify(table.path)}`,
  );
  const total = numberValue(row, 'n');
  if (total === 0) {
    return [];
  }
  return table.columns
    .filter(
      (column) =>
        numberValue(row, `${ident(column.name)}_distinct`) === total &&
        numberValue(row, `${ident(column.name)}_nulls`) === 0,
    )
    .map((column) => column.name);
}

function choosePrimaryKey(tableName: string, unique: readonly string[]): string {
  if (unique.length === 0) {
    throw new Error(`No unique non-null column on ${tableName}`);
  }
  const noun = singular(tableName);
  const preferred = [`${noun}_id`, `${noun}_uuid`, `${tableName}_id`, 'id'];
  for (const name of preferred) {
    if (unique.includes(name)) {
      return name;
    }
  }
  const fallback =
    unique.find((name) => name.endsWith('_uuid')) ??
    unique.find((name) => name.endsWith('_id')) ??
    unique.at(0);
  if (fallback === undefined) {
    throw new Error(`No unique non-null column on ${tableName}`);
  }
  return fallback;
}

async function isContained(
  warehouse: Warehouse,
  childPath: string,
  column: string,
  parentPath: string,
  parentColumn: string,
): Promise<boolean> {
  const row = await oneRow(
    warehouse,
    `SELECT SUM(CASE WHEN c.${ident(column)} IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM ${qualify(parentPath)} p WHERE p.${ident(parentColumn)} = c.${ident(column)}
     ) THEN 1 ELSE 0 END) AS missing
     FROM ${qualify(childPath)} c`,
  );
  return numberValue(row, 'missing') === 0;
}

async function parentsContaining(
  warehouse: Warehouse,
  table: KeyedTable,
  column: ColumnInfo,
  keyed: readonly KeyedTable[],
): Promise<KeyedTable[]> {
  const matches: KeyedTable[] = [];
  for (const parent of keyed) {
    if (parent.table.path === table.table.path) {
      continue;
    }
    const parentType = parent.table.columns.find((item) => item.name === parent.primaryKey);
    if (parentType === undefined || typeFamily(parentType.dataType) !== 'char') {
      continue;
    }
    const contained = await isContained(
      warehouse,
      table.table.path,
      column.name,
      parent.table.path,
      parent.primaryKey,
    );
    if (contained) {
      matches.push(parent);
    }
  }
  return matches;
}

function chosenParent(matches: readonly KeyedTable[], column: string): KeyedTable | undefined {
  const named = matches.filter((parent) => parent.primaryKey === column);
  if (named.length === 1) {
    return named.at(0);
  }
  if (matches.length === 1) {
    return matches.at(0);
  }
  return undefined;
}

async function findForeignKeys(
  warehouse: Warehouse,
  table: KeyedTable,
  keyed: readonly KeyedTable[],
): Promise<ForeignKey[]> {
  const found: ForeignKey[] = [];
  for (const column of table.table.columns) {
    if (column.name === table.primaryKey || typeFamily(column.dataType) !== 'char') {
      continue;
    }
    const chosen = chosenParent(
      await parentsContaining(warehouse, table, column, keyed),
      column.name,
    );
    if (chosen !== undefined) {
      found.push({
        column: column.name,
        parentPath: chosen.table.path,
        parentColumn: chosen.primaryKey,
      });
    }
  }
  return found;
}

async function keyTables(
  warehouse: Warehouse,
  tables: readonly TableInfo[],
): Promise<KeyedTable[]> {
  const keyed: KeyedTable[] = [];
  for (const table of tables) {
    const primaryKey = choosePrimaryKey(table.name, await uniqueColumns(warehouse, table));
    keyed.push({ table, primaryKey, foreignKeys: [] });
  }
  for (const table of keyed) {
    table.foreignKeys = await findForeignKeys(warehouse, table, keyed);
  }
  return keyed;
}

function lineStem(tableName: string): string | undefined {
  for (const suffix of LINE_SUFFIXES) {
    if (tableName.endsWith(suffix)) {
      return tableName.slice(0, -suffix.length);
    }
  }
  return undefined;
}

function lineParent<T extends KeyedTable>(table: T, keyed: readonly T[]): T | undefined {
  const stem = lineStem(table.table.name);
  if (stem === undefined) {
    return undefined;
  }
  const parent = keyed.find(
    (other) => other.table.name === stem || singular(other.table.name) === stem,
  );
  if (parent === undefined) {
    return undefined;
  }
  const linked = table.foreignKeys.some((key) => key.parentPath === parent.table.path);
  return linked ? parent : undefined;
}

function isCalendarTable(table: KeyedTable): boolean {
  if (/time_spine|date_spine|calendar/.test(table.table.name)) {
    return true;
  }
  const dates = table.table.columns.filter((column) => column.dataType.toUpperCase() === 'DATE');
  return (
    dates.length === 1 && dates[0]?.name === table.primaryKey && table.table.columns.length === 1
  );
}

function catalogPaths(keyed: readonly KeyedTable[]): Set<string> {
  const goods = keyed.filter((table) => GOODS_TERMS.has(singular(table.table.name)));
  const paths = new Set<string>();
  for (const component of keyed.filter((table) => COMPONENT_TABLES.has(table.table.name))) {
    const link = component.foreignKeys.find((key) =>
      goods.some((good) => good.table.path === key.parentPath),
    );
    const good = goods.find((item) => item.table.path === link?.parentPath);
    if (link !== undefined && good !== undefined && lineParent(component, keyed) === undefined) {
      paths.add(component.table.path);
      paths.add(good.table.path);
    }
  }
  return paths;
}

function timeUnit(column: string): string {
  if (column.includes('week')) {
    return 'week';
  }
  if (column.includes('month')) {
    return 'month';
  }
  if (column.includes('quarter')) {
    return 'quarter';
  }
  if (column.includes('year')) {
    return 'year';
  }
  return 'day';
}

function termForTable(table: KeyedTable, domainId: string, calendar: boolean): string {
  if (calendar) {
    const unit = timeUnit(table.primaryKey);
    return GENERIC_NOUNS.has(unit) ? `${CALENDAR_DOMAIN}_${unit}` : unit;
  }
  const noun = singular(table.table.name);
  return GENERIC_NOUNS.has(noun) ? `${domainId}_${noun}` : noun;
}

function domainFor(
  table: KeyedTable,
  keyed: readonly KeyedTable[],
  catalog: ReadonlySet<string>,
): string {
  if (isCalendarTable(table)) {
    return CALENDAR_DOMAIN;
  }
  if (catalog.has(table.table.path)) {
    return CATALOG_DOMAIN;
  }
  return lineParent(table, keyed)?.table.name ?? table.table.name;
}

function assignMarts(keyed: readonly KeyedTable[]): Mart[] {
  const catalog = catalogPaths(keyed);
  return keyed.map((table) => {
    const domainId = domainFor(table, keyed, catalog);
    return {
      ...table,
      domainId,
      termId: termForTable(table, domainId, domainId === CALENDAR_DOMAIN),
    };
  });
}

function isDocument(mart: Mart, marts: readonly Mart[]): boolean {
  return marts.some((other) => lineParent(other, marts)?.table.path === mart.table.path);
}

interface RelationInput {
  name: string;
  from: Mart;
  to: Mart;
  fromColumn: string;
  toColumn: string;
  join: string;
}

function relation(input: RelationInput): DraftRelation {
  return {
    name: input.name,
    fromTermId: input.from.termId,
    toTermId: input.to.termId,
    fromColumn: input.fromColumn,
    toColumn: input.toColumn,
    join: input.join,
    evidence: `Checked ${input.join}.`,
  };
}

function partyRelation(
  child: Mart,
  parent: Mart,
  parentRef: string,
  childRef: string,
  marts: readonly Mart[],
): DraftRelation | undefined {
  if (!PARTY_TERMS.has(parent.termId) || !isDocument(child, marts)) {
    return undefined;
  }
  const name = child.termId === 'order' ? 'places' : 'creates';
  return relation({
    name,
    from: parent,
    to: child,
    fromColumn: parentRef,
    toColumn: childRef,
    join: `${parentRef} = ${childRef}`,
  });
}

function containsRelation(
  child: Mart,
  parent: Mart,
  parentRef: string,
  childRef: string,
  marts: readonly Mart[],
): DraftRelation | undefined {
  const childIsLine = lineParent(child, marts)?.table.path === parent.table.path;
  if (!isDocument(parent, marts) || !childIsLine) {
    return undefined;
  }
  return relation({
    name: 'contains',
    from: parent,
    to: child,
    fromColumn: parentRef,
    toColumn: childRef,
    join: `${parentRef} = ${childRef}`,
  });
}

function goodsRelation(
  child: Mart,
  parent: Mart,
  parentRef: string,
  childRef: string,
  marts: readonly Mart[],
): DraftRelation | undefined {
  if (!GOODS_TERMS.has(parent.termId)) {
    return undefined;
  }
  if (lineParent(child, marts) !== undefined) {
    const column = childRef.split('.').at(-1) ?? '';
    const noun = column.endsWith('_id') ? column.slice(0, -'_id'.length) : column;
    return relation({
      name: `for_${noun}`,
      from: child,
      to: parent,
      fromColumn: childRef,
      toColumn: parentRef,
      join: `${childRef} = ${parentRef}`,
    });
  }
  if (!COMPONENT_TABLES.has(child.table.name)) {
    return undefined;
  }
  return relation({
    name: 'used_by',
    from: child,
    to: parent,
    fromColumn: childRef,
    toColumn: parentRef,
    join: `${childRef} = ${parentRef}`,
  });
}

function siteRelation(
  child: Mart,
  parent: Mart,
  parentRef: string,
  childRef: string,
  marts: readonly Mart[],
): DraftRelation | undefined {
  if (!SITE_TERMS.has(parent.termId)) {
    return undefined;
  }
  const line = lineParent(child, marts);
  const subject = isDocument(child, marts) ? child.termId : (line?.termId ?? child.termId);
  return relation({
    name: subject === 'order' ? 'placed_at' : 'at_site',
    from: child,
    to: parent,
    fromColumn: childRef,
    toColumn: parentRef,
    join: `${childRef} = ${parentRef}`,
  });
}

function fkRelation(
  child: Mart,
  parent: Mart,
  fk: ForeignKey,
  marts: readonly Mart[],
): DraftRelation | undefined {
  const childRef = columnRef(child.table.path, fk.column);
  const parentRef = columnRef(parent.table.path, fk.parentColumn);
  return (
    partyRelation(child, parent, parentRef, childRef, marts) ??
    containsRelation(child, parent, parentRef, childRef, marts) ??
    goodsRelation(child, parent, parentRef, childRef, marts) ??
    siteRelation(child, parent, parentRef, childRef, marts)
  );
}

function relationsFromKeys(marts: readonly Mart[]): DraftRelation[] {
  const relations: DraftRelation[] = [];
  for (const child of marts) {
    for (const fk of child.foreignKeys) {
      const parent = marts.find((mart) => mart.table.path === fk.parentPath);
      if (parent === undefined) {
        continue;
      }
      const draft = fkRelation(child, parent, fk, marts);
      if (draft !== undefined) {
        relations.push(draft);
      }
    }
  }
  return relations;
}

function eventColumns(mart: Mart): string[] {
  return mart.table.columns
    .filter(
      (column) =>
        column.dataType.toUpperCase().includes('TIMESTAMP') &&
        column.name.endsWith('_at') &&
        !SUMMARY_TIMESTAMP.test(column.name),
    )
    .map((column) => column.name);
}

async function onCalendar(
  warehouse: Warehouse,
  event: Mart,
  column: string,
  calendar: Mart,
): Promise<boolean> {
  const row = await oneRow(
    warehouse,
    `SELECT SUM(CASE WHEN e.${ident(column)} IS NOT NULL AND NOT EXISTS (
       SELECT 1 FROM ${qualify(calendar.table.path)} d
       WHERE d.${ident(calendar.primaryKey)} = CAST(e.${ident(column)} AS DATE)
     ) THEN 1 ELSE 0 END) AS missing
     FROM ${qualify(event.table.path)} e`,
  );
  return numberValue(row, 'missing') === 0;
}

async function calendarRelations(
  warehouse: Warehouse,
  marts: readonly Mart[],
): Promise<DraftRelation[]> {
  const calendar = marts.find((mart) => mart.domainId === CALENDAR_DOMAIN);
  if (calendar === undefined) {
    return [];
  }
  const relations: DraftRelation[] = [];
  const events = marts.filter(
    (mart) => isDocument(mart, marts) || lineParent(mart, marts) !== undefined,
  );
  for (const event of events) {
    for (const column of eventColumns(event)) {
      if (!(await onCalendar(warehouse, event, column, calendar))) {
        continue;
      }
      const from = columnRef(event.table.path, column);
      const to = columnRef(calendar.table.path, calendar.primaryKey);
      relations.push(
        relation({
          name: 'occurs_on',
          from: event,
          to: calendar,
          fromColumn: from,
          toColumn: to,
          join: `CAST(${from} AS DATE) = ${to}`,
        }),
      );
    }
  }
  return relations;
}

function numericColumns(mart: Mart): ColumnInfo[] {
  return mart.table.columns.filter((column) => typeFamily(column.dataType) === 'number');
}

async function failures(warehouse: Warehouse, sql: string): Promise<number> {
  return numberValue(await oneRow(warehouse, sql), 'bad');
}

function namesOverlap(left: string, right: string): boolean {
  return left.includes(right) || right.includes(left);
}

function checkedConstraint(mart: Mart, text: string): DraftConstraint {
  return { termId: mart.termId, text, evidence: `Checked ${text}`, layer: false };
}

function equalityPairs(mart: Mart): [ColumnInfo, ColumnInfo][] {
  const columns = numericColumns(mart);
  const pairs: [ColumnInfo, ColumnInfo][] = [];
  for (const left of columns) {
    for (const right of columns) {
      if (left.ordinal < right.ordinal && namesOverlap(left.name, right.name)) {
        pairs.push([left, right]);
      }
    }
  }
  return pairs;
}

async function equalityConstraints(warehouse: Warehouse, mart: Mart): Promise<DraftConstraint[]> {
  const pairs = equalityPairs(mart);
  if (pairs.length === 0) {
    return [];
  }
  const selects = pairs.map(
    ([left, right], index) =>
      `SUM(CASE WHEN ${ident(left.name)} = ${ident(right.name)}
         OR (${ident(left.name)} IS NULL AND ${ident(right.name)} = 0)
         OR (${ident(right.name)} IS NULL AND ${ident(left.name)} = 0)
         THEN 0 ELSE 1 END) AS p${index}`,
  );
  const row = await oneRow(
    warehouse,
    `SELECT ${selects.join(', ')} FROM ${qualify(mart.table.path)}`,
  );
  return pairs.flatMap(([left, right], index) => {
    if (numberValue(row, `p${index}`) !== 0) {
      return [];
    }
    const text = `${columnRef(mart.table.path, left.name)} = ${columnRef(mart.table.path, right.name)}.`;
    return [checkedConstraint(mart, text)];
  });
}

interface SumTriple {
  left: ColumnInfo;
  first: ColumnInfo;
  second: ColumnInfo;
}

function sumTriples(mart: Mart): SumTriple[] {
  const totals = numericColumns(mart).filter((column) =>
    /total|spend|sum|subtotal/.test(column.name),
  );
  const others = numericColumns(mart);
  const triples: SumTriple[] = [];
  for (const left of totals) {
    for (const [index, first] of others.entries()) {
      for (const second of others.slice(index + 1)) {
        if (first.name !== left.name && second.name !== left.name) {
          triples.push({ left, first, second });
        }
      }
    }
  }
  return triples;
}

async function sumConstraints(warehouse: Warehouse, mart: Mart): Promise<DraftConstraint[]> {
  const triples = sumTriples(mart);
  if (triples.length === 0) {
    return [];
  }
  const selects = triples.map(
    (triple, index) =>
      `SUM(CASE WHEN ${ident(triple.left.name)} IS NOT DISTINCT FROM ${ident(triple.first.name)} + ${ident(triple.second.name)}
         THEN 0 ELSE 1 END) AS p${index}`,
  );
  const row = await oneRow(
    warehouse,
    `SELECT ${selects.join(', ')} FROM ${qualify(mart.table.path)}`,
  );
  return triples.flatMap((triple, index) => {
    if (numberValue(row, `p${index}`) !== 0) {
      return [];
    }
    const text = `${columnRef(mart.table.path, triple.left.name)} = ${columnRef(mart.table.path, triple.first.name)} + ${columnRef(mart.table.path, triple.second.name)}.`;
    return [checkedConstraint(mart, text)];
  });
}

async function centBases(warehouse: Warehouse, mart: Mart): Promise<string[]> {
  const bases: string[] = [];
  for (const column of numericColumns(mart)) {
    if (!column.name.endsWith('_cents')) {
      continue;
    }
    const base = column.name.slice(0, -'_cents'.length);
    if (!mart.table.columns.some((item) => item.name === base)) {
      continue;
    }
    const bad = await failures(
      warehouse,
      `SELECT SUM(CASE WHEN ${ident(base)} = ${ident(column.name)} / 100 THEN 0 ELSE 1 END) AS bad
       FROM ${qualify(mart.table.path)}`,
    );
    if (bad === 0) {
      bases.push(base);
    }
  }
  return bases;
}

async function moneyLayer(
  warehouse: Warehouse,
  marts: readonly Mart[],
): Promise<DraftConstraint | undefined> {
  let best: { mart: Mart; bases: string[] } | undefined;
  for (const mart of marts) {
    const bases = await centBases(warehouse, mart);
    if (best === undefined || bases.length > best.bases.length) {
      best = { mart, bases };
    }
  }
  if (best === undefined || best.bases.length === 0) {
    return undefined;
  }
  const listed = best.bases.join(', ');
  const text =
    `Analyze from ${best.mart.table.schema} marts. raw.* money columns are integer cents. ` +
    `Dollar amounts on ${qualify(best.mart.table.path)} (${listed}) are those cents divided by 100.`;
  return {
    termId: best.mart.termId,
    text,
    evidence: `Checked ${listed} = cents / 100.`,
    layer: true,
  };
}

function quoteList(values: readonly string[]): string {
  return values.join(' or ');
}

async function flagConstraint(
  warehouse: Warehouse,
  mart: Mart,
  category: string,
): Promise<DraftConstraint | undefined> {
  const flags = mart.table.columns.filter((column) => column.dataType.toUpperCase() === 'BOOLEAN');
  if (flags.length === 0) {
    return undefined;
  }
  const flagSelects = flags
    .map(
      (flag) => `SUM(CASE WHEN ${ident(flag.name)} THEN 1 ELSE 0 END) AS ${ident(flag.name)}_true`,
    )
    .join(', ');
  const groups = await rowsOf(
    warehouse,
    `SELECT ${ident(category)} AS category_value, COUNT(*) AS n, ${flagSelects}
     FROM ${qualify(mart.table.path)} GROUP BY 1`,
  );
  if (groups.length < 2 || groups.length > 6) {
    return undefined;
  }
  const sentences: string[] = [];
  for (const flag of flags) {
    const matched = groups.filter(
      (group) => numberValue(group, `${flag.name}_true`) === numberValue(group, 'n'),
    );
    const mixed = groups.some((group) => {
      const trues = numberValue(group, `${flag.name}_true`);
      const total = numberValue(group, 'n');
      return trues !== 0 && trues !== total;
    });
    const only = matched[0]?.get('category_value');
    if (!mixed && matched.length === 1 && only !== undefined && only !== '') {
      sentences.push(`${flag.name} is true exactly when ${category} is ${only}`);
    }
  }
  if (sentences.length === 0) {
    return undefined;
  }
  const values = groups
    .map((group) => group.get('category_value') ?? '')
    .filter((value) => value !== '');
  const text = `${columnRef(mart.table.path, category)} is only ${quoteList(values)}. ${sentences.join('. ')}.`;
  return {
    termId: mart.termId,
    text,
    evidence: `Checked ${category} against ${flags.length} flags.`,
    layer: false,
  };
}

async function statusConstraint(
  warehouse: Warehouse,
  mart: Mart,
  category: string,
): Promise<DraftConstraint | undefined> {
  const counts = mart.table.columns.filter(
    (column) => typeFamily(column.dataType) === 'number' && column.name.startsWith('count_'),
  );
  for (const count of counts) {
    const groups = await rowsOf(
      warehouse,
      `SELECT ${ident(category)} AS category_value, COUNT(*) AS n,
         MIN(${ident(count.name)}) AS min_v, MAX(${ident(count.name)}) AS max_v,
         SUM(CASE WHEN ${ident(count.name)} = 1 THEN 1 ELSE 0 END) AS ones
       FROM ${qualify(mart.table.path)} GROUP BY 1`,
    );
    if (groups.length < 2) {
      continue;
    }
    const special = groups.find(
      (group) =>
        numberValue(group, 'ones') === numberValue(group, 'n') &&
        numberValue(group, 'min_v') === 1 &&
        numberValue(group, 'max_v') === 1,
    );
    const othersClear = groups
      .filter((group) => group !== special)
      .every((group) => numberValue(group, 'ones') === 0);
    const specialValue = special?.get('category_value');
    if (
      special === undefined ||
      !othersClear ||
      specialValue === undefined ||
      specialValue === ''
    ) {
      continue;
    }
    const values = groups
      .map((group) => group.get('category_value') ?? '')
      .filter((value) => value !== '');
    const text =
      `${columnRef(mart.table.path, category)} is only ${quoteList(values)}. ` +
      `${specialValue} means ${columnRef(mart.table.path, count.name)} = 1. ` +
      'It is a status, not a kind of person.';
    return {
      termId: mart.termId,
      text,
      evidence: `Checked ${category} against ${count.name}.`,
      layer: false,
    };
  }
  return undefined;
}

async function categoryConstraints(warehouse: Warehouse, mart: Mart): Promise<DraftConstraint[]> {
  const found: DraftConstraint[] = [];
  for (const column of mart.table.columns) {
    if (typeFamily(column.dataType) !== 'char') {
      continue;
    }
    const distinct = numberValue(
      await oneRow(
        warehouse,
        `SELECT COUNT(DISTINCT ${ident(column.name)}) AS n FROM ${qualify(mart.table.path)}`,
      ),
      'n',
    );
    if (distinct < 2 || distinct > 6) {
      continue;
    }
    const flags = await flagConstraint(warehouse, mart, column.name);
    if (flags !== undefined) {
      found.push(flags);
    }
    const status = await statusConstraint(warehouse, mart, column.name);
    if (status !== undefined) {
      found.push(status);
    }
  }
  return found;
}

function sharedCost(line: Mart, component: Mart): string | undefined {
  const componentNames = new Set(component.table.columns.map((column) => column.name));
  return line.table.columns.find(
    (column) =>
      column.name.includes('cost') &&
      componentNames.has(column.name) &&
      typeFamily(column.dataType) === 'number',
  )?.name;
}

interface Rollup {
  mart: Mart;
  grouped: Mart;
  groupKey: string;
  martKey: string;
  cost: string;
}

async function rolledUpCost(warehouse: Warehouse, rollup: Rollup): Promise<string | undefined> {
  const totals = `(SELECT ${ident(rollup.groupKey)} AS grain, SUM(${ident(rollup.cost)}) AS sum_cost
     FROM ${qualify(rollup.grouped.table.path)} GROUP BY 1)`;
  for (const column of numericColumns(rollup.mart)) {
    if (!column.name.includes('cost')) {
      continue;
    }
    const bad = await failures(
      warehouse,
      `SELECT SUM(CASE WHEN m.${ident(column.name)} = s.sum_cost THEN 0 ELSE 1 END) AS bad
       FROM ${qualify(rollup.mart.table.path)} m
       JOIN ${totals} s ON m.${ident(rollup.martKey)} = s.grain`,
    );
    if (bad === 0) {
      return column.name;
    }
  }
  return undefined;
}

async function doubleCountConstraint(
  warehouse: Warehouse,
  marts: readonly Mart[],
): Promise<DraftConstraint | undefined> {
  for (const line of marts) {
    const parent = lineParent(line, marts);
    if (parent === undefined) {
      continue;
    }
    for (const component of marts.filter((mart) => COMPONENT_TABLES.has(mart.table.name))) {
      const cost = sharedCost(line, component);
      const goods = marts.find((mart) =>
        component.foreignKeys.some(
          (key) => key.parentPath === mart.table.path && GOODS_TERMS.has(mart.termId),
        ),
      );
      const lineGoods = line.foreignKeys.find((key) => key.parentPath === goods?.table.path);
      const componentGoods = component.foreignKeys.find(
        (key) => key.parentPath === goods?.table.path,
      );
      const lineToParent = line.foreignKeys.find((key) => key.parentPath === parent.table.path);
      if (
        cost === undefined ||
        goods === undefined ||
        lineGoods === undefined ||
        componentGoods === undefined ||
        lineToParent === undefined
      ) {
        continue;
      }
      const lineMatches = await rolledUpCost(warehouse, {
        mart: line,
        grouped: component,
        groupKey: componentGoods.column,
        martKey: lineGoods.column,
        cost,
      });
      const documentCost = await rolledUpCost(warehouse, {
        mart: parent,
        grouped: line,
        groupKey: lineToParent.column,
        martKey: parent.primaryKey,
        cost,
      });
      if (lineMatches === undefined || documentCost === undefined) {
        continue;
      }
      const text =
        `${columnRef(line.table.path, lineMatches)} and ${columnRef(parent.table.path, documentCost)} ` +
        `already sum supplies for the product. Do not add them again to ${columnRef(component.table.path, cost)}.`;
      return {
        termId: line.termId,
        text,
        evidence: `Checked ${lineMatches} and ${documentCost} against ${cost}.`,
        layer: false,
      };
    }
  }
  return undefined;
}

function dateText(value: string): string {
  return value.slice(0, 10);
}

async function calendarConstraint(
  warehouse: Warehouse,
  marts: readonly Mart[],
): Promise<DraftConstraint | undefined> {
  const calendar = marts.find((mart) => mart.domainId === CALENDAR_DOMAIN);
  if (calendar === undefined) {
    return undefined;
  }
  const row = await oneRow(
    warehouse,
    `SELECT MIN(${ident(calendar.primaryKey)}) AS min_day, MAX(${ident(calendar.primaryKey)}) AS max_day
     FROM ${qualify(calendar.table.path)}`,
  );
  const minDay = dateText(row.get('min_day') ?? '');
  const maxDay = dateText(row.get('max_day') ?? '');
  const column = columnRef(calendar.table.path, calendar.primaryKey);
  const text = `${column} is a calendar from ${minDay} through ${maxDay}, not a table of business events.`;
  return { termId: calendar.termId, text, evidence: `Checked ${column} bounds.`, layer: false };
}

async function collectConstraints(
  warehouse: Warehouse,
  marts: readonly Mart[],
): Promise<DraftConstraint[]> {
  const layer = await moneyLayer(warehouse, marts);
  const arithmetic = (
    await Promise.all(
      marts.flatMap((mart) => [
        equalityConstraints(warehouse, mart),
        sumConstraints(warehouse, mart),
      ]),
    )
  ).flat();
  const categories = (
    await Promise.all(marts.map((mart) => categoryConstraints(warehouse, mart)))
  ).flat();
  const doubleCount = await doubleCountConstraint(warehouse, marts);
  const calendar = await calendarConstraint(warehouse, marts);
  return [layer, ...arithmetic, ...categories, doubleCount, calendar].filter(
    (item): item is DraftConstraint => item !== undefined,
  );
}

function proposalFrom(
  databaseName: string,
  marts: readonly Mart[],
  relations: readonly DraftRelation[],
  constraints: readonly DraftConstraint[],
): Proposal {
  const membership = new Map<string, string[]>();
  for (const mart of marts) {
    const paths = membership.get(mart.domainId) ?? [];
    paths.push(mart.table.path);
    membership.set(mart.domainId, paths);
  }
  const domains = [
    { domainId: databaseName, name: titleName(databaseName), parentDomainId: null, tables: [] },
    ...[...membership]
      .map(([domainId, tables]) => ({
        domainId,
        name: titleName(domainId),
        parentDomainId: databaseName,
        tables: [...tables].sort(),
      }))
      .sort((left, right) => left.domainId.localeCompare(right.domainId)),
  ];
  const terms = [...marts]
    .sort((left, right) => left.termId.localeCompare(right.termId))
    .map((mart) => ({
      termId: mart.termId,
      domainId: mart.domainId,
      table: mart.table.path,
      definition: `One row is one ${mart.termId.replaceAll('_', ' ')} from ${mart.table.path}.`,
      primaryKey: [mart.primaryKey],
      foreignKeys: mart.foreignKeys.map((key) => key.column),
      evidence: `Checked ${mart.table.path}: count(*) equals count(distinct ${mart.primaryKey}) with no nulls.`,
    }));
  const layer = constraints.find((constraint) => constraint.layer);
  if (layer === undefined) {
    throw new Error('The warehouse has no checked money conversion for the analysis layer');
  }
  const rest = constraints.filter((constraint) => !constraint.layer);
  return {
    domains,
    terms,
    relations: [...relations].sort(
      (left, right) =>
        left.name.localeCompare(right.name) ||
        left.fromTermId.localeCompare(right.fromTermId) ||
        left.toTermId.localeCompare(right.toTermId),
    ),
    constraints: rest.map(({ termId, text, evidence }) => ({ termId, text, evidence })),
    analysisLayer: { termId: layer.termId, text: layer.text, evidence: layer.evidence },
  };
}

/**
 * Builds a semantic proposal by checking the warehouse with read-only SQL.
 * Names come from the catalog and from the same generic rules the seed instructions give a model.
 */
export async function investigateWarehouse(warehouse: Warehouse): Promise<Proposal> {
  const tables = analysisTables(await readCatalog(warehouse));
  const marts = assignMarts(await keyTables(warehouse, tables));
  const relations = [...relationsFromKeys(marts), ...(await calendarRelations(warehouse, marts))];
  return proposalFrom(
    warehouse.databaseName,
    marts,
    relations,
    await collectConstraints(warehouse, marts),
  );
}
