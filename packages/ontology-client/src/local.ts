import { checkSqlAgainst } from './check-sql.js';
import { formatContext } from './format.js';

import type { OntologyClient, OntologyContext, SqlCheck } from './client.js';
import type {
  MoveOptions,
  Ontology,
  OntologySnapshot,
  ReviseOptions,
  RevisePatch,
  Submission,
  Version,
  WriteOptions,
} from '@data-agent-ontology/ontology-core';

const MAX_CONTEXT_TERMS = 5;

/** Runs the ontology core in-process. The snapshot is cached per version, so checks cost no query. */
export class LocalOntologyClient implements OntologyClient {
  private cached: OntologySnapshot | undefined;

  constructor(private readonly ontology: Ontology) {}

  browse(question: string): Promise<ReturnType<Ontology['browse']>> {
    return Promise.resolve(this.ontology.browse(question));
  }

  resolve(termIds: string[]): Promise<ReturnType<Ontology['resolve']>> {
    return Promise.resolve(this.ontology.resolve(termIds));
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

  checkSql(sql: string): Promise<SqlCheck> {
    const snapshot = this.cachedSnapshot();
    return Promise.resolve({
      versionId: snapshot.version.versionId,
      issues: checkSqlAgainst(sql, snapshot),
    });
  }

  snapshot(): Promise<OntologySnapshot> {
    return Promise.resolve(this.cachedSnapshot());
  }

  listVersions(): Promise<Version[]> {
    return Promise.resolve(this.ontology.store.listVersions());
  }

  submitScope(submission: Submission, options?: WriteOptions): Promise<Version> {
    return this.write(() => this.ontology.submitScope(submission, options));
  }

  revise(patch: RevisePatch, options?: ReviseOptions): Promise<Version> {
    return this.write(() => this.ontology.revise(patch, options));
  }

  revert(versionId: string, options?: MoveOptions): Promise<Version> {
    return this.write(() => this.ontology.revert(versionId, options));
  }

  rollback(versionId: string, options?: Pick<MoveOptions, 'expectedActive'>): Promise<Version> {
    return this.write(() => this.ontology.rollback(versionId, options));
  }

  private write(action: () => Version): Promise<Version> {
    try {
      return Promise.resolve(action());
    } catch (error) {
      return Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private cachedSnapshot(): OntologySnapshot {
    const active = this.ontology.store.activeVersion;
    if (this.cached && active && this.cached.version.versionId === active.versionId) {
      return this.cached;
    }
    this.cached = this.ontology.snapshot();
    return this.cached;
  }
}
