import { EventVisibility } from '@tripwith/shared';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateIf,
} from 'class-validator';

const EVENT_TIMESTAMP =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Mutable draft fields only. Global whitelist validation rejects lifecycle/host projections. */
export class UpdateEventDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  categoryId?: number;

  @IsOptional()
  @IsString()
  @MinLength(3)
  @MaxLength(140)
  title?: string;

  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  description?: string | null;

  @IsOptional()
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10_000)
  capacityMax?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  priceMinor?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  depositMinor?: number;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @IsOptional()
  @IsString()
  @Matches(EVENT_TIMESTAMP)
  startsAt?: string;

  @IsOptional()
  @IsString()
  @Matches(EVENT_TIMESTAMP)
  endsAt?: string;

  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  longitude?: number;

  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  meetingPointLabel?: string | null;

  @IsOptional()
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  minTrustScore?: number;

  @IsOptional()
  @IsBoolean()
  joinApprovalRequired?: boolean;

  @IsOptional()
  @ValidateIf((_object, value: unknown) => value !== null)
  @IsString()
  cancellationPolicy?: string | null;
}
