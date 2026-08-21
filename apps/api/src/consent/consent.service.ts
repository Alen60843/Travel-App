import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { ConsentType } from '@tripwith/shared';
import { DataSource } from 'typeorm';

import { ValidationError } from '../common/errors/app-error';
import { consentLockKey } from './consent-lock';
import { ConsentPolicyService } from './consent-policy.service';
import type { RecordConsentDto } from './record-consent.dto';

export interface ConsentSourceMetadata {
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
}

export interface ConsentEventView {
  readonly id: string;
  readonly consentType: ConsentType;
  readonly granted: boolean;
  readonly policyVersion: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly createdAt: string;
}

interface ConsentRow {
  readonly id: string;
  readonly consentType: ConsentType;
  readonly granted: boolean;
  readonly policyVersion: string;
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
  readonly createdAt: Date;
}

const CONSENT_TYPES = new Set<ConsentType>(Object.values(ConsentType));
const REQUIRED_DISCOVERY_CONSENTS = new Set<ConsentType>([
  ConsentType.TermsOfService,
  ConsentType.PrivacyPolicy,
]);
const MAX_POLICY_VERSION_LENGTH = 100;

@Injectable()
export class ConsentService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly consentPolicy: ConsentPolicyService,
  ) {}

  /**
   * Records both grants and withdrawals by INSERT only.
   *
   * The transaction-scoped advisory lock orders competing events for one
   * user/type. clock_timestamp() is intentionally used after acquiring the
   * lock (rather than transaction-start now()) so the current-state ordering
   * reflects the order in which events were durably appended.
   */
  async recordOwn(
    userId: string,
    input: RecordConsentDto,
    source: ConsentSourceMetadata,
  ): Promise<ConsentEventView> {
    this.assertInput(input);
    const policyVersion = input.policyVersion.trim();
    this.consentPolicy.assertCurrentRequiredVersion(input.consentType, policyVersion);

    return this.dataSource.transaction(async (manager) => {
      await manager.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1, 0))',
        [consentLockKey(userId, input.consentType)],
      );
      const rows = (await manager.query(
        `INSERT INTO user_consents
           (user_id, consent_type, granted, policy_version, source_ip, user_agent, created_at)
         VALUES ($1, $2, $3, $4, $5::inet, $6, clock_timestamp())
         RETURNING id,
                   consent_type AS "consentType",
                   granted,
                   policy_version AS "policyVersion",
                   host(source_ip) AS "sourceIp",
                   user_agent AS "userAgent",
                   created_at AS "createdAt"`,
        [
          userId,
          input.consentType,
          input.granted,
          policyVersion,
          source.sourceIp,
          source.userAgent,
        ],
      )) as ConsentRow[];
      // A required-consent withdrawal and the discoverability change are one
      // atomic state transition. History remains append-only; only the
      // independently mutable settings projection is switched off.
      if (!input.granted && REQUIRED_DISCOVERY_CONSENTS.has(input.consentType)) {
        await manager.query(
          'UPDATE user_settings SET discovery_enabled = FALSE WHERE user_id = $1',
          [userId],
        );
      }
      return this.toView(rows[0]);
    });
  }

  async getCurrentOwn(userId: string): Promise<readonly ConsentEventView[]> {
    const rows = (await this.dataSource.query(
      `SELECT DISTINCT ON (consent_type)
              id,
              consent_type AS "consentType",
              granted,
              policy_version AS "policyVersion",
              host(source_ip) AS "sourceIp",
              user_agent AS "userAgent",
              created_at AS "createdAt"
         FROM user_consents
        WHERE user_id = $1
        ORDER BY consent_type, created_at DESC, id DESC`,
      [userId],
    )) as ConsentRow[];
    return rows.map((row) => this.toView(row));
  }

  async getHistoryOwn(userId: string): Promise<readonly ConsentEventView[]> {
    const rows = (await this.dataSource.query(
      `SELECT id,
              consent_type AS "consentType",
              granted,
              policy_version AS "policyVersion",
              host(source_ip) AS "sourceIp",
              user_agent AS "userAgent",
              created_at AS "createdAt"
         FROM user_consents
        WHERE user_id = $1
        ORDER BY created_at DESC, id DESC`,
      [userId],
    )) as ConsentRow[];
    return rows.map((row) => this.toView(row));
  }

  private assertInput(input: RecordConsentDto): void {
    if (!CONSENT_TYPES.has(input.consentType)) {
      throw new ValidationError('Invalid consent type', { field: 'consentType' });
    }
    if (typeof input.granted !== 'boolean') {
      throw new ValidationError('Consent grant state must be boolean', { field: 'granted' });
    }
    const policyVersion =
      typeof input.policyVersion === 'string' ? input.policyVersion.trim() : '';
    if (
      typeof input.policyVersion !== 'string' ||
      [...policyVersion].length === 0 ||
      [...policyVersion].length > MAX_POLICY_VERSION_LENGTH ||
      input.policyVersion.includes('\0')
    ) {
      throw new ValidationError('Policy version must be nonempty and at most 100 characters', {
        field: 'policyVersion',
      });
    }
  }

  private toView(row: ConsentRow | undefined): ConsentEventView {
    if (!row) throw new Error('Consent insert did not return a row');
    return {
      id: row.id,
      consentType: row.consentType,
      granted: row.granted,
      policyVersion: row.policyVersion,
      sourceIp: row.sourceIp,
      userAgent: row.userAgent,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
