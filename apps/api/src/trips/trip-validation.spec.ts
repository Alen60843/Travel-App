import {
  InvalidTripDateError,
  InvalidTripDateRangeError,
  InvalidTripMetadataError,
  SegmentOutsideTripError,
} from './trips.errors';
import {
  assertIsoCalendarDate,
  assertOrderedRange,
  assertSegmentContained,
  normaliseBoundedText,
  normaliseMetadata,
} from './trip-validation';

describe('trip validation', () => {
  it.each(['2028-02-29', '2026-08-20', '0001-01-01'])('accepts exact calendar date %s', (date) => {
    expect(() => assertIsoCalendarDate(date, 'startDate')).not.toThrow();
  });

  it.each(['2026-2-01', '2026-02-30', '2025-02-29', '0000-01-01', '2026-13-01'])(
    'rejects invalid or non-exact calendar date %s',
    (date) => {
      expect(() => assertIsoCalendarDate(date, 'startDate')).toThrow(InvalidTripDateError);
    },
  );

  it('treats a same-day trip as an ordered inclusive range', () => {
    expect(() => assertOrderedRange({ start: '2026-08-20', end: '2026-08-20' })).not.toThrow();
  });

  it('rejects reversed ranges', () => {
    expect(() => assertOrderedRange({ start: '2026-08-21', end: '2026-08-20' })).toThrow(
      InvalidTripDateRangeError,
    );
  });

  it.each([
    ['2026-08-20', '2026-08-20'],
    ['2026-08-20', '2026-08-25'],
    ['2026-08-25', '2026-08-31'],
    ['2026-08-21', '2026-08-30'],
  ])('accepts contained inclusive segment %s through %s', (start, end) => {
    expect(() =>
      assertSegmentContained(
        { start, end },
        { start: '2026-08-20', end: '2026-08-31' },
      ),
    ).not.toThrow();
  });

  it.each([
    ['2026-08-19', '2026-08-20'],
    ['2026-08-31', '2026-09-01'],
  ])('rejects segment %s through %s outside the parent', (start, end) => {
    expect(() =>
      assertSegmentContained(
        { start, end },
        { start: '2026-08-20', end: '2026-08-31' },
      ),
    ).toThrow(SegmentOutsideTripError);
  });

  it('trims bounded display text and rejects PostgreSQL-invalid NULs', () => {
    expect(normaliseBoundedText('  Tokyo  ', 'destinationName', 1, 160)).toBe('Tokyo');
    expect(() => normaliseBoundedText('Tok\0yo', 'destinationName', 1, 160)).toThrow();
  });

  it('accepts detached JSON-object metadata and rejects non-JSON values', () => {
    const input = { note: 'hello', route: [1, true, null, { mode: 'rail' }] };
    const result = normaliseMetadata(input);
    expect(result).toEqual(input);
    expect(result).not.toBe(input);
    expect(() => normaliseMetadata([])).toThrow(InvalidTripMetadataError);
    expect(() => normaliseMetadata({ value: Number.NaN })).toThrow(InvalidTripMetadataError);
    expect(() => normaliseMetadata({ value: undefined })).toThrow(InvalidTripMetadataError);
  });
});
