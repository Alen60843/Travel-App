/**
 * Baseline environment for tests.
 *
 * Only fills values that are ABSENT, so a test can override anything by
 * setting it first, and CI can point the integration suite at real services.
 * These are obviously-fake local values — never real credentials.
 */
const defaults: Record<string, string> = {
  NODE_ENV: 'test',
  PORT: '3000',
  DB_HOST: process.env.TEST_DB_HOST ?? 'localhost',
  DB_PORT: process.env.TEST_DB_PORT ?? '55432',
  DB_USER: process.env.TEST_DB_USER ?? 'postgres',
  DB_PASSWORD: process.env.TEST_DB_PASSWORD ?? '',
  DB_NAME: process.env.TEST_DB_NAME ?? 'tripwith',
  DB_SSL: 'false',
  REDIS_QUEUE_URL: process.env.TEST_REDIS_QUEUE_URL ?? 'redis://localhost:6399',
  REDIS_CACHE_URL: process.env.TEST_REDIS_CACHE_URL ?? 'redis://localhost:6398',
  FIREBASE_PROJECT_ID: 'tripwith-test',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_REGION: 'eu-central-1',
  S3_BUCKET: 'tripwith-test',
  S3_ACCESS_KEY_ID: 'test-access-key',
  S3_SECRET_ACCESS_KEY: 'test-secret-key',
  LOG_LEVEL: 'error',
};

for (const [key, value] of Object.entries(defaults)) {
  process.env[key] ??= value;
}
