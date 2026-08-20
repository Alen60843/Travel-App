import { Injectable } from '@nestjs/common';

/**
 * A trivial in-memory counter keyed by an arbitrary string.
 *
 * Exists ONLY so integration tests can assert "an effect ran exactly once"
 * after a redelivery, instead of merely "no error was thrown". It has no
 * business meaning and backs nothing except `infra.echo`
 * (`infra-echo.processor.ts`) — see that file's own idempotency comment for
 * why the counter, not just absence of an error, is the thing worth
 * asserting.
 */
@Injectable()
export class EffectCounterRegistry {
  private readonly counts = new Map<string, number>();

  increment(key: string): number {
    const next = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, next);
    return next;
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  reset(): void {
    this.counts.clear();
  }
}
