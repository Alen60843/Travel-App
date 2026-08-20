/**
 * Extension point for readiness checks.
 *
 * Owned by this module, implemented independently by whichever module owns
 * a dependency worth checking (database connection pool, Redis, queue,
 * outbox relay, ...). This module deliberately knows nothing about what
 * those checks actually do — it only knows how to run and aggregate
 * whatever implementations are registered under `READINESS_CHECK`. See
 * health.module.ts for why that registration has to happen at the
 * composition root rather than here.
 */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<{ healthy: boolean; detail?: string }>;
}

/** Multi-provider token: bind an array of `ReadinessCheck` implementations to this. */
export const READINESS_CHECK = Symbol('READINESS_CHECK');
