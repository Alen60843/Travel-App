import type { Socket } from 'socket.io';

const BEARER_PREFIX = 'Bearer ';

/**
 * Extracts the bearer token from a Socket.IO handshake.
 *
 * The conventional client usage is `io(url, { auth: { token } })`, which
 * lands in `handshake.auth.token` — that's the primary path. We fall back to
 * a standard `Authorization: Bearer <token>` header so the same
 * token-carrying convention HTTP requests use also works here, for clients
 * (or tools) that find that more natural to send.
 */
export function extractHandshakeToken(handshake: Socket['handshake']): string | undefined {
  const authToken: unknown = handshake.auth['token'];
  if (typeof authToken === 'string' && authToken.length > 0) {
    return authToken;
  }

  const header = handshake.headers.authorization;
  if (typeof header === 'string' && header.startsWith(BEARER_PREFIX)) {
    const token = header.slice(BEARER_PREFIX.length).trim();
    return token.length > 0 ? token : undefined;
  }

  return undefined;
}
