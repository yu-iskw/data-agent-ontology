import { isVisible } from './model.js';
import { browseRecords, resolveRecords, withoutRevisionFlag } from './read.js';
import { applyRevision } from './revise.js';
import { OntologyStore } from './store.js';
import { applySubmission } from './submit.js';

import type {
  BrowseResult,
  Lifecycle,
  OntologyRecords,
  OntologySnapshot,
  RecordKind,
  ResolveResult,
  RevisePatch,
  Submission,
  Version,
} from './model.js';
import type { RecordReader } from './read.js';

function byId<T>(id: (record: T) => string): (a: T, b: T) => number {
  return (a, b) => id(a).localeCompare(id(b));
}

function visibleSorted<T extends Lifecycle>(records: T[], id: (record: T) => string): T[] {
  return records.filter(isVisible).sort(byId(id));
}

/** The five core operations of RFC section 5 over one in-memory store. */
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

  submitScope(submission: Submission): Version {
    return this.store.commit('scope', (draft) => {
      applySubmission(draft, submission);
    });
  }

  revise(patch: RevisePatch): Version {
    return this.store.commit('revise', (draft) => {
      applyRevision(draft, patch);
    });
  }

  rollback(versionId: string): Version {
    return this.store.activate(versionId);
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
