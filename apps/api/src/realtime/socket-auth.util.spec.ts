import type { Socket } from 'socket.io';

import { extractHandshakeToken } from './socket-auth.util';

function fakeHandshake(overrides: {
  auth?: Record<string, unknown>;
  authorization?: string;
}): Socket['handshake'] {
  return {
    headers: overrides.authorization ? { authorization: overrides.authorization } : {},
    time: new Date().toISOString(),
    address: '127.0.0.1',
    xdomain: false,
    secure: false,
    issued: Date.now(),
    url: '/socket.io/',
    query: {},
    auth: overrides.auth ?? {},
  } as unknown as Socket['handshake'];
}

describe('extractHandshakeToken', () => {
  it('prefers handshake.auth.token', () => {
    const handshake = fakeHandshake({ auth: { token: 'from-auth' }, authorization: 'Bearer from-header' });

    expect(extractHandshakeToken(handshake)).toBe('from-auth');
  });

  it('falls back to an Authorization: Bearer header when auth.token is absent', () => {
    const handshake = fakeHandshake({ authorization: 'Bearer from-header' });

    expect(extractHandshakeToken(handshake)).toBe('from-header');
  });

  it('returns undefined when neither is present', () => {
    const handshake = fakeHandshake({});

    expect(extractHandshakeToken(handshake)).toBeUndefined();
  });

  it('ignores a non-Bearer Authorization header', () => {
    const handshake = fakeHandshake({ authorization: 'Basic dXNlcjpwYXNz' });

    expect(extractHandshakeToken(handshake)).toBeUndefined();
  });

  it('ignores an empty auth.token and falls back to the header', () => {
    const handshake = fakeHandshake({ auth: { token: '' }, authorization: 'Bearer from-header' });

    expect(extractHandshakeToken(handshake)).toBe('from-header');
  });
});
