import { BadRequestException, HttpException, type ArgumentsHost, type LoggerService } from '@nestjs/common';

import { runWithCorrelation } from '../correlation';
import { ConflictError, NotFoundError } from '../errors/app-error';
import type { ErrorResponse } from '../errors/error-response';
import type { HttpRequestLike, HttpResponseLike } from '../http.types';
import { GlobalExceptionFilter } from './global-exception.filter';

function fakeHost(req: HttpRequestLike, res: HttpResponseLike): ArgumentsHost {
  return {
    getType: () => 'http',
    switchToHttp: () => ({
      getRequest: () => req,
      getResponse: () => res,
      getNext: () => undefined,
    }),
  } as unknown as ArgumentsHost;
}

function fakeResponse(): HttpResponseLike & { statusCode: number; body: unknown } {
  return {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(b: unknown) {
      this.body = b;
      return this;
    },
    setHeader() {
      return this;
    },
  };
}

function fakeLogger(): LoggerService {
  return { log: jest.fn(), error: jest.fn(), warn: jest.fn() };
}

const req: HttpRequestLike = { method: 'GET', url: '/things/1', headers: {} };

describe('GlobalExceptionFilter', () => {
  it('maps an AppError to its own code/status/details', () => {
    const filter = new GlobalExceptionFilter(fakeLogger());
    const res = fakeResponse();

    filter.catch(new NotFoundError('Trip', { tripId: 't-1' }), fakeHost(req, res));

    expect(res.statusCode).toBe(404);
    const body = res.body as ErrorResponse;
    expect(body.error.code).toBe('RESOURCE_NOT_FOUND');
    expect(body.error.message).toBe('Trip not found');
    expect(body.error.details).toEqual({ tripId: 't-1' });
  });

  it('maps a ConflictError to 409', () => {
    const filter = new GlobalExceptionFilter(fakeLogger());
    const res = fakeResponse();

    filter.catch(new ConflictError('DUPLICATE_INVITE', 'Invite already exists'), fakeHost(req, res));

    expect(res.statusCode).toBe(409);
    expect((res.body as ErrorResponse).error.code).toBe('DUPLICATE_INVITE');
  });

  it('maps a Nest HttpException to a sensible stable code', () => {
    const filter = new GlobalExceptionFilter(fakeLogger());
    const res = fakeResponse();

    filter.catch(new HttpException('Forbidden resource', 403), fakeHost(req, res));

    expect(res.statusCode).toBe(403);
    expect((res.body as ErrorResponse).error.code).toBe('FORBIDDEN');
    expect((res.body as ErrorResponse).error.message).toBe('Forbidden resource');
  });

  it('joins an array-style class-validator message body into one message', () => {
    const filter = new GlobalExceptionFilter(fakeLogger());
    const res = fakeResponse();

    filter.catch(new BadRequestException(['field a is required', 'field b must be a number']), fakeHost(req, res));

    expect(res.statusCode).toBe(400);
    expect((res.body as ErrorResponse).error.message).toContain('field a is required');
    expect((res.body as ErrorResponse).error.message).toContain('field b must be a number');
  });

  it('echoes the active correlation id into the response body', () => {
    const filter = new GlobalExceptionFilter(fakeLogger());
    const res = fakeResponse();

    runWithCorrelation({ correlationId: 'req-corr-42' }, () => {
      filter.catch(new NotFoundError('Trip'), fakeHost(req, res));
    });

    expect((res.body as ErrorResponse).error.correlationId).toBe('req-corr-42');
  });

  describe('unexpected errors — no internal detail ever reaches the client', () => {
    it('maps a bare Error to a generic 500 without leaking its message or stack', () => {
      const filter = new GlobalExceptionFilter(fakeLogger());
      const res = fakeResponse();
      const sensitive =
        'FATAL: password authentication failed for user "tripwith" at 10.0.4.12:5432 SELECT * FROM users WHERE token_hash=...';

      filter.catch(new Error(sensitive), fakeHost(req, res));

      expect(res.statusCode).toBe(500);
      const body = res.body as ErrorResponse;
      expect(body.error.code).toBe('INTERNAL_ERROR');

      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain(sensitive);
      expect(serialized).not.toContain('password authentication failed');
      expect(serialized).not.toContain('SELECT');
      expect(serialized).not.toContain('10.0.4.12');
      expect(body.error.message).toBe('An unexpected error occurred.');
    });

    it('logs the real detail server-side at error level with the correlation id', () => {
      const logger = fakeLogger();
      const filter = new GlobalExceptionFilter(logger);
      const res = fakeResponse();

      runWithCorrelation({ correlationId: 'corr-for-log' }, () => {
        filter.catch(new Error('the real internal reason'), fakeHost(req, res));
      });

      expect(logger.error).toHaveBeenCalled();
      const [, , , meta] = (logger.error as jest.Mock).mock.calls[0] as unknown[];
      expect(meta).toMatchObject({ correlationId: 'corr-for-log', code: 'INTERNAL_ERROR' });
    });

    it('treats a thrown non-Error value the same way', () => {
      const filter = new GlobalExceptionFilter(fakeLogger());
      const res = fakeResponse();

      // eslint-disable-next-line @typescript-eslint/only-throw-error
      filter.catch('a plain string throw', fakeHost(req, res));

      expect(res.statusCode).toBe(500);
      expect((res.body as ErrorResponse).error.code).toBe('INTERNAL_ERROR');
    });
  });
});
