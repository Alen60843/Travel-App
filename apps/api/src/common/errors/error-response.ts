/**
 * The single response shape for every failure the API produces.
 *
 * One shape means clients write one error handler. `correlationId` is echoed so
 * a user-reported failure can be found in the logs without guesswork.
 */
export interface ErrorResponse {
  readonly error: {
    readonly code: string;
    readonly message: string;
    readonly correlationId: string;
    readonly timestamp: string;
    readonly details?: Readonly<Record<string, unknown>>;
  };
}

export function buildErrorResponse(params: {
  code: string;
  message: string;
  correlationId: string;
  details?: Readonly<Record<string, unknown>>;
}): ErrorResponse {
  return {
    error: {
      code: params.code,
      message: params.message,
      correlationId: params.correlationId,
      timestamp: new Date().toISOString(),
      ...(params.details ? { details: params.details } : {}),
    },
  };
}
