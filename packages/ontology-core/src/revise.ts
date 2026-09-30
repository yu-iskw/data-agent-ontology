import { isDeepStrictEqual } from 'node:util';

import { refreshDrift } from './submit.js';

import type {
  ConstraintInput,
  DomainInput,
  Evidence,
  MappingInput,
  MembershipInput,
  RelationInput,
  RevisePatch,
  TermInput,
} from './model.js';
import type { Draft } from './store.js';

export class RevisionError extends Error {
  constructor(readonly problems: string[]) {
    super(`Revision rejected:\n- ${problems.join('\n- ')}`);
    this.name = 'RevisionError';
  }
}

const MAX_DOMAIN_DEPTH = 32;

function slug(text: string): string {
  const underscored = text.toLowerCase().replaceAll(/[^a-z0-9]+/g, '_');
  let start = 0;
  let end = underscored.length;
  while (start < end && underscored.charCodeAt(start) === 95) {
    start += 1;
  }
  while (end > start && underscored.charCodeAt(end - 1) === 95) {
    end -= 1;
  }
  return underscored.slice(start, end).slice(0, 48);
}

function holdsDifferentRecord(existing: object, next: object): boolean {
  return !isDeepStrictEqual(existing, next);
}

/** Reports a problem when `id` already holds a different record. */
function conflicts(
  ctx: RevisionContext,
  label: string,
  id: string,
  existing: object | undefined,
  next: object,
): boolean {
  if (existing !== undefined && holdsDifferentRecord(existing, next)) {
    ctx.problem(`${label} id ${id} already holds a different record`);
    return true;
  }
  return false;
}

interface Citation {
  summary: string;
  /** Constraints and relations can be cited from traces; other records stay `revise`. */
  trajectory: boolean;
}

class RevisionContext {
  readonly evidence = new Map<string, Citation>();
  readonly problems: string[] = [];

  constructor(
    readonly draft: Draft,
    private readonly summary: string,
  ) {}

  cite(targetId: string, summary: string | undefined, trajectory: boolean): void {
    this.evidence.set(targetId, { summary: summary ?? this.summary, trajectory });
  }

  problem(message: string): void {
    this.problems.push(message);
  }
}

function putDomain(ctx: RevisionContext, input: DomainInput): void {
  ctx.draft.put('domains', input.domainId, {
    domainId: input.domainId,
    name: input.name,
    parentDomainId: input.parentDomainId,
    active: true,
    drifted: false,
  });
  ctx.cite(input.domainId, undefined, false);
}

function checkDomainParents(ctx: RevisionContext, inputs: DomainInput[]): void {
  for (const input of inputs) {
    let parent = input.parentDomainId;
    for (let depth = 0; parent !== null; depth += 1) {
      if (parent === input.domainId || depth > MAX_DOMAIN_DEPTH) {
        ctx.problem(`Domain ${input.domainId} has a cyclic parent chain`);
        break;
      }
      const next = ctx.draft.get('domains', parent);
      if (!next) {
        ctx.problem(`Domain ${input.domainId} has unknown parent ${parent}`);
        break;
      }
      parent = next.parentDomainId;
    }
  }
}

function putMembership(ctx: RevisionContext, input: MembershipInput): void {
  const table = ctx.draft.get('tables', input.tableId);
  if (!table?.active) {
    ctx.problem(`Membership targets unknown or inactive table ${input.tableId}`);
    return;
  }
  const unknown = input.domainIds.filter((id) => !ctx.draft.get('domains', id));
  if (unknown.length > 0) {
    ctx.problem(`Membership for ${input.tableId} uses unknown domains ${unknown.join(', ')}`);
    return;
  }
  ctx.draft.put('tables', table.tableId, {
    ...table,
    domainIds: [...new Set(input.domainIds)].sort((a, b) => a.localeCompare(b)),
    membershipRevised: true,
  });
  ctx.cite(table.tableId, undefined, false);
}

function putTerm(ctx: RevisionContext, input: TermInput): void {
  if (!ctx.draft.get('domains', input.domainId)) {
    ctx.problem(`Term ${input.termId} belongs to unknown domain ${input.domainId}`);
    return;
  }
  ctx.draft.put('terms', input.termId, {
    termId: input.termId,
    name: input.name,
    domainId: input.domainId,
    definition: input.definition,
    active: true,
    drifted: false,
  });
  ctx.cite(input.termId, input.evidence, false);
}

function putMapping(ctx: RevisionContext, input: MappingInput): void {
  const column = ctx.draft.get('columns', input.columnId);
  if (!ctx.draft.get('terms', input.termId)) {
    ctx.problem(`Mapping targets unknown term ${input.termId}`);
    return;
  }
  if (!column?.active) {
    ctx.problem(`Mapping for ${input.termId} targets unknown or inactive column ${input.columnId}`);
    return;
  }
  const mappingId = input.mappingId ?? `${input.termId}.${column.name}`;
  const mapping = {
    mappingId,
    termId: input.termId,
    columnId: input.columnId,
    role: input.role,
    active: true,
    drifted: false,
  };
  if (conflicts(ctx, 'Mapping', mappingId, ctx.draft.get('mappings', mappingId), mapping)) {
    return;
  }
  ctx.draft.put('mappings', mappingId, mapping);
  ctx.cite(mappingId, input.evidence, false);
}

function putRelation(ctx: RevisionContext, input: RelationInput): void {
  const missing = [input.fromTermId, input.toTermId].filter((id) => !ctx.draft.get('terms', id));
  const dead = [input.fromColumnId, input.toColumnId].filter(
    (id) => !ctx.draft.get('columns', id)?.active,
  );
  if (missing.length > 0 || dead.length > 0) {
    ctx.problem(
      `Relation ${input.name} references unknown terms [${missing.join(', ')}] or columns [${dead.join(', ')}]`,
    );
    return;
  }
  const relationId = input.relationId ?? `${input.fromTermId}_${input.name}_${input.toTermId}`;
  const relation = {
    relationId,
    name: input.name,
    fromTermId: input.fromTermId,
    toTermId: input.toTermId,
    fromColumnId: input.fromColumnId,
    toColumnId: input.toColumnId,
    join: input.join,
    active: true,
    drifted: false,
  };
  if (conflicts(ctx, 'Relation', relationId, ctx.draft.get('relations', relationId), relation)) {
    return;
  }
  ctx.draft.put('relations', relationId, relation);
  ctx.cite(relationId, input.evidence, true);
}

function putConstraint(ctx: RevisionContext, input: ConstraintInput): void {
  if (!ctx.draft.get('terms', input.termId)) {
    ctx.problem(`Constraint targets unknown term ${input.termId}`);
    return;
  }
  const constraintId = input.constraintId ?? `${input.termId}:${slug(input.text)}`;
  const constraint = {
    constraintId,
    termId: input.termId,
    text: input.text,
    active: true,
    drifted: false,
  };
  if (
    conflicts(
      ctx,
      'Constraint',
      constraintId,
      ctx.draft.get('constraints', constraintId),
      constraint,
    )
  ) {
    return;
  }
  ctx.draft.put('constraints', constraintId, constraint);
  ctx.cite(constraintId, input.evidence, true);
}

/** Mapping integrity (RFC section 6): the mapped table must belong to the term's domain. */
function checkMappingIntegrity(ctx: RevisionContext): void {
  for (const mapping of ctx.draft.list('mappings').filter((m) => m.active)) {
    const term = ctx.draft.get('terms', mapping.termId);
    const column = ctx.draft.get('columns', mapping.columnId);
    const table = column ? ctx.draft.get('tables', column.tableId) : undefined;
    if (term && table && !table.domainIds.includes(term.domainId)) {
      ctx.problem(
        `Term ${term.termId} (domain ${term.domainId}) cannot map to ${table.path}, which is outside its domain`,
      );
    }
  }
}

function each<T>(items: T[] | undefined, apply: (item: T) => void): void {
  for (const item of items ?? []) {
    apply(item);
  }
}

function evidenceFor(targetId: string, cited: Citation, traceIds: string[] | undefined): Evidence {
  const evidenceId = `evidence:${targetId}`;
  if (cited.trajectory && traceIds !== undefined) {
    return {
      evidenceId,
      targetId,
      source: 'trajectory',
      summary: cited.summary,
      traceIds: [...traceIds],
    };
  }
  return { evidenceId, targetId, source: 'revise', summary: cited.summary };
}

/** Applies an authoritative semantic revision (RFC section 11). All problems are reported together. */
export function applyRevision(draft: Draft, patch: RevisePatch): void {
  const ctx = new RevisionContext(draft, patch.summary);
  each(patch.domains, (domain) => putDomain(ctx, domain));
  checkDomainParents(ctx, patch.domains ?? []);
  each(patch.memberships, (membership) => putMembership(ctx, membership));
  each(patch.terms, (term) => putTerm(ctx, term));
  each(patch.mappings, (mapping) => putMapping(ctx, mapping));
  each(patch.relations, (relation) => putRelation(ctx, relation));
  each(patch.constraints, (constraint) => putConstraint(ctx, constraint));
  checkMappingIntegrity(ctx);
  if (ctx.problems.length > 0) {
    throw new RevisionError(ctx.problems);
  }
  for (const [targetId, cited] of ctx.evidence) {
    const evidence = evidenceFor(targetId, cited, patch.traceIds);
    draft.put('evidence', evidence.evidenceId, evidence);
  }
  refreshDrift(draft);
}
