/**
 * Readiness contract, declared locally.
 *
 * Agent C (Observability) owns the canonical version of this interface and
 * the health-check aggregator that consumes it. We declare our own
 * structurally-identical copy rather than importing their module, so this
 * package has zero compile-time dependency on another agent's in-flight
 * work. TypeScript's structural typing means any `RedisReadinessCheck`
 * instance satisfies Agent C's interface too, as long as the shape matches
 * — the Lead reconciles the two declarations (or drops ours in favour of
 * theirs) at integration time.
 */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<{ healthy: boolean; detail?: string }>;
}
