import type { INestApplication, Provider } from '@nestjs/common';
import { Test } from '@nestjs/testing';

import { ConnectionTracker } from './connection-tracker.service';
import { RealtimeGateway } from './realtime.gateway';
import { RealtimeModule } from './realtime.module';
import { userRoom } from './rooms';
import { SOCKET_AUTHENTICATOR } from './socket-authenticator';
import type { AuthenticatedPrincipal, SocketAuthenticator } from './socket-authenticator';

/**
 * These tests drive a real, in-process Nest application over an actual
 * WebSocket connection. Neither `socket.io-client` nor `ws` are reachable
 * from apps/api's node_modules in this workspace (verified: pnpm did not
 * hoist either as this package has no direct dependency on them), so this
 * uses Node's built-in global `WebSocket` (stable since Node 21, confirmed
 * present under this repo's Jest "node" test environment) to speak the
 * engine.io v4 / socket.io v5 wire protocol directly:
 *
 *   -> connect to  ws://host:port/socket.io/?EIO=4&transport=websocket
 *   <- engine.io OPEN packet:              `0{"sid":...}`
 *   -> socket.io CONNECT packet with auth:  `40{"token":"..."}`
 *   <- socket.io CONNECT-ACK (accepted):    `40{"sid":...}`
 *      ...or the raw WebSocket closes (rejected)
 *
 * This was verified against this exact server setup before being relied on
 * here (see the task report for the raw frame trace).
 */

class FakeAuthenticator implements SocketAuthenticator {
  async authenticate(token: string | undefined): Promise<AuthenticatedPrincipal | null> {
    return token === 'good-token' ? { userId: 'user-123' } : null;
  }
}

function waitForFrame(ws: WebSocket, predicate: (frame: string) => boolean, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.removeEventListener('message', handler);
      reject(new Error('timed out waiting for a matching frame'));
    }, timeoutMs);
    const handler = (ev: MessageEvent): void => {
      const frame = String(ev.data);
      if (predicate(frame)) {
        clearTimeout(timer);
        ws.removeEventListener('message', handler);
        resolve(frame);
      }
    };
    ws.addEventListener('message', handler);
  });
}

// `CloseEvent` itself isn't part of @types/node's global surface (unlike
// `WebSocket`/`MessageEvent`, which are) -- `Event` is, and it's all the
// callers below need (they only check that a close event fired at all).
function waitForClose(ws: WebSocket, timeoutMs = 4000): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timed out waiting for close')), timeoutMs);
    ws.addEventListener('close', (ev) => {
      clearTimeout(timer);
      resolve(ev);
    });
  });
}

async function openEngineIoSocket(port: number): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/socket.io/?EIO=4&transport=websocket`);
  await waitForFrame(ws, (f) => f.startsWith('0'));
  return ws;
}

describe('RealtimeGateway (real Nest app, real WebSocket wire protocol)', () => {
  let app: INestApplication | undefined;
  let port: number;
  let gateway: RealtimeGateway;
  let connectionTracker: ConnectionTracker;

  async function buildApp(authenticatorProvider?: Provider): Promise<void> {
    const moduleRef = await Test.createTestingModule({
      imports: [RealtimeModule.forRoot(authenticatorProvider ? { authenticatorProvider } : {})],
    }).compile();

    const nestApp = moduleRef.createNestApplication();
    await nestApp.listen(0);
    app = nestApp;

    const address = nestApp.getHttpServer().address();
    port = typeof address === 'object' && address !== null ? address.port : 0;

    gateway = moduleRef.get(RealtimeGateway);
    connectionTracker = moduleRef.get(ConnectionTracker);
  }

  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  describe('gateway boots and accepts a connection the authenticator approves', () => {
    beforeEach(async () => {
      await buildApp({ provide: SOCKET_AUTHENTICATOR, useClass: FakeAuthenticator });
    });

    it('sends a connect ack and joins the socket to its user:{id} room', async () => {
      const ws = await openEngineIoSocket(port);
      ws.send('40{"token":"good-token"}');

      const ack = await waitForFrame(ws, (f) => f.startsWith('40'));
      expect(ack).toContain('"sid"');

      // handleConnection awaits client.join() before returning; give the
      // event loop one tick to let that resolve on the server side.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(connectionTracker.activeConnections).toBe(1);
      const room = gateway.server.sockets.adapter.rooms.get(userRoom('user-123'));
      expect(room?.size).toBe(1);

      const clientClosed = waitForClose(ws);
      ws.close();
      await clientClosed;
    });
  });

  describe('a socket is rejected when the authenticator returns null', () => {
    beforeEach(async () => {
      await buildApp({ provide: SOCKET_AUTHENTICATOR, useClass: FakeAuthenticator });
    });

    it('closes the underlying connection and never joins a room or counts as connected', async () => {
      const ws = await openEngineIoSocket(port);
      ws.send('40{"token":"not-a-real-token"}');

      const closeEvent = await waitForClose(ws);

      expect(closeEvent).toBeDefined();
      expect(connectionTracker.activeConnections).toBe(0);
    });
  });

  describe('the default authenticator (no authenticatorProvider registered)', () => {
    beforeEach(async () => {
      await buildApp(); // no authenticatorProvider -> RejectingSocketAuthenticator
    });

    it('rejects every connection, proving fail-closed behaviour end to end', async () => {
      const ws = await openEngineIoSocket(port);
      // Even a token that would pass a real authenticator must still be rejected.
      ws.send('40{"token":"good-token"}');

      const closeEvent = await waitForClose(ws);

      expect(closeEvent).toBeDefined();
      expect(connectionTracker.activeConnections).toBe(0);
    });
  });

  describe('graceful shutdown', () => {
    beforeEach(async () => {
      await buildApp({ provide: SOCKET_AUTHENTICATOR, useClass: FakeAuthenticator });
    });

    it('closes cleanly and disconnects live sockets without hanging', async () => {
      const ws = await openEngineIoSocket(port);
      ws.send('40{"token":"good-token"}');
      await waitForFrame(ws, (f) => f.startsWith('40'));

      const clientClosed = waitForClose(ws);

      // Promise.race doesn't cancel the loser: an uncleared timer here would
      // keep the process alive for the rest of its 5s even after app.close()
      // wins the race, which is itself exactly the kind of leaked handle
      // this test is trying to prove the *gateway* doesn't have.
      let timer: NodeJS.Timeout;
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('app.close() hung')), 5000);
      });
      try {
        await Promise.race([app!.close(), deadline]);
      } finally {
        clearTimeout(timer!);
      }
      app = undefined; // already closed; afterEach must not close it again

      await expect(clientClosed).resolves.toBeDefined();
    });
  });
});
