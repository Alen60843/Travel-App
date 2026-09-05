import { EventVisibility } from '@tripwith/shared';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNumber,
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
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(2_147_483_647)
  categoryId?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MinLength(3)
  @MaxLength(140)
  title?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  description?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsEnum(EventVisibility)
  visibility?: EventVisibility;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10_000)
  capacityMax?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  priceMinor?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(2_147_483_647)
  depositMinor?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(/^[A-Z]{3}$/)
  currency?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(EVENT_TIMESTAMP)
  startsAt?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @Matches(EVENT_TIMESTAMP)
  endsAt?: string;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-90)
  @Max(90)
  latitude?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber({ allowInfinity: false, allowNaN: false })
  @Min(-180)
  @Max(180)
  longitude?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  meetingPointLabel?: string | null;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsNumber({ allowInfinity: false, allowNaN: false, maxDecimalPlaces: 2 })
  @Min(0)
  @Max(10)
  minTrustScore?: number;

  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsBoolean()
  joinApprovalRequired?: boolean;

  @ValidateIf((_object, value: unknown) => value !== undefined && value !== null)
  @IsString()
  cancellationPolicy?: string | null;
}
