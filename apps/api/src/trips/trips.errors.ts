import { AppError } from '../common/errors/app-error';

export class TripNotFoundError extends AppError {
  constructor() {
    // Deliberately identical for a missing trip and another user's trip.
    super('TRIP_NOT_FOUND', 'Trip not found.', 404);
  }
}

export class TripSegmentNotFoundError extends AppError {
  constructor() {
    super('TRIP_SEGMENT_NOT_FOUND', 'Trip segment not found.', 404);
  }
}

export class TripValueError extends AppError {
  constructor(code: string, message: string, field?: string) {
    super(code, message, 422, field ? { field } : undefined);
  }
}

export class InvalidTripDateError extends TripValueError {
  constructor(field: string) {
    super('TRIP_DATE_INVALID', 'Trip dates must be valid YYYY-MM-DD calendar dates.', field);
  }
}

export class InvalidTripDateRangeError extends TripValueError {
  constructor() {
    super('TRIP_DATE_RANGE_INVALID', 'The end date must not precede the start date.');
  }
}

export class SegmentOutsideTripError extends TripValueError {
  constructor() {
    super(
      'TRIP_SEGMENT_OUTSIDE_TRIP',
      'Segment dates must be fully contained within the parent trip dates.',
    );
  }
}

export class InvalidSegmentOrderError extends TripValueError {
  constructor() {
    super('TRIP_SEGMENT_ORDER_INVALID', 'Segment sortOrder is outside the valid insertion range.', 'sortOrder');
  }
}

export class InvalidTripMetadataError extends TripValueError {
  constructor() {
    super('TRIP_METADATA_INVALID', 'Metadata must be a JSON object containing only valid JSON values.', 'metadata');
  }
}

export class InvalidTripValueError extends TripValueError {
  constructor(field: string, message: string) {
    super('TRIP_VALUE_INVALID', message, field);
  }
}
