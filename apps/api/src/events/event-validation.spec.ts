import { EventVisibility } from '@tripwith/shared';

import { InvalidEventValueError } from './events.errors';
import {
  assertEventMoney,
  assertEventTrustScore,
  assertEventVisibility,
  assertOrderedEventTimes,
  normaliseEventCurrency,
  normaliseEventTitle,
  normaliseOptionalEventText,
  parseEventTimestamp,
} from './event-validation';

describe('Event validation', () => {
  it('accepts exact offset timestamps and rejects invalid calendar values', () => {
    expect(parseEventTimestamp('2090-02-28T10:30:00+02:00', 'startsAt').toISOString()).toBe(
      '2090-02-28T08:30:00.000Z',
    );
    expect(() => parseEventTimestamp('2090-02-30T10:30:00Z', 'startsAt')).toThrow(
      InvalidEventValueError,
    );
    expect(() => parseEventTimestamp('2090-02-28T10:30:00', 'startsAt')).toThrow(
      InvalidEventValueError,
    );
  });

  it('requires a strictly ordered timestamp range', () => {
    const start = new Date('2090-01-01T10:00:00Z');
    expect(() => assertOrderedEventTimes(start, new Date('2090-01-01T11:00:00Z'))).not.toThrow();
    expect(() => assertOrderedEventTimes(start, new Date('2090-01-01T10:00:00Z'))).toThrow(
      InvalidEventValueError,
    );
  });

  it('normalizes text without inventing a database-absent maximum', () => {
    expect(normaliseEventTitle('  Night market walk  ')).toBe('Night market walk');
    expect(normaliseOptionalEventText('   ', 'description')).toBeNull();
    expect(normaliseOptionalEventText('  Meet outside  ', 'meetingPointLabel')).toBe(
      'Meet outside',
    );
    expect(() => normaliseEventTitle(' x ')).toThrow(InvalidEventValueError);
    expect(() => normaliseOptionalEventText('bad\0text', 'description')).toThrow(
      InvalidEventValueError,
    );
  });

  it('mirrors money, currency, trust and visibility constraints', () => {
    expect(() => assertEventMoney(5_000, 1_500)).not.toThrow();
    expect(() => assertEventMoney(1_000, 1_001)).toThrow(InvalidEventValueError);
    expect(normaliseEventCurrency(' EUR ')).toBe('EUR');
    expect(() => normaliseEventCurrency('eur')).toThrow(InvalidEventValueError);
    expect(() => assertEventTrustScore(7.25)).not.toThrow();
    expect(() => assertEventTrustScore(7.251)).toThrow(InvalidEventValueError);
    expect(() => assertEventVisibility(EventVisibility.Unlisted)).not.toThrow();
    expect(() => assertEventVisibility('FRIENDS')).toThrow(InvalidEventValueError);
  });
});
