import type { LoggerService } from '@nestjs/common';
import { Inject, Injectable, Optional } from '@nestjs/common';

import { LOGGER } from '../observability/tokens';
import { READINESS_CHECK, type ReadinessCheck } from './readiness-check.interface';

export interface ReadinessCheckResult {
  readonly name: string;
  readonly healthy: boolean;
  readonly detail?: string;
}

export interface ReadinessResult {
  readonly healthy: boolean;
  readonly checks: readonly ReadinessCheckResult[];
}

/**
 * Runs every registered `ReadinessCheck` and aggregates the result.
 *
 * `checks` is `@Optional()`: with nothing bound to `READINESS_CHECK`
 * anywhere in the app (a fresh app that hasn't wired any dependency checks
 * yet, or this module under test in isolation), it defaults to an empty
 * array — readiness is vacuously true with zero checks, not an error.
 *
 * A check that *throws* is treated as unhealthy rather than propagating and
 * crashing the endpoint — a buggy or misbehaving check must not itself take
 * down the readiness probe. The real error is logged server-side; only a
 * generic detail is returned, same no-leak principle as the exception filter.
 */
@Injectable()
export class ReadinessService {
  constructor(
    @Optional() @Inject(READINESS_CHECK) private readonly checks: ReadinessCheck[] = [],
    @Optional() @Inject(LOGGER) private readonly logger?: LoggerService,
  ) {}

  async evaluate(): Promise<ReadinessResult> {
    const results = await Promise.all(this.checks.map((check) => this.runOne(check)));
    return { healthy: results.every((r) => r.healthy), checks: results };
  }

  private async runOne(check: ReadinessCheck): Promise<ReadinessCheckResult> {
    try {
      const { healthy, detail } = await check.check();
      return { name: check.name, healthy, ...(detail !== undefined ? { detail } : {}) };
    } catch (err) {
      this.logger?.error?.(
        `Readiness check "${check.name}" threw`,
        err instanceof Error ? err.stack : undefined,
        'ReadinessService',
      );
      return { name: check.name, healthy: false, detail: 'check threw an unexpected error' };
    }
  }
}
