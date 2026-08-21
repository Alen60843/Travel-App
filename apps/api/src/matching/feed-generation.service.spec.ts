import type { CacheService } from '../redis/cache.service';
import { FeedGenerationService } from './feed-generation.service';

describe('FeedGenerationService', () => {
  const cache = {
    get: jest.fn(),
    increment: jest.fn(),
  } as unknown as CacheService;
  const service = new FeedGenerationService(cache);

  beforeEach(() => jest.clearAllMocks());

  it('uses zero before the first mutation and builds the approved cache key', async () => {
    jest.mocked(cache.get).mockResolvedValue(null);
    await expect(service.current('viewer')).resolves.toBe(0);
    expect(service.rankingKey('viewer', 0, 'abc')).toBe('feed:v0:viewer:abc');
    expect(service.rankingKey('viewer', 0, 'abc', 'next')).toBe(
      'feed:v0:viewer:abc:next',
    );
  });

  it('atomically bumps the viewer generation', async () => {
    jest.mocked(cache.increment).mockResolvedValue(4);
    await expect(service.bump('viewer')).resolves.toBe(4);
    expect(cache.increment).toHaveBeenCalledWith('feed:gen:viewer');
  });

  it('hashes filters independently of object insertion order', () => {
    expect(service.filterHash({ radius: 10, country: 'JP' })).toBe(
      service.filterHash({ country: 'JP', radius: 10 }),
    );
  });
});
