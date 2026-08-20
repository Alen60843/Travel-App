/**
 * Stable machine-readable codes for HTTP statuses that don't originate from
 * an `AppError` (e.g. a bare Nest `HttpException`, or a guard throwing
 * `UnauthorizedException`). Clients branch on `code`, not on `message` or
 * the raw status — keeping this mapping small and explicit means a new
 * status always gets a deliberate code rather than an ad-hoc string.
 */
const STATUS_CODES: Readonly<Record<number, string>> = {
  400: 'BAD_REQUEST',
  401: 'UNAUTHORIZED',
  403: 'FORBIDDEN',
  404: 'NOT_FOUND',
  405: 'METHOD_NOT_ALLOWED',
  408: 'REQUEST_TIMEOUT',
  409: 'CONFLICT',
  410: 'GONE',
  413: 'PAYLOAD_TOO_LARGE',
  415: 'UNSUPPORTED_MEDIA_TYPE',
  422: 'VALIDATION_FAILED',
  429: 'TOO_MANY_REQUESTS',
  500: 'INTERNAL_ERROR',
  501: 'NOT_IMPLEMENTED',
  502: 'BAD_GATEWAY',
  503: 'SERVICE_UNAVAILABLE',
  504: 'GATEWAY_TIMEOUT',
};

export function httpStatusToCode(status: number): string {
  return STATUS_CODES[status] ?? 'HTTP_ERROR';
}
