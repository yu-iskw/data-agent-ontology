import { METHODS } from '@data-agent-ontology/ontology-client';

import { ServiceError } from './errors.js';

import type { Method, Requests, Responses } from '@data-agent-ontology/ontology-client';
import type { Ontology, OntologySnapshot } from '@data-agent-ontology/ontology-core';

function isMethod(name: string): name is Method {
  return (METHODS as readonly string[]).includes(name);
}

/* eslint-disable security/detect-object-injection -- keys are typed request fields and method names checked by isMethod */
function field<T extends object, K extends keyof T>(body: T, key: K): T[K] {
  if (!(key in body) || body[key] === undefined) {
    throw new ServiceError(400, 'bad_request', `Missing field ${String(key)}`);
  }
  return body[key];
}

/* eslint-enable security/detect-object-injection */

type Handler<M extends Method> = (service: OntologyService, request: Requests[M]) => Responses[M];

/** One handler per method. The mapped type makes a new method a compile error until handled. */
const HANDLERS: { [M in Method]: Handler<M> } = {
  browse: (s, r) => s.ontology.browse(field(r, 'question')),
  resolve: (s, r) => s.ontology.resolve(field(r, 'termIds')),
  snapshot: (s) => s.snapshot(),
  listVersions: (s) => s.ontology.store.listVersions(),
  submitScope: (s, r) => s.ontology.submitScope(field(r, 'submission'), r.options),
  revise: (s, r) => s.ontology.revise(field(r, 'patch'), r.options),
  revert: (s, r) => s.ontology.revert(field(r, 'versionId'), r.options),
  rollback: (s, r) => s.ontology.rollback(field(r, 'versionId'), r.options),
  recordTrace: (s, r) => s.ontology.recordTrace(field(r, 'trace')),
  listTraces: (s) => s.ontology.listTraces(),
  note: (s, r) => s.ontology.note(field(r, 'input')),
  listProposals: (s, r) => s.ontology.listProposals(r.status),
  proposeRelations: (s, r) => s.ontology.proposeRelations(r.thresholds),
  acceptProposal: (s, r) =>
    s.ontology.acceptProposal(field(r, 'proposalId'), field(r, 'curator'), r.edits),
  rejectProposal: (s, r) => s.ontology.rejectProposal(field(r, 'proposalId'), field(r, 'curator')),
};

/**
 * The core behind one process. Calls run to completion on the event loop, so writes are
 * serialized, and the snapshot is cached per active version because versions are immutable.
 */
export class OntologyService {
  private cached: OntologySnapshot | undefined;

  constructor(readonly ontology: Ontology) {}

  call(name: string, body: unknown): Responses[Method] {
    if (!isMethod(name)) {
      throw new ServiceError(404, 'unknown_method', `Unknown method ${name}`);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ServiceError(400, 'bad_request', 'The request body must be a JSON object');
    }
    // eslint-disable-next-line security/detect-object-injection -- `name` passed isMethod
    const handler = HANDLERS[name] as Handler<Method>;
    return handler(this, body);
  }

  snapshot(): OntologySnapshot {
    const active = this.ontology.store.activeVersion;
    if (this.cached && active?.versionId === this.cached.version.versionId) {
      return this.cached;
    }
    this.cached = this.ontology.snapshot();
    return this.cached;
  }
}
