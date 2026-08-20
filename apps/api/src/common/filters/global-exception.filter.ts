import type { ArgumentsHost, ExceptionFilter, LoggerService } from '@nestjs/common';
import { Catch, HttpException, Inject, Injectable } from '@nestjs/common';

import { LOGGER } from '../../observability/tokens';
import { getCorrelationId } from '../correlation';
import { AppError } from '../errors/app-error';
import { buildErrorResponse } from '../errors/error-response';
import type { HttpRequestLike, HttpResponseLike } from '../http.types';
import { httpStatusToCode } from './http-status-to-code';

interface Resolved {
  readonly status: number;
  readonly code: string;
  readonly message: string;
  readonly details?: Record<string, unknown>;
  /** Extra fields for the server-side log line only — never sent to the client. */
  readonly logMeta?: Record<string, unknown>;
}

/**
 * Converts every thrown value into the single `ErrorResponse` shape.
 *
 * - `AppError` (and subclasses: NotFoundError, ConflictError, ...) → its own
 *   `code`/`status`/`details`, all of which are already client-safe by
 *   construction (see app-error.ts).
 * - Nest `HttpException` (guards, the validation pipe, framework-thrown
 *   errors) → mapped to a stable code via status (see http-status-to-code.ts).
 * - Anything else (a bare `Error`, a driver exception, a typo'd `throw
 *   'string'`) → generic 500 `INTERNAL_ERROR`. The real message and stack
 *   are logged server-side at `error` level with the correlation id; the
 *   client only ever sees the generic message. This is the one enforcement
 *   point for "never leak stack traces / SQL / driver messages" — it does
 *   not rely on every call site remembering not to leak.
 */
@Catch()
@Injectable()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(@Inject(LOGGER) private readonly logger: LoggerService) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() !== 'http') {
      // WebSocket/RPC transports have their own response shape and are
      // handled by their own filters (see src/realtime/**); this filter only
      // formats HTTP responses.
      this.logger.error(
        'Unhandled exception outside HTTP context',
        exception instanceof Error ? exception.stack : undefined,
        'GlobalExceptionFilter',
      );
      return;
    }

    const ctx = host.switchToHttp();
    const response = ctx.getResponse<HttpResponseLike>();
    const request = ctx.getRequest<HttpRequestLike>();
    const correlationId = getCorrelationId();
    const resolved = this.resolve(exception);

    this.logger.error(
      `${request.method} ${request.url} -> ${resolved.status} ${resolved.code}`,
      exception instanceof Error ? exception.stack : undefined,
      'GlobalExceptionFilter',
      { correlationId, code: resolved.code, ...(resolved.logMeta ?? {}) },
    );

    const body = buildErrorResponse({
      code: resolved.code,
      message: resolved.message,
      correlationId,
      ...(resolved.details ? { details: resolved.details } : {}),
    });

    response.status(resolved.status).json(body);
  }

  private resolve(exception: unknown): Resolved {
    if (exception instanceof AppError) {
      return {
        status: exception.status,
        code: exception.code,
        message: exception.message,
        ...(exception.details ? { details: exception.details } : {}),
      };
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const body = exception.getResponse();
      const rawMessage =
        typeof body === 'string'
          ? body
          : ((body as { message?: unknown } | null)?.message ?? exception.message);
      const message = Array.isArray(rawMessage) ? rawMessage.join('; ') : String(rawMessage);
      return { status, code: httpStatusToCode(status), message };
    }

    return {
      status: 500,
      code: 'INTERNAL_ERROR',
      message: 'An unexpected error occurred.',
      logMeta:
        exception instanceof Error
          ? { originalMessage: exception.message }
          : { exception: String(exception) },
    };
  }
}
