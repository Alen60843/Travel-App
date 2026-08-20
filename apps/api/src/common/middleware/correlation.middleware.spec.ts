import { getCorrelationContext } from '../correlation';
import type { HttpRequestLike, HttpResponseLike } from '../http.types';
import { CorrelationMiddleware } from './correlation.middleware';

function fakeResponse(): HttpResponseLike & { headers: Record<string, string> } {
  const headers: Record<string, string> = {};
  return {
    headers,
    status() {
      return this;
    },
    json() {
      return this;
    },
    setHeader(name: string, value: string) {
      headers[name.toLowerCase()] = value;
      return this;
    },
  };
}

describe('CorrelationMiddleware', () => {
  const middleware = new CorrelationMiddleware();

  it('generates a correlation id when the client sends none', () => {
    const req = { method: 'GET', url: '/x', headers: {} } as HttpRequestLike;
    const res = fakeResponse();
    let observed: string | undefined;

    middleware.use(req, res, () => {
      observed = getCorrelationContext()?.correlationId;
    });

    expect(observed).toBeDefined();
    expect(res.headers['x-correlation-id']).toBe(observed);
  });

  it('accepts a well-formed client-supplied correlation id and echoes it back', () => {
    const clientId = 'client-supplied-id-123';
    const req = { method: 'GET', url: '/x', headers: { 'x-correlation-id': clientId } } as HttpRequestLike;
    const res = fakeResponse();
    let observed: string | undefined;

    middleware.use(req, res, () => {
      observed = getCorrelationContext()?.correlationId;
    });

    expect(observed).toBe(clientId);
    expect(res.headers['x-correlation-id']).toBe(clientId);
  });

  it('rejects a malformed client-supplied id and generates a fresh one instead', () => {
    const req = {
      method: 'GET',
      url: '/x',
      headers: { 'x-correlation-id': 'not valid! contains spaces and punctuation' },
    } as HttpRequestLike;
    const res = fakeResponse();
    let observed: string | undefined;

    middleware.use(req, res, () => {
      observed = getCorrelationContext()?.correlationId;
    });

    expect(observed).toBeDefined();
    expect(observed).not.toBe('not valid! contains spaces and punctuation');
  });

  it('makes the correlation context unavailable outside the request scope', () => {
    expect(getCorrelationContext()).toBeUndefined();
  });
});
