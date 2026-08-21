import {
  ConfigValidationError,
  loadConfig,
  loadDatabaseConfig,
} from './configuration';

/** A complete, valid environment — every test starts from a copy of this and mutates it. */
const VALID_ENV: NodeJS.ProcessEnv = {
  NODE_ENV: 'production',
  PORT: '4000',
  API_PREFIX: 'api',
  API_DEFAULT_VERSION: '1',
  SHUTDOWN_TIMEOUT_MS: '15000',
  DEPENDENCY_CHECK_TIMEOUT_MS: '2000',
  BODY_LIMIT: '1mb',

  DB_HOST: 'db.internal',
  DB_PORT: '5432',
  DB_USER: 'tripwith',
  DB_PASSWORD: 'super-secret',
  DB_NAME: 'tripwith',
  DB_SSL: 'true',
  DB_SSL_CA: '-----BEGIN CERTIFICATE-----\\ntrusted-ca\\n-----END CERTIFICATE-----',
  DB_SSL_INSECURE_LOCAL: 'false',
  DB_LOGGING: 'false',
  DB_POOL_MAX: '10',

  CURRENT_TOS_VERSION: 'tos-2026-08-21',
  CURRENT_PRIVACY_POLICY_VERSION: 'privacy-2026-08-21',

  REDIS_QUEUE_URL: 'redis://queue.internal:6379',
  REDIS_CACHE_URL: 'redis://cache.internal:6379',
  QUEUE_PREFIX: 'tripwith',

  OUTBOX_POLL_INTERVAL_MS: '1000',
  OUTBOX_BATCH_SIZE: '100',
  OUTBOX_LEASE_MS: '300000',
  OUTBOX_ENABLED: 'true',

  FIREBASE_PROJECT_ID: 'tripwith-prod',
  FIREBASE_CLIENT_EMAIL: 'svc@tripwith-prod.iam.gserviceaccount.com',
  FIREBASE_PRIVATE_KEY: '-----BEGIN PRIVATE KEY-----\\nabc\\n-----END PRIVATE KEY-----\\n',

  S3_ENDPOINT: 'https://s3.eu-central-1.amazonaws.com',
  S3_REGION: 'eu-central-1',
  S3_BUCKET: 'tripwith-prod',
  S3_ACCESS_KEY_ID: 'AKIA-EXAMPLE',
  S3_SECRET_ACCESS_KEY: 'example-secret',

  LOG_LEVEL: 'info',
  LOG_PRETTY: 'false',
  SERVICE_NAME: 'tripwith-api',
};

function envWithout(...keys: string[]): NodeJS.ProcessEnv {
  const env = { ...VALID_ENV };
  for (const key of keys) delete env[key];
  return env;
}

describe('loadConfig — valid input', () => {
  it('parses a fully-specified valid environment into a grouped AppConfig', () => {
    const config = loadConfig(VALID_ENV);

    expect(config.app).toEqual({
      env: 'production',
      isProduction: true,
      port: 4000,
      apiPrefix: 'api',
      defaultVersion: '1',
      shutdownTimeoutMs: 15000,
      dependencyCheckTimeoutMs: 2000,
      bodyLimit: '1mb',
    });
    expect(config.database.host).toBe('db.internal');
    expect(config.database.ssl).toEqual({
      rejectUnauthorized: true,
      ca: '-----BEGIN CERTIFICATE-----\ntrusted-ca\n-----END CERTIFICATE-----',
    });
    expect(config.database.connectionOptions).toBe('-c timezone=UTC');
    expect(config.consentPolicy).toEqual({
      currentTermsOfServiceVersion: 'tos-2026-08-21',
      currentPrivacyPolicyVersion: 'privacy-2026-08-21',
    });
    expect(config.redisQueue.url).toBe('redis://queue.internal:6379');
    expect(config.observability.level).toBe('info');
  });

  it('applies documented defaults when optional fields are omitted', () => {
    const env = {
      ...envWithout(
        'PORT',
        'API_PREFIX',
        'DB_SSL',
        'DB_SSL_CA',
        'LOG_LEVEL',
        'LOG_PRETTY',
      ),
      NODE_ENV: 'test',
    };

    const config = loadConfig(env);

    expect(config.app.port).toBe(3000);
    expect(config.app.apiPrefix).toBe('api');
    expect(config.database.ssl).toBe(false);
    expect(config.observability.level).toBe('info');
    expect(config.observability.pretty).toBe(false);
  });

  it('returns a deeply frozen (immutable) config', () => {
    const config = loadConfig(VALID_ENV);

    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.app)).toBe(true);
    expect(Object.isFrozen(config.database)).toBe(true);
  });

  it('accepts "1"/"0" as valid booleans in addition to "true"/"false"', () => {
    const config = loadConfig({ ...VALID_ENV, DB_SSL: '1', OUTBOX_ENABLED: '0' });

    expect(config.database.ssl).toMatchObject({ rejectUnauthorized: true });
    expect(config.outbox.enabled).toBe(false);
  });

  it('gives Nest and the migration DataSource identical TLS and UTC session settings', () => {
    const appConfig = loadConfig(VALID_ENV);
    const databaseConfig = loadDatabaseConfig(VALID_ENV);

    expect(databaseConfig).toEqual(appConfig.database);
    expect(databaseConfig.connectionOptions).toBe('-c timezone=UTC');
  });

  it('omits optional Firebase fields entirely rather than setting them to undefined', () => {
    const env = envWithout('FIREBASE_CLIENT_EMAIL', 'FIREBASE_PRIVATE_KEY');

    const config = loadConfig(env);

    expect('clientEmail' in config.firebase).toBe(false);
    expect('privateKey' in config.firebase).toBe(false);
  });

  it('rejects a partial Firebase service-account credential pair', () => {
    expect(() => loadConfig(envWithout('FIREBASE_PRIVATE_KEY'))).toThrow(ConfigValidationError);
    expect(() => loadConfig(envWithout('FIREBASE_CLIENT_EMAIL'))).toThrow(ConfigValidationError);
  });
});

describe('loadConfig — missing required variables', () => {
  it('throws ConfigValidationError', () => {
    expect(() => loadConfig(envWithout('DB_HOST'))).toThrow(ConfigValidationError);
  });

  it('lists EVERY missing/invalid field at once, not just the first', () => {
    const env = envWithout(
      'DB_HOST',
      'DB_USER',
      'FIREBASE_PROJECT_ID',
      'S3_BUCKET',
      'S3_ACCESS_KEY_ID',
      'REDIS_QUEUE_URL',
    );

    let caught: ConfigValidationError | undefined;
    try {
      loadConfig(env);
    } catch (err) {
      caught = err as ConfigValidationError;
    }

    expect(caught).toBeInstanceOf(ConfigValidationError);
    const paths = caught?.issues.join('\n') ?? '';
    expect(paths).toContain('DB_HOST');
    expect(paths).toContain('DB_USER');
    expect(paths).toContain('FIREBASE_PROJECT_ID');
    expect(paths).toContain('S3_BUCKET');
    expect(paths).toContain('S3_ACCESS_KEY_ID');
    expect(paths).toContain('REDIS_QUEUE_URL');
    // Six independently-broken fields must produce (at least) six issues —
    // proving this isn't short-circuiting on the first failure.
    expect(caught?.issues.length).toBeGreaterThanOrEqual(6);
  });

  it('includes actionable guidance in the thrown error message', () => {
    let caught: ConfigValidationError | undefined;
    try {
      loadConfig(envWithout('DB_HOST'));
    } catch (err) {
      caught = err as ConfigValidationError;
    }

    expect(caught?.message).toContain('.env.example');
  });
});

describe('loadConfig — malformed values are rejected', () => {
  it('rejects a non-numeric port', () => {
    expect(() => loadConfig({ ...VALID_ENV, DB_PORT: 'not-a-port' })).toThrow(ConfigValidationError);
  });

  it('rejects a port outside the valid TCP range', () => {
    expect(() => loadConfig({ ...VALID_ENV, PORT: '70000' })).toThrow(ConfigValidationError);
    expect(() => loadConfig({ ...VALID_ENV, PORT: '0' })).toThrow(ConfigValidationError);
  });

  it('rejects a malformed URL for a Redis connection string', () => {
    expect(() => loadConfig({ ...VALID_ENV, REDIS_QUEUE_URL: 'not a url at all' })).toThrow(ConfigValidationError);
  });

  it('rejects a malformed URL for the S3 endpoint', () => {
    expect(() => loadConfig({ ...VALID_ENV, S3_ENDPOINT: 'definitely-not-a-url' })).toThrow(ConfigValidationError);
  });

  it('rejects a boolean value that is neither true/false/1/0', () => {
    expect(() => loadConfig({ ...VALID_ENV, DB_SSL: 'yes' })).toThrow(ConfigValidationError);
  });

  it('rejects a NODE_ENV outside the allowed enum', () => {
    expect(() => loadConfig({ ...VALID_ENV, NODE_ENV: 'staging' })).toThrow(ConfigValidationError);
  });

  it('rejects a LOG_LEVEL outside the allowed enum', () => {
    expect(() => loadConfig({ ...VALID_ENV, LOG_LEVEL: 'verbose-ish' })).toThrow(ConfigValidationError);
  });

  it('rejects a non-numeric API_DEFAULT_VERSION', () => {
    expect(() => loadConfig({ ...VALID_ENV, API_DEFAULT_VERSION: 'v1' })).toThrow(ConfigValidationError);
  });

  it('rejects a negative duration', () => {
    expect(() => loadConfig({ ...VALID_ENV, OUTBOX_POLL_INTERVAL_MS: '-100' })).toThrow(ConfigValidationError);
  });

  it('requires a trusted CA for PostgreSQL TLS in production', () => {
    expect(() => loadConfig(envWithout('DB_SSL_CA'))).toThrow(ConfigValidationError);
  });

  it('allows insecure PostgreSQL TLS only through an explicit non-production opt-in', () => {
    const local = {
      ...envWithout('DB_SSL_CA'),
      NODE_ENV: 'development',
      DB_SSL_INSECURE_LOCAL: 'true',
    };
    expect(loadConfig(local).database.ssl).toEqual({ rejectUnauthorized: false });

    expect(() =>
      loadConfig({ ...local, NODE_ENV: 'production' }),
    ).toThrow(ConfigValidationError);
  });

  it('rejects TLS-only options when database TLS is disabled', () => {
    expect(() => loadConfig({ ...VALID_ENV, DB_SSL: 'false' })).toThrow(
      ConfigValidationError,
    );
    expect(() =>
      loadConfig({
        ...VALID_ENV,
        NODE_ENV: 'test',
        DB_SSL: 'false',
        DB_SSL_CA: '',
        DB_SSL_INSECURE_LOCAL: 'true',
      }),
    ).toThrow(ConfigValidationError);
  });

  it('requires nonempty server-owned current Terms and Privacy versions', () => {
    expect(() => loadConfig(envWithout('CURRENT_TOS_VERSION'))).toThrow(
      ConfigValidationError,
    );
    expect(() =>
      loadConfig({ ...VALID_ENV, CURRENT_PRIVACY_POLICY_VERSION: '   ' }),
    ).toThrow(ConfigValidationError);
  });
});
