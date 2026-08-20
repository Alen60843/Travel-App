import pino, { type DestinationStream } from 'pino';

import { getCorrelationContext, runWithCorrelation } from '../common/correlation';
import { PinoLoggerService } from './pino-logger.service';
import { REDACT_CENSOR, REDACT_PATHS } from './redact-paths';

/** Captures every line pino writes so assertions can inspect the parsed JSON. */
function capturingStream(): { stream: DestinationStream; lines: () => Record<string, unknown>[] } {
  const raw: string[] = [];
  return {
    stream: { write: (msg: string) => raw.push(msg) },
    lines: () => raw.map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** Builds a logger using the exact redact/mixin config the app ships with. */
function makeLogger(): { logger: PinoLoggerService; lines: () => Record<string, unknown>[] } {
  const { stream, lines } = capturingStream();
  const p = pino(
    {
      level: 'trace',
      redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
      mixin() {
        const corr = getCorrelationContext();
        if (!corr) return {};
        return corr.userId
          ? { correlationId: corr.correlationId, userId: corr.userId }
          : { correlationId: corr.correlationId };
      },
    },
    stream,
  );
  return { logger: new PinoLoggerService(p), lines };
}

describe('PinoLoggerService redaction', () => {
  it('redacts a top-level token-bearing object', () => {
    const { logger, lines } = makeLogger();

    logger.log('login attempt', {
      password: 'hunter2',
      token: 'abc.def.ghi',
      token_hash: 'sha256:deadbeef',
      accessToken: 'access-secret',
      userId: 'user-123',
    });

    const line = lines()[0];
    expect(line).toBeDefined();
    expect(line?.['password']).toBe(REDACT_CENSOR);
    expect(line?.['token']).toBe(REDACT_CENSOR);
    expect(line?.['token_hash']).toBe(REDACT_CENSOR);
    expect(line?.['accessToken']).toBe(REDACT_CENSOR);
    // Safe fields pass through untouched.
    expect(line?.['userId']).toBe('user-123');

    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('abc.def.ghi');
    expect(serialized).not.toContain('deadbeef');
    expect(serialized).not.toContain('access-secret');
  });

  it('redacts nested authorization/cookie headers', () => {
    const { logger, lines } = makeLogger();

    logger.log('incoming request', {
      headers: {
        authorization: 'Bearer super-secret-jwt',
        cookie: 'session=super-secret-cookie',
        'content-type': 'application/json',
      },
    });

    const line = lines()[0];
    const headers = line?.['headers'] as Record<string, unknown>;
    expect(headers['authorization']).toBe(REDACT_CENSOR);
    expect(headers['cookie']).toBe(REDACT_CENSOR);
    expect(headers['content-type']).toBe('application/json');

    const serialized = JSON.stringify(line);
    expect(serialized).not.toContain('super-secret-jwt');
    expect(serialized).not.toContain('super-secret-cookie');
  });

  it('redacts SOS share-link access tokens nested under a user object', () => {
    const { logger, lines } = makeLogger();

    logger.log('sos link resolved', {
      user: { id: 'u1', token_hash: 'sos-secret-hash', tokenHash: 'sos-secret-hash-2' },
    });

    const line = lines()[0];
    const user = line?.['user'] as Record<string, unknown>;
    expect(user['token_hash']).toBe(REDACT_CENSOR);
    expect(user['tokenHash']).toBe(REDACT_CENSOR);
    expect(user['id']).toBe('u1');
  });

  it('never leaks a token through any field in a realistic mixed payload', () => {
    const { logger, lines } = makeLogger();
    const secret = 'THIS-MUST-NEVER-APPEAR-IN-OUTPUT';

    logger.error('downstream call failed', {
      req: { headers: { authorization: `Bearer ${secret}` } },
      body: { password: secret },
      config: { password: secret },
    });

    const serialized = JSON.stringify(lines()[0]);
    expect(serialized).not.toContain(secret);
  });
});

describe('PinoLoggerService structured fields', () => {
  it('stamps the correlation id from AsyncLocalStorage onto every line', () => {
    const { logger, lines } = makeLogger();

    runWithCorrelation({ correlationId: 'corr-abc-123' }, () => {
      logger.log('inside request');
    });
    logger.log('outside request');

    const [inside, outside] = lines();
    expect(inside?.['correlationId']).toBe('corr-abc-123');
    expect(outside?.['correlationId']).toBeUndefined();
  });

  it('carries the module/context on the log line', () => {
    const { logger, lines } = makeLogger();
    const scoped = logger.forContext('OrdersService');

    scoped.log('order created', { orderId: 'order-1' });

    const line = lines()[0];
    expect(line?.['context']).toBe('OrdersService');
    expect(line?.['orderId']).toBe('order-1');
  });

  it('supports Nest error(message, trace, context) call convention', () => {
    const { logger, lines } = makeLogger();

    logger.error('boom', 'Error: boom\n    at somewhere', 'MyService');

    const line = lines()[0];
    expect(line?.['msg']).toBe('boom');
    expect(line?.['context']).toBe('MyService');
    expect(line?.['trace']).toContain('at somewhere');
  });

  it('setLogLevels raises the minimum level pino will emit', () => {
    const { logger, lines } = makeLogger();

    logger.setLogLevels(['error', 'fatal']);
    logger.debug('should be suppressed');
    logger.error('should appear');

    const emitted = lines();
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.['msg']).toBe('should appear');
  });
});
