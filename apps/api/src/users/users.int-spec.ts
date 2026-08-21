import { randomUUID } from 'node:crypto';

import { ConsentType, UserAccountStatus } from '@tripwith/shared';

import { AccountAccessError, TripWithUserResolver, type VerifiedFirebaseIdentity } from '../auth';
import { AppDataSource } from '../database/data-source';
import { AccountRestrictionEntity, UserEntity } from '../database/entities';
import { MinimumAgeError, InvalidDateOfBirthError } from './age';
import type { ProvisionAccountDto } from './dto/provision-account.dto';
import {
  InvalidInterestError,
  InvalidProfileError,
  InvalidProvisioningConsentError,
  VerifiedEmailRequiredError,
} from './users.errors';
import { UsersService } from './users.service';

const RUN_ID = randomUUID().replace(/-/g, '');
const UID_PREFIX = `users-int-${RUN_ID}`;
const INTEREST_PREFIX = `users_int_${RUN_ID.slice(0, 16)}`;

function identity(suffix: string, overrides: Partial<VerifiedFirebaseIdentity> = {}): VerifiedFirebaseIdentity {
  return {
    firebaseUid: `${UID_PREFIX}-${suffix}`,
    email: `${RUN_ID}-${suffix}@example.com`,
    emailVerified: true,
    authTime: new Date(),
    ...overrides,
  };
}

function provisionDto(overrides: Partial<ProvisionAccountDto> = {}): ProvisionAccountDto {
  return {
    dateOfBirth: '1990-01-01',
    displayName: 'Integration Traveller',
    requiredConsents: [
      { consentType: ConsentType.TermsOfService, policyVersion: 'tos-test-v1' },
      { consentType: ConsentType.PrivacyPolicy, policyVersion: 'privacy-test-v1' },
    ],
    ...overrides,
  };
}

function utcDateAtAge(years: number, dayOffset = 0): string {
  const now = new Date();
  const date = new Date(
    Date.UTC(now.getUTCFullYear() - years, now.getUTCMonth(), now.getUTCDate() + dayOffset),
  );
  return date.toISOString().slice(0, 10);
}

describe('UsersService (real PostgreSQL)', () => {
  let service: UsersService;

  beforeAll(async () => {
    await AppDataSource.initialize();
    service = new UsersService(
      AppDataSource,
      new TripWithUserResolver(
        AppDataSource.getRepository(UserEntity),
        AppDataSource.getRepository(AccountRestrictionEntity),
      ),
    );
  });

  afterAll(async () => {
    try {
      await AppDataSource.transaction(async (manager) => {
        // The production consent ledger is append-only. Test fixture removal
        // temporarily disables that one user trigger inside a transaction;
        // any cleanup failure rolls the trigger state back automatically.
        await manager.query(`ALTER TABLE user_consents DISABLE TRIGGER user_consents_append_only`);
        await manager.query(`DELETE FROM users WHERE firebase_uid LIKE $1`, [`${UID_PREFIX}%`]);
        await manager.query(`ALTER TABLE user_consents ENABLE TRIGGER user_consents_append_only`);
        await manager.query(`DELETE FROM interests WHERE code LIKE $1`, [`${INTEREST_PREFIX}%`]);
      });
    } finally {
      await AppDataSource.destroy();
    }
  });

  it('creates the complete account once and makes repeated provisioning idempotent', async () => {
    const verified = identity('idempotent');
    const first = await service.provision(verified, provisionDto(), {
      sourceIp: '127.0.0.1',
      userAgent: 'users-integration-test',
    });
    const repeated = await service.provision(
      verified,
      provisionDto({ displayName: 'Must Not Replace Existing Profile' }),
      { sourceIp: null, userAgent: null },
    );

    expect(repeated.id).toBe(first.id);
    expect(repeated.profile.displayName).toBe('Integration Traveller');
    expect(first.onboarding).toEqual({
      complete: true,
      discoverable: true,
      missingRequirements: [],
    });
    expect(first).not.toHaveProperty('firebaseUid');
    expect(first).not.toHaveProperty('deletedAt');
    expect(first.settings).toMatchObject({
      ghostModeEnabled: false,
      ghostModeUntil: null,
      discoveryEnabled: true,
      locale: 'en',
      timezone: 'UTC',
    });

    const [counts] = await AppDataSource.query(
      `SELECT
         (SELECT count(*)::int FROM users WHERE firebase_uid = $1) AS users,
         (SELECT count(*)::int FROM user_profiles p JOIN users u ON u.id = p.user_id WHERE u.firebase_uid = $1) AS profiles,
         (SELECT count(*)::int FROM user_settings s JOIN users u ON u.id = s.user_id WHERE u.firebase_uid = $1) AS settings,
         (SELECT count(*)::int FROM user_consents c JOIN users u ON u.id = c.user_id WHERE u.firebase_uid = $1) AS consents`,
      [verified.firebaseUid],
    );
    expect(counts).toEqual({ users: 1, profiles: 1, settings: 1, consents: 2 });
    const consentRows = await AppDataSource.query(
      `SELECT consent_type, granted, policy_version, source_ip::text, user_agent
         FROM user_consents
        WHERE user_id = $1
        ORDER BY consent_type`,
      [first.id],
    );
    expect(consentRows).toEqual([
      {
        consent_type: ConsentType.TermsOfService,
        granted: true,
        policy_version: 'tos-test-v1',
        source_ip: '127.0.0.1/32',
        user_agent: 'users-integration-test',
      },
      {
        consent_type: ConsentType.PrivacyPolicy,
        granted: true,
        policy_version: 'privacy-test-v1',
        source_ip: '127.0.0.1/32',
        user_agent: 'users-integration-test',
      },
    ]);
  });

  it('rejects an unverified email or an incomplete required-consent grant set', async () => {
    await expect(
      service.provision(
        identity('unverified', { emailVerified: false }),
        provisionDto(),
        { sourceIp: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(VerifiedEmailRequiredError);

    await expect(
      service.provision(
        identity('duplicate-consent'),
        provisionDto({
          requiredConsents: [
            { consentType: ConsentType.TermsOfService, policyVersion: 'v1' },
            { consentType: ConsentType.TermsOfService, policyVersion: 'v1' },
          ],
        }),
        { sourceIp: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(InvalidProvisioningConsentError);
  });

  it('applies the normal account-usability boundary on repeated provisioning', async () => {
    const verified = identity('inactive-repeat');
    const created = await service.provision(verified, provisionDto(), {
      sourceIp: null,
      userAgent: null,
    });
    await AppDataSource.getRepository(UserEntity).update(
      { id: created.id },
      { accountStatus: UserAccountStatus.Deactivated },
    );

    await expect(
      service.provision(verified, provisionDto(), { sourceIp: null, userAgent: null }),
    ).rejects.toBeInstanceOf(AccountAccessError);
  });

  it('returns effective settings when a timed Ghost Mode interval has expired', async () => {
    const created = await service.provision(identity('expired-ghost'), provisionDto(), {
      sourceIp: null,
      userAgent: null,
    });
    await AppDataSource.query(
      `UPDATE user_settings
          SET ghost_mode_enabled = TRUE,
              ghost_mode_until = now() - interval '1 minute'
        WHERE user_id = $1`,
      [created.id],
    );

    const current = await service.getCurrentUser(created.id);
    expect(current.settings).toMatchObject({
      ghostModeEnabled: false,
      ghostModeUntil: null,
    });
    expect(current.onboarding.discoverable).toBe(true);
  });

  it('uses database uniqueness to create exactly one account under concurrent first requests', async () => {
    const verified = identity('concurrent');
    const results = await Promise.all(
      Array.from({ length: 12 }, () =>
        service.provision(verified, provisionDto(), { sourceIp: null, userAgent: null }),
      ),
    );

    expect(new Set(results.map((result) => result.id)).size).toBe(1);
    const [counts] = await AppDataSource.query(
      `SELECT
         count(DISTINCT u.id)::int AS users,
         count(DISTINCT p.user_id)::int AS profiles,
         count(DISTINCT s.user_id)::int AS settings,
         count(DISTINCT c.id)::int AS consents
       FROM users u
       LEFT JOIN user_profiles p ON p.user_id = u.id
       LEFT JOIN user_settings s ON s.user_id = u.id
       LEFT JOIN user_consents c ON c.user_id = u.id
       WHERE u.firebase_uid = $1`,
      [verified.firebaseUid],
    );
    expect(counts).toEqual({ users: 1, profiles: 1, settings: 1, consents: 2 });
  });

  it('enforces below/exactly/above-18 and invalid/future boundaries before writing', async () => {
    await expect(
      service.provision(
        identity('underage'),
        provisionDto({ dateOfBirth: utcDateAtAge(18, 1) }),
        { sourceIp: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(MinimumAgeError);

    await expect(
      service.provision(
        identity('exactly-18'),
        provisionDto({ dateOfBirth: utcDateAtAge(18) }),
        { sourceIp: null, userAgent: null },
      ),
    ).resolves.toMatchObject({ onboarding: { complete: true } });

    await expect(
      service.provision(
        identity('older'),
        provisionDto({ dateOfBirth: utcDateAtAge(18, -1) }),
        { sourceIp: null, userAgent: null },
      ),
    ).resolves.toMatchObject({ onboarding: { complete: true } });

    await expect(
      service.provision(
        identity('future'),
        provisionDto({ dateOfBirth: utcDateAtAge(-1) }),
        { sourceIp: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(InvalidDateOfBirthError);

    await expect(
      service.provision(
        identity('invalid-date'),
        provisionDto({ dateOfBirth: '2000-02-30' }),
        { sourceIp: null, userAgent: null },
      ),
    ).rejects.toBeInstanceOf(InvalidDateOfBirthError);

    const [underage] = await AppDataSource.query(
      `SELECT count(*)::int AS count FROM users WHERE firebase_uid = $1`,
      [identity('underage').firebaseUid],
    );
    expect(underage.count).toBe(0);
  });

  it('updates only the authenticated owner and rejects invalid profile values', async () => {
    const owner = await service.provision(identity('owner-a'), provisionDto({ displayName: 'Owner A' }), {
      sourceIp: null,
      userAgent: null,
    });
    const other = await service.provision(identity('owner-b'), provisionDto({ displayName: 'Owner B' }), {
      sourceIp: null,
      userAgent: null,
    });

    const updated = await service.updateProfile(owner.id, {
      displayName: '  Updated Owner  ',
      bio: 'Travel biography',
      homeCountryCode: 'IL',
      nativeLanguageCode: 'he',
      languagesSpoken: ['he', 'en'],
      travelStyle: 4,
    });
    expect(updated).toMatchObject({
      userId: owner.id,
      displayName: 'Updated Owner',
      homeCountryCode: 'IL',
      nativeLanguageCode: 'he',
      languagesSpoken: ['he', 'en'],
      travelStyle: 4,
    });
    await expect(service.getProfile(other.id)).resolves.toMatchObject({
      userId: other.id,
      displayName: 'Owner B',
    });

    await expect(service.updateProfile(owner.id, { displayName: ' ' })).rejects.toBeInstanceOf(
      InvalidProfileError,
    );
    await expect(service.updateProfile(owner.id, { displayName: '😀' })).rejects.toBeInstanceOf(
      InvalidProfileError,
    );
    await expect(
      service.updateProfile(owner.id, { bio: 'x'.repeat(1001) }),
    ).rejects.toBeInstanceOf(InvalidProfileError);
    await expect(
      service.updateProfile(owner.id, { homeCountryCode: 'israel' }),
    ).rejects.toBeInstanceOf(InvalidProfileError);
    await expect(
      service.updateProfile(owner.id, { nativeLanguageCode: 'EN-US' }),
    ).rejects.toBeInstanceOf(InvalidProfileError);
    await expect(service.updateProfile(owner.id, { travelStyle: 6 })).rejects.toBeInstanceOf(
      InvalidProfileError,
    );
  });

  it('lists active interests and keeps the relational set and trigger projection identical', async () => {
    const user = await service.provision(identity('interests'), provisionDto(), {
      sourceIp: null,
      userAgent: null,
    });
    const [activeA, activeB, inactive] = await Promise.all([
      AppDataSource.query(
        `INSERT INTO interests (code, label, grouping, is_active, sort_order)
         VALUES ($1, 'Active A', 'test', TRUE, 2) RETURNING id`,
        [`${INTEREST_PREFIX}_a`],
      ),
      AppDataSource.query(
        `INSERT INTO interests (code, label, grouping, is_active, sort_order)
         VALUES ($1, 'Active B', 'test', TRUE, 1) RETURNING id`,
        [`${INTEREST_PREFIX}_b`],
      ),
      AppDataSource.query(
        `INSERT INTO interests (code, label, grouping, is_active, sort_order)
         VALUES ($1, 'Inactive', 'test', FALSE, 0) RETURNING id`,
        [`${INTEREST_PREFIX}_inactive`],
      ),
    ]);
    const ids = [activeA[0].id as number, activeB[0].id as number];

    const available = await service.listActiveInterests();
    expect(available.filter((interest) => ids.includes(interest.id)).map((interest) => interest.id)).toEqual([
      activeB[0].id,
      activeA[0].id,
    ]);
    expect(available).not.toEqual(expect.arrayContaining([expect.objectContaining({ id: inactive[0].id })]));

    const profile = await service.replaceInterests(user.id, { interestIds: ids });
    expect(profile.interests.map((interest) => interest.id).sort((a, b) => a - b)).toEqual(
      [...ids].sort((a, b) => a - b),
    );
    const [projection] = await AppDataSource.query(
      `SELECT p.interest_ids,
              COALESCE(array_agg(ui.interest_id ORDER BY ui.interest_id)
                FILTER (WHERE ui.interest_id IS NOT NULL), '{}'::int[]) AS relational_ids
         FROM user_profiles p
         LEFT JOIN user_interests ui ON ui.user_id = p.user_id
        WHERE p.user_id = $1
        GROUP BY p.user_id`,
      [user.id],
    );
    expect(projection.interest_ids).toEqual(projection.relational_ids);

    await expect(
      service.replaceInterests(user.id, { interestIds: [inactive[0].id as number] }),
    ).rejects.toBeInstanceOf(InvalidInterestError);
    await expect(service.getProfile(user.id)).resolves.toMatchObject({
      interests: expect.arrayContaining(ids.map((id) => expect.objectContaining({ id }))),
    });

    const cleared = await service.replaceInterests(user.id, { interestIds: [] });
    expect(cleared.interests).toEqual([]);
    const [clearedProjection] = await AppDataSource.query(
      `SELECT interest_ids FROM user_profiles WHERE user_id = $1`,
      [user.id],
    );
    expect(clearedProjection.interest_ids).toEqual([]);
  });
});
