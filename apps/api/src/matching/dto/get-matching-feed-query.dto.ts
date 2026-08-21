import { Transform, Type } from 'class-transformer';
import {
  ArrayMaxSize,
  ArrayUnique,
  IsArray,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

function queryIntegerArray(value: unknown): unknown[] {
  const values = Array.isArray(value) ? value : [value];
  return values.map((entry) =>
    typeof entry === 'string' && entry.trim() !== '' ? Number(entry) : entry,
  );
}

export class GetMatchingFeedQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  @MaxLength(2_048)
  cursor?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  homeCountryCode?: string;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2,3}$/)
  nativeLanguageCode?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(18)
  @Max(120)
  minAge?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(18)
  @Max(120)
  maxAge?: number;

  @IsOptional()
  @Transform(({ value }: { value: unknown }) => queryIntegerArray(value))
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  interestIds?: number[];
}
