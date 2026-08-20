/**
 * Minimal metrics abstraction.
 *
 * Deliberately small: a counter, a gauge, and a timing. This is NOT a
 * monitoring platform — no Prometheus client, no registry, no exporters.
 * The point is to give later phases a stable interface to code against
 * (`@Inject(METRICS)`) so instrumentation can be added without touching call
 * sites again, and to swap the implementation (e.g. for a Prometheus-backed
 * one) behind this interface when that becomes a real requirement.
 *
 * `tags` are a flat string/string map — good enough for a name + a couple of
 * dimensions (route, outcome). Nothing here assumes a specific backend's
 * tag/label cardinality rules.
 */
export type MetricTags = Readonly<Record<string, string>>;

export interface MetricsService {
  /** Increments a named counter by `value` (default 1). */
  increment(name: string, value?: number, tags?: MetricTags): void;

  /** Sets a named gauge to an absolute value. */
  gauge(name: string, value: number, tags?: MetricTags): void;

  /** Records a duration, in milliseconds, for a named timing. */
  timing(name: string, durationMs: number, tags?: MetricTags): void;
}
