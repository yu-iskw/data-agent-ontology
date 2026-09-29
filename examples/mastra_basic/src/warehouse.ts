import { fileURLToPath } from 'node:url';

import { DuckDBInstance } from '@duckdb/node-api';

import type { DuckDBConnection } from '@duckdb/node-api';

const DEFAULT_DATABASE_PATH = fileURLToPath(new URL('../data/jaffle_shop.duckdb', import.meta.url));

/**
 * Read-only, no file system, no extensions, and no way to change these settings from SQL.
 * This is what keeps the agent's only tool confined to the one database file.
 */
const LOCKED_DOWN_CONFIG = {
  access_mode: 'READ_ONLY',
  enable_external_access: 'false',
  autoinstall_known_extensions: 'false',
  autoload_known_extensions: 'false',
  lock_configuration: 'true',
} as const;

interface QueryResult {
  columns: string[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated: boolean;
}

export class Warehouse {
  private constructor(
    private readonly instance: DuckDBInstance,
    private readonly connection: DuckDBConnection,
    readonly databaseName: string,
  ) {}

  static async open(path: string = DEFAULT_DATABASE_PATH): Promise<Warehouse> {
    const instance = await DuckDBInstance.create(path, { ...LOCKED_DOWN_CONFIG });
    const connection = await instance.connect();
    const reader = await connection.runAndReadAll('SELECT current_database() AS name');
    const name = reader.getRowObjectsJson().at(0)?.name;
    return new Warehouse(instance, connection, typeof name === 'string' ? name : 'warehouse');
  }

  async query(sql: string, maxRows = 200): Promise<QueryResult> {
    // observeWarehouse passes Number.MAX_SAFE_INTEGER when it needs every row.
    const readAll = maxRows === Number.MAX_SAFE_INTEGER;
    const reader = readAll
      ? await this.connection.runAndReadAll(sql)
      : await this.connection.streamAndReadUntil(sql, maxRows + 1);
    const materialized = reader.getRowObjectsJson() as Record<string, unknown>[];
    const truncated = !readAll && materialized.length > maxRows;
    return {
      columns: reader.columnNames(),
      rows: truncated ? materialized.slice(0, maxRows) : materialized,
      rowCount: materialized.length,
      truncated,
    };
  }

  close(): void {
    this.connection.closeSync();
    this.instance.closeSync();
  }
}
