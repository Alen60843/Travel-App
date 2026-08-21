import type { CacheService } from '../redis/cache.service';
import { FeedGenerationService } from './feed-generation.service';

describe('FeedGenerationService', () => {
  const cache = {
    get: jest.fn(),
    replace: jest.fn(),
    setIfAbsent: jest.fn(),
  } as unknown as CacheService;
  const service = new FeedGenerationService(cache);

  beforeEach(() => jest.clearAllMocks());

  it('creates a fresh opaque namespace when generation metadata is missing', async () => {
    jest.mocked(cache.get).mockResolvedValue(null);
    jest.mocked(cache.setIfAbsent).mockResolvedValue(true);
    const generation = await service.current('viewer');
    expect(generation).toMatch(/^[a-f0-9]{32}$/);
    expect(service.rankingKey('viewer', generation, 'abc')).toBe(
      `feed:v${generation}:viewer:abc`,
    );
    expect(service.rankingKey('viewer', generation, 'abc', 'next')).toBe(
      `feed:v${generation}:viewer:abc:next`,
    );
    expect(cache.setIfAbsent).toHaveBeenCalledWith('feed:gen:viewer', generation);
  });

  it('uses the winner of a concurrent missing-key claim', async () => {
    const winner = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    jest.mocked(cache.get).mockResolvedValueOnce(null).mockResolvedValueOnce(winner);
    jest.mocked(cache.setIfAbsent).mockResolvedValue(false);
    await expect(service.current('viewer')).resolves.toBe(winner);
  });

  it('replaces legacy generation metadata instead of reviving its namespace', async () => {
    jest.mocked(cache.get).mockResolvedValue(0);
    jest.mocked(cache.replace).mockResolvedValue(true);
    const generation = await service.current('viewer');
    expect(generation).toMatch(/^[a-f0-9]{32}$/);
    expect(generation).not.toBe('0');
    expect(cache.replace).toHaveBeenCalledWith('feed:gen:viewer', generation);
  });

  it('invalidates with a new opaque generation and reports Redis failure', async () => {
    jest.mocked(cache.replace).mockResolvedValueOnce(true).mockResolvedValueOnce(false);
    const generation = await service.bump('viewer');
    expect(generation).toMatch(/^[a-f0-9]{32}$/);
    await expect(service.bump('viewer')).resolves.toBeNull();
  });

  it('hashes filters independently of object insertion order', () => {
    expect(service.filterHash({ radius: 10, country: 'JP' })).toBe(
      service.filterHash({ country: 'JP', radius: 10 }),
    );
  });

  it('gives different dynamic filters different cache namespaces', () => {
    const generation = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const france = service.filterHash({
      homeCountryCode: 'FR',
      nativeLanguageCode: null,
      minAge: null,
      maxAge: null,
      interestIds: [2, 7],
    });
    const spain = service.filterHash({
      homeCountryCode: 'ES',
      nativeLanguageCode: null,
      minAge: null,
      maxAge: null,
      interestIds: [2, 7],
    });
    expect(france).not.toBe(spain);
    expect(service.rankingKey('viewer', generation, france)).not.toBe(
      service.rankingKey('viewer', generation, spain),
    );
  });
});
