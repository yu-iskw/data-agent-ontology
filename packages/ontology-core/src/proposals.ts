import type {
  Actor,
  Mapping,
  OntologySnapshot,
  Proposal,
  ProposalDraft,
  RelationInput,
  Trace,
} from './model.js';

export interface ProposerThresholds {
  /** Successful statements that must show the join. */
  minSupport: number;
  /** Distinct sessions that must show it. */
  minSessions: number;
}

export const DEFAULT_THRESHOLDS: ProposerThresholds = { minSupport: 3, minSessions: 2 };

export const RELATION_PROPOSER: Actor = { id: 'relation-proposer' };

interface Sighting {
  traceIds: string[];
  sessions: Set<string>;
  users: Set<string>;
}

function pairKey(a: string, b: string): [string, string] {
  return a.localeCompare(b) <= 0 ? [a, b] : [b, a];
}

/** Successful joins by unordered column pair, with who saw them and where. */
function sightings(traces: Trace[]): Map<string, Sighting & { pair: [string, string] }> {
  const found = new Map<string, Sighting & { pair: [string, string] }>();
  for (const trace of traces) {
    if (trace.outcome !== 'ok') {
      continue;
    }
    for (const [a, b] of trace.joins) {
      const pair = pairKey(a, b);
      const key = pair.join('|');
      const entry = found.get(key) ?? {
        pair,
        traceIds: [],
        sessions: new Set<string>(),
        users: new Set<string>(),
      };
      entry.traceIds.push(trace.traceId);
      entry.sessions.add(trace.sessionId);
      entry.users.add(trace.actor?.onBehalfOf ?? trace.actor?.id ?? trace.sessionId);
      found.set(key, entry);
    }
  }
  return found;
}

/** The term that maps a column, preferring a primary-key mapping; ties break by term id. */
function termOfColumn(
  mappings: Mapping[],
  columnId: string,
): { termId: string; role: Mapping['role'] } | undefined {
  const candidates = mappings
    .filter((mapping) => mapping.columnId === columnId)
    .sort((a, b) => a.termId.localeCompare(b.termId));
  return candidates.at(0) && { termId: candidates[0].termId, role: candidates[0].role };
}

function joinText(snapshot: OntologySnapshot, from: string, to: string): string {
  const path = (columnId: string): string => {
    const column = snapshot.columns.find((candidate) => candidate.columnId === columnId);
    const table = snapshot.tables.find((candidate) => candidate.tableId === column?.tableId);
    return `${table?.path ?? column?.tableId ?? columnId}.${column?.name ?? ''}`;
  };
  return `${path(from)} = ${path(to)}`;
}

function relationFor(
  snapshot: OntologySnapshot,
  pair: [string, string],
  summary: string,
): RelationInput | undefined {
  const left = termOfColumn(snapshot.mappings, pair[0]);
  const right = termOfColumn(snapshot.mappings, pair[1]);
  if (!left || !right || left.termId === right.termId) {
    return undefined;
  }
  const leftIsParent = left.role === 'primary_key' || right.role !== 'primary_key';
  const [from, to] = leftIsParent ? [left, right] : [right, left];
  const [fromColumnId, toColumnId] = leftIsParent ? pair : [pair[1], pair[0]];
  return {
    name: `${from.termId}_to_${to.termId}`,
    fromTermId: from.termId,
    toTermId: to.termId,
    fromColumnId,
    toColumnId,
    join: joinText(snapshot, fromColumnId, toColumnId),
    evidence: summary,
  };
}

function alreadyKnown(snapshot: OntologySnapshot, pair: [string, string]): boolean {
  return snapshot.relations.some((relation) => {
    const known = pairKey(relation.fromColumnId, relation.toColumnId);
    return known[0] === pair[0] && known[1] === pair[1];
  });
}

/**
 * Deterministic relation proposals from replayed joins. A join becomes a proposal only when it
 * succeeded in at least `minSupport` statements across `minSessions` sessions, no visible
 * relation already joins those columns, and both columns are mapped to different terms. The
 * relation name is a placeholder; a curator names it on acceptance.
 */
export function proposeRelations(
  snapshot: OntologySnapshot,
  traces: Trace[],
  thresholds: ProposerThresholds = DEFAULT_THRESHOLDS,
): ProposalDraft[] {
  const drafts: ProposalDraft[] = [];
  const ordered = [...sightings(traces).values()].sort((a, b) =>
    a.pair.join('|').localeCompare(b.pair.join('|')),
  );
  for (const seen of ordered) {
    if (
      seen.traceIds.length < thresholds.minSupport ||
      seen.sessions.size < thresholds.minSessions ||
      alreadyKnown(snapshot, seen.pair)
    ) {
      continue;
    }
    const summary = `Joined in ${seen.traceIds.length} successful statements across ${seen.sessions.size} sessions`;
    const relation = relationFor(snapshot, seen.pair, summary);
    if (!relation) {
      continue;
    }
    drafts.push({
      kind: 'relation',
      key: `relation:${seen.pair.join('|')}`,
      patch: { summary, relations: [relation] },
      baseVersionId: snapshot.version.versionId,
      evidence: { summary, traceIds: seen.traceIds },
      proposer: RELATION_PROPOSER,
      sessions: [...seen.sessions].sort((a, b) => a.localeCompare(b)),
      users: [...seen.users].sort((a, b) => a.localeCompare(b)),
    });
  }
  return drafts;
}

export interface NoteInput {
  termId: string;
  statement: string;
  /** SQL that shows the statement holds. */
  evidenceSql?: string;
  sessionId: string;
  actor: Actor;
}

function normalize(text: string): string {
  return text
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** A constraint proposal from a note the agent made about a term. */
export function proposeNote(snapshot: OntologySnapshot, note: NoteInput): ProposalDraft {
  const summary = note.evidenceSql
    ? `Agent note, shown by: ${note.evidenceSql}`
    : 'Agent note without SQL evidence';
  return {
    kind: 'constraint',
    key: `constraint:${note.termId}:${normalize(note.statement)}`,
    patch: {
      summary,
      constraints: [{ termId: note.termId, text: note.statement, evidence: summary }],
    },
    baseVersionId: snapshot.version.versionId,
    evidence: { summary, traceIds: [] },
    proposer: note.actor,
    sessions: [note.sessionId],
    users: [note.actor.onBehalfOf ?? note.actor.id],
  };
}

export interface ProposalEdits {
  /** Replaces the relation name in a relation proposal. */
  name?: string;
  /** Replaces the constraint text in a constraint proposal. */
  text?: string;
}

/** A curator's edits applied to a copy of the proposal's patch. */
export function editedPatch(proposal: Proposal, edits: ProposalEdits = {}): Proposal['patch'] {
  const patch = structuredClone(proposal.patch);
  if (edits.name !== undefined) {
    for (const relation of patch.relations ?? []) {
      relation.name = edits.name;
      delete relation.relationId;
    }
  }
  if (edits.text !== undefined) {
    for (const constraint of patch.constraints ?? []) {
      constraint.text = edits.text;
      delete constraint.constraintId;
    }
  }
  return patch;
}
