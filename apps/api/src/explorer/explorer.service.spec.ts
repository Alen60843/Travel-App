import { EventStatus } from '@tripwith/shared';

import type { ExplorerRepository } from './explorer.repository';
import { ExplorerService } from './explorer.service';

const USER_ID = '00000000-0000-4000-8000-000000000001';
const NOW = new Date('2089-12-20T00:00:00Z');

describe('ExplorerService', () => {
  let repository: jest.Mocked<ExplorerRepository>;
  let service: ExplorerService;

  beforeEach(() => {
    repository = {
      findKnownCategoryCodes: jest.fn().mockResolvedValue(['trek']),
      findDiscoverableMarkers: jest.fn().mockResolvedValue({
        eventCount: 1,
        markers: [
          {
            kind: 'event',
            id: '00000000-0000-4000-8000-000000000010',
            title: 'Map event',
            status: EventStatus.Active,
            coordinate: { latitude: 31.76, longitude: 35.21 },
            category: { code: 'trek', label: 'Trek', icon: 'mountain' },
            startsAt: '2090-01-01T00:00:00.000Z',
            endsAt: '2090-01-01T01:00:00.000Z',
            meetingPointLabel: 'Trail head',
          },
        ],
      }),
    } as unknown as jest.Mocked<ExplorerRepository>;
    service = new ExplorerService(repository);
  });

  it('normalizes the authenticated discovery query and returns individual pins at high zoom', async () => {
    const result = await service.discoverEvents(
      USER_ID,
      {
        centerLatitude: 31.76,
        centerLongitude: 35.21,
        radiusMeters: 20_000,
        zoom: 18,
        categoryCodes: ['trek'],
      },
      NOW,
    );
    expect(repository.findKnownCategoryCodes).toHaveBeenCalledWith(['trek']);
    expect(repository.findDiscoverableMarkers).toHaveBeenCalledWith(
      expect.objectContaining({
        spatial: expect.objectContaining({ kind: 'radius', radiusMeters: 20_000 }),
        windowStart: NOW,
        categoryCodes: ['trek'],
      }),
    );
    expect(result).toMatchObject({ spatialMode: 'radius', eventCount: 1 });
    expect(result.markers[0]).toMatchObject({ kind: 'event', title: 'Map event' });
  });

  it('rejects unknown editorial categories before running discovery SQL', async () => {
    repository.findKnownCategoryCodes.mockResolvedValue([]);
    await expect(
      service.discoverEvents(
        USER_ID,
        { south: 30, west: 34, north: 33, east: 36, zoom: 10, categoryCodes: ['invented'] },
        NOW,
      ),
    ).rejects.toMatchObject({
      code: 'EXPLORER_QUERY_INVALID',
      details: { field: 'categoryCodes' },
    });
    expect(repository.findDiscoverableMarkers).not.toHaveBeenCalled();
  });
});
