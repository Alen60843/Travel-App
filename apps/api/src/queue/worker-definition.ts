import type { Processor } from 'bullmq';

/**
 * A queue this deployable should actually consume.
 *
 * Registering a worker is deliberately separate from *creating* a queue.
 * `QueueRegistry` gets-or-creates a `Queue` for producing; a `WorkerDefinition`
 * declares that this process is also willing to run the jobs on it. The HTTP
 * API produces without consuming; the worker deployable consumes.
 *
 * Later phases add a job by providing another definition against the
 * `WORKER_DEFINITION` multi-token — no edit to the worker entrypoint, and no
 * risk of a queue silently having no consumer because someone forgot to
 * register it somewhere central.
 */
export interface WorkerDefinition<T = unknown, R = unknown> {
  /** Queue name. Must match the `topic` written to `job_outbox`. */
  readonly name: string;
  readonly processor: Processor<T, R>;
  /** Overrides DEFAULT_WORKER_CONCURRENCY when a job needs a different bound. */
  readonly concurrency?: number;
}

/**
 * Multi-provider token. Bind an array; `WorkerHost` starts everything bound
 * here. Injected with `@Optional()` and defaulted to `[]`, so a deployable
 * that consumes nothing (the HTTP API) is a valid configuration rather than a
 * DI error.
 */
export const WORKER_DEFINITION = Symbol('WORKER_DEFINITION');

/**
 * Registers a typed processor as an erased `WorkerDefinition`.
 *
 * `Processor<T>` is contravariant in `T`, so `Processor<InfraEchoPayload>` is
 * not assignable to `Processor<unknown>` and a heterogeneous array of
 * definitions cannot be typed without widening somewhere. This function is
 * that somewhere: one cast, in one place, instead of `any` sprinkled across
 * every registration site.
 *
 * The widening is honest rather than hidden. Job payloads arrive as JSON from
 * Redis, so their shape can never be statically guaranteed at the point the
 * worker invokes the processor — the compiler cannot check across a queue
 * boundary no matter how the types are arranged. Payload validation, if a job
 * needs it, belongs inside the processor.
 */
export function defineWorker<T, R = unknown>(definition: WorkerDefinition<T, R>): WorkerDefinition {
  return definition as unknown as WorkerDefinition;
}
