import type { JobsOptions } from 'bullmq';

/**
 * Default retry/backoff policy applied to every job this process enqueues.
 *
 * `attempts: 5` — enough to ride out a transient blip (a DB failover, a
 * momentary upstream 5xx) without paging anyone, but small enough that a
 * job that is systematically broken (bad payload, permanently-down
 * dependency) fails out of BullMQ quickly. BullMQ exhausting its attempts is
 * NOT the end of the story for outbox-sourced jobs: the row survives in
 * `job_outbox` regardless (see OutboxRelay) and is only dead-lettered by the
 * relay's own `max_attempts`, which is a separate, coarser counter measured
 * in publish/re-drive cycles rather than BullMQ attempts. This keeps BullMQ
 * retries cheap and fast while the outbox retains the slower, durable safety
 * net described in §6.7.
 *
 * `backoff: exponential, delay 2000ms` — attempt delays are approximately
 * 2s, 4s, 8s, 16s, 32s: about a minute of total spread, which comfortably
 * covers a Postgres failover or a brief network partition without hammering
 * a struggling dependency at a fixed interval.
 *
 * `removeOnComplete` / `removeOnFail` bound Redis memory (queue Redis runs
 * `noeviction`, so an unbounded job history is a slow-motion OOM) while
 * still keeping recently finished jobs around long enough to inspect during
 * an incident.
 */
export const DEFAULT_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 2_000 },
  removeOnComplete: { age: 3_600, count: 1_000 },
  removeOnFail: { age: 86_400 },
};

/** Default worker concurrency when a caller doesn't specify one. */
export const DEFAULT_WORKER_CONCURRENCY = 5;
