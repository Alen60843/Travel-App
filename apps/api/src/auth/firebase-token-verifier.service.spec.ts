import type { DecodedIdToken } from 'firebase-admin/auth';

import type { AppConfig } from '../config/configuration';
import { AuthErrorCode } from './auth.errors';
import { FirebaseAdminService } from './firebase-admin.service';
import { FirebaseTokenVerifierService } from './firebase-token-verifier.service';

const NOW_SECONDS = Math.floor(Date.now() / 1_000);

function token(overrides: Partial<DecodedIdToken> = {}): DecodedIdToken {
  return {
    aud: 'tripwith-test',
    auth_time: NOW_SECONDS - 10,
    exp: NOW_SECONDS + 3_600,
    firebase: { identities: {}, sign_in_provider: 'password' },
    iat: NOW_SECONDS - 10,
    iss: 'https://securetoken.google.com/tripwith-test',
    sub: 'firebase-user-1',
    uid: 'firebase-user-1',
    email: 'traveller@example.com',
    email_verified: true,
    ...overrides,
  } as DecodedIdToken;
}

describe(FirebaseTokenVerifierService.name, () => {
  const config = {
    firebase: { projectId: 'tripwith-test' },
  } as AppConfig;
  let admin: { verifyIdToken: jest.Mock };
  let verifier: FirebaseTokenVerifierService;

  beforeEach(() => {
    admin = { verifyIdToken: jest.fn().mockResolvedValue(token()) };
    verifier = new FirebaseTokenVerifierService(admin as unknown as FirebaseAdminService, config);
  });

  it('returns a safe identity and uses cached-key verification on the normal path', async () => {
    await expect(verifier.verifyIdToken('opaque-token', false)).resolves.toEqual({
      firebaseUid: 'firebase-user-1',
      email: 'traveller@example.com',
      emailVerified: true,
      authTime: new Date((NOW_SECONDS - 10) * 1_000),
    });
    expect(admin.verifyIdToken).toHaveBeenCalledWith('opaque-token', false);
  });

  it('passes through the explicit revocation check flag', async () => {
    await verifier.verifyIdToken('opaque-token', true);
    expect(admin.verifyIdToken).toHaveBeenCalledWith('opaque-token', true);
  });

  it.each([
    [{ code: 'auth/id-token-expired' }, AuthErrorCode.TokenExpired],
    [{ code: 'auth/id-token-revoked' }, AuthErrorCode.TokenRevoked],
    [
      { code: 'auth/argument-error', message: 'Firebase ID token has invalid signature' },
      AuthErrorCode.TokenInvalid,
    ],
    [
      { code: 'auth/argument-error', message: 'Firebase ID token has incorrect audience claim' },
      AuthErrorCode.TokenWrongAudience,
    ],
  ])('maps Firebase failure %# to a stable safe error', async (firebaseError, expectedCode) => {
    admin.verifyIdToken.mockRejectedValue(firebaseError);
    await expect(verifier.verifyIdToken('never-exposed', false)).rejects.toMatchObject({
      code: expectedCode,
      status: 401,
    });
  });

  it('rejects an otherwise decoded token for a different project', async () => {
    admin.verifyIdToken.mockResolvedValue(token({ aud: 'another-project' }));
    await expect(verifier.verifyIdToken('opaque-token', false)).rejects.toMatchObject({
      code: AuthErrorCode.TokenWrongAudience,
    });
  });

  it('rejects an expired decoded token even if a test adapter returns one', async () => {
    admin.verifyIdToken.mockResolvedValue(token({ exp: NOW_SECONDS - 1 }));
    await expect(verifier.verifyIdToken('opaque-token', false)).rejects.toMatchObject({
      code: AuthErrorCode.TokenExpired,
    });
  });

  it.each([
    { iss: 'https://securetoken.google.com/another-project' },
    { uid: '' },
    { sub: 'different-subject' },
  ])('rejects invalid issuer/identity claims: %#', async (overrides) => {
    admin.verifyIdToken.mockResolvedValue(token(overrides));
    await expect(verifier.verifyIdToken('opaque-token', false)).rejects.toMatchObject({
      code: AuthErrorCode.TokenInvalid,
    });
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects a non-finite auth_time claim: %s',
    async (authTime) => {
      admin.verifyIdToken.mockResolvedValue(token({ auth_time: authTime }));
      await expect(verifier.verifyIdToken('opaque-token', false)).rejects.toMatchObject({
        code: AuthErrorCode.TokenInvalid,
      });
    },
  );

  it('rejects a missing auth_time claim', async () => {
    const missingAuthTime = { ...token() } as Record<string, unknown>;
    delete missingAuthTime.auth_time;
    admin.verifyIdToken.mockResolvedValue(missingAuthTime);
    await expect(verifier.verifyIdToken('opaque-token', false)).rejects.toMatchObject({
      code: AuthErrorCode.TokenInvalid,
    });
  });
});
