import { z } from 'zod';

/**
 * Typed, validated configuration.
 *
 * Every value is parsed from the environment exactly once, at startup, through
 * this schema. If anything required is missing or malformed the process exits
 * before it can accept a request — a half-configured API that serves traffic is
 * worse than one that refuses to start.
 *
 * There are deliberately NO production defaults here. Defaults exist only for
 * values that are genuinely environment-independent (a port, a log level, a
 * poll interval). Credentials, hostnames and bucket names have none: forgetting
 * to set them must fail loudly rather than silently pointing at localhost.
 */

const portSchema = z.coerce.number().int().min(1).max(65_535);

/** Accepts "true"/"false"/"1"/"0"; anything else is a configuration error. */
const booleanSchema = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const durationMsSchema = z.coerce.number().int().positive();

export const configSchema = z.object({
  // ---- application ------------------------------------------------------
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: portSchema.default(3000),
  API_PREFIX: z.string().default('api'),
  API_DEFAULT_VERSION: z.string().regex(/^\d+$/).default('1'),
  SHUTDOWN_TIMEOUT_MS: durationMsSchema.default(15_000),
  DEPENDENCY_CHECK_TIMEOUT_MS: durationMsSchema.default(2_000),
  BODY_LIMIT: z.string().default('1mb'),

  // ---- PostgreSQL -------------------------------------------------------
  DB_HOST: z.string().min(1),
  DB_PORT: portSchema,
  DB_USER: z.string().min(1),
  DB_PASSWORD: z.string(),
  DB_NAME: z.string().min(1),
  DB_SSL: booleanSchema.default('false'),
  DB_LOGGING: booleanSchema.default('false'),
  DB_POOL_MAX: z.coerce.number().int().positive().default(10),

  // ---- Redis ------------------------------------------------------------
  //
  // Two independent URLs, never derived from one another. Queue and cache
  // require different maxmemory-policies (noeviction vs allkeys-lru), which is
  // a server-level setting — so in production these MUST be separate
  // instances, not two logical databases on one server.
  REDIS_QUEUE_URL: z.string().url(),
  REDIS_CACHE_URL: z.string().url(),
  QUEUE_PREFIX: z.string().default('tripwith'),

  // ---- outbox relay -----------------------------------------------------
  OUTBOX_POLL_INTERVAL_MS: durationMsSchema.default(1_000),
  OUTBOX_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(100),
  /** How long a published-but-unacknowledged row waits before re-drive. */
  OUTBOX_LEASE_MS: durationMsSchema.default(300_000),
  OUTBOX_ENABLED: booleanSchema.default('true'),

  // ---- Firebase ---------------------------------------------------------
  //
  // Verification is local JWT validation against Google's cached signing keys;
  // these identify the project the token must be issued for.
  FIREBASE_PROJECT_ID: z.string().min(1),
  FIREBASE_CLIENT_EMAIL: z.string().email().optional(),
  FIREBASE_PRIVATE_KEY: z.string().optional(),

  // ---- object storage ---------------------------------------------------
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1),
  S3_BUCKET: z.string().min(1),
  S3_ACCESS_KEY_ID: z.string().min(1),
  S3_SECRET_ACCESS_KEY: z.string().min(1),

  // ---- observability ----------------------------------------------------
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace']).default('info'),
  LOG_PRETTY: booleanSchema.default('false'),
  SERVICE_NAME: z.string().default('tripwith-api'),
}).superRefine((config, context) => {
  const hasClientEmail = config.FIREBASE_CLIENT_EMAIL !== undefined;
  const hasPrivateKey = config.FIREBASE_PRIVATE_KEY !== undefined;
  if (hasClientEmail !== hasPrivateKey) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['FIREBASE_CLIENT_EMAIL'],
      message:
        'FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY must either both be set or both be omitted',
    });
  }
});

export type RawConfig = z.infer<typeof configSchema>;

/** Grouped, immutable view of configuration handed to the rest of the app. */
export interface AppConfig {
  readonly app: {
    readonly env: RawConfig['NODE_ENV'];
    readonly isProduction: boolean;
    readonly port: number;
    readonly apiPrefix: string;
    readonly defaultVersion: string;
    readonly shutdownTimeoutMs: number;
    readonly dependencyCheckTimeoutMs: number;
    readonly bodyLimit: string;
  };
  readonly database: {
    readonly host: string;
    readonly port: number;
    readonly username: string;
    readonly password: string;
    readonly database: string;
    readonly ssl: boolean;
    readonly logging: boolean;
    readonly poolMax: number;
  };
  readonly redisQueue: { readonly url: string; readonly prefix: string };
  readonly redisCache: { readonly url: string };
  readonly outbox: {
    readonly enabled: boolean;
    readonly pollIntervalMs: number;
    readonly batchSize: number;
    readonly leaseMs: number;
  };
  readonly firebase: {
    readonly projectId: string;
    readonly clientEmail?: string;
    readonly privateKey?: string;
  };
  readonly storage: {
    readonly endpoint: string;
    readonly region: string;
    readonly bucket: string;
    readonly accessKeyId: string;
    readonly secretAccessKey: string;
  };
  readonly observability: {
    readonly level: RawConfig['LOG_LEVEL'];
    readonly pretty: boolean;
    readonly serviceName: string;
  };
}

export class ConfigValidationError extends Error {
  constructor(public readonly issues: readonly string[]) {
    super(
      `Invalid configuration:\n${issues.map((i) => `  - ${i}`).join('\n')}\n` +
        `Copy apps/api/.env.example to .env and fill in the missing values.`,
    );
    this.name = 'ConfigValidationError';
  }
}

/**
 * Parses and groups configuration. Throws ConfigValidationError listing EVERY
 * problem at once — reporting one missing variable per restart wastes time.
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = configSchema.safeParse(env);

  if (!parsed.success) {
    const issues = parsed.error.issues.map(
      (issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`,
    );
    throw new ConfigValidationError(issues);
  }

  const c = parsed.data;

  return Object.freeze({
    app: Object.freeze({
      env: c.NODE_ENV,
      isProduction: c.NODE_ENV === 'production',
      port: c.PORT,
      apiPrefix: c.API_PREFIX,
      defaultVersion: c.API_DEFAULT_VERSION,
      shutdownTimeoutMs: c.SHUTDOWN_TIMEOUT_MS,
      dependencyCheckTimeoutMs: c.DEPENDENCY_CHECK_TIMEOUT_MS,
      bodyLimit: c.BODY_LIMIT,
    }),
    database: Object.freeze({
      host: c.DB_HOST,
      port: c.DB_PORT,
      username: c.DB_USER,
      password: c.DB_PASSWORD,
      database: c.DB_NAME,
      ssl: c.DB_SSL,
      logging: c.DB_LOGGING,
      poolMax: c.DB_POOL_MAX,
    }),
    redisQueue: Object.freeze({ url: c.REDIS_QUEUE_URL, prefix: c.QUEUE_PREFIX }),
    redisCache: Object.freeze({ url: c.REDIS_CACHE_URL }),
    outbox: Object.freeze({
      enabled: c.OUTBOX_ENABLED,
      pollIntervalMs: c.OUTBOX_POLL_INTERVAL_MS,
      batchSize: c.OUTBOX_BATCH_SIZE,
      leaseMs: c.OUTBOX_LEASE_MS,
    }),
    firebase: Object.freeze({
      projectId: c.FIREBASE_PROJECT_ID,
      ...(c.FIREBASE_CLIENT_EMAIL ? { clientEmail: c.FIREBASE_CLIENT_EMAIL } : {}),
      // Private keys arrive from env with literal \n sequences.
      ...(c.FIREBASE_PRIVATE_KEY
        ? { privateKey: c.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') }
        : {}),
    }),
    storage: Object.freeze({
      endpoint: c.S3_ENDPOINT,
      region: c.S3_REGION,
      bucket: c.S3_BUCKET,
      accessKeyId: c.S3_ACCESS_KEY_ID,
      secretAccessKey: c.S3_SECRET_ACCESS_KEY,
    }),
    observability: Object.freeze({
      level: c.LOG_LEVEL,
      pretty: c.LOG_PRETTY,
      serviceName: c.SERVICE_NAME,
    }),
  });
}

/** DI token for AppConfig. */
export const APP_CONFIG = Symbol('APP_CONFIG');
