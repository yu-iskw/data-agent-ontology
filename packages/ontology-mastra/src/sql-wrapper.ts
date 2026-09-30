import type { OntologyClient, SqlIssue } from '@data-agent-ontology/ontology-client';
import type { Actor } from '@data-agent-ontology/ontology-core';

type Execute = (input: Record<string, unknown>, context: unknown) => Promise<unknown>;

export interface SqlWrapOptions {
  client: OntologyClient;
  /** Name of the input field that holds the statement. */
  sqlField: string;
  actor: Actor;
  sessionId: (context: unknown) => string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The error a SQL tool reports: thrown, or returned as `{ error }` the way tools usually do. */
function errorOf(result: unknown): string | undefined {
  return isRecord(result) && typeof result.error === 'string' ? result.error : undefined;
}

/** The ontology never blocks a statement: its findings ride along with the result. */
function withFindings(result: unknown, issues: SqlIssue[]): unknown {
  if (issues.length === 0 || !isRecord(result)) {
    return result;
  }
  return {
    ...result,
    ontology_check: issues.map((issue) => `${issue.severity}: ${issue.message}`),
  };
}

async function safely<T>(action: () => Promise<T>): Promise<T | undefined> {
  try {
    return await action();
  } catch {
    // The ontology is an aid; an unreachable service must not break the user's SQL tool.
    return undefined;
  }
}

/**
 * Wraps a SQL tool: before the statement runs it is checked against the ontology, and after
 * it runs the outcome is recorded as a trace. The user's tool itself is unchanged.
 */
export function wrapSqlTool<T extends object>(tool: T, options: SqlWrapOptions): T {
  const inner = (tool as { execute?: Execute }).execute;
  if (!inner) {
    return tool;
  }
  const execute: Execute = async (input, context) => {
    const statement = input[options.sqlField];
    if (typeof statement !== 'string') {
      return inner(input, context);
    }
    const check = await safely(() => options.client.checkSql(statement));
    let result: unknown;
    let error: string | undefined;
    try {
      result = await inner(input, context);
      error = errorOf(result);
    } catch (thrown) {
      error = thrown instanceof Error ? thrown.message : String(thrown);
      await record(options, statement, context, error);
      throw thrown;
    }
    await record(options, statement, context, error);
    return withFindings(result, check?.issues ?? []);
  };
  return Object.assign(Object.create(Object.getPrototypeOf(tool) as object) as T, tool, {
    execute,
  });
}

async function record(
  options: SqlWrapOptions,
  sql: string,
  context: unknown,
  error: string | undefined,
): Promise<void> {
  await safely(() =>
    options.client.recordSql({
      sql,
      sessionId: options.sessionId(context),
      actor: options.actor,
      outcome: error === undefined ? 'ok' : 'error',
      ...(error !== undefined && { error }),
    }),
  );
}
