import type {
  Actor,
  BrowseResult,
  MoveOptions,
  NoteInput,
  OntologySnapshot,
  Proposal,
  ProposalEdits,
  ProposalStatus,
  ProposerThresholds,
  ResolveResult,
  ReviseOptions,
  RevisePatch,
  Submission,
  Trace,
  TraceInput,
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
  recordTrace: { trace: TraceInput };
  listTraces: Record<string, never>;
  note: { input: NoteInput };
  listProposals: { status?: ProposalStatus };
  proposeRelations: { thresholds?: ProposerThresholds };
  acceptProposal: { proposalId: string; curator: Actor; edits?: ProposalEdits };
  rejectProposal: { proposalId: string; curator: Actor };
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
  recordTrace: Trace;
  listTraces: Trace[];
  note: Proposal;
  listProposals: Proposal[];
  proposeRelations: Proposal[];
  acceptProposal: Proposal;
  rejectProposal: Proposal;
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
  'recordTrace',
  'listTraces',
  'note',
  'listProposals',
  'proposeRelations',
  'acceptProposal',
  'rejectProposal',
] as const satisfies readonly Method[];

export type ErrorCode =
  | 'unauthorized'
  | 'bad_request'
  | 'unknown_method'
  | 'unknown_version'
  | 'merge_conflict'
  | 'active_version_changed'
  | 'revert_conflict'
  | 'unknown_proposal'
  | 'proposal_closed'
  | 'revision_rejected'
  | 'rejected'
  | 'internal';

export interface ErrorBody {
  code: ErrorCode;
  message: string;
  details?: unknown;
}

export type Envelope<T> = { ok: true; result: T } | { ok: false; error: ErrorBody };
