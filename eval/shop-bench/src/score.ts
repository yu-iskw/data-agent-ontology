import type { ShopTask } from './tasks.js';

export interface TaskScore {
  id: string;
  hit: string[];
  miss: string[];
}

export interface BenchReport {
  empty: TaskScore[];
  static: TaskScore[];
  learning: TaskScore[];
  dependentTraces: number;
  poison: string[];
}

export function scoreFacts(
  text: string,
  facts: readonly string[],
): Pick<TaskScore, 'hit' | 'miss'> {
  const hit: string[] = [];
  const miss: string[] = [];
  for (const fact of facts) {
    if (text.includes(fact)) {
      hit.push(fact);
    } else {
      miss.push(fact);
    }
  }
  return { hit, miss };
}

export function expectedScores(tasks: readonly ShopTask[], present: boolean): TaskScore[] {
  return tasks.map((task) => ({
    id: task.id,
    hit: present ? [...task.facts] : [],
    miss: present ? [] : [...task.facts],
  }));
}

function byId(scores: readonly TaskScore[], id: string): TaskScore | undefined {
  return scores.find((score) => score.id === id);
}

function missedAll(score: TaskScore | undefined): boolean {
  return score !== undefined && score.hit.length === 0 && score.miss.length > 0;
}

function hitAll(score: TaskScore | undefined): boolean {
  return score !== undefined && score.miss.length === 0 && score.hit.length > 0;
}

/** Empty misses everything, static hits only the seed, learning gains the later facts, poison is empty. */
export function passed(report: BenchReport): boolean {
  const emptyOk = report.empty.every((score) => missedAll(score));
  return (
    emptyOk &&
    hitAll(byId(report.static, 'customer-order')) &&
    missedAll(byId(report.static, 'refund-order')) &&
    hitAll(byId(report.learning, 'customer-order')) &&
    hitAll(byId(report.learning, 'refund-order')) &&
    report.poison.length === 0
  );
}
