import { EventStatus } from '@tripwith/shared';

import { clusterExplorerEvents } from './explorer-clustering';
import type { ExplorerEventPin } from './explorer.types';

function event(
  id: string,
  latitude: number,
  longitude: number,
  categoryCode = 'trek',
): ExplorerEventPin {
  return {
    kind: 'event',
    id,
    title: `Private-to-pin payload ${id}`,
    status: EventStatus.Active,
    coordinate: { latitude, longitude },
    category: { code: categoryCode, label: categoryCode, icon: `${categoryCode}-icon` },
    startsAt: `2090-01-0${id}T00:00:00.000Z`,
    endsAt: `2090-01-0${id}T01:00:00.000Z`,
    meetingPointLabel: `Meeting ${id}`,
  };
}

describe('clusterExplorerEvents', () => {
  it('returns individual pins at high zoom', () => {
    const second = event('2', 31.77, 35.22);
    const first = event('1', 31.76, 35.21);
    expect(clusterExplorerEvents([second, first], 18, 10)).toEqual([second, first]);
  });

  it('returns only map-safe aggregates for a populated low-zoom grid cell', () => {
    const markers = clusterExplorerEvents(
      [event('1', 31.76, 35.21), event('2', 31.77, 35.22, 'party')],
      8,
      10,
    );
    expect(markers).toEqual([
      {
        kind: 'cluster',
        id: expect.stringMatching(/^cluster:z8:s1:x\d+:y\d+$/),
        coordinate: { latitude: 31.765, longitude: 35.215 },
        eventCount: 2,
        categories: [
          { code: 'party', eventCount: 1 },
          { code: 'trek', eventCount: 1 },
        ],
      },
    ]);
    expect(markers[0]).not.toHaveProperty('title');
    expect(markers[0]).not.toHaveProperty('meetingPointLabel');
    expect(JSON.stringify(markers[0])).not.toContain('Private-to-pin payload');
  });

  it('adaptively clusters a dense high-zoom response to the result limit', () => {
    const events = Array.from({ length: 20 }, (_, index) =>
      event(String((index % 8) + 1), 30 + index / 10, 34 + index / 10),
    );
    const markers = clusterExplorerEvents(events, 18, 3);
    expect(markers.length).toBeLessThanOrEqual(3);
    expect(markers.some(({ kind }) => kind === 'cluster')).toBe(true);
  });

  it('uses a circular centroid for a cluster spanning the antimeridian', () => {
    const markers = clusterExplorerEvents(
      [event('1', 0, 179.5), event('2', 0, -179.5)],
      1,
      1,
    );
    expect(markers).toHaveLength(1);
    expect(markers[0]).toMatchObject({ kind: 'cluster', eventCount: 2 });
    expect(Math.abs(markers[0]!.coordinate.longitude)).toBe(180);
  });
});
