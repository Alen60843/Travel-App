import type { ExecutionContext } from '@nestjs/common';

import { AuthErrorCode, revokedTokenError } from './auth.errors';
import type {
  AuthenticatedHttpRequest,
  FirebaseTokenVerifier,
  VerifiedFirebaseIdentity,
} from './auth.types';
import { FirebaseAuthGuard, RevocationCheckedFirebaseAuthGuard } from './firebase-auth.guard';

const identity: VerifiedFirebaseIdentity = {
  firebaseUid: 'firebase-user-1',
  email: 'traveller@example.com',
  emailVerified: true,
  authTime: new Date('2026-08-21T00:00:00.000Z'),
};

function context(request: AuthenticatedHttpRequest): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('Firebase HTTP guards', () => {
  let verifyIdToken: jest.Mock;
  let verifier: FirebaseTokenVerifier;

  beforeEach(() => {
    verifyIdToken = jest.fn().mockResolvedValue(identity);
    verifier = { verifyIdToken };
  });

  it('accepts one Bearer token, attaches identity, and disables revocation lookup normally', async () => {
    const request: AuthenticatedHttpRequest = {
      headers: { authorization: 'Bearer signed.id.token' },
    };
    await expect(new FirebaseAuthGuard(verifier).canActivate(context(request))).resolves.toBe(true);
    expect(request.firebaseIdentity).toBe(identity);
    expect(verifyIdToken).toHaveBeenCalledWith('signed.id.token', false);
  });

  it('returns a stable missing-token error', async () => {
    const request: AuthenticatedHttpRequest = { headers: {} };
    await expect(new FirebaseAuthGuard(verifier).canActivate(context(request))).rejects.toMatchObject({
      code: AuthErrorCode.TokenMissing,
      status: 401,
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it.each([
    '',
    'token-only',
    'Basic abc',
    'Bearer',
    'Bearer  abc',
    'Bearer abc def',
    ' Bearer abc',
    ['Bearer abc'],
  ])('rejects malformed or ambiguous Authorization input: %#', async (authorization) => {
    const request: AuthenticatedHttpRequest = { headers: { authorization } };
    await expect(new FirebaseAuthGuard(verifier).canActivate(context(request))).rejects.toMatchObject({
      code: AuthErrorCode.BearerMalformed,
      status: 401,
    });
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('uses Firebase revocation checking only on the explicit guard', async () => {
    verifyIdToken.mockRejectedValue(revokedTokenError());
    const request: AuthenticatedHttpRequest = {
      headers: { authorization: 'Bearer revoked-token' },
    };
    await expect(
      new RevocationCheckedFirebaseAuthGuard(verifier).canActivate(context(request)),
    ).rejects.toMatchObject({ code: AuthErrorCode.TokenRevoked });
    expect(verifyIdToken).toHaveBeenCalledWith('revoked-token', true);
  });
});

