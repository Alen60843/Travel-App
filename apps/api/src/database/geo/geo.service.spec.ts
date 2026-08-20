import { GeoService } from './geo.service';
import { geoPoint } from './geo-point';

describe('geoPoint', () => {
  it('builds a GeoJSON Point in [lng, lat] order from (lat, lng) inputs', () => {
    expect(geoPoint(13.7563, 100.5018)).toEqual({
      type: 'Point',
      coordinates: [100.5018, 13.7563],
    });
  });

  it('rejects an out-of-range latitude', () => {
    expect(() => geoPoint(91, 0)).toThrow(RangeError);
    expect(() => geoPoint(-91, 0)).toThrow(RangeError);
  });

  it('rejects an out-of-range longitude', () => {
    expect(() => geoPoint(0, 181)).toThrow(RangeError);
    expect(() => geoPoint(0, -181)).toThrow(RangeError);
  });

  it('rejects non-finite input', () => {
    expect(() => geoPoint(Number.NaN, 0)).toThrow(RangeError);
    expect(() => geoPoint(0, Number.POSITIVE_INFINITY)).toThrow(RangeError);
  });
});

describe('GeoService', () => {
  const geo = new GeoService();

  describe('withinRadius', () => {
    it('produces a parameterised ST_DWithin fragment on geography', () => {
      const fragment = geo.withinRadius('e.meeting_point', { latitude: 13.7563, longitude: 100.5018 }, 5000);
      expect(fragment.sql).toBe(
        'ST_DWithin(e.meeting_point, ST_SetSRID(ST_MakePoint(:geoRadiusLng, :geoRadiusLat), 4326)::geography, :geoRadiusMeters)',
      );
      expect(fragment.parameters).toEqual({
        geoRadiusLng: 100.5018,
        geoRadiusLat: 13.7563,
        geoRadiusMeters: 5000,
      });
    });

    it('namespaces parameters with a custom prefix so two fragments can coexist', () => {
      const a = geo.withinRadius('a.location', { latitude: 1, longitude: 2 }, 100, 'a');
      const b = geo.withinRadius('b.location', { latitude: 3, longitude: 4 }, 200, 'b');
      const combinedParamNames = new Set([...Object.keys(a.parameters), ...Object.keys(b.parameters)]);
      expect(combinedParamNames.size).toBe(6); // no collisions between the two fragments
    });

    it('rejects a non-positive radius', () => {
      expect(() => geo.withinRadius('e.meeting_point', { latitude: 0, longitude: 0 }, 0)).toThrow(RangeError);
      expect(() => geo.withinRadius('e.meeting_point', { latitude: 0, longitude: 0 }, -5)).toThrow(RangeError);
    });
  });

  describe('withinBoundingBox', () => {
    it('produces a parameterised ST_Intersects/ST_MakeEnvelope fragment', () => {
      const fragment = geo.withinBoundingBox(
        'p.location',
        { latitude: 13.5, longitude: 100.3 },
        { latitude: 14.0, longitude: 100.9 },
      );
      expect(fragment.sql).toBe(
        'ST_Intersects(p.location, ST_MakeEnvelope(:geoBboxMinLng, :geoBboxMinLat, :geoBboxMaxLng, :geoBboxMaxLat, 4326)::geography)',
      );
      expect(fragment.parameters).toEqual({
        geoBboxMinLng: 100.3,
        geoBboxMinLat: 13.5,
        geoBboxMaxLng: 100.9,
        geoBboxMaxLat: 14.0,
      });
    });

    it('rejects a degenerate or inverted box', () => {
      expect(() =>
        geo.withinBoundingBox('p.location', { latitude: 14, longitude: 100 }, { latitude: 13, longitude: 101 }),
      ).toThrow(RangeError);
      expect(() =>
        geo.withinBoundingBox('p.location', { latitude: 13, longitude: 101 }, { latitude: 14, longitude: 100 }),
      ).toThrow(RangeError);
    });
  });

  describe('point', () => {
    it('delegates to geoPoint', () => {
      expect(geo.point(1, 2)).toEqual({ type: 'Point', coordinates: [2, 1] });
    });
  });
});
