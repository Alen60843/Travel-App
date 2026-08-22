import { normalizeExplorerQuery } from './explorer-query';

const NOW = new Date('2089-12-20T12:00:00Z');

describe('normalizeExplorerQuery', () => {
  it('accepts and marks an antimeridian-crossing viewport', () => {
    const result = normalizeExplorerQuery(
      { south: -10, west: 170, north: 10, east: -170, zoom: 8 },
      NOW,
    );
    expect(result.spatial).toEqual({
      kind: 'viewport',
      south: -10,
      west: 170,
      north: 10,
      east: -170,
      crossesAntimeridian: true,
    });
    expect(result.windowStart).toEqual(NOW);
    expect(result.windowEnd).toEqual(new Date('2090-01-19T12:00:00Z'));
  });

  it('accepts a bounded radius and sorts category filters deterministically', () => {
    const result = normalizeExplorerQuery(
      {
        centerLatitude: 31.7683,
        centerLongitude: 35.2137,
        radiusMeters: 25_000,
        zoom: 15,
        categoryCodes: ['trek', 'party'],
      },
      NOW,
    );
    expect(result.spatial).toMatchObject({ kind: 'radius', radiusMeters: 25_000 });
    expect(result.categoryCodes).toEqual(['party', 'trek']);
  });

  it('clamps a requested past start to now while preserving a UTC end', () => {
    const result = normalizeExplorerQuery(
      {
        south: 30,
        west: 34,
        north: 33,
        east: 36,
        zoom: 12,
        windowStart: '2089-12-19T00:00:00+00:00',
        windowEnd: '2090-01-01T00:00:00Z',
      },
      NOW,
    );
    expect(result.windowStart).toEqual(NOW);
    expect(result.windowEnd.toISOString()).toBe('2090-01-01T00:00:00.000Z');
  });

  it.each([
    [{ zoom: 10 }, 'spatialQuery'],
    [{ south: 0, west: 0, north: 1, east: 1, centerLatitude: 0, centerLongitude: 0, radiusMeters: 1000, zoom: 10 }, 'spatialQuery'],
    [{ south: 0, west: 0, north: 1, zoom: 10 }, 'viewport'],
    [{ south: 1, west: 0, north: 1, east: 2, zoom: 10 }, 'viewport'],
    [{ south: -40, west: 0, north: 40, east: 2, zoom: 2 }, 'viewport'],
    [{ south: 0, west: -100, north: 1, east: 100, zoom: 2 }, 'viewport'],
    [{ centerLatitude: 0, centerLongitude: 0, zoom: 10 }, 'radiusMeters'],
    [{ centerLatitude: 0, centerLongitude: 0, radiusMeters: 1000, zoom: 10, windowStart: '2090-01-01T00:00:00Z' }, 'windowStart'],
    [{ centerLatitude: 0, centerLongitude: 0, radiusMeters: 1000, zoom: 10, windowStart: '2090-02-01T00:00:00Z', windowEnd: '2090-01-01T00:00:00Z' }, 'windowEnd'],
    [{ centerLatitude: 0, centerLongitude: 0, radiusMeters: 1000, zoom: 10, windowStart: '2089-01-01T00:00:00Z', windowEnd: '2089-02-01T00:00:00Z' }, 'windowEnd'],
    [{ centerLatitude: 0, centerLongitude: 0, radiusMeters: 1000, zoom: 10, windowStart: '2090-01-01T00:00:00Z', windowEnd: '2090-04-02T00:00:00Z' }, 'windowEnd'],
    [{ centerLatitude: 0, centerLongitude: 0, radiusMeters: 1000, zoom: 10, categoryCodes: ['trek', 'trek'] }, 'categoryCodes'],
    [{ centerLatitude: 0, centerLongitude: 0, radiusMeters: 1000, zoom: 10, categoryCodes: ['NOT_VALID'] }, 'categoryCodes'],
  ])('rejects invalid cross-field query %#', (query, field) => {
    expect(() => normalizeExplorerQuery(query, NOW)).toThrow(
      expect.objectContaining({ code: 'EXPLORER_QUERY_INVALID', details: { field } }),
    );
  });
});
