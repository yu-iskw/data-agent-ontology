import type { SqlIssue } from './check-sql.js';
import type {
  BrowseResult,
  Actor,
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
  Version,
  WriteOptions,
} from '@data-agent-ontology/ontology-core';

export interface OntologyContext {
  /** Version the context was read from; a later write can cite it as its base. */
  versionId: string;
  /** Prompt-ready block. Empty when nothing matched the question. */
  text: string;
  termIds: string[];
}

/** One SQL statement an agent ran, before it is reduced to a trace. */
export interface SqlRun {
  sql: string;
  sessionId: string;
  actor?: Actor;
  question?: string;
  outcome: 'ok' | 'error';
  error?: string;
}

export interface SqlCheck {
  versionId: string;
  issues: SqlIssue[];
}

/**
 * What an agent host needs from the ontology. The local implementation runs the core
 * in-process; a remote implementation calls the ontology service with the same shape.
 */
export interface OntologyClient {
  browse(question: string): Promise<BrowseResult>;
  resolve(termIds: string[]): Promise<ResolveResult>;
  /** Browse and resolve in one step, formatted for a model. */
  contextFor(question: string): Promise<OntologyContext>;
  /** Advisory check of one SQL statement against the active version. */
  checkSql(sql: string): Promise<SqlCheck>;
  snapshot(): Promise<OntologySnapshot>;
  listVersions(): Promise<Version[]>;
  /** Structural observation. Applies to the active head; a full scope may carry `observedAt`. */
  submitScope(submission: Submission, options?: WriteOptions): Promise<Version>;
  /** Semantic write. Pass the `versionId` the caller read as `baseVersionId`. */
  revise(patch: RevisePatch, options?: ReviseOptions): Promise<Version>;
  revert(versionId: string, options?: MoveOptions): Promise<Version>;
  rollback(versionId: string, options?: Pick<MoveOptions, 'expectedActive'>): Promise<Version>;
  /** Reduces a run to the tables and joins the ontology recognizes and appends it to the trace log. */
  recordSql(run: SqlRun): Promise<Trace>;
  /** Files an agent's note about a term as a constraint proposal. */
  note(input: NoteInput): Promise<Proposal>;
  listProposals(status?: ProposalStatus): Promise<Proposal[]>;
  /** Runs the deterministic relation proposer over the trace log. */
  proposeRelations(thresholds?: ProposerThresholds): Promise<Proposal[]>;
  acceptProposal(proposalId: string, curator: Actor, edits?: ProposalEdits): Promise<Proposal>;
  rejectProposal(proposalId: string, curator: Actor): Promise<Proposal>;
}
