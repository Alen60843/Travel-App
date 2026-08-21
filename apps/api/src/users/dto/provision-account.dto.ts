import { ConsentType } from '@tripwith/shared';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayMinSize,
  IsArray,
  IsIn,
  IsString,
  Matches,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';

const REQUIRED_CONSENT_TYPES = [ConsentType.TermsOfService, ConsentType.PrivacyPolicy] as const;

export class ProvisioningConsentDto {
  @IsIn(REQUIRED_CONSENT_TYPES)
  consentType!: (typeof REQUIRED_CONSENT_TYPES)[number];

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/\S/, { message: 'policyVersion must not be blank' })
  policyVersion!: string;
}

export class ProvisionAccountDto {
  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  dateOfBirth!: string;

  @IsString()
  @MinLength(2)
  @MaxLength(50)
  @Matches(/\S.*\S|\S/, { message: 'displayName must not be blank' })
  displayName!: string;

  @IsArray()
  @ArrayMinSize(2)
  @ArrayMaxSize(2)
  @ValidateNested({ each: true })
  @Type(() => ProvisioningConsentDto)
  requiredConsents!: ProvisioningConsentDto[];
}

