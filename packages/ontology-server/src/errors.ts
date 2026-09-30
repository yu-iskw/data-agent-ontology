import {
  ActiveVersionChangedError,
  MergeConflictError,
  ResolveLimitError,
  RevertConflictError,
  RevertRootError,
  RevisionError,
  ScopeViolationError,
  SubmissionError,
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

/** Maps a thrown error to the status and body the client turns back into the same error class. */
export function toFailure(error: unknown): HttpFailure {
  if (error instanceof ServiceError) {
    return failure(error.status, error, error.code);
  }
  if (error instanceof MergeConflictError) {
    return failure(409, error, 'merge_conflict', {
      baseVersionId: error.baseVersionId,
      headVersionId: error.headVersionId,
      conflicts: error.conflicts,
    });
  }
  if (error instanceof ActiveVersionChangedError) {
    return failure(409, error, 'active_version_changed', {
      expected: error.expected,
      actual: error.actual,
    });
  }
  if (error instanceof RevertConflictError) {
    return failure(409, error, 'revert_conflict', {
      versionId: error.versionId,
      conflicts: error.conflicts,
    });
  }
  if (error instanceof RevisionError) {
    return failure(422, error, 'revision_rejected', { problems: error.problems });
  }
  if (error instanceof UnknownVersionError) {
    return failure(404, error, 'unknown_version');
  }
  if (
    error instanceof SubmissionError ||
    error instanceof ScopeViolationError ||
    error instanceof ResolveLimitError ||
    error instanceof RevertRootError
  ) {
    return failure(422, error, 'rejected');
  }
  return {
    status: 500,
    body: { code: 'internal', message: error instanceof Error ? error.message : String(error) },
  };
}
