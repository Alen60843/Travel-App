import { MINIMUM_ACCOUNT_AGE_YEARS, TripVisibility } from '@tripwith/shared';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsISO8601,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

/**
 * Owner-editable matching, notification and privacy preferences.
 *
 * Cross-field rules (age ordering and Ghost Mode's enabled/until pairing)
 * depend on both the persisted row and this partial patch, so the service
 * validates them while holding the settings row lock.
 */
export class UpdateSettingsDto {
  @IsOptional()
  @IsBoolean()
  ghostModeEnabled?: boolean;

  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsISO8601({ strict: true })
  ghostModeUntil?: string | null;

  @IsOptional()
  @IsBoolean()
  discoveryEnabled?: boolean;

  @IsOptional()
  @IsEnum(TripVisibility)
  tripVisibility?: TripVisibility;

  @IsOptional()
  @IsInt()
  @Min(MINIMUM_ACCOUNT_AGE_YEARS)
  @Max(120)
  minAgePreference?: number;

  @IsOptional()
  @IsInt()
  @Min(MINIMUM_ACCOUNT_AGE_YEARS)
  @Max(120)
  maxAgePreference?: number;

  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  minTrustScorePreference?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(20_000)
  maxDistanceKm?: number;

  @IsOptional()
  @IsBoolean()
  pushEnabled?: boolean;

  @IsOptional()
  @IsBoolean()
  emailEnabled?: boolean;

  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(35)
  locale?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  timezone?: string;
}
