import { Inject, Injectable } from '@nestjs/common';
import { ConsentType } from '@tripwith/shared';

import { ValidationError } from '../common/errors/app-error';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

export const REQUIRED_CONSENT_TYPES = [
  ConsentType.TermsOfService,
  ConsentType.PrivacyPolicy,
] as const;

type RequiredConsentType = (typeof REQUIRED_CONSENT_TYPES)[number];

/**
 * Single server-owned authority for the currently effective required policy
 * versions. Client-supplied version strings are attestations to these values,
 * never a way to define which policy is current.
 */
@Injectable()
export class ConsentPolicyService {
  constructor(@Inject(APP_CONFIG) private readonly config: AppConfig) {}

  isRequired(type: ConsentType): type is RequiredConsentType {
    return (REQUIRED_CONSENT_TYPES as readonly ConsentType[]).includes(type);
  }

  currentVersion(type: RequiredConsentType): string {
    return type === ConsentType.TermsOfService
      ? this.config.consentPolicy.currentTermsOfServiceVersion
      : this.config.consentPolicy.currentPrivacyPolicyVersion;
  }

  isCurrent(type: ConsentType, version: string): boolean {
    return !this.isRequired(type) || version === this.currentVersion(type);
  }

  assertCurrentRequiredVersion(type: ConsentType, version: string): void {
    if (this.isRequired(type) && version !== this.currentVersion(type)) {
      throw new ValidationError('Required consent must reference the current policy version', {
        field: 'policyVersion',
        consentType: type,
      });
    }
  }
}
