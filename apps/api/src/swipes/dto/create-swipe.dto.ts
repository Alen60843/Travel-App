import { SwipeDirection } from '@tripwith/shared';
import { IsEnum, IsUUID } from 'class-validator';

export class CreateSwipeDto {
  @IsUUID('4')
  targetUserId!: string;

  @IsEnum(SwipeDirection)
  direction!: SwipeDirection;
}
