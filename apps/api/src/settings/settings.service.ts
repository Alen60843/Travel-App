import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import {
  ConsentType,
  MINIMUM_ACCOUNT_AGE_YEARS,
  TripVisibility,
} from '@tripwith/shared';
import { DataSource, type EntityManager } from 'typeorm';

import { NotFoundError, ValidationError } from '../common/errors/app-error';
import { consentLockKey } from '../consent/consent-lock';
import {
  ConsentPolicyService,
  REQUIRED_CONSENT_TYPES,
} from '../consent/consent-policy.service';
import { UserSettingsEntity } from '../database/entities';
import type { UpdateSettingsDto } from './update-settings.dto';

export interface UserSettingsView {
  readonly ghostModeEnabled: boolean;
  readonly ghostModeUntil: string | null;
  readonly discoveryEnabled: boolean;
  readonly tripVisibility: TripVisibility;
  readonly minAgePreference: number;
  readonly maxAgePreference: number;
  readonly minTrustScorePreference: number;
  readonly maxDistanceKm: number;
  readonly pushEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly locale: string;
  readonly timezone: string;
  readonly updatedAt: string;
}

const MAX_AGE = 120;
const MIN_TRUST = 0;
const MAX_TRUST = 10;
const MIN_DISTANCE_KM = 1;
const MAX_DISTANCE_KM = 20_000;
const SETTINGS_FIELDS: readonly (keyof UpdateSettingsDto)[] = [
  'ghostModeEnabled',
  'ghostModeUntil',
  'discoveryEnabled',
  'tripVisibility',
  'minAgePreference',
  'maxAgePreference',
  'minTrustScorePreference',
  'maxDistanceKm',
  'pushEnabled',
  'emailEnabled',
  'locale',
  'timezone',
];

@Injectable()
export class SettingsService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly consentPolicy: ConsentPolicyService,
  ) {}

  /**
   * Reads effective settings and durably expires timed Ghost Mode.
   *
   * The conditional UPDATE is concurrency-safe: PostgreSQL rechecks its
   * predicate after waiting for a concurrent row writer, so it cannot turn
   * off a newly extended Ghost Mode interval.
   */
  async getOwn(userId: string): Promise<UserSettingsView> {
    const repository = this.dataSource.getRepository(UserSettingsEntity);
    const current = await repository.findOneBy({ userId });
    if (!current) throw new NotFoundError('User settings');

    if (
      current.ghostModeEnabled &&
      current.ghostModeUntil !== null &&
      current.ghostModeUntil.getTime() <= Date.now()
    ) {
      await repository
        .createQueryBuilder()
        .update(UserSettingsEntity)
        .set({ ghostModeEnabled: false, ghostModeUntil: null })
        .where('user_id = :userId', { userId })
        .andWhere('ghost_mode_enabled = TRUE')
        .andWhere('ghost_mode_until IS NOT NULL')
        .andWhere('ghost_mode_until <= clock_timestamp()')
        .execute();
    }

    const effective = await repository.findOneBy({ userId });
    if (!effective) throw new NotFoundError('User settings');
    return this.toView(effective);
  }

  async updateOwn(userId: string, patch: UpdateSettingsDto): Promise<UserSettingsView> {
    if (!this.hasPatchValue(patch)) {
      throw new ValidationError('At least one settings field is required');
    }

    return this.dataSource.transaction(async (manager) => {
      if (patch.discoveryEnabled === true) {
        await this.assertRequiredConsentsGranted(manager, userId);
      }
      const repository = manager.getRepository(UserSettingsEntity);
      const settings = await repository.findOne({
        where: { userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!settings) throw new NotFoundError('User settings');

      const now = new Date();
      this.normalizeExpiredGhostMode(settings, now);
      this.applyPatch(settings, patch, now);
      await manager.save(settings);
      return this.toView(settings);
    });
  }

  private applyPatch(
    settings: UserSettingsEntity,
    patch: UpdateSettingsDto,
    now: Date,
  ): void {
    const nextMinAge = patch.minAgePreference ?? settings.minAgePreference;
    const nextMaxAge = patch.maxAgePreference ?? settings.maxAgePreference;
    this.assertIntegerRange(
      'minAgePreference',
      nextMinAge,
      MINIMUM_ACCOUNT_AGE_YEARS,
      MAX_AGE,
    );
    this.assertIntegerRange(
      'maxAgePreference',
      nextMaxAge,
      MINIMUM_ACCOUNT_AGE_YEARS,
      MAX_AGE,
    );
    if (nextMinAge > nextMaxAge) {
      throw new ValidationError('Minimum age preference cannot exceed maximum age preference', {
        field: 'minAgePreference',
      });
    }

    const nextTrust = patch.minTrustScorePreference ?? settings.minTrustScorePreference;
    if (!Number.isFinite(nextTrust) || nextTrust < MIN_TRUST || nextTrust > MAX_TRUST) {
      throw this.fieldError(
        'minTrustScorePreference',
        `must be between ${MIN_TRUST} and ${MAX_TRUST}`,
      );
    }

    const nextDistance = patch.maxDistanceKm ?? settings.maxDistanceKm;
    this.assertIntegerRange(
      'maxDistanceKm',
      nextDistance,
      MIN_DISTANCE_KM,
      MAX_DISTANCE_KM,
    );

    const nextGhostEnabled = patch.ghostModeEnabled ?? settings.ghostModeEnabled;
    let nextGhostUntil = settings.ghostModeUntil;
    if (patch.ghostModeUntil !== undefined) {
      nextGhostUntil =
        patch.ghostModeUntil === null
          ? null
          : this.parseFutureGhostExpiry(patch.ghostModeUntil, now);
    }
    if (
      nextGhostUntil !== null &&
      !nextGhostEnabled &&
      patch.ghostModeUntil !== undefined
    ) {
      throw this.fieldError('ghostModeUntil', 'requires Ghost Mode to be enabled');
    }
    if (!nextGhostEnabled) nextGhostUntil = null;
    if (nextGhostUntil !== null && nextGhostUntil.getTime() <= now.getTime()) {
      throw this.fieldError('ghostModeUntil', 'must be in the future');
    }

    if (patch.locale !== undefined) this.assertLocale(patch.locale);
    if (patch.timezone !== undefined) this.assertTimezone(patch.timezone);

    settings.ghostModeEnabled = nextGhostEnabled;
    settings.ghostModeUntil = nextGhostUntil;
    settings.discoveryEnabled = patch.discoveryEnabled ?? settings.discoveryEnabled;
    settings.tripVisibility = patch.tripVisibility ?? settings.tripVisibility;
    settings.minAgePreference = nextMinAge;
    settings.maxAgePreference = nextMaxAge;
    settings.minTrustScorePreference = nextTrust;
    settings.maxDistanceKm = nextDistance;
    settings.pushEnabled = patch.pushEnabled ?? settings.pushEnabled;
    settings.emailEnabled = patch.emailEnabled ?? settings.emailEnabled;
    settings.locale = patch.locale ?? settings.locale;
    settings.timezone = patch.timezone ?? settings.timezone;
  }

  private normalizeExpiredGhostMode(settings: UserSettingsEntity, now: Date): void {
    if (
      settings.ghostModeEnabled &&
      settings.ghostModeUntil !== null &&
      settings.ghostModeUntil.getTime() <= now.getTime()
    ) {
      settings.ghostModeEnabled = false;
      settings.ghostModeUntil = null;
    }
  }

  private parseFutureGhostExpiry(value: string, now: Date): Date {
    const expiry = new Date(value);
    if (!Number.isFinite(expiry.getTime()) || expiry.getTime() <= now.getTime()) {
      throw this.fieldError('ghostModeUntil', 'must be a valid future timestamp');
    }
    return expiry;
  }

  private assertIntegerRange(field: string, value: number, min: number, max: number): void {
    if (!Number.isInteger(value) || value < min || value > max) {
      throw this.fieldError(field, `must be an integer between ${min} and ${max}`);
    }
  }

  private assertLocale(value: string): void {
    if (value.length < 2 || value.length > 35 || value.trim() !== value) {
      throw this.fieldError('locale', 'must be a valid BCP 47 locale code');
    }
    try {
      // Intl.Locale validates the language tag without introducing a mutable
      // application-owned locale allow-list.
      new Intl.Locale(value);
    } catch {
      throw this.fieldError('locale', 'must be a valid BCP 47 locale code');
    }
  }

  private assertTimezone(value: string): void {
    if (value.length < 1 || value.length > 100 || value.trim() !== value) {
      throw this.fieldError('timezone', 'must be a valid IANA timezone');
    }
    try {
      new Intl.DateTimeFormat('en', { timeZone: value }).format();
    } catch {
      throw this.fieldError('timezone', 'must be a valid IANA timezone');
    }
  }

  /**
   * Lock ordering is consent advisory locks, then the settings row. Consent
   * withdrawals use the same order before forcing discovery off, avoiding a
   * withdrawal/re-enable race and its corresponding deadlock shape.
   */
  private async assertRequiredConsentsGranted(
    manager: EntityManager,
    userId: string,
  ): Promise<void> {
    for (const type of REQUIRED_CONSENT_TYPES) {
      await manager.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
        consentLockKey(userId, type),
      ]);
    }

    const rows = (await manager.query(
      `SELECT DISTINCT ON (consent_type)
              consent_type AS "consentType",
              granted,
              policy_version AS "policyVersion"
         FROM user_consents
        WHERE user_id = $1
          AND consent_type = ANY($2::consent_type[])
        ORDER BY consent_type, created_at DESC, id DESC`,
      [userId, REQUIRED_CONSENT_TYPES],
    )) as { consentType: ConsentType; granted: boolean; policyVersion: string }[];
    const latest = new Map(rows.map((row) => [row.consentType, row]));
    const missing = REQUIRED_CONSENT_TYPES.filter((type) => {
      const row = latest.get(type);
      return (
        row?.granted !== true ||
        !this.consentPolicy.isCurrent(type, row.policyVersion)
      );
    });
    if (missing.length > 0) {
      throw new ValidationError('Discovery requires current Terms and Privacy consent', {
        field: 'discoveryEnabled',
        missingConsents: missing,
      });
    }
  }

  private fieldError(field: string, rule: string): ValidationError {
    return new ValidationError(`Invalid ${field}: ${rule}`, { field });
  }

  private hasPatchValue(patch: UpdateSettingsDto): boolean {
    return SETTINGS_FIELDS.some((field) => patch[field] !== undefined);
  }

  private toView(settings: UserSettingsEntity): UserSettingsView {
    return {
      ghostModeEnabled: settings.ghostModeEnabled,
      ghostModeUntil: settings.ghostModeUntil?.toISOString() ?? null,
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
      updatedAt: settings.updatedAt.toISOString(),
    };
  }
}
