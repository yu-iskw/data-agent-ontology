import { isVisible } from './model.js';
import { browseRecords, resolveRecords, withoutRevisionFlag } from './read.js';
import { DEFAULT_THRESHOLDS, editedPatch, proposeNote, proposeRelations } from './proposals.js';
import { applyRevert, RevertRootError } from './revert.js';
import { applyRevision } from './revise.js';
import { OntologyStore, UnknownVersionError } from './store.js';
import { applySubmission } from './submit.js';

import type {
  Actor,
  BrowseResult,
  Lifecycle,
  MoveOptions,
  OntologyRecords,
  OntologySnapshot,
  Proposal,
  ProposalDraft,
  ProposalStatus,
  RecordKind,
  ResolveResult,
  ReviseOptions,
  RevisePatch,
  Submission,
  Trace,
  TraceInput,
  Version,
  WriteOptions,
} from './model.js';
import type { NoteInput, ProposalEdits, ProposerThresholds } from './proposals.js';
import type { RecordReader } from './read.js';

export class UnknownProposalError extends Error {
  constructor(proposalId: string) {
    super(`Unknown proposal: ${proposalId}`);
    this.name = 'UnknownProposalError';
  }
}

export class ProposalClosedError extends Error {
  constructor(proposalId: string, status: ProposalStatus) {
    super(`Proposal ${proposalId} is already ${status}`);
    this.name = 'ProposalClosedError';
  }
}

function union(a: string[] | undefined, b: string[]): string[] {
  return [...new Set([...(a ?? []), ...b])].sort((x, y) => x.localeCompare(y));
}

function byId<T>(id: (record: T) => string): (a: T, b: T) => number {
  return (a, b) => id(a).localeCompare(id(b));
}

function visibleSorted<T extends Lifecycle>(records: T[], id: (record: T) => string): T[] {
  return records.filter(isVisible).sort(byId(id));
}

/** The five core operations of RFC section 5 over one Ladybug store. */
export class Ontology {
  readonly store: OntologyStore;

  constructor(store: OntologyStore = new OntologyStore()) {
    this.store = store;
  }

  browse(question: string): BrowseResult {
    return {
      versionId: this.requireActive().versionId,
      hits: browseRecords(this.reader(), question),
    };
  }

  resolve(termIds: string[]): ResolveResult {
    return { versionId: this.requireActive().versionId, ...resolveRecords(this.reader(), termIds) };
  }

  /** Structural writes always apply to the active head; `observedAt` guards stale full scopes. */
  submitScope(submission: Submission, options: WriteOptions = {}): Version {
    return this.store.commit(
      'scope',
      (draft) => {
        applySubmission(draft, submission);
      },
      options,
    );
  }

  revise(patch: RevisePatch, options: ReviseOptions = {}): Version {
    return this.store.commit(
      'revise',
      (draft) => {
        applyRevision(draft, patch);
      },
      options,
    );
  }

  /** Moves the active pointer back or forward. Later changes leave the active view; use `revert` to keep them. */
  rollback(versionId: string, options: Pick<MoveOptions, 'expectedActive'> = {}): Version {
    return this.store.activate(versionId, options.expectedActive);
  }

  /** Commits a new version that undoes one version's changes and keeps everything after it. */
  revert(versionId: string, options: MoveOptions = {}): Version {
    const target = this.store.listVersions().find((version) => version.versionId === versionId);
    if (!target) {
      throw new UnknownVersionError(versionId);
    }
    if (target.parentVersionId === null) {
      throw new RevertRootError(versionId);
    }
    const before = this.store.recordsOf(target.parentVersionId);
    const after = this.store.recordsOf(versionId);
    return this.store.commit(
      'revert',
      (draft) => {
        applyRevert(draft, versionId, after, before);
      },
      options,
    );
  }

  /** Appends what one SQL statement showed. Traces never change the ontology by themselves. */
  recordTrace(input: TraceInput): Trace {
    const trace: Trace = {
      ...input,
      traceId: `t${this.store.listWorkItems<Trace>('trace').length + 1}`,
      at: this.store.now().toISOString(),
    };
    this.store.putWorkItem('trace', trace.traceId, trace);
    return trace;
  }

  listTraces(): Trace[] {
    return this.store.listWorkItems<Trace>('trace');
  }

  listProposals(status?: ProposalStatus): Proposal[] {
    const all = this.store.listWorkItems<Proposal>('proposal');
    return status ? all.filter((proposal) => proposal.status === status) : all;
  }

  /**
   * Stores a candidate change. A draft with the key of an open proposal adds its sightings to
   * that proposal; one matching an accepted or rejected proposal changes nothing.
   */
  propose(draft: ProposalDraft): Proposal {
    const existing = this.listProposals().find(
      (proposal) => proposal.kind === draft.kind && proposal.key === draft.key,
    );
    const now = this.store.now().toISOString();
    if (existing && existing.status !== 'open') {
      return existing;
    }
    const traceIds = [
      ...new Set([...(existing?.evidence.traceIds ?? []), ...draft.evidence.traceIds]),
    ];
    const proposal: Proposal = {
      ...draft,
      proposalId: existing?.proposalId ?? `p${this.listProposals().length + 1}`,
      status: 'open',
      evidence: { summary: draft.evidence.summary, traceIds },
      sessions: union(existing?.sessions, draft.sessions),
      users: union(existing?.users, draft.users),
      support: draft.kind === 'relation' ? traceIds.length : (existing?.support ?? 0) + 1,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.store.putWorkItem('proposal', proposal.proposalId, proposal);
    return proposal;
  }

  /** Runs the deterministic relation proposer over every trace and stores what it finds. */
  proposeRelations(thresholds: ProposerThresholds = DEFAULT_THRESHOLDS): Proposal[] {
    return proposeRelations(this.snapshot(), this.listTraces(), thresholds).map((draft) =>
      this.propose(draft),
    );
  }

  /** Turns an agent's note about a term into a constraint proposal. */
  note(input: NoteInput): Proposal {
    return this.propose(proposeNote(this.snapshot(), input));
  }

  /**
   * A curator accepts a proposal: its patch is revised against the version it came from, so an
   * overlapping change since then throws `MergeConflictError` and the proposal stays open.
   */
  acceptProposal(proposalId: string, curator: Actor, edits?: ProposalEdits): Proposal {
    const proposal = this.openProposal(proposalId);
    const version = this.revise(editedPatch(proposal, edits), {
      baseVersionId: proposal.baseVersionId,
      actor: curator,
      proposalId,
    });
    return this.decide(proposal, 'accepted', curator, version.versionId);
  }

  /** A rejected proposal stays stored, so the proposers do not raise it again. */
  rejectProposal(proposalId: string, curator: Actor): Proposal {
    return this.decide(this.openProposal(proposalId), 'rejected', curator);
  }

  private openProposal(proposalId: string): Proposal {
    const proposal = this.listProposals().find((candidate) => candidate.proposalId === proposalId);
    if (!proposal) {
      throw new UnknownProposalError(proposalId);
    }
    if (proposal.status !== 'open') {
      throw new ProposalClosedError(proposalId, proposal.status);
    }
    return proposal;
  }

  private decide(
    proposal: Proposal,
    status: 'accepted' | 'rejected',
    curator: Actor,
    resolvedVersionId?: string,
  ): Proposal {
    const decided: Proposal = {
      ...proposal,
      status,
      decidedBy: curator,
      ...(resolvedVersionId && { resolvedVersionId }),
      updatedAt: this.store.now().toISOString(),
    };
    this.store.putWorkItem('proposal', decided.proposalId, decided);
    return decided;
  }

  /** Visible records of the active version, in the artifact shape the evaluator reads. */
  snapshot(): OntologySnapshot {
    const version = this.requireActive();
    const read = this.reader();
    const domains = visibleSorted(read.list('domains'), (d) => d.domainId);
    const tables = visibleSorted(read.list('tables'), (t) => t.tableId);
    const columns = visibleSorted(read.list('columns'), (c) => c.columnId);
    const terms = visibleSorted(read.list('terms'), (t) => t.termId);
    const mappings = visibleSorted(read.list('mappings'), (m) => m.mappingId);
    const relations = visibleSorted(read.list('relations'), (r) => r.relationId);
    const constraints = visibleSorted(read.list('constraints'), (c) => c.constraintId);
    const targets = new Set([
      ...domains.map((d) => d.domainId),
      ...tables.map((t) => t.tableId),
      ...terms.map((t) => t.termId),
      ...mappings.map((m) => m.mappingId),
      ...relations.map((r) => r.relationId),
      ...constraints.map((c) => c.constraintId),
    ]);
    const evidence = read
      .list('evidence')
      .filter((e) => targets.has(e.targetId))
      .sort(byId((e) => e.evidenceId));
    return {
      version: { ...version, active: true },
      domains,
      tables: tables.map(withoutRevisionFlag),
      columns,
      terms,
      mappings,
      relations,
      constraints,
      evidence,
    };
  }

  private requireActive(): Version {
    const version = this.store.activeVersion;
    if (!version) {
      throw new Error('The ontology has no version yet; submit a scope first');
    }
    return version;
  }

  private reader(): RecordReader {
    const store = this.store;
    return {
      get: <K extends RecordKind>(kind: K, id: string): OntologyRecords[K] | undefined =>
        store.get(kind, id),
      list: <K extends RecordKind>(kind: K): OntologyRecords[K][] => store.list(kind),
    };
  }
}
