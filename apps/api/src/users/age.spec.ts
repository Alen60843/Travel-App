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
});

