import { Injectable, type NestMiddleware } from '@nestjs/common';

import { CORRELATION_HEADER, normalizeCorrelationId, runWithCorrelation } from '../correlation';
import type { HttpRequestLike, HttpResponseLike } from '../http.types';

/**
 * Establishes request correlation for the whole pipeline.
 *
 * Reads `x-correlation-id` from the client (validated — an attacker-supplied
 * header must not end up unescaped in every downstream log line), runs the
 * rest of the request inside `runWithCorrelation` so every log line and
 * error response for this request carries the same id via AsyncLocalStorage,
 * and echoes the (possibly newly-generated) id back on the response so a
 * caller who didn't send one can still find this request in the logs.
 *
 * Registered first in the middleware chain (see main.ts) so it wraps
 * everything else, including the exception filter.
 */
@Injectable()
export class CorrelationMiddleware implements NestMiddleware {
  use(req: HttpRequestLike, res: HttpResponseLike, next: (error?: unknown) => void): void {
    const headerValue = req.headers[CORRELATION_HEADER];
    const candidate = Array.isArray(headerValue) ? headerValue[0] : headerValue;
    const correlationId = normalizeCorrelationId(candidate);

    res.setHeader(CORRELATION_HEADER, correlationId);

    runWithCorrelation({ correlationId }, () => next());
  }
}
