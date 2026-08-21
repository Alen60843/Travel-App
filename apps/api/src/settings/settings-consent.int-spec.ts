import { randomUUID } from 'node:crypto';

import {
  ConsentType,
  TripVisibility,
  UserAccountStatus,
} from '@tripwith/shared';

import { ValidationError } from '../common/errors/app-error';
import { loadConfig } from '../config/configuration';
import { ConsentPolicyService } from '../consent/consent-policy.service';
import { AppDataSource } from '../database/data-source';
import { UserEntity, UserSettingsEntity } from '../database/entities';
import type { FeedGenerationService } from '../matching/feed-generation.service';
import { ConsentService } from '../consent/consent.service';
import { SettingsService } from './settings.service';

interface SeededAccount {
  readonly user: UserEntity;
  readonly settings: UserSettingsEntity;
}

async function createAccount(): Promise<SeededAccount> {
  const userRepository = AppDataSource.getRepository(UserEntity);
  const user = await userRepository.save(
    userRepository.create({
      firebaseUid: `settings-test-${randomUUID()}`,
      email: `settings-test-${randomUUID()}@example.com`,
      accountStatus: UserAccountStatus.Active,
      dateOfBirth: '1990-01-01',
    }),
  );

  const settingsRepository = AppDataSource.getRepository(UserSettingsEntity);
  const settings = await settingsRepository.save(
    settingsRepository.create({
      userId: user.id,
      ghostModeEnabled: false,
      ghostModeUntil: null,
      discoveryEnabled: false,
      tripVisibility: TripVisibility.MatchesOnly,
      minAgePreference: 18,
      maxAgePreference: 99,
      minTrustScorePreference: 0,
      maxDistanceKm: 500,
      pushEnabled: true,
      emailEnabled: true,
      locale: 'en',
      timezone: 'UTC',
    }),
  );
  return { user, settings };
}

describe('settings, privacy, and consent (real PostgreSQL)', () => {
  let settings: SettingsService;
  let consents: ConsentService;
  const feedGeneration = {
    bump: jest.fn().mockResolvedValue('aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'),
  };

  beforeAll(async () => {
    await AppDataSource.initialize();
    const policy = new ConsentPolicyService(loadConfig());
    settings = new SettingsService(
      AppDataSource,
      policy,
      feedGeneration as unknown as FeedGenerationService,
    );
    consents = new ConsentService(AppDataSource, policy);
  });

  afterAll(async () => {
    await AppDataSource.destroy();
  });

  it('updates every owner setting while preserving another account and enforcing schema ranges', async () => {
    const owner = await createAccount();
    const other = await createAccount();
    const ghostUntil = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    const result = await settings.updateOwn(owner.user.id, {
      ghostModeEnabled: true,
      ghostModeUntil: ghostUntil,
      discoveryEnabled: false,
      tripVisibility: TripVisibility.Private,
      minAgePreference: 25,
      maxAgePreference: 45,
      minTrustScorePreference: 6.25,
      maxDistanceKm: 1_200,
      pushEnabled: false,
      emailEnabled: false,
      locale: 'fr-FR',
      timezone: 'Europe/Paris',
    });

    expect(result).toMatchObject({
      ghostModeEnabled: true,
      ghostModeUntil: ghostUntil,
      discoveryEnabled: false,
      tripVisibility: TripVisibility.Private,
      minAgePreference: 25,
      maxAgePreference: 45,
      minTrustScorePreference: 6.25,
      maxDistanceKm: 1_200,
      pushEnabled: false,
      emailEnabled: false,
      locale: 'fr-FR',
      timezone: 'Europe/Paris',
    });
    expect(feedGeneration.bump).toHaveBeenCalledWith(owner.user.id);

    const unchangedOther = await settings.getOwn(other.user.id);
    expect(unchangedOther).toMatchObject({
      ghostModeEnabled: false,
      discoveryEnabled: false,
      tripVisibility: TripVisibility.MatchesOnly,
      minAgePreference: 18,
      maxAgePreference: 99,
      locale: 'en',
      timezone: 'UTC',
    });

    await expect(
      settings.updateOwn(owner.user.id, { minAgePreference: 50, maxAgePreference: 40 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      settings.updateOwn(owner.user.id, { minAgePreference: 17 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      settings.updateOwn(owner.user.id, { minTrustScorePreference: 10.01 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      settings.updateOwn(owner.user.id, { maxDistanceKm: 20_001 }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      settings.updateOwn(owner.user.id, { locale: 'not_a_locale' }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      settings.updateOwn(owner.user.id, { timezone: 'Mars/Olympus_Mons' }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires a future enabled Ghost Mode expiry and durably normalizes expiration on read', async () => {
    const owner = await createAccount();
    const future = new Date(Date.now() + 60 * 60 * 1000).toISOString();
    const past = new Date(Date.now() - 60 * 1000);

    await expect(
      settings.updateOwn(owner.user.id, { ghostModeUntil: future }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      settings.updateOwn(owner.user.id, {
        ghostModeEnabled: true,
        ghostModeUntil: past.toISOString(),
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      settings.updateOwn(owner.user.id, {
        ghostModeEnabled: false,
        ghostModeUntil: future,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
    await settings.updateOwn(owner.user.id, {
      ghostModeEnabled: true,
      ghostModeUntil: future,
    });
    await expect(
      settings.updateOwn(owner.user.id, { ghostModeEnabled: false }),
    ).resolves.toMatchObject({ ghostModeEnabled: false, ghostModeUntil: null });

    // The database permits an elapsed timestamp so timed Ghost Mode can
    // naturally expire. GET must return the effective state and make it
    // durable rather than leaving a stale, permanently enabled row.
    await AppDataSource.getRepository(UserSettingsEntity).update(
      { userId: owner.user.id },
      { ghostModeEnabled: true, ghostModeUntil: past },
    );

    await expect(settings.getOwn(owner.user.id)).resolves.toMatchObject({
      ghostModeEnabled: false,
      ghostModeUntil: null,
    });
    const persisted = await AppDataSource.getRepository(UserSettingsEntity).findOneByOrFail({
      userId: owner.user.id,
    });
    expect(persisted.ghostModeEnabled).toBe(false);
    expect(persisted.ghostModeUntil).toBeNull();
  });

  it('appends grants and withdrawals, projects latest state, and keeps history owner-scoped', async () => {
    const owner = await createAccount();
    const other = await createAccount();
    const source = { sourceIp: '203.0.113.10', userAgent: 'TripWith-Test/1.0' };

    const grant = await consents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.PrivacyPolicy,
        granted: true,
        policyVersion: ' privacy-test-v1 ',
      },
      source,
    );
    await consents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.TermsOfService,
        granted: true,
        policyVersion: 'tos-test-v1',
      },
      source,
    );
    await expect(
      settings.updateOwn(owner.user.id, { discoveryEnabled: true }),
    ).resolves.toMatchObject({ discoveryEnabled: true });
    await consents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.MarketingEmail,
        granted: true,
        policyVersion: 'marketing-v1',
      },
      { sourceIp: null, userAgent: null },
    );
    const withdrawal = await consents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.PrivacyPolicy,
        granted: false,
        policyVersion: 'privacy-test-v1',
      },
      source,
    );

    expect(grant).toMatchObject({
      consentType: ConsentType.PrivacyPolicy,
      granted: true,
      policyVersion: 'privacy-test-v1',
      sourceIp: '203.0.113.10',
      userAgent: 'TripWith-Test/1.0',
    });
    expect(withdrawal.id).not.toBe(grant.id);
    await expect(settings.getOwn(owner.user.id)).resolves.toMatchObject({
      discoveryEnabled: false,
    });
    await expect(
      settings.updateOwn(owner.user.id, { discoveryEnabled: true }),
    ).rejects.toBeInstanceOf(ValidationError);

    const current = await consents.getCurrentOwn(owner.user.id);
    expect(current).toHaveLength(3);
    expect(current).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentType: ConsentType.PrivacyPolicy,
          granted: false,
        }),
        expect.objectContaining({
          consentType: ConsentType.MarketingEmail,
          granted: true,
        }),
      ]),
    );

    const history = await consents.getHistoryOwn(owner.user.id);
    expect(history).toHaveLength(4);
    expect(history.filter((event) => event.consentType === ConsentType.PrivacyPolicy)).toHaveLength(2);
    await expect(consents.getHistoryOwn(other.user.id)).resolves.toEqual([]);
    await expect(consents.getCurrentOwn(other.user.id)).resolves.toEqual([]);

    // The schema's append-only trigger is the final authority. Application
    // code has no update/delete consent method, and direct mutation fails.
    await expect(
      AppDataSource.query('UPDATE user_consents SET granted = TRUE WHERE id = $1', [withdrawal.id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(
      AppDataSource.query('DELETE FROM user_consents WHERE id = $1', [withdrawal.id]),
    ).rejects.toMatchObject({ code: '23001' });
    await expect(consents.getHistoryOwn(owner.user.id)).resolves.toHaveLength(4);
  });

  it('rejects unknown consent types and unbounded or blank policy versions before SQL', async () => {
    const owner = await createAccount();
    const noSource = { sourceIp: null, userAgent: null };

    await expect(
      consents.recordOwn(
        owner.user.id,
        {
          consentType: 'NOT_A_CONSENT' as ConsentType,
          granted: true,
          policyVersion: 'v1',
        },
        noSource,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      consents.recordOwn(
        owner.user.id,
        { consentType: ConsentType.TermsOfService, granted: true, policyVersion: '   ' },
        noSource,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      consents.recordOwn(
        owner.user.id,
        {
          consentType: ConsentType.TermsOfService,
          granted: true,
          policyVersion: 'v'.repeat(101),
        },
        noSource,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      consents.recordOwn(
        owner.user.id,
        {
          consentType: ConsentType.TermsOfService,
          granted: true,
          policyVersion: 'future-client-value',
        },
        noSource,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('requires current policy grants after a configured version change and preserves history', async () => {
    const owner = await createAccount();
    const source = { sourceIp: null, userAgent: 'policy-version-test' };
    await consents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.TermsOfService,
        granted: true,
        policyVersion: 'tos-test-v1',
      },
      source,
    );
    await consents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.PrivacyPolicy,
        granted: true,
        policyVersion: 'privacy-test-v1',
      },
      source,
    );
    await settings.updateOwn(owner.user.id, { discoveryEnabled: true });

    const nextPolicy = new ConsentPolicyService(
      loadConfig({
        ...process.env,
        CURRENT_TOS_VERSION: 'tos-test-v2',
        CURRENT_PRIVACY_POLICY_VERSION: 'privacy-test-v2',
      }),
    );
    const nextSettings = new SettingsService(AppDataSource, nextPolicy);
    const nextConsents = new ConsentService(AppDataSource, nextPolicy);

    await expect(
      nextSettings.updateOwn(owner.user.id, { discoveryEnabled: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      nextConsents.recordOwn(
        owner.user.id,
        {
          consentType: ConsentType.TermsOfService,
          granted: true,
          policyVersion: 'tos-test-v1',
        },
        source,
      ),
    ).rejects.toBeInstanceOf(ValidationError);

    await nextConsents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.TermsOfService,
        granted: true,
        policyVersion: 'tos-test-v2',
      },
      source,
    );
    await nextConsents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.PrivacyPolicy,
        granted: true,
        policyVersion: 'privacy-test-v2',
      },
      source,
    );
    await nextSettings.updateOwn(owner.user.id, { discoveryEnabled: false });
    await expect(
      nextSettings.updateOwn(owner.user.id, { discoveryEnabled: true }),
    ).resolves.toMatchObject({ discoveryEnabled: true });

    const history = await nextConsents.getHistoryOwn(owner.user.id);
    expect(history).toHaveLength(4);
    expect(history.map((event) => event.policyVersion)).toEqual(
      expect.arrayContaining([
        'tos-test-v1',
        'privacy-test-v1',
        'tos-test-v2',
        'privacy-test-v2',
      ]),
    );
  });

  it('cannot race a required-consent withdrawal with discovery re-enable', async () => {
    const owner = await createAccount();
    const source = { sourceIp: null, userAgent: 'consent-race-test' };
    await consents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.TermsOfService,
        granted: true,
        policyVersion: 'tos-test-v1',
      },
      source,
    );
    await consents.recordOwn(
      owner.user.id,
      {
        consentType: ConsentType.PrivacyPolicy,
        granted: true,
        policyVersion: 'privacy-test-v1',
      },
      source,
    );

    const [enableResult, withdrawalResult] = await Promise.allSettled([
      settings.updateOwn(owner.user.id, { discoveryEnabled: true }),
      consents.recordOwn(
        owner.user.id,
        {
          consentType: ConsentType.PrivacyPolicy,
          granted: false,
          policyVersion: 'privacy-test-v1',
        },
        source,
      ),
    ]);

    expect(withdrawalResult.status).toBe('fulfilled');
    expect(['fulfilled', 'rejected']).toContain(enableResult.status);
    await expect(settings.getOwn(owner.user.id)).resolves.toMatchObject({
      discoveryEnabled: false,
    });
    await expect(
      settings.updateOwn(owner.user.id, { discoveryEnabled: true }),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(consents.getCurrentOwn(owner.user.id)).resolves.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          consentType: ConsentType.PrivacyPolicy,
          granted: false,
          policyVersion: 'privacy-test-v1',
        }),
      ]),
    );
  });
});
