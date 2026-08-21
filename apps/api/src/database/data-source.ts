import 'dotenv/config';
import { DataSource } from 'typeorm';

import { loadDatabaseConfig } from '../config/configuration';
import { entities } from './entities';

/**
 * TypeORM DataSource used by the migration CLI (and available for any script
 * that needs a raw connection outside Nest's DI, e.g. one-off admin tasks).
 *
 * Every value comes from the environment; nothing is defaulted to a real
 * credential and nothing is committed.
 *
 * `synchronize` is hard-coded false — non-negotiable. The schema is owned by
 * the hand-written SQL in migrations/sql/*.up.sql (see that file's own
 * header comment: it is the canonical definition, and the TypeORM migration
 * class only executes it). Letting TypeORM introspect entities and push DDL
 * itself would let a local, uncommitted entity edit silently rewrite a
 * shared database out from under a reviewed migration — exactly backwards
 * for a schema that encodes invariants (append-only ledgers, trust-score
 * triggers, capacity guards) no entity decorator can express. Same reasoning
 * for `migrationsRun: false`: migrations run explicitly via the CLI
 * (`pnpm migration:run`), never implicitly on connect, so a process boot
 * can never race a schema change.
 */
const database = loadDatabaseConfig();

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: database.host,
  port: database.port,
  username: database.username,
  password: database.password,
  database: database.database,
  ssl: database.ssl,
  extra: { options: database.connectionOptions },

  synchronize: false,
  migrationsRun: false,
  logging: database.logging,

  entities: [...entities],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
  migrationsTableName: 'schema_migrations',
});
