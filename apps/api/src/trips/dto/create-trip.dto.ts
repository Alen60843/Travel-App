import { TripVisibility } from '@tripwith/shared';
import { IsEnum, IsObject, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';

export class CreateTripDto {
  @IsString()
  @MinLength(1)
  @MaxLength(120)
  title!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  startDate!: string;

  @IsString()
  @Matches(/^\d{4}-\d{2}-\d{2}$/)
  endDate!: string;

  @IsOptional()
  @IsEnum(TripVisibility)
  visibility?: TripVisibility;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, unknown>;
}
