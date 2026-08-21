import { ArrayMaxSize, ArrayUnique, IsArray, IsInt, Min } from 'class-validator';

export class ReplaceInterestsDto {
  @IsArray()
  @ArrayMaxSize(100)
  @ArrayUnique()
  @IsInt({ each: true })
  @Min(1, { each: true })
  interestIds!: number[];
}

