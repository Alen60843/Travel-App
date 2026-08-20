import { Injectable, Logger } from '@nestjs/common';

/**
 * The authenticated principal resolved from a socket's handshake token.
 * Deliberately minimal: only `userId` is guaranteed. Anything a later phase
 * needs beyond that (roles, verification status, …) belongs to that phase,
 * not to this infrastructure module.
 */
export interface AuthenticatedPrincipal {
  readonly userId: string;
}

/**
 * The extension point Phase 3 implements with real Firebase token
 * verification (the same local JWT validation used for HTTP, per the Phase 1
 * design doc §7). This module defines the contract and a fail-closed default
 * only — it must never verify a token itself, see the design doc for why
 * that's Phase 3's job (it owns Firebase credentials and key caching).
 */
export interface SocketAuthenticator {
  /** Verify the handshake and return the authenticated principal, or null to reject. */
  authenticate(handshakeToken: string | undefined): Promise<AuthenticatedPrincipal | null>;
}

/** DI token for {@link SocketAuthenticator}. */
export const SOCKET_AUTHENTICATOR = Symbol('SOCKET_AUTHENTICATOR');

/**
 * Fail-closed default, registered by `RealtimeModule.forRoot()` whenever the
 * caller doesn't supply a real authenticator provider.
 *
 * This exists so that a deployment which forgets to wire up Phase 3's real
 * authenticator rejects every socket instead of silently accepting all of
 * them. A default that *accepted* connections would be a security hole
 * introduced purely by omission — nobody would notice until an
 * unauthenticated client had already joined a room.
 */
@Injectable()
export class RejectingSocketAuthenticator implements SocketAuthenticator {
  private readonly logger = new Logger(RejectingSocketAuthenticator.name);
  private warned = false;

  async authenticate(_handshakeToken: string | undefined): Promise<null> {
    // Logged once per process rather than once per connection: under a
    // connection storm against a misconfigured deployment, per-connection
    // logging here would itself become a resource problem.
    if (!this.warned) {
      this.warned = true;
      this.logger.warn(
        'No SocketAuthenticator is registered — rejecting all Socket.IO connections. ' +
          'This is the deliberate fail-closed default; register a real authenticator via ' +
          'RealtimeModule.forRoot({ authenticatorProvider }) before this reaches production.',
      );
    }
    return null;
  }
}
