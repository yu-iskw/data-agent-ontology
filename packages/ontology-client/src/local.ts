import { checkSqlAgainst } from './check-sql.js';
import { formatContext } from './format.js';

import type { OntologyClient, OntologyContext, SqlCheck } from './client.js';
import type { Ontology, OntologySnapshot } from '@data-agent-ontology/ontology-core';

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
    const snapshot = this.snapshot();
    return Promise.resolve({
      versionId: snapshot.version.versionId,
      issues: checkSqlAgainst(sql, snapshot),
    });
  }

  private snapshot(): OntologySnapshot {
    const active = this.ontology.store.activeVersion;
    if (this.cached && active && this.cached.version.versionId === active.versionId) {
      return this.cached;
    }
    this.cached = this.ontology.snapshot();
    return this.cached;
  }
}
