import {
  ActiveVersionChangedError,
  MergeConflictError,
  ProposalClosedError,
  RevertConflictError,
  RevisionError,
  UnknownProposalError,
  UnknownVersionError,
} from '@data-agent-ontology/ontology-core';

import { checkSqlAgainst, shapeOfSql } from './check-sql.js';
import { contextFor as readContext } from './context.js';

import type { OntologyClient, OntologyContext, SqlCheck, SqlRun } from './client.js';
import type { Envelope, ErrorBody, ErrorCode, Method, Requests, Responses } from './protocol.js';
import type {
  Actor,
  MergeConflict,
  MoveOptions,
  NoteInput,
  OntologySnapshot,
  Proposal,
  ProposalEdits,
  ProposalStatus,
  ProposerThresholds,
  RevertConflict,
  ReviseOptions,
  RevisePatch,
  Submission,
  Trace,
  Version,
  WriteOptions,
} from '@data-agent-ontology/ontology-core';

/** The service refused a request. The code says why; `details` holds what the service returned. */
export class RemoteError extends Error {
  constructor(
    readonly status: number,
    readonly body: ErrorBody,
  ) {
    super(body.message);
    this.name = 'RemoteError';
  }
}

type Details = Record<string, unknown> | undefined;

type Reviver = (status: number, body: ErrorBody, details: Details) => Error;

const asRemote: Reviver = (status, body) => new RemoteError(status, body);

/** Rebuilds the core error a local client would have thrown, so callers handle both alike. */
const REVIVERS: Record<ErrorCode, Reviver> = {
  merge_conflict: (_status, _body, details) =>
    new MergeConflictError(
      details?.baseVersionId as string,
      details?.headVersionId as string | null,
      details?.conflicts as MergeConflict[],
    ),
  active_version_changed: (_status, _body, details) =>
    new ActiveVersionChangedError(
      details?.expected as string | null,
      details?.actual as string | null,
    ),
  revert_conflict: (_status, _body, details) =>
    new RevertConflictError(details?.versionId as string, details?.conflicts as RevertConflict[]),
  revision_rejected: (_status, _body, details) => new RevisionError(details?.problems as string[]),
  proposal_closed: (_status, _body, details) =>
    new ProposalClosedError(details?.proposalId as string, details?.status as Proposal['status']),
  unknown_proposal: (_status, _body, details) =>
    new UnknownProposalError(details?.proposalId as string),
  unknown_version: (_status, _body, details) =>
    new UnknownVersionError(typeof details?.versionId === 'string' ? details.versionId : ''),
  unauthorized: asRemote,
  bad_request: asRemote,
  unknown_method: asRemote,
  rejected: asRemote,
  internal: asRemote,
};

function reviveError(status: number, body: ErrorBody): Error {
  return REVIVERS[body.code](status, body, body.details as Details);
}

export interface RemoteOptions {
  url: string;
  token: string;
  fetch?: typeof fetch;
}

/** Calls an ontology service over HTTP. Checks run against a snapshot cached per version. */
export class RemoteOntologyClient implements OntologyClient {
  private cached: OntologySnapshot | undefined;

  constructor(private readonly options: RemoteOptions) {}

  async browse(question: string): Promise<Responses['browse']> {
    return this.observed(await this.call('browse', { question }));
  }

  async resolve(termIds: string[]): Promise<Responses['resolve']> {
    return this.observed(await this.call('resolve', { termIds }));
  }

  contextFor(question: string): Promise<OntologyContext> {
    return readContext(this, question);
  }

  async checkSql(sql: string): Promise<SqlCheck> {
    const snapshot = this.cached ?? (await this.snapshot());
    return { versionId: snapshot.version.versionId, issues: checkSqlAgainst(sql, snapshot) };
  }

  async snapshot(): Promise<OntologySnapshot> {
    this.cached = await this.call('snapshot', {});
    return this.cached;
  }

  listVersions(): Promise<Version[]> {
    return this.call('listVersions', {});
  }

  submitScope(submission: Submission, options?: WriteOptions): Promise<Version> {
    return this.write('submitScope', { submission, options });
  }

  revise(patch: RevisePatch, options?: ReviseOptions): Promise<Version> {
    return this.write('revise', { patch, options });
  }

  revert(versionId: string, options?: MoveOptions): Promise<Version> {
    return this.write('revert', { versionId, options });
  }

  rollback(versionId: string, options?: Pick<MoveOptions, 'expectedActive'>): Promise<Version> {
    return this.write('rollback', { versionId, options });
  }

  async recordSql(run: SqlRun): Promise<Trace> {
    const snapshot = this.cached ?? (await this.snapshot());
    return this.call('recordTrace', {
      trace: { ...run, versionId: snapshot.version.versionId, ...shapeOfSql(run.sql, snapshot) },
    });
  }

  note(input: NoteInput): Promise<Proposal> {
    return this.call('note', { input });
  }

  listProposals(status?: ProposalStatus): Promise<Proposal[]> {
    return this.call('listProposals', { status });
  }

  proposeRelations(thresholds?: ProposerThresholds): Promise<Proposal[]> {
    return this.call('proposeRelations', { thresholds });
  }

  acceptProposal(proposalId: string, curator: Actor, edits?: ProposalEdits): Promise<Proposal> {
    return this.write('acceptProposal', { proposalId, curator, edits });
  }

  rejectProposal(proposalId: string, curator: Actor): Promise<Proposal> {
    return this.call('rejectProposal', { proposalId, curator });
  }

  /** Drops the cached snapshot when a response shows the active version moved. */
  private observed<T extends { versionId: string }>(response: T): T {
    if (this.cached && this.cached.version.versionId !== response.versionId) {
      this.cached = undefined;
    }
    return response;
  }

  /** A write moves the active version, so the cached snapshot is stale afterwards. */
  private async write<
    M extends 'submitScope' | 'revise' | 'revert' | 'rollback' | 'acceptProposal',
  >(method: M, body: Requests[M]): Promise<Responses[M]> {
    this.cached = undefined;
    return this.call(method, body);
  }

  private async call<M extends Method>(method: M, body: Requests[M]): Promise<Responses[M]> {
    const send = this.options.fetch ?? fetch;
    const response = await send(`${this.options.url}/v1/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.options.token}`,
      },
      body: JSON.stringify(body),
    });
    const envelope = (await response.json()) as Envelope<Responses[M]>;
    if (!envelope.ok) {
      throw reviveError(response.status, envelope.error);
    }
    return envelope.result;
  }
}
