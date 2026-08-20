import type { INestApplicationContext } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import { IoAdapter } from '@nestjs/platform-socket.io';
import { createAdapter } from '@socket.io/redis-adapter';
import { Redis } from 'ioredis';
import type { Server, ServerOptions } from 'socket.io';

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;

/**
 * Wires the Socket.IO server to Redis pub/sub so rooms (`user:{id}`,
 * `chat:{roomId}`) are visible across every horizontally-scaled API
 * instance, not just the process that happens to hold a given socket. The
 * API is stateless (Phase 1 design doc §2/§7) — without this, a broadcast to
 * a room would only reach sockets connected to the same instance.
 *
 * Deliberately builds its OWN ioredis clients here rather than importing
 * `src/redis` (the shared cache client another agent owns): once a client
 * issues SUBSCRIBE it is locked into pub/sub mode and can no longer run
 * ordinary commands, so the adapter needs two private connections it fully
 * owns, not a client borrowed from — and shared with — anything else. This
 * is intentional duplication of "an ioredis client pointed at REDIS_CACHE_URL",
 * not an oversight.
 *
 * `connectToRedis()` is a separate, explicit, awaited step (not done lazily
 * inside `createIOServer`) so a Redis outage at boot is a loud startup
 * failure: main.ts calls `await redisIoAdapter.connectToRedis(url)` before
 * `app.listen()`, so an unreachable Redis throws and aborts the deploy.
 * There is deliberately no silent fallback to the in-memory adapter — that
 * would leave the API looking healthy as a single instance while quietly
 * breaking cross-instance room delivery the moment it's scaled beyond one
 * process.
 */
export class RedisIoAdapter extends IoAdapter {
  private readonly logger = new Logger(RedisIoAdapter.name);
  private pubClient?: Redis;
  private subClient?: Redis;
  private adapterConstructor?: ReturnType<typeof createAdapter>;

  constructor(app: INestApplicationContext) {
    super(app);
  }

  /** Must be called and awaited before `app.listen()` / `createIOServer()`. */
  async connectToRedis(redisUrl: string, connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<void> {
    // lazyConnect so construction never auto-connects: connect() below is
    // the only connection attempt, and it's the one we can time out loudly.
    const pubClient = new Redis(redisUrl, { lazyConnect: true });
    const subClient = pubClient.duplicate();

    // Attached before connecting, not after success: a client with zero
    // 'error' listeners throws on the next background reconnect attempt
    // (including the very first failed one), which would otherwise crash
    // the process instead of surfacing as the clean rejection this method
    // is supposed to produce.
    pubClient.on('error', (error: Error) => this.logger.error(`Redis pub client error: ${error.message}`));
    subClient.on('error', (error: Error) => this.logger.error(`Redis sub client error: ${error.message}`));

    try {
      await Promise.all([
        this.connectWithDeadline(pubClient, 'pub', connectTimeoutMs),
        this.connectWithDeadline(subClient, 'sub', connectTimeoutMs),
      ]);
    } catch (error) {
      // Neither client is left half-open: whichever one did connect still
      // needs to be torn down, or it leaks a handle past the failed boot.
      pubClient.disconnect();
      subClient.disconnect();
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(
        `RedisIoAdapter: could not connect to Redis at ${redactUrl(redisUrl)} for the Socket.IO adapter: ${message}`,
      );
    }

    this.pubClient = pubClient;
    this.subClient = subClient;
    this.adapterConstructor = createAdapter(pubClient, subClient);
    this.logger.log('Socket.IO Redis adapter connected');
  }

  private connectWithDeadline(client: Redis, label: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`${label} client did not become ready within ${timeoutMs}ms`));
      }, timeoutMs);

      client
        .connect()
        .then(() => {
          clearTimeout(timer);
          resolve();
        })
        .catch((error: Error) => {
          clearTimeout(timer);
          reject(error);
        });
    });
  }

  override createIOServer(port: number, options?: ServerOptions): Server {
    const server: Server = super.createIOServer(port, options);

    if (!this.adapterConstructor) {
      // Programmer error, not an environment failure: whoever wired this
      // adapter skipped `await connectToRedis(...)` before the app started
      // listening. Fail loud here too, for the same reason as above.
      throw new Error(
        'RedisIoAdapter.connectToRedis() must be called and awaited before the Nest app starts listening.',
      );
    }

    server.adapter(this.adapterConstructor);
    return server;
  }

  override async close(server: Server): Promise<void> {
    // Sockets first: disconnect them while the pub/sub clients are still
    // live, so nothing races an in-flight cross-instance broadcast against a
    // Redis connection that's already gone.
    server.disconnectSockets(true);
    await super.close(server);
  }

  override async dispose(): Promise<void> {
    // Runs once, after every gateway's close() has completed — see
    // @nestjs/websockets SocketModule#close(), which calls close() per
    // server and then dispose() a single time at the end. Only quit clients
    // that actually connected (connectToRedis may never have succeeded).
    await Promise.all([this.pubClient?.quit(), this.subClient?.quit()]);
  }
}

/** Never let a credential embedded in a Redis URL reach a log or error message. */
function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    if (parsed.username) parsed.username = '***';
    return parsed.toString();
  } catch {
    return '(unparseable redis url)';
  }
}
