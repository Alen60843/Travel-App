import { Injectable } from '@nestjs/common';
import { ConsentType, UserAccountStatus } from '@tripwith/shared';
import { DataSource, EntityManager } from 'typeorm';

import { TripWithUserResolver, type VerifiedFirebaseIdentity } from '../auth';
import {
  InterestEntity,
  UserEntity,
  UserInterestEntity,
  UserProfileEntity,
  UserSettingsEntity,
} from '../database/entities';
import { assertEligibleDateOfBirth, MinimumAgeError } from './age';
import type { ProvisionAccountDto, ProvisioningConsentDto } from './dto/provision-account.dto';
import type { ReplaceInterestsDto } from './dto/replace-interests.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';
import {
  AccountIdentityConflictError,
  AccountNotProvisionedError,
  InvalidInterestError,
  InvalidProfileError,
  InvalidProvisioningConsentError,
  VerifiedEmailRequiredError,
} from './users.errors';
import type {
  CurrentUserView,
  InterestView,
  ProfileView,
  ProvisionAuditContext,
} from './users.types';

const REQUIRED_CONSENT_TYPES = [ConsentType.TermsOfService, ConsentType.PrivacyPolicy] as const;
const EMAIL_PATTERN = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const LANGUAGE_PATTERN = /^[a-z]{2,3}$/;
const COUNTRY_PATTERN = /^[A-Z]{2}$/;

interface InsertedUserRow {
  readonly id: string;
}

interface CurrentConsentRow {
  readonly consent_type: string;
  readonly granted: boolean;
}

interface PgErrorLike {
  readonly code?: string;
  readonly constraint?: string;
}

@Injectable()
export class UsersService {
  constructor(
    private readonly dataSource: DataSource,
    private readonly userResolver: TripWithUserResolver,
  ) {}

  async provision(
    identity: VerifiedFirebaseIdentity,
    dto: ProvisionAccountDto,
    audit: ProvisionAuditContext,
  ): Promise<CurrentUserView> {
    const email = this.requireVerifiedEmail(identity);
    assertEligibleDateOfBirth(dto.dateOfBirth);
    const displayName = this.normaliseDisplayName(dto.displayName);
    const consents = this.validateRequiredConsents(dto.requiredConsents);

    try {
      const userId = await this.dataSource.transaction(async (manager) => {
        // PostgreSQL uniqueness is the concurrency authority. ON CONFLICT waits
        // for a concurrent insert of the same Firebase UID, then returns no row
        // after the winner commits; the following SELECT resolves that winner.
        const inserted: InsertedUserRow[] = await manager.query(
          `INSERT INTO users
             (firebase_uid, email, email_verified_at, account_status, date_of_birth)
           VALUES ($1, $2, now(), $3, $4)
           ON CONFLICT DO NOTHING
           RETURNING id`,
          [identity.firebaseUid, email, UserAccountStatus.Active, dto.dateOfBirth],
        );

        const insertedId = inserted[0]?.id;
        if (!insertedId) {
          const existing = await manager.getRepository(UserEntity).findOne({
            select: { id: true },
            where: { firebaseUid: identity.firebaseUid },
            withDeleted: true,
          });
          if (!existing) {
            // A different uniqueness rule (normally lower(email)) rejected the
            // identity. Keep database/index details out of the API response.
            throw new AccountIdentityConflictError();
          }
          return existing.id;
        }

        await manager.query(
          `INSERT INTO user_profiles (user_id, display_name)
           VALUES ($1, $2)`,
          [insertedId, displayName],
        );
        await manager.query(`INSERT INTO user_settings (user_id) VALUES ($1)`, [insertedId]);
        await this.insertRequiredConsents(manager, insertedId, consents, audit);
        return insertedId;
      });

      // The provisioning guard intentionally permits an unprovisioned
      // identity. Once a row exists, apply the same active/deleted/suspension
      // boundary as every other TripWith endpoint before returning owner data.
      const authenticated = await this.userResolver.resolve(identity);
      if (authenticated.id !== userId) {
        throw new AccountIdentityConflictError();
      }
      return this.getCurrentUser(authenticated.id);
    } catch (error) {
      if (error instanceof AccountIdentityConflictError) {
        throw error;
      }
      const postgresError = error as PgErrorLike;
      if (postgresError.code === '23505') {
        throw new AccountIdentityConflictError();
      }
      // The API check provides the useful boundary response; the trigger is
      // still authoritative if the calendar advances during the transaction.
      if (postgresError.code === '23514' && !postgresError.constraint) {
        throw new MinimumAgeError();
      }
      if (postgresError.code === '23514') {
        throw new InvalidProfileError('displayName', 'The supplied account profile is invalid.');
      }
      throw error;
    }
  }

  async getCurrentUser(userId: string): Promise<CurrentUserView> {
    const manager = this.dataSource.manager;
    const user = await manager.getRepository(UserEntity).findOneBy({ id: userId });
    if (!user) {
      throw new AccountNotProvisionedError();
    }

    const [profile, settings, consentRows] = await Promise.all([
      this.getProfileWithManager(manager, userId),
      manager.getRepository(UserSettingsEntity).findOneBy({ userId }),
      this.getCurrentRequiredConsents(manager, userId),
    ]);

    const grantedTypes = new Set(
      consentRows.filter((row) => row.granted).map((row) => row.consent_type),
    );
    const missingRequirements: string[] = [];
    if (user.accountStatus !== UserAccountStatus.Active) missingRequirements.push('active_account');
    if (!user.emailVerifiedAt) missingRequirements.push('verified_email');
    if (!profile.displayName.trim()) missingRequirements.push('display_name');
    if (!settings) missingRequirements.push('settings');
    for (const consentType of REQUIRED_CONSENT_TYPES) {
      if (!grantedTypes.has(consentType)) missingRequirements.push(`consent:${consentType}`);
    }

    const complete = missingRequirements.length === 0;
    const ghostModeActive = Boolean(
      settings?.ghostModeEnabled &&
        (!settings.ghostModeUntil || settings.ghostModeUntil.getTime() > Date.now()),
    );

    return {
      id: user.id,
      email: user.email,
      emailVerified: Boolean(user.emailVerifiedAt),
      accountStatus: user.accountStatus,
      dateOfBirth: user.dateOfBirth,
      profile,
      settings: settings
        ? {
            ghostModeEnabled: ghostModeActive,
            ghostModeUntil: ghostModeActive ? settings.ghostModeUntil?.toISOString() ?? null : null,
            discoveryEnabled: settings.discoveryEnabled,
            tripVisibility: settings.tripVisibility,
            minAgePreference: settings.minAgePreference,
            maxAgePreference: settings.maxAgePreference,
            minTrustScorePreference: settings.minTrustScorePreference,
            maxDistanceKm: settings.maxDistanceKm,
            pushEnabled: settings.pushEnabled,
            emailEnabled: settings.emailEnabled,
            locale: settings.locale,
            timezone: settings.timezone,
          }
        : null,
      onboarding: {
        complete,
        discoverable: Boolean(complete && settings?.discoveryEnabled && !ghostModeActive),
        missingRequirements,
      },
      createdAt: user.createdAt.toISOString(),
    };
  }

  async getProfile(userId: string): Promise<ProfileView> {
    return this.getProfileWithManager(this.dataSource.manager, userId);
  }

  async updateProfile(userId: string, dto: UpdateProfileDto): Promise<ProfileView> {
    const update = this.normaliseProfileUpdate(dto);
    if (Object.keys(update).length === 0) {
      return this.getProfile(userId);
    }

    const result = await this.dataSource
      .getRepository(UserProfileEntity)
      .update({ userId }, update);
    if (result.affected !== 1) {
      throw new AccountNotProvisionedError();
    }
    return this.getProfile(userId);
  }

  async listActiveInterests(): Promise<readonly InterestView[]> {
    const rows = await this.dataSource.getRepository(InterestEntity).find({
      where: { isActive: true },
      order: { sortOrder: 'ASC', label: 'ASC', id: 'ASC' },
    });
    return rows.map((interest) => this.toInterestView(interest));
  }

  async replaceInterests(userId: string, dto: ReplaceInterestsDto): Promise<ProfileView> {
    if (!Array.isArray(dto.interestIds)) {
      throw new InvalidInterestError();
    }
    const interestIds = [...dto.interestIds];
    this.validateInterestIds(interestIds);

    await this.dataSource.transaction(async (manager) => {
      // The profile row is the aggregate lock. Concurrent replacements for one
      // owner cannot interleave their DELETE/INSERT sets and produce a union.
      const lockedProfiles: { user_id: string }[] = await manager.query(
        `SELECT user_id FROM user_profiles WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      if (!lockedProfiles[0]) {
        throw new AccountNotProvisionedError();
      }

      if (interestIds.length > 0) {
        const validRows: { id: number }[] = await manager.query(
          `SELECT id FROM interests WHERE is_active = TRUE AND id = ANY($1::int[])`,
          [interestIds],
        );
        if (validRows.length !== interestIds.length) {
          throw new InvalidInterestError();
        }
      }

      await manager.getRepository(UserInterestEntity).delete({ userId });
      if (interestIds.length > 0) {
        await manager.query(
          `INSERT INTO user_interests (user_id, interest_id)
           SELECT $1, interest_id
             FROM unnest($2::int[]) AS selected(interest_id)`,
          [userId, interestIds],
        );
      }
    });

    return this.getProfile(userId);
  }

  private requireVerifiedEmail(identity: VerifiedFirebaseIdentity): string {
    const email = identity.email?.trim().toLowerCase();
    if (
      !identity.emailVerified ||
      !email ||
      email.includes('\0') ||
      !EMAIL_PATTERN.test(email)
    ) {
      throw new VerifiedEmailRequiredError();
    }
    return email;
  }

  private normaliseDisplayName(value: string): string {
    if (typeof value !== 'string') {
      throw new InvalidProfileError('displayName', 'Display name must contain 2 to 50 characters.');
    }
    const displayName = value.trim();
    const characterCount = [...displayName].length;
    if (displayName.includes('\0') || characterCount < 2 || characterCount > 50) {
      throw new InvalidProfileError('displayName', 'Display name must contain 2 to 50 characters.');
    }
    return displayName;
  }

  private validateRequiredConsents(
    values: readonly ProvisioningConsentDto[],
  ): readonly ProvisioningConsentDto[] {
    if (!Array.isArray(values) || values.length !== REQUIRED_CONSENT_TYPES.length) {
      throw new InvalidProvisioningConsentError();
    }
    const byType = new Map(values.map((value) => [value.consentType, value]));
    if (
      byType.size !== REQUIRED_CONSENT_TYPES.length ||
      REQUIRED_CONSENT_TYPES.some((type) => !byType.has(type)) ||
      values.some(
        (value) =>
          typeof value.policyVersion !== 'string' ||
          value.policyVersion.includes('\0') ||
          [...value.policyVersion.trim()].length < 1 ||
          [...value.policyVersion.trim()].length > 100,
      )
    ) {
      throw new InvalidProvisioningConsentError();
    }
    return values.map((value) => ({
      consentType: value.consentType,
      policyVersion: value.policyVersion.trim(),
    }));
  }

  private async insertRequiredConsents(
    manager: EntityManager,
    userId: string,
    consents: readonly ProvisioningConsentDto[],
    audit: ProvisionAuditContext,
  ): Promise<void> {
    await manager.query(
      `INSERT INTO user_consents
         (user_id, consent_type, granted, policy_version, source_ip, user_agent)
       SELECT $1, consent_type::consent_type, TRUE, policy_version, $4::inet, $5
         FROM unnest($2::text[], $3::text[]) AS required(consent_type, policy_version)`,
      [
        userId,
        consents.map((consent) => consent.consentType),
        consents.map((consent) => consent.policyVersion),
        audit.sourceIp,
        audit.userAgent,
      ],
    );
  }

  private async getCurrentRequiredConsents(
    manager: EntityManager,
    userId: string,
  ): Promise<CurrentConsentRow[]> {
    return manager.query(
      `SELECT DISTINCT ON (consent_type) consent_type::text, granted
         FROM user_consents
        WHERE user_id = $1
          AND consent_type = ANY($2::consent_type[])
        ORDER BY consent_type, created_at DESC, id DESC`,
      [userId, REQUIRED_CONSENT_TYPES],
    );
  }

  private async getProfileWithManager(manager: EntityManager, userId: string): Promise<ProfileView> {
    const profile = await manager.getRepository(UserProfileEntity).findOneBy({ userId });
    if (!profile) {
      throw new AccountNotProvisionedError();
    }
    const interests = await manager
      .getRepository(InterestEntity)
      .createQueryBuilder('interest')
      .innerJoin(UserInterestEntity, 'selected', 'selected.interest_id = interest.id')
      .where('selected.user_id = :userId', { userId })
      .orderBy('interest.sort_order', 'ASC')
      .addOrderBy('interest.label', 'ASC')
      .addOrderBy('interest.id', 'ASC')
      .getMany();

    return {
      userId: profile.userId,
      displayName: profile.displayName,
      bio: profile.bio,
      avatarUrl: profile.avatarUrl,
      homeCountryCode: profile.homeCountryCode,
      nativeLanguageCode: profile.nativeLanguageCode,
      languagesSpoken: profile.languagesSpoken,
      travelStyle: profile.travelStyle,
      interests: interests.map((interest) => this.toInterestView(interest)),
      identityVerifiedAt: profile.identityVerifiedAt?.toISOString() ?? null,
    };
  }

  private normaliseProfileUpdate(dto: UpdateProfileDto): Partial<UserProfileEntity> {
    const update: Partial<UserProfileEntity> = {};
    if (dto.displayName !== undefined) {
      update.displayName = this.normaliseDisplayName(dto.displayName);
    }
    if (dto.bio !== undefined) {
      if (
        dto.bio !== null &&
        (typeof dto.bio !== 'string' || dto.bio.includes('\0') || [...dto.bio].length > 1000)
      ) {
        throw new InvalidProfileError('bio', 'Bio must contain no more than 1000 characters.');
      }
      update.bio = dto.bio;
    }
    if (dto.homeCountryCode !== undefined) {
      if (
        dto.homeCountryCode !== null &&
        (typeof dto.homeCountryCode !== 'string' || !COUNTRY_PATTERN.test(dto.homeCountryCode))
      ) {
        throw new InvalidProfileError('homeCountryCode', 'Home country must be an ISO alpha-2 code.');
      }
      update.homeCountryCode = dto.homeCountryCode;
    }
    if (dto.nativeLanguageCode !== undefined) {
      if (
        dto.nativeLanguageCode !== null &&
        (typeof dto.nativeLanguageCode !== 'string' ||
          !LANGUAGE_PATTERN.test(dto.nativeLanguageCode))
      ) {
        throw new InvalidProfileError(
          'nativeLanguageCode',
          'Native language must be a lower-case ISO language code.',
        );
      }
      update.nativeLanguageCode = dto.nativeLanguageCode;
    }
    if (dto.languagesSpoken !== undefined) {
      if (
        !Array.isArray(dto.languagesSpoken) ||
        dto.languagesSpoken.length > 20 ||
        new Set(dto.languagesSpoken).size !== dto.languagesSpoken.length ||
        dto.languagesSpoken.some(
          (language) => typeof language !== 'string' || !LANGUAGE_PATTERN.test(language),
        )
      ) {
        throw new InvalidProfileError(
          'languagesSpoken',
          'Spoken languages must be unique lower-case ISO language codes.',
        );
      }
      update.languagesSpoken = dto.languagesSpoken;
    }
    if (dto.travelStyle !== undefined) {
      if (!Number.isInteger(dto.travelStyle) || dto.travelStyle < 1 || dto.travelStyle > 5) {
        throw new InvalidProfileError('travelStyle', 'Travel style must be an integer from 1 to 5.');
      }
      update.travelStyle = dto.travelStyle;
    }
    return update;
  }

  private validateInterestIds(interestIds: readonly number[]): void {
    if (
      interestIds.length > 100 ||
      new Set(interestIds).size !== interestIds.length ||
      interestIds.some((id) => !Number.isInteger(id) || id < 1)
    ) {
      throw new InvalidInterestError();
    }
  }

  private toInterestView(interest: InterestEntity): InterestView {
    return {
      id: interest.id,
      code: interest.code,
      label: interest.label,
      grouping: interest.grouping,
    };
  }
}
