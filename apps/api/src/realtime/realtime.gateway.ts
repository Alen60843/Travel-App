import { Inject, Logger } from '@nestjs/common';
import { OnGatewayConnection, OnGatewayDisconnect, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import type { Server } from 'socket.io';

import { ConnectionTracker } from './connection-tracker.service';
import type { RealtimeSocket } from './realtime-socket.types';
import { userRoom } from './rooms';
import { extractHandshakeToken } from './socket-auth.util';
import { SOCKET_AUTHENTICATOR, type SocketAuthenticator } from './socket-authenticator';

/**
 * Socket.IO's own defaults are already 25s/20s; set explicitly so the value
 * is a deliberate, documented choice rather than an implicit library default
 * that could silently change on a dependency bump. Generous enough to
 * tolerate a mobile client's brief radio handoffs (Expo/React Native, per
 * the Phase 1 design doc) without flapping the connection.
 */
const PING_INTERVAL_MS = 25_000;
const PING_TIMEOUT_MS = 20_000;

/**
 * 1 MB: enough for control/event frames, small enough that a single frame
 * can't be used to exhaust server memory. Message-payload limits proper are
 * Phase 7's concern once there is an actual chat payload shape to bound.
 */
const MAX_HTTP_BUFFER_SIZE_BYTES = 1_000_000;

@WebSocketGateway({
  transports: ['websocket', 'polling'],
  pingInterval: PING_INTERVAL_MS,
  pingTimeout: PING_TIMEOUT_MS,
  maxHttpBufferSize: MAX_HTTP_BUFFER_SIZE_BYTES,
  cors: {
    // No origin allowlist exists in AppConfig yet (src/config/configuration.ts
    // is out of this module's scope — see FILES YOU MUST NOT TOUCH). `origin:
    // false` disables CORS headers entirely: browsers then block cross-origin
    // access by default (fail closed) rather than a wildcard leaving every
    // origin able to open a socket. Native mobile/server clients are
    // unaffected — CORS is a browser-enforced restriction, not a server-side
    // one. Revisit once an origin allowlist lands in configuration.ts.
    origin: false,
  },
})
export class RealtimeGateway implements OnGatewayConnection, OnGatewayDisconnect {
  @WebSocketServer()
  server!: Server;

  private readonly logger = new Logger(RealtimeGateway.name);

  constructor(
    @Inject(SOCKET_AUTHENTICATOR) private readonly authenticator: SocketAuthenticator,
    private readonly connectionTracker: ConnectionTracker,
  ) {}

  async handleConnection(client: RealtimeSocket): Promise<void> {
    try {
      const token = extractHandshakeToken(client.handshake);
      const principal = await this.authenticator.authenticate(token);

      if (!principal) {
        // Never log the token itself — only that a socket was rejected.
        this.logger.warn(`Socket ${client.id} rejected: authentication failed`);
        client.disconnect(true);
        return;
      }

      client.data.userId = principal.userId;
      await client.join(userRoom(principal.userId));
      this.connectionTracker.increment();
      this.logger.log(`Socket ${client.id} connected (user ${principal.userId})`);
    } catch (error) {
      // An authentication error is a rejected connection, never a crashed
      // gateway — one bad token or a transient verifier failure must not
      // take down every other socket on this process.
      const message = error instanceof Error ? error.message : 'unknown error';
      this.logger.error(`Socket ${client.id} authentication error: ${message}`);
      client.disconnect(true);
    }
  }

  handleDisconnect(client: RealtimeSocket): void {
    const userId = client.data.userId;
    if (userId) {
      this.connectionTracker.decrement();
      this.logger.log(`Socket ${client.id} disconnected (user ${userId})`);
    } else {
      // Disconnected before/without ever authenticating — normal for a
      // rejected socket, not necessarily worth a warning.
      this.logger.log(`Socket ${client.id} disconnected (unauthenticated)`);
    }
  }
}
