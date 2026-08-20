import { Client } from 'pg';

import { AppDataSource } from './data-source';

/**
 * Proves `synchronize: false` (see the comment on AppDataSource) actually
 * holds: initializing the DataSource — with every entity in this module
 * registered — must not alter the schema by a single byte.
 *
 * The "before" snapshot is taken over a plain `pg` client, deliberately
 * untouched by TypeORM, so this test cannot be fooled by TypeORM caching or
 * normalising something on its own read path. The "after" snapshot is taken
 * through AppDataSource itself, after `initialize()` has run.
 */

interface SchemaSnapshot {
  readonly tables: readonly string[];
  readonly columns: readonly Record<string, unknown>[];
  readonly indexes: readonly Record<string, unknown>[];
  readonly constraints: readonly Record<string, unknown>[];
}

const TABLES_SQL = `SELECT table_name FROM information_schema.tables
  WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
  ORDER BY table_name`;

const COLUMNS_SQL = `SELECT table_name, column_name, data_type, udt_name, is_nullable, column_default
  FROM information_schema.columns
  WHERE table_schema = 'public'
  ORDER BY table_name, ordinal_position`;

const INDEXES_SQL = `SELECT schemaname, tablename, indexname, indexdef
  FROM pg_indexes
  WHERE schemaname = 'public'
  ORDER BY indexname`;

const CONSTRAINTS_SQL = `SELECT conname, pg_get_constraintdef(oid) AS definition
  FROM pg_constraint
  WHERE connamespace = 'public'::regnamespace
  ORDER BY conname`;

async function snapshotViaPg(client: Client): Promise<SchemaSnapshot> {
  // Sequential, not Promise.all: a plain pg.Client does not pipeline
  // concurrent queries (only Pool/multiple connections do).
  const tables = await client.query(TABLES_SQL);
  const columns = await client.query(COLUMNS_SQL);
  const indexes = await client.query(INDEXES_SQL);
  const constraints = await client.query(CONSTRAINTS_SQL);
  return {
    tables: tables.rows.map((r: { table_name: string }) => r.table_name),
    columns: columns.rows,
    indexes: indexes.rows,
    constraints: constraints.rows,
  };
}

async function snapshotViaDataSource(): Promise<SchemaSnapshot> {
  const [tables, columns, indexes, constraints] = await Promise.all([
    AppDataSource.query(TABLES_SQL),
    AppDataSource.query(COLUMNS_SQL),
    AppDataSource.query(INDEXES_SQL),
    AppDataSource.query(CONSTRAINTS_SQL),
  ]);
  return {
    tables: (tables as { table_name: string }[]).map((r) => r.table_name),
    columns,
    indexes,
    constraints,
  };
}

describe('synchronize: false leaves the schema untouched', () => {
  it('schema snapshot is byte-identical before and after DataSource#initialize()', async () => {
    const probe = new Client({
      host: process.env.DB_HOST,
      port: Number.parseInt(process.env.DB_PORT ?? '5432', 10),
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
    });
    await probe.connect();
    const before = await snapshotViaPg(probe);
    await probe.end();

    // The thing under test: does registering all 35 entities and connecting
    // through them change the schema in any way?
    await AppDataSource.initialize();
    try {
      const after = await snapshotViaDataSource();
      expect(after).toEqual(before);
    } finally {
      await AppDataSource.destroy();
    }
  });
});
