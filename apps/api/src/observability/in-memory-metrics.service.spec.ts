import { InMemoryMetricsService } from './in-memory-metrics.service';

describe('InMemoryMetricsService', () => {
  it('accumulates counters, tracking tag combinations separately', () => {
    const metrics = new InMemoryMetricsService();

    metrics.increment('http.requests');
    metrics.increment('http.requests');
    metrics.increment('http.requests', 3, { route: '/health' });

    expect(metrics.getCounter('http.requests')).toBe(2);
    expect(metrics.getCounter('http.requests', { route: '/health' })).toBe(3);
    expect(metrics.getCounter('http.requests', { route: '/other' })).toBe(0);
  });

  it('overwrites gauge values rather than accumulating', () => {
    const metrics = new InMemoryMetricsService();

    metrics.gauge('pool.active', 5);
    metrics.gauge('pool.active', 8);

    expect(metrics.getGauge('pool.active')).toBe(8);
    expect(metrics.getGauge('pool.unset')).toBeUndefined();
  });

  it('records timing samples per key', () => {
    const metrics = new InMemoryMetricsService();

    metrics.timing('request.duration', 12);
    metrics.timing('request.duration', 34);

    expect(metrics.getTimings('request.duration')).toEqual([12, 34]);
  });

  it('is order-insensitive when keying by tags', () => {
    const metrics = new InMemoryMetricsService();

    metrics.increment('x', 1, { a: '1', b: '2' });
    metrics.increment('x', 1, { b: '2', a: '1' });

    expect(metrics.getCounter('x', { a: '1', b: '2' })).toBe(2);
  });

  it('reset clears all recorded data', () => {
    const metrics = new InMemoryMetricsService();
    metrics.increment('x');
    metrics.gauge('y', 1);
    metrics.timing('z', 1);

    metrics.reset();

    expect(metrics.getCounter('x')).toBe(0);
    expect(metrics.getGauge('y')).toBeUndefined();
    expect(metrics.getTimings('z')).toEqual([]);
  });
});
