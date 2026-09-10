import { AppError } from '../common/errors/app-error';

const errors = {
  JOIN_REQUEST_NOT_FOUND: [404, 'Join request not found.'],
  JOIN_REQUEST_NOT_PENDING: [409, 'Only a pending request can be changed.'],
  JOIN_REQUEST_EXPIRED: [409, 'The join request has expired.'],
  JOIN_REQUEST_ALREADY_EXISTS: [409, 'A live join request already exists.'],
  EVENT_ALREADY_JOINED: [409, 'An active participation already exists.'],
  EVENT_CAPACITY_REACHED: [409, 'The Event has no available seats.'],
  EVENT_NOT_JOINABLE: [409, 'The Event is not available for joining.'],
  EVENT_SELF_JOIN: [422, 'The host cannot request to join their own Event.'],
  EVENT_TRUST_REQUIRED: [403, 'The Event trust requirement is not met.'],
  JOIN_ACCOUNT_UNAVAILABLE: [403, 'This account cannot join Events.'],
  PAID_JOIN_NOT_AVAILABLE: [409, 'Joining Events with a deposit is not available yet.'],
} as const;

export function joinError(code: keyof typeof errors): AppError {
  const [status, message] = errors[code];
  return new AppError(code, message, status);
}

/** Only known database invariants become client-visible conflicts. */
export function translateJoinConflict(error: unknown): unknown {
  const driver = (error as { driverError?: { code?: string; constraint?: string } })?.driverError;
  if (driver?.code === '23505') {
    if (driver.constraint === 'event_join_requests_active_uk') {
      return joinError('JOIN_REQUEST_ALREADY_EXISTS');
    }
    if (driver.constraint === 'event_participants_active_uk' ||
        driver.constraint === 'event_participants_join_request_uk') {
      return joinError('EVENT_ALREADY_JOINED');
    }
  }
  if (driver?.code === '23514' && driver.constraint === 'events_capacity_not_exceeded_chk') {
    return joinError('EVENT_CAPACITY_REACHED');
  }
  return error;
}
