import type {
  BrowseResult,
  MoveOptions,
  OntologySnapshot,
  ResolveResult,
  ReviseOptions,
  RevisePatch,
  Submission,
  Version,
  WriteOptions,
} from '@data-agent-ontology/ontology-core';

/** Request bodies by method name. The path is `/v1/<method>`. */
export interface Requests {
  browse: { question: string };
  resolve: { termIds: string[] };
  snapshot: Record<string, never>;
  listVersions: Record<string, never>;
  submitScope: { submission: Submission; options?: WriteOptions };
  revise: { patch: RevisePatch; options?: ReviseOptions };
  revert: { versionId: string; options?: MoveOptions };
  rollback: { versionId: string; options?: Pick<MoveOptions, 'expectedActive'> };
}

export interface Responses {
  browse: BrowseResult;
  resolve: ResolveResult;
  snapshot: OntologySnapshot;
  listVersions: Version[];
  submitScope: Version;
  revise: Version;
  revert: Version;
  rollback: Version;
}

export type Method = keyof Requests;

export const METHODS = [
  'browse',
  'resolve',
  'snapshot',
  'listVersions',
  'submitScope',
  'revise',
  'revert',
  'rollback',
] as const satisfies readonly Method[];

export type ErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'unknown_method'
  | 'unknown_version'
  | 'merge_conflict'
  | 'active_version_changed'
  | 'revert_conflict'
  | 'revision_rejected'
  | 'rejected'
  | 'internal';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export type Envelope<T> = { ok: true; result: T } | { ok: false; error: ErrorBody };
