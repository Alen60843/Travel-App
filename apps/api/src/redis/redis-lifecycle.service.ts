import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
import { OperationTimeoutError, withTimeout } from '../common/with-timeout';
import { CACHE_REDIS, QUEUE_REDIS } from './redis.tokens';

/**
 * Closes both Redis connections on module shutdown.
 *
 * `quit()` is graceful: it waits for in-flight commands to finish and sends
 * the QUIT command before closing the socket. If that hangs (server already
 * gone, network partition) we fall back to `disconnect()`, which tears the
 * socket down immediately — shutdown must complete either way, a dying
 * process should never be blocked forever on a connection that's never
 * coming back.
 *
 * One subtlety verified empirically against ioredis: the promise `quit()`
 * returns resolves once the QUIT command's reply is read off the socket, but
 * `.status` flips to `'end'` off the socket's own `'end'` event, which lands
 * a tick LATER. Awaiting `quit()` alone is therefore not sufficient to
 * guarantee the connection has actually reached `'end'` by the time this
 * method returns — which matters for a caller that inspects `.status`
 * immediately after (a test verifying clean shutdown, or a process-exit path
 * checking for lingering handles). We attach the `'end'` listener BEFORE
 * calling `quit()` to avoid racing it, bounded by a short timeout so a
 * connection that never emits `'end'` cannot block shutdown forever.
 */
@Injectable()
export class RedisLifecycleService implements OnModuleDestroy {
  private readonly logger = new Logger(RedisLifecycleService.name);

  constructor(
    @Inject(QUEUE_REDIS) private readonly queueRedis: Redis,
    @Inject(CACHE_REDIS) private readonly cacheRedis: Redis,
  ) {}

  async onModuleDestroy(): Promise<void> {
    await Promise.all([
      closeRedisGracefully(this.queueRedis, 'queue', 2_000, this.logger),
      closeRedisGracefully(this.cacheRedis, 'cache', 2_000, this.logger),
    ]);
  }
}

/**
 * Closes one ioredis connection within a hard deadline.
 *
 * The timeout wraps `quit()` itself, not only the later socket `end` event.
 * Otherwise an unavailable Redis with persistent reconnect enabled can block
 * Nest's `onModuleDestroy` phase forever, before any later shutdown watchdog
 * gets a chance to run.
 */
export async function closeRedisGracefully(
  redis: Redis,
  label: string,
  timeoutMs: number,
  logger: Pick<Logger, 'warn'> = new Logger(RedisLifecycleService.name),
): Promise<void> {
  if (redis.status === 'end') return;

  const reachedEnd = new Promise<void>((resolve) => {
    if (redis.status === 'end') {
      resolve();
      return;
    }
    redis.once('end', () => resolve());
  });

  try {
    await withTimeout(
      (async () => {
        await redis.quit();
        await reachedEnd;
      })(),
      timeoutMs,
      `${label} Redis did not close within ${timeoutMs}ms`,
    );
  } catch (err) {
    const reason = err instanceof OperationTimeoutError ? err.message : (err as Error).message;
    logger.warn(`graceful quit failed for ${label} Redis, forcing disconnect: ${reason}`);
    const statusAfterFailure: string = redis.status;
    if (statusAfterFailure !== 'end') {
      redis.disconnect();
    }
  }
}
