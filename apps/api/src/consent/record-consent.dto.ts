import { ConsentType } from '@tripwith/shared';
import { IsBoolean, IsEnum, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class RecordConsentDto {
  @IsEnum(ConsentType)
  consentType!: ConsentType;

  /** `false` records withdrawal as a new event; history is never mutated. */
  @IsBoolean()
  granted!: boolean;

  @IsString()
  @MinLength(1)
  @MaxLength(100)
  @Matches(/\S/, { message: 'policyVersion must not be blank' })
  policyVersion!: string;
}
