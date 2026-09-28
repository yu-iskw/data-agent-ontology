import type { Warehouse } from './warehouse.js';
import type {
  ColumnObservation,
  Submission,
  TableObservation,
} from '@data-agent-ontology/ontology-core';

const OBJECTS_SQL = `
SELECT table_schema, table_name, table_type
FROM information_schema.tables
WHERE table_catalog = current_database()
  AND table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY table_schema, table_name`;

const COLUMNS_SQL = `
SELECT table_schema, table_name, column_name, data_type, ordinal_position
FROM information_schema.columns
WHERE table_catalog = current_database()
  AND table_schema NOT IN ('information_schema', 'pg_catalog')
ORDER BY table_schema, table_name, ordinal_position`;

const NO_LIMIT = Number.MAX_SAFE_INTEGER;

/**
 * A full-scope structural observation of every schema in the warehouse (RFC section 9).
 * This is plain metadata inspection; semantic knowledge comes from the agent.
 */
export async function observeWarehouse(warehouse: Warehouse): Promise<Submission> {
  const objects = (await warehouse.query(OBJECTS_SQL, NO_LIMIT)).rows;
  const columns = (await warehouse.query(COLUMNS_SQL, NO_LIMIT)).rows;
  const tables: TableObservation[] = objects.map((row) => ({
    engine: 'duckdb',
    path: `${String(row.table_schema)}.${String(row.table_name)}`,
    kind: row.table_type === 'VIEW' ? 'view' : 'table',
  }));
  const columnObservations: ColumnObservation[] = columns.map((row) => ({
    engine: 'duckdb',
    tablePath: `${String(row.table_schema)}.${String(row.table_name)}`,
    name: String(row.column_name),
    dataType: String(row.data_type),
    ordinalPosition: Number(row.ordinal_position),
  }));
  const schemas = [...new Set(objects.map((row) => String(row.table_schema)))];
  return {
    scope: schemas.map((path) => ({ engine: 'duckdb', path, completeness: 'full' })),
    tables,
    columns: columnObservations,
  };
}
