import { LocalOntologyClient } from '@data-agent-ontology/ontology-client';
import { seededOntology } from '@data-agent-ontology/ontology-client/testing';
import { Ontology } from '@data-agent-ontology/ontology-core';

import { scoreFacts } from './score.js';
import { AFTER, BEFORE, EXCLUDE_CANCELLED_TEXT, NET_REVENUE, REFUND_SQL, TASKS } from './tasks.js';

import type { BenchReport, TaskScore } from './score.js';
import type { ShopTask } from './tasks.js';
import type { OntologyClient } from '@data-agent-ontology/ontology-client';
import type { Actor, OntologySnapshot, Submission } from '@data-agent-ontology/ontology-core';

const ANALYST: Actor = { id: 'analyst-agent', onBehalfOf: 'analyst' };
const CURATOR: Actor = { id: 'curator' };
const SESSION_A = 'session-a';
const REPLAY_SESSIONS = [SESSION_A, SESSION_A, 'session-b'] as const;
const GOLD_RELATIONS = new Set(['places', 'refunded_by']);
const GOLD_CONSTRAINTS = new Set([EXCLUDE_CANCELLED_TEXT, NET_REVENUE]);

/** A version with no terms. A store that has never been submitted cannot be read. */
const EMPTY_SCOPE: Submission = {
  scope: [{ engine: 'bigquery', path: 'proj.sales', completeness: 'full' }],
  tables: [],
  columns: [],
};

function emptyClient(): LocalOntologyClient {
  const ontology = new Ontology();
  ontology.submitScope(EMPTY_SCOPE);
  return new LocalOntologyClient(ontology);
}

async function scoreTasks(
  client: OntologyClient,
  tasks: readonly ShopTask[],
): Promise<TaskScore[]> {
  const scores: TaskScore[] = [];
  for (const task of tasks) {
    const context = await client.contextFor(task.question);
    scores.push({ id: task.id, ...scoreFacts(context.text, task.facts) });
  }
  return scores;
}

function poisonOf(snapshot: OntologySnapshot): string[] {
  return [
    ...snapshot.relations
      .filter((relation) => !GOLD_RELATIONS.has(relation.name))
      .map((relation) => `relation ${relation.name}`),
    ...snapshot.constraints
      .filter((constraint) => !GOLD_CONSTRAINTS.has(constraint.text))
      .map((constraint) => `constraint ${constraint.text}`),
  ];
}

/** True when the active context already states one of the facts this trace would support. */
async function replay(
  client: OntologyClient,
  sessionId: string,
  claims: readonly string[],
): Promise<boolean> {
  const context = await client.contextFor('refund totals');
  const dependent = claims.some((claim) => context.text.includes(claim));
  await client.recordSql({
    sql: REFUND_SQL,
    sessionId,
    actor: ANALYST,
    question: 'refund totals',
    outcome: 'ok',
  });
  return dependent;
}

async function acceptLearned(client: OntologyClient): Promise<void> {
  const proposals = await client.proposeRelations();
  if (proposals.length !== 1) {
    throw new Error(`Expected one relation proposal, got ${String(proposals.length)}`);
  }
  const relation = proposals[0];
  await client.acceptProposal(relation.proposalId, CURATOR, { name: 'refunded_by' });
  const note = await client.note({
    termId: 'refund',
    statement: NET_REVENUE,
    evidenceSql: REFUND_SQL,
    sessionId: SESSION_A,
    actor: ANALYST,
  });
  await client.acceptProposal(note.proposalId, CURATOR);
}

const LEARNED_CLAIMS = AFTER[0].facts;

async function learn(
  client: OntologyClient,
): Promise<{ dependentTraces: number; poison: string[] }> {
  let dependentTraces = 0;
  for (const sessionId of REPLAY_SESSIONS) {
    if (await replay(client, sessionId, LEARNED_CLAIMS)) {
      dependentTraces += 1;
    }
  }
  await acceptLearned(client);
  if (await replay(client, 'session-c', LEARNED_CLAIMS)) {
    dependentTraces += 1;
  }
  return { dependentTraces, poison: poisonOf(await client.snapshot()) };
}

export async function runBench(): Promise<BenchReport> {
  const learningClient = new LocalOntologyClient(seededOntology());
  const before = await scoreTasks(learningClient, BEFORE);
  const learned = await learn(learningClient);
  const after = await scoreTasks(learningClient, AFTER);
  return {
    empty: await scoreTasks(emptyClient(), TASKS),
    static: await scoreTasks(new LocalOntologyClient(seededOntology()), TASKS),
    learning: [...before, ...after],
    dependentTraces: learned.dependentTraces,
    poison: learned.poison,
  };
}
