import { createValidationPipe } from '../../common/pipes/create-validation-pipe';
import { GetExplorerEventsQueryDto } from './get-explorer-events-query.dto';

describe('GetExplorerEventsQueryDto', () => {
  const pipe = createValidationPipe();
  const metadata = { type: 'query' as const, metatype: GetExplorerEventsQueryDto };

  it('transforms a bounded viewport query and repeated category filters', async () => {
    await expect(
      pipe.transform(
        {
          south: '-10',
          west: '170',
          north: '10',
          east: '-170',
          zoom: '8',
          limit: '50',
          categoryCodes: ['party', 'trek'],
          windowStart: '2090-01-01T00:00:00Z',
          windowEnd: '2090-02-01T00:00:00+00:00',
        },
        metadata,
      ),
    ).resolves.toMatchObject({
      south: -10,
      west: 170,
      north: 10,
      east: -170,
      zoom: 8,
      limit: 50,
      categoryCodes: ['party', 'trek'],
    });
  });

  it.each([
    [{ centerLatitude: '91', centerLongitude: '0', radiusMeters: '1000', zoom: '12' }, 'centerLatitude'],
    [{ centerLatitude: '0', centerLongitude: '181', radiusMeters: '1000', zoom: '12' }, 'centerLongitude'],
    [{ centerLatitude: '0', centerLongitude: '0', radiusMeters: '99', zoom: '12' }, 'radiusMeters'],
    [{ centerLatitude: '0', centerLongitude: '0', radiusMeters: '500001', zoom: '12' }, 'radiusMeters'],
    [{ south: '0', west: '0', north: '1', east: '1', zoom: '0' }, 'zoom'],
    [{ south: '0', west: '0', north: '1', east: '1', zoom: '12', limit: '201' }, 'limit'],
    [{ south: '0', west: '0', north: '1', east: '1', zoom: '12', categoryCodes: ['trek', 'trek'] }, 'categoryCodes'],
    [{ south: '0', west: '0', north: '1', east: '1', zoom: '12', categoryCodes: 'NOT VALID' }, 'categoryCodes'],
    [{ south: '0', west: '0', north: '1', east: '1', zoom: '12', windowStart: '2090-01-01T00:00:00' }, 'windowStart'],
  ])('rejects malformed or abusive query %#', async (query, field) => {
    await expect(pipe.transform(query, metadata)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
  });

  it('rejects a client-supplied userId through the global whitelist', async () => {
    await expect(
      pipe.transform(
        { south: '0', west: '0', north: '1', east: '1', zoom: '12', userId: 'attacker' },
        metadata,
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });
});
