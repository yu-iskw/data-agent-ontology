import { checkSqlAgainst, shapeOfSql } from './check-sql.js';
import { contextFor as readContext } from './context.js';

import type { OntologyClient, OntologyContext, SqlCheck, SqlRun } from './client.js';
import type {
  Actor,
  MoveOptions,
  NoteInput,
  Ontology,
  OntologySnapshot,
  Proposal,
  ProposalEdits,
  ProposalStatus,
  ProposerThresholds,
  ReviseOptions,
  RevisePatch,
  Submission,
  Trace,
  Version,
  WriteOptions,
} from '@data-agent-ontology/ontology-core';

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

  contextFor(question: string): Promise<OntologyContext> {
    return readContext(this, question);
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

  recordSql(run: SqlRun): Promise<Trace> {
    const snapshot = this.cachedSnapshot();
    return this.write(() =>
      this.ontology.recordTrace({
        ...run,
        versionId: snapshot.version.versionId,
        ...shapeOfSql(run.sql, snapshot),
      }),
    );
  }

  note(input: NoteInput): Promise<Proposal> {
    return this.write(() => this.ontology.note(input));
  }

  listProposals(status?: ProposalStatus): Promise<Proposal[]> {
    return Promise.resolve(this.ontology.listProposals(status));
  }

  proposeRelations(thresholds?: ProposerThresholds): Promise<Proposal[]> {
    return this.write(() => this.ontology.proposeRelations(thresholds));
  }

  acceptProposal(proposalId: string, curator: Actor, edits?: ProposalEdits): Promise<Proposal> {
    return this.write(() => this.ontology.acceptProposal(proposalId, curator, edits));
  }

  rejectProposal(proposalId: string, curator: Actor): Promise<Proposal> {
    return this.write(() => this.ontology.rejectProposal(proposalId, curator));
  }

  private write<T>(action: () => T): Promise<T> {
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
