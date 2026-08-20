import { Inject, Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import type { Redis } from 'ioredis';
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
      this.closeGracefully(this.queueRedis, 'queue'),
      this.closeGracefully(this.cacheRedis, 'cache'),
    ]);
  }

  private async closeGracefully(redis: Redis, label: string): Promise<void> {
    if (redis.status === 'end') return;

    const reachedEnd = new Promise<void>((resolve) => {
      if (redis.status === 'end') {
        resolve();
        return;
      }
      redis.once('end', () => resolve());
    });

    try {
      await redis.quit();
      await Promise.race([reachedEnd, sleep(2_000)]);
      // Re-read into a widened local: TS's control-flow narrowing from the
      // `=== 'end'` check at the top of this function incorrectly persists
      // across the awaits above, even though `.status` is a live getter that
      // has since changed. Without this, TS reports the comparison below as
      // having no overlap — which is exactly backwards, since detecting that
      // `quit()` did NOT reach 'end' is the whole point of this check.
      const statusAfterQuit: string = redis.status;
      if (statusAfterQuit !== 'end') {
        this.logger.warn(`${label} redis did not reach 'end' within 2s of quit(); forcing disconnect`);
        redis.disconnect();
      }
    } catch (err) {
      this.logger.warn(
        `graceful quit failed for ${label} redis, forcing disconnect: ${(err as Error).message}`,
      );
      redis.disconnect();
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
