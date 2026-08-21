import { malformedBearerError, tokenMissingError } from './auth.errors';

/**
 * Parse one RFC 6750 Bearer credential and reject ambiguous input.
 *
 * The scheme is case-insensitive as required by HTTP authentication, while
 * surrounding/embedded whitespace, multiple values, and empty credentials
 * are rejected. The token is deliberately never included in an error.
 */
export function extractBearerToken(
  authorization: string | readonly string[] | undefined,
): string {
  if (authorization === undefined) {
    throw tokenMissingError();
  }

  if (typeof authorization !== 'string') {
    throw malformedBearerError();
  }

  const match = /^Bearer ([^\s]+)$/i.exec(authorization);
  if (!match?.[1]) {
    throw malformedBearerError();
  }

  return match[1];
}

