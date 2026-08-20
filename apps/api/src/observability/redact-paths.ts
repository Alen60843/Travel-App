/**
 * Structural redaction for the logger.
 *
 * Redaction here is enforced by pino's `redact` option against this fixed
 * path list — it happens on every log line regardless of what the caller
 * remembered to scrub. Relying on call sites to "just not log the token" is
 * exactly the failure mode this is meant to close off.
 *
 * fast-redact (pino's redaction engine) matches paths structurally and does
 * NOT support a recursive "at any depth" wildcard (no `**`). We therefore
 * enumerate the key names at the depths they realistically occur: top level,
 * one level down (`*.key`, covering `headers.authorization`, `body.token`,
 * `user.password`, ...), and two levels down for common nested containers
 * (`req.headers.authorization`, error-wrapper shapes, etc). Anything logged
 * deeper than that should be pre-sanitized by the caller before it reaches
 * the logger — this list is the structural backstop, not the only line of
 * defense.
 *
 * Covers: bearer/JWT/session tokens, the Authorization and Cookie headers,
 * SOS share-link access tokens (`token`/`token_hash`), OAuth client secrets,
 * passwords, and payment card fields.
 */

const KEYS = [
  // --- auth tokens ---
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'idToken',
  'id_token',
  'jwt',
  'bearerToken',
  'sessionToken',
  'session_token',
  // --- SOS emergency-share access tokens ---
  'tokenHash',
  'token_hash',
  // --- secrets / API keys ---
  'secret',
  'clientSecret',
  'client_secret',
  'apiKey',
  'api_key',
  'privateKey',
  'private_key',
  // --- transport-level auth ---
  'authorization',
  'cookie',
  'set-cookie',
  // --- credentials ---
  'password',
  'newPassword',
  'currentPassword',
  'passwordConfirmation',
  // --- payment ---
  'cardNumber',
  'card_number',
  'cvv',
  'cvc',
  'ssn',
] as const;

function pathsAtDepth(prefix: string): string[] {
  return KEYS.map((key) => (prefix ? `${prefix}.${key}` : key));
}

export const REDACT_PATHS: string[] = [
  // depth 0 — the field logged directly on the payload
  ...pathsAtDepth(''),
  // depth 1 — nested one level (headers.authorization, body.token, user.password, sos.token_hash, ...)
  ...pathsAtDepth('*'),
  // depth 2 — common wrapper containers (req.headers.authorization, err.config.headers.authorization, ...)
  ...pathsAtDepth('req.headers'),
  ...pathsAtDepth('res.headers'),
  ...pathsAtDepth('headers'),
  ...pathsAtDepth('body'),
  ...pathsAtDepth('query'),
  ...pathsAtDepth('user'),
  ...pathsAtDepth('sos'),
  ...pathsAtDepth('payment'),
  ...pathsAtDepth('config'),
  ...pathsAtDepth('err.config'),
  ...pathsAtDepth('*.headers'),
];

/** Value substituted for anything matched by REDACT_PATHS. */
export const REDACT_CENSOR = '[REDACTED]';
