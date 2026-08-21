import { AuthErrorCode, AccountAccessError } from './auth.errors';
import type { AuthenticatedUser, FirebaseTokenVerifier, VerifiedFirebaseIdentity } from './auth.types';
import { FirebaseSocketAuthenticator } from './firebase-socket-authenticator.service';
import { TripWithUserResolver } from './tripwith-user-resolver.service';

const identity: VerifiedFirebaseIdentity = {
  firebaseUid: 'firebase-user-1',
  email: null,
  emailVerified: false,
  authTime: new Date('2026-08-21T00:00:00.000Z'),
};
const user = {
  id: 'd52fc609-8c00-4052-a2d3-0e7c0d34f79c',
  firebaseUid: identity.firebaseUid,
  accountStatus: 'ACTIVE',
  firebaseIdentity: identity,
} as AuthenticatedUser;

describe(FirebaseSocketAuthenticator.name, () => {
  let verifyIdToken: jest.Mock;
  let resolve: jest.Mock;
  let authenticator: FirebaseSocketAuthenticator;

  beforeEach(() => {
    verifyIdToken = jest.fn().mockResolvedValue(identity);
    resolve = jest.fn().mockResolvedValue(user);
    authenticator = new FirebaseSocketAuthenticator(
      { verifyIdToken } as FirebaseTokenVerifier,
      { resolve } as unknown as TripWithUserResolver,
    );
  });

  it('verifies a handshake token locally and returns only the internal user id', async () => {
    await expect(authenticator.authenticate('socket-token')).resolves.toEqual({ userId: user.id });
    expect(verifyIdToken).toHaveBeenCalledWith('socket-token', false);
    expect(resolve).toHaveBeenCalledWith(identity);
  });

  it('rejects a missing token without invoking Firebase', async () => {
    await expect(authenticator.authenticate(undefined)).resolves.toBeNull();
    expect(verifyIdToken).not.toHaveBeenCalled();
  });

  it('returns null for invalid tokens', async () => {
    verifyIdToken.mockRejectedValue(new Error('signature failure'));
    await expect(authenticator.authenticate('invalid-token')).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('returns null when the internal account is unusable', async () => {
    resolve.mockRejectedValue(
      new AccountAccessError(AuthErrorCode.AccountSuspended, 'This account is suspended.'),
    );
    await expect(authenticator.authenticate('valid-but-suspended')).resolves.toBeNull();
  });
});

