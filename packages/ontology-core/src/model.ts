/**
 * Record types from docs/rfc/ontology-service.md sections 6, 9, and 12.
 * `duckdb` extends the RFC engine union for local fixtures.
 */
export type Engine = 'bigquery' | 'snowflake' | 'duckdb';

export type Completeness = 'full' | 'partial';

export type TableKind = 'table' | 'view';

export type MappingRole = 'primary_key' | 'foreign_key' | 'attribute';

export type EvidenceSource = 'submission' | 'revise' | 'trajectory';

export type VersionReason = 'scope' | 'revise';

export interface Lifecycle {
  active: boolean;
  drifted: boolean;
}

export interface Domain extends Lifecycle {
  domainId: string;
  name: string;
  parentDomainId: string | null;
}

export interface Table extends Lifecycle {
  tableId: string;
  engine: Engine;
  path: string;
  kind: TableKind;
  domainIds: string[];
  /** True once `revise` has set `domainIds`; structural submissions no longer change them. */
  membershipRevised: boolean;
}

export interface Column extends Lifecycle {
  columnId: string;
  tableId: string;
  name: string;
  dataType: string;
  ordinalPosition: number;
}

export interface Term extends Lifecycle {
  termId: string;
  name: string;
  domainId: string;
  definition: string;
}

export interface Mapping extends Lifecycle {
  mappingId: string;
  termId: string;
  columnId: string;
  role: MappingRole;
}

export interface Relation extends Lifecycle {
  relationId: string;
  name: string;
  fromTermId: string;
  toTermId: string;
  fromColumnId: string;
  toColumnId: string;
  join: string;
}

export interface Constraint extends Lifecycle {
  constraintId: string;
  termId: string;
  text: string;
}

export interface Evidence {
  evidenceId: string;
  targetId: string;
  source: EvidenceSource;
  summary: string;
}

export interface OntologyRecords {
  domains: Domain;
  tables: Table;
  columns: Column;
  terms: Term;
  mappings: Mapping;
  relations: Relation;
  constraints: Constraint;
  evidence: Evidence;
}

export type RecordKind = keyof OntologyRecords;

export interface Version {
  versionId: string;
  parentVersionId: string | null;
  createdAt: string;
  reason: VersionReason;
}

export interface Scope {
  engine: Engine;
  /** Dataset or schema path, for example `project.dataset`, `database.schema`, or `main`. */
  path: string;
  completeness: Completeness;
}

export interface TableObservation {
  engine: Engine;
  path: string;
  kind: TableKind;
  /** Agent-submitted membership. Ignored once a revision controls the table's membership. */
  domainIds?: string[];
}

export interface ColumnObservation {
  engine: Engine;
  tablePath: string;
  name: string;
  dataType: string;
  ordinalPosition: number;
}

export interface WarehouseObject {
  engine: Engine;
  path: string;
  /** When set, the removal targets this column of `path` instead of the whole table. */
  column?: string;
}

export interface Submission {
  scope: Scope[];
  tables: TableObservation[];
  columns: ColumnObservation[];
  removed?: WarehouseObject[];
}

export interface DomainInput {
  domainId: string;
  name: string;
  parentDomainId: string | null;
}

export interface MembershipInput {
  tableId: string;
  domainIds: string[];
}

export interface TermInput {
  termId: string;
  name: string;
  domainId: string;
  definition: string;
  evidence?: string;
}

export interface MappingInput {
  mappingId?: string;
  termId: string;
  columnId: string;
  role: MappingRole;
  evidence?: string;
}

export interface RelationInput {
  relationId?: string;
  name: string;
  fromTermId: string;
  toTermId: string;
  fromColumnId: string;
  toColumnId: string;
  join: string;
  evidence?: string;
}

export interface ConstraintInput {
  constraintId?: string;
  termId: string;
  text: string;
  evidence?: string;
}

export interface RevisePatch {
  /** Default evidence summary for records in this patch that carry no evidence of their own. */
  summary: string;
  domains?: DomainInput[];
  memberships?: MembershipInput[];
  terms?: TermInput[];
  mappings?: MappingInput[];
  relations?: RelationInput[];
  constraints?: ConstraintInput[];
}

export interface BrowseHit {
  kind: 'domain' | 'term';
  id: string;
  name: string;
  domainId: string | null;
  score: number;
}

export interface BrowseResult {
  versionId: string;
  hits: BrowseHit[];
}

export type SnapshotTable = Omit<Table, 'membershipRevised'>;

export interface ResolveResult {
  versionId: string;
  terms: Term[];
  mappings: Mapping[];
  tables: SnapshotTable[];
  columns: Column[];
  relations: Relation[];
  constraints: Constraint[];
  evidence: Evidence[];
}

export interface OntologySnapshot {
  version: Version & { active: true };
  domains: Domain[];
  tables: SnapshotTable[];
  columns: Column[];
  terms: Term[];
  mappings: Mapping[];
  relations: Relation[];
  constraints: Constraint[];
  evidence: Evidence[];
}

export function tableIdOf(engine: Engine, path: string): string {
  return `${engine}:${path}`;
}

export function columnIdOf(tableId: string, column: string): string {
  return `${tableId}.${column}`;
}

/** Parent dataset or schema path of a table path: `main.orders` becomes `main`. */
export function scopePathOf(tablePath: string): string {
  const cut = tablePath.lastIndexOf('.');
  return cut === -1 ? '' : tablePath.slice(0, cut);
}

export function isVisible(record: Lifecycle): boolean {
  return record.active && !record.drifted;
}
