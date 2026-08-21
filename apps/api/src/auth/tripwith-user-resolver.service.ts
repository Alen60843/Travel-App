import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { RestrictionType, UserAccountStatus } from '@tripwith/shared';
import { IsNull, LessThanOrEqual, MoreThan, Repository } from 'typeorm';

import { AccountRestrictionEntity, UserEntity } from '../database/entities';
import { AccountAccessError, AuthErrorCode } from './auth.errors';
import type { AuthenticatedUser, VerifiedFirebaseIdentity } from './auth.types';

@Injectable()
export class TripWithUserResolver {
  constructor(
    @InjectRepository(UserEntity) private readonly users: Repository<UserEntity>,
    @InjectRepository(AccountRestrictionEntity)
    private readonly restrictions: Repository<AccountRestrictionEntity>,
  ) {}

  async resolve(identity: VerifiedFirebaseIdentity): Promise<AuthenticatedUser> {
    const user = await this.users.findOne({
      where: { firebaseUid: identity.firebaseUid },
      withDeleted: true,
    });

    if (!user) {
      throw new AccountAccessError(
        AuthErrorCode.AccountNotProvisioned,
        'This Firebase identity does not have a TripWith account.',
      );
    }

    if (user.deletedAt || user.accountStatus === UserAccountStatus.Deleted) {
      throw new AccountAccessError(AuthErrorCode.AccountDeleted, 'This account is unavailable.');
    }
    if (user.accountStatus === UserAccountStatus.Deactivated) {
      throw new AccountAccessError(AuthErrorCode.AccountDeactivated, 'This account is deactivated.');
    }
    if (user.accountStatus === UserAccountStatus.Suspended) {
      throw new AccountAccessError(AuthErrorCode.AccountSuspended, 'This account is suspended.');
    }
    if (user.accountStatus !== UserAccountStatus.Active) {
      throw new AccountAccessError(AuthErrorCode.AccountInactive, 'This account is not active.');
    }

    const now = new Date();
    const fullySuspended = await this.restrictions.exists({
      where: [
        {
          userId: user.id,
          type: RestrictionType.FullSuspension,
          startsAt: LessThanOrEqual(now),
          endsAt: IsNull(),
          liftedAt: IsNull(),
        },
        {
          userId: user.id,
          type: RestrictionType.FullSuspension,
          startsAt: LessThanOrEqual(now),
          endsAt: MoreThan(now),
          liftedAt: IsNull(),
        },
      ],
    });
    if (fullySuspended) {
      throw new AccountAccessError(
        AuthErrorCode.AccountFullySuspended,
        'This account is currently restricted.',
      );
    }

    return Object.freeze({
      id: user.id,
      firebaseUid: user.firebaseUid,
      accountStatus: user.accountStatus,
      firebaseIdentity: identity,
    });
  }
}

