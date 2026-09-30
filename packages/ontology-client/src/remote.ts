import {
  ActiveVersionChangedError,
  MergeConflictError,
  RevertConflictError,
  RevisionError,
  UnknownVersionError,
} from '@data-agent-ontology/ontology-core';

import { checkSqlAgainst } from './check-sql.js';
import { formatContext } from './format.js';

import type { OntologyClient, OntologyContext, SqlCheck } from './client.js';
import type { Envelope, ErrorBody, Method, Requests, Responses } from './protocol.js';
import type {
  MergeConflict,
  RevertConflict,
  MoveOptions,
  OntologySnapshot,
  ReviseOptions,
  RevisePatch,
  Submission,
  Version,
  WriteOptions,
} from '@data-agent-ontology/ontology-core';

const MAX_CONTEXT_TERMS = 5;

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

interface ConflictDetails {
  baseVersionId: string;
  headVersionId: string | null;
  conflicts: MergeConflict[];
}

/** Rebuilds the core error a local client would have thrown, so callers handle both alike. */
function reviveError(status: number, body: ErrorBody): Error {
  const details = body.details as Record<string, unknown> | undefined;
  switch (body.code) {
    case 'merge_conflict': {
      const { baseVersionId, headVersionId, conflicts } = details as unknown as ConflictDetails;
      return new MergeConflictError(baseVersionId, headVersionId, conflicts);
    }
    case 'active_version_changed':
      return new ActiveVersionChangedError(
        details?.expected as string | null,
        details?.actual as string | null,
      );
    case 'revert_conflict':
      return new RevertConflictError(
        details?.versionId as string,
        details?.conflicts as RevertConflict[],
      );
    case 'revision_rejected':
      return new RevisionError(details?.problems as string[]);
    case 'unknown_version':
      return new UnknownVersionError(body.message.replace('Unknown ontology version: ', ''));
    case 'unauthorized':
    case 'bad_request':
    case 'unknown_method':
    case 'rejected':
    case 'internal':
      return new RemoteError(status, body);
    default: {
      const unreachable: never = body.code;
      return new RemoteError(status, { code: 'internal', message: String(unreachable) });
    }
  }
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

  async contextFor(question: string): Promise<OntologyContext> {
    const { versionId, hits } = await this.browse(question);
    const termIds = hits
      .filter((hit) => hit.kind === 'term')
      .slice(0, MAX_CONTEXT_TERMS)
      .map((hit) => hit.id);
    if (termIds.length === 0) {
      return { versionId, text: '', termIds };
    }
    const resolved = await this.resolve(termIds);
    return { versionId: resolved.versionId, text: formatContext(resolved), termIds };
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

  /** Drops the cached snapshot when a response shows the active version moved. */
  private observed<T extends { versionId: string }>(response: T): T {
    if (this.cached && this.cached.version.versionId !== response.versionId) {
      this.cached = undefined;
    }
    return response;
  }

  /** A write moves the active version, so the cached snapshot is stale afterwards. */
  private async write<M extends 'submitScope' | 'revise' | 'revert' | 'rollback'>(
    method: M,
    body: Requests[M],
  ): Promise<Responses[M]> {
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
