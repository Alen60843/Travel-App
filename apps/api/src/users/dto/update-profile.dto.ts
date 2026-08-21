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
  ValidateIf,
} from 'class-validator';

export class UpdateProfileDto {
  @ValidateIf((_object, value: unknown) => value !== undefined)
  @IsString()
  @MaxLength(50)
  displayName?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  bio?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[A-Z]{2}$/)
  homeCountryCode?: string | null;

  @IsOptional()
  @IsString()
  @Matches(/^[a-z]{2,3}$/)
  nativeLanguageCode?: string | null;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(20)
  @ArrayUnique()
  @IsString({ each: true })
  @Matches(/^[a-z]{2,3}$/, { each: true })
  languagesSpoken?: string[];

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(5)
  travelStyle?: number;
}
