import { RestrictionType, UserAccountStatus } from '@tripwith/shared';
import type { Repository } from 'typeorm';

import { AccountRestrictionEntity, UserEntity } from '../database/entities';
import { AuthErrorCode } from './auth.errors';
import type { VerifiedFirebaseIdentity } from './auth.types';
import { TripWithUserResolver } from './tripwith-user-resolver.service';

const identity: VerifiedFirebaseIdentity = {
  firebaseUid: 'firebase-user-1',
  email: 'traveller@example.com',
  emailVerified: true,
  authTime: new Date('2026-08-21T00:00:00.000Z'),
};

function user(overrides: Partial<UserEntity> = {}): UserEntity {
  return {
    id: 'a2689ca1-951b-4e31-9c1d-d68334369214',
    firebaseUid: identity.firebaseUid,
    accountStatus: UserAccountStatus.Active,
    deletedAt: null,
    ...overrides,
  } as UserEntity;
}

describe(TripWithUserResolver.name, () => {
  let users: { findOne: jest.Mock };
  let restrictions: { exists: jest.Mock };
  let resolver: TripWithUserResolver;

  beforeEach(() => {
    users = { findOne: jest.fn().mockResolvedValue(user()) };
    restrictions = { exists: jest.fn().mockResolvedValue(false) };
    resolver = new TripWithUserResolver(
      users as unknown as Repository<UserEntity>,
      restrictions as unknown as Repository<AccountRestrictionEntity>,
    );
  });

  it('resolves a usable account to the internal UUID', async () => {
    await expect(resolver.resolve(identity)).resolves.toMatchObject({
      id: 'a2689ca1-951b-4e31-9c1d-d68334369214',
      firebaseUid: identity.firebaseUid,
      accountStatus: UserAccountStatus.Active,
      firebaseIdentity: identity,
    });
    expect(users.findOne).toHaveBeenCalledWith({
      where: { firebaseUid: identity.firebaseUid },
      withDeleted: true,
    });
    expect(restrictions.exists).toHaveBeenCalledWith({
      where: expect.arrayContaining([
        expect.objectContaining({ type: RestrictionType.FullSuspension }),
      ]),
    });
  });

  it('rejects an identity with no provisioned TripWith account', async () => {
    users.findOne.mockResolvedValue(null);
    await expect(resolver.resolve(identity)).rejects.toMatchObject({
      code: AuthErrorCode.AccountNotProvisioned,
      status: 403,
    });
  });

  it.each([
    [UserAccountStatus.PendingVerification, null, AuthErrorCode.AccountInactive],
    [UserAccountStatus.Deactivated, null, AuthErrorCode.AccountDeactivated],
    [UserAccountStatus.Suspended, null, AuthErrorCode.AccountSuspended],
    [UserAccountStatus.Deleted, null, AuthErrorCode.AccountDeleted],
    [UserAccountStatus.Active, new Date('2026-08-20T00:00:00.000Z'), AuthErrorCode.AccountDeleted],
  ])('rejects unusable account status/deletion %#', async (accountStatus, deletedAt, expectedCode) => {
    users.findOne.mockResolvedValue(user({ accountStatus, deletedAt }));
    await expect(resolver.resolve(identity)).rejects.toMatchObject({ code: expectedCode, status: 403 });
    expect(restrictions.exists).not.toHaveBeenCalled();
  });

  it('rejects a currently effective FULL_SUSPENSION', async () => {
    restrictions.exists.mockResolvedValue(true);
    await expect(resolver.resolve(identity)).rejects.toMatchObject({
      code: AuthErrorCode.AccountFullySuspended,
      status: 403,
    });
  });
});

