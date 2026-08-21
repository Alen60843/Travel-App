import { assertEligibleDateOfBirth, InvalidDateOfBirthError, MinimumAgeError } from './age';

const NOW = new Date('2026-08-21T00:00:00.000Z');

describe('assertEligibleDateOfBirth', () => {
  it('rejects a traveller who turns 18 tomorrow', () => {
    expect(() => assertEligibleDateOfBirth('2008-08-22', NOW)).toThrow(MinimumAgeError);
  });

  it('accepts exactly 18 and older dates', () => {
    expect(() => assertEligibleDateOfBirth('2008-08-21', NOW)).not.toThrow();
    expect(() => assertEligibleDateOfBirth('1980-01-01', NOW)).not.toThrow();
  });

  it.each(['2027-01-01', '2026-02-30', '21-08-2000', 'not-a-date'])(
    'rejects invalid or future date %s',
    (value) => {
      expect(() => assertEligibleDateOfBirth(value, NOW)).toThrow(InvalidDateOfBirthError);
    },
  );

  it('uses UTC date boundaries consistently across New Year midnight', () => {
    expect(() =>
      assertEligibleDateOfBirth(
        '2008-01-01',
        new Date('2025-12-31T23:59:59.999Z'),
      ),
    ).toThrow(MinimumAgeError);
    expect(() =>
      assertEligibleDateOfBirth(
        '2008-01-01',
        new Date('2026-01-01T00:00:00.000Z'),
      ),
    ).not.toThrow();
  });

  it('treats a 29 February birthday as occurring on 1 March in non-leap years', () => {
    expect(() =>
      assertEligibleDateOfBirth('2004-02-29', new Date('2022-02-28T23:59:59.999Z')),
    ).toThrow(MinimumAgeError);
    expect(() =>
      assertEligibleDateOfBirth('2004-02-29', new Date('2022-03-01T00:00:00.000Z')),
    ).not.toThrow();
  });
});
