import { Injectable } from '@nestjs/common';

import type { MetricsService, MetricTags } from './metrics.interface';

/**
 * Trivial default implementation of {@link MetricsService}.
 *
 * Keeps counters/gauges in memory, keyed by name + sorted tags. This is
 * intentionally simple — a real backend (Prometheus, CloudWatch, ...) is a
 * later-phase concern and will implement the same interface. Useful today
 * for tests and for local debugging without standing up any infrastructure.
 * Timings are kept as a bounded rolling sample per key so this can't grow
 * without limit in a long-running process.
 */
@Injectable()
export class InMemoryMetricsService implements MetricsService {
  private readonly maxSamplesPerKey = 1_000;

  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();
  private readonly timings = new Map<string, number[]>();

  increment(name: string, value = 1, tags?: MetricTags): void {
    const key = this.key(name, tags);
    this.counters.set(key, (this.counters.get(key) ?? 0) + value);
  }

  gauge(name: string, value: number, tags?: MetricTags): void {
    this.gauges.set(this.key(name, tags), value);
  }

  timing(name: string, durationMs: number, tags?: MetricTags): void {
    const key = this.key(name, tags);
    const samples = this.timings.get(key) ?? [];
    samples.push(durationMs);
    if (samples.length > this.maxSamplesPerKey) {
      samples.shift();
    }
    this.timings.set(key, samples);
  }

  /** Test/debug accessor — not exposed over HTTP. */
  getCounter(name: string, tags?: MetricTags): number {
    return this.counters.get(this.key(name, tags)) ?? 0;
  }

  /** Test/debug accessor — not exposed over HTTP. */
  getGauge(name: string, tags?: MetricTags): number | undefined {
    return this.gauges.get(this.key(name, tags));
  }

  /** Test/debug accessor — not exposed over HTTP. */
  getTimings(name: string, tags?: MetricTags): readonly number[] {
    return this.timings.get(this.key(name, tags)) ?? [];
  }

  /** Clears all recorded data. Test-only. */
  reset(): void {
    this.counters.clear();
    this.gauges.clear();
    this.timings.clear();
  }

  private key(name: string, tags?: MetricTags): string {
    if (!tags) return name;
    const sortedEntries = Object.entries(tags).sort(([a], [b]) => a.localeCompare(b));
    if (sortedEntries.length === 0) return name;
    const tagString = sortedEntries.map(([k, v]) => `${k}=${v}`).join(',');
    return `${name}{${tagString}}`;
  }
}
