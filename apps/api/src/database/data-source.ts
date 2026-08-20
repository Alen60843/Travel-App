import 'dotenv/config';
import { DataSource } from 'typeorm';

/**
 * TypeORM DataSource used by the migration CLI.
 *
 * Every value comes from the environment; nothing is defaulted to a real
 * credential and nothing is committed. `synchronize` is hard-coded false —
 * schema changes only ever arrive through a reviewed migration.
 */
function required(name: string): string {
  const value = process.env[name];
  if (!value) {
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

  entities: [],
  migrations: [`${__dirname}/migrations/*.{ts,js}`],
  migrationsTableName: 'schema_migrations',
});
