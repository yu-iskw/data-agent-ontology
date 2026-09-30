import { METHODS } from '@data-agent-ontology/ontology-client';

import { ServiceError } from './errors.js';

import type { Method, Requests, Responses } from '@data-agent-ontology/ontology-client';
import type { Ontology, OntologySnapshot } from '@data-agent-ontology/ontology-core';

function isMethod(name: string): name is Method {
  return (METHODS as readonly string[]).includes(name);
}

function field<T extends object, K extends keyof T>(body: T, key: K): T[K] {
  if (!(key in body) || body[key] === undefined) {
    throw new ServiceError(400, 'bad_request', `Missing field ${String(key)}`);
  }
  return body[key];
}

/**
 * The core behind one process. Calls run to completion on the event loop, so writes are
 * serialized, and the snapshot is cached per active version because versions are immutable.
 */
export class OntologyService {
  private cached: OntologySnapshot | undefined;

  constructor(private readonly ontology: Ontology) {}

  call(name: string, body: unknown): Responses[Method] {
    if (!isMethod(name)) {
      throw new ServiceError(404, 'unknown_method', `Unknown method ${name}`);
    }
    if (body === null || typeof body !== 'object' || Array.isArray(body)) {
      throw new ServiceError(400, 'bad_request', 'The request body must be a JSON object');
    }
    return this.dispatch(name, body as Requests[Method]);
  }

  private dispatch(name: Method, body: Requests[Method]): Responses[Method] {
    switch (name) {
      case 'browse':
        return this.ontology.browse(field(body as Requests['browse'], 'question'));
      case 'resolve':
        return this.ontology.resolve(field(body as Requests['resolve'], 'termIds'));
      case 'snapshot':
        return this.snapshot();
      case 'listVersions':
        return this.ontology.store.listVersions();
      case 'submitScope': {
        const request = body as Requests['submitScope'];
        return this.ontology.submitScope(field(request, 'submission'), request.options);
      }
      case 'revise': {
        const request = body as Requests['revise'];
        return this.ontology.revise(field(request, 'patch'), request.options);
      }
      case 'revert': {
        const request = body as Requests['revert'];
        return this.ontology.revert(field(request, 'versionId'), request.options);
      }
      case 'rollback': {
        const request = body as Requests['rollback'];
        return this.ontology.rollback(field(request, 'versionId'), request.options);
      }
      default: {
        const unreachable: never = name;
        throw new Error(`Unhandled method ${String(unreachable)}`);
      }
    }
  }

  private snapshot(): OntologySnapshot {
    const active = this.ontology.store.activeVersion;
    if (this.cached && active?.versionId === this.cached.version.versionId) {
      return this.cached;
    }
    this.cached = this.ontology.snapshot();
    return this.cached;
  }
}
