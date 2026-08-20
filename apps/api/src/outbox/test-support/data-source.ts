import { DataSource } from 'typeorm';

/**
 * A bare `DataSource` for integration tests, built directly from the same
 * env vars `src/config/configuration.ts` validates (`test/setup-env.ts`
 * fills in the `TEST_DB_*`-derived defaults). No entities — every query this
 * package runs against `job_outbox` is raw SQL via `.query()`, matching the
 * production services exactly (see OutboxRelay's module doc for why).
 *
 * Not a `*.spec.ts`/`*.int-spec.ts` file, so jest's testRegex does not pick
 * it up as a test suite.
 */
export function createTestDataSource(): DataSource {
  return new DataSource({
    type: 'postgres',
    host: requireEnv('DB_HOST'),
    port: Number.parseInt(requireEnv('DB_PORT'), 10),
    username: requireEnv('DB_USER'),
    password: process.env.DB_PASSWORD ?? '',
    database: requireEnv('DB_NAME'),
    entities: [],
    synchronize: false,
    logging: false,
    // A couple of concurrent claim tests deliberately race two connections
    // against each other; the pool needs headroom for that to be a genuine
    // concurrent race rather than accidentally serialised on one socket.
    extra: { max: 8 },
  });
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required test env var ${name} (see test/setup-env.ts)`);
  }
  return value;
}
