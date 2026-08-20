import 'dotenv/config';
import { DataSource } from 'typeorm';

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
function required(name: string): string {
  const value = process.env[name];
  // Deliberately checking for `undefined`, not falsiness: DB_PASSWORD is
  // legitimately '' for local trust-auth Postgres, and an empty string is a
  // valid (if unusual) value for several of these — only "never set" is an
  // error.
  if (value === undefined) {
    throw new Error(
      `Missing required environment variable ${name}. ` +
        `Copy .env.example to .env and fill it in.`,
    );
  }
  return value;
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: required('DB_HOST'),
  port: Number.parseInt(required('DB_PORT'), 10),
  username: required('DB_USER'),
  password: required('DB_PASSWORD'),
  database: required('DB_NAME'),
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: false } : false,

  synchronize: false,
  migrationsRun: false,
  logging: process.env.DB_LOGGING === 'true',

  entities: [...entities],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
  migrationsTableName: 'schema_migrations',
});
