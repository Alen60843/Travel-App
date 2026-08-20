import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Request correlation.
 *
 * AsyncLocalStorage rather than passing an id through every signature: log
 * lines emitted deep inside a service still carry the request they belong to,
 * without the id leaking into domain APIs that have no business knowing about
 * transport concerns.
 *
 * Background work (outbox relay, workers) runs its own store keyed by job id,
 * so a queued action is traceable end to end.
 */
export interface CorrelationContext {
  readonly correlationId: string;
  readonly userId?: string;
}

const storage = new AsyncLocalStorage<CorrelationContext>();

export const CORRELATION_HEADER = 'x-correlation-id';

export function runWithCorrelation<T>(context: CorrelationContext, fn: () => T): T {
  return storage.run(context, fn);
}

export function getCorrelationContext(): CorrelationContext | undefined {
  return storage.getStore();
}

export function getCorrelationId(): string {
  return storage.getStore()?.correlationId ?? 'no-correlation';
}

/**
 * Accepts a client-supplied id only if it looks like one. An unvalidated
 * header would let a caller inject newlines or megabytes into every log line
 * for the request.
 */
export function normalizeCorrelationId(candidate: unknown): string {
  if (typeof candidate === 'string' && /^[A-Za-z0-9_-]{8,128}$/.test(candidate)) {
    return candidate;
  }
  return randomUUID();
}
