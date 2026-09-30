export { columnIdOf, isVisible, scopePathOf, tableIdOf } from './model.js';
export { ActiveVersionChangedError, MergeConflictError } from './merge.js';
export { Ontology } from './ontology.js';
export { MAX_BROWSE_HITS, MAX_RESOLVE_TERMS, ResolveLimitError } from './read.js';
export { RevertConflictError, RevertRootError } from './revert.js';
export { RevisionError } from './revise.js';
export { OntologyStore, STORE_FORMAT, UnknownVersionError } from './store.js';
export type { MergeConflict } from './merge.js';
export type { RevertConflict } from './revert.js';
export type { StoreJson } from './store.js';
export { ScopeViolationError, SubmissionError } from './submit.js';

export type {
  Actor,
  BrowseHit,
  BrowseResult,
  Column,
  ColumnObservation,
  Completeness,
  Constraint,
  ConstraintInput,
  Domain,
  DomainInput,
  Engine,
  Evidence,
  EvidenceSource,
  Lifecycle,
  Mapping,
  MappingInput,
  MappingRole,
  MembershipInput,
  MoveOptions,
  OntologySnapshot,
  Relation,
  RelationInput,
  ResolveResult,
  ReviseOptions,
  RevisePatch,
  Scope,
  SnapshotTable,
  Submission,
  Table,
  TableKind,
  TableObservation,
  Term,
  TermInput,
  Version,
  VersionReason,
  WarehouseObject,
  WriteOptions,
} from './model.js';
