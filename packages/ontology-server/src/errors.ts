import {
  ActiveVersionChangedError,
  MergeConflictError,
  ProposalClosedError,
  ResolveLimitError,
  RevertConflictError,
  RevertRootError,
  RevisionError,
  ScopeViolationError,
  SubmissionError,
  UnknownProposalError,
  UnknownVersionError,
} from '@data-agent-ontology/ontology-core';

import type { ErrorBody } from '@data-agent-ontology/ontology-client';

/** A request the service refuses before it reaches the core. */
export class ServiceError extends Error {
  constructor(
    readonly status: 400 | 401 | 404,
    readonly code: 'bad_request' | 'unauthorized' | 'unknown_method',
    message: string,
  ) {
    super(message);
    this.name = 'ServiceError';
  }
}

export interface HttpFailure {
  status: number;
  body: ErrorBody;
}

function failure(
  status: number,
  error: Error,
  code: ErrorBody['code'],
  details?: unknown,
): HttpFailure {
  return {
    status,
    body: { code, message: error.message, ...(details !== undefined && { details }) },
  };
}

type Mapper = (error: unknown) => HttpFailure | undefined;

function on<T extends Error>(
  type: new (...args: never[]) => T,
  status: number,
  code: ErrorBody['code'],
  details?: (error: T) => unknown,
): Mapper {
  return (error) =>
    error instanceof type ? failure(status, error, code, details?.(error)) : undefined;
}

/** Ordered: the first mapper that recognizes the error decides the reply. */
const MAPPERS: Mapper[] = [
  on(MergeConflictError, 409, 'merge_conflict', (error) => ({
    baseVersionId: error.baseVersionId,
    headVersionId: error.headVersionId,
    conflicts: error.conflicts,
  })),
  on(ActiveVersionChangedError, 409, 'active_version_changed', (error) => ({
    expected: error.expected,
    actual: error.actual,
  })),
  on(RevertConflictError, 409, 'revert_conflict', (error) => ({
    versionId: error.versionId,
    conflicts: error.conflicts,
  })),
  on(ProposalClosedError, 409, 'proposal_closed', (error) => ({
    proposalId: error.proposalId,
    status: error.status,
  })),
  on(UnknownProposalError, 404, 'unknown_proposal', (error) => ({ proposalId: error.proposalId })),
  on(RevisionError, 422, 'revision_rejected', (error) => ({ problems: error.problems })),
  on(UnknownVersionError, 404, 'unknown_version', (error) => ({ versionId: error.versionId })),
  on(SubmissionError, 422, 'rejected'),
  on(ScopeViolationError, 422, 'rejected'),
  on(ResolveLimitError, 422, 'rejected'),
  on(RevertRootError, 422, 'rejected'),
];

/** Maps a thrown error to the status and body the client turns back into the same error class. */
export function toFailure(error: unknown): HttpFailure {
  if (error instanceof ServiceError) {
    return failure(error.status, error, error.code);
  }
  for (const mapper of MAPPERS) {
    const mapped = mapper(error);
    if (mapped) {
      return mapped;
    }
  }
  return {
    status: 500,
    body: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
  };
}
