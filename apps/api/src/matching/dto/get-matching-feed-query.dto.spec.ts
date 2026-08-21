import { createValidationPipe } from '../../common/pipes/create-validation-pipe';
import { GetMatchingFeedQueryDto } from './get-matching-feed-query.dto';

describe('GetMatchingFeedQueryDto', () => {
  const pipe = createValidationPipe();
  const metadata = { type: 'query' as const, metatype: GetMatchingFeedQueryDto };

  it('validates and transforms every supported matching filter', async () => {
    await expect(pipe.transform({
      homeCountryCode: 'FR',
      nativeLanguageCode: 'es',
      minAge: '24',
      maxAge: '42',
      interestIds: ['7', '9'],
    }, metadata)).resolves.toMatchObject({
      homeCountryCode: 'FR',
      nativeLanguageCode: 'es',
      minAge: 24,
      maxAge: 42,
      interestIds: [7, 9],
    });
  });

  it.each([
    [{ homeCountryCode: 'France' }, 'homeCountryCode'],
    [{ nativeLanguageCode: 'ES' }, 'nativeLanguageCode'],
    [{ minAge: '17' }, 'minAge'],
    [{ maxAge: '121' }, 'maxAge'],
    [{ interestIds: 'not-an-id' }, 'interestIds'],
    [{ interestIds: ['1', '1'] }, 'interestIds'],
    [{ interestIds: Array.from({ length: 21 }, (_, index) => String(index + 1)) }, 'interestIds'],
  ])('rejects malformed filter input %#', async (query, field) => {
    await expect(pipe.transform(query, metadata)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      details: { fields: expect.arrayContaining([expect.objectContaining({ field })]) },
    });
  });
});
