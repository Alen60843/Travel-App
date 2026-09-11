import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error';
import { ChatService } from '../chat.service';
import { parseChat } from '../chat.validation';
import { PresenceStore } from './presence.store';

export const presenceRequest = z.object({ roomId: z.string().uuid(), targetUserId: z.string().uuid() }).strict();
export type PresenceTarget = z.infer<typeof presenceRequest>;

@Injectable()
export class PresenceService {
  constructor(
    private readonly chat: ChatService,
    private readonly database: DataSource,
    private readonly store: PresenceStore,
  ) {}

  async query(userId: string, input: unknown) {
    const target = parseChat(presenceRequest, input);
    await this.authorize(userId, target);
    const state = await this.store.read(target.targetUserId);
    // Redis can be slow: never deliver under a policy checked before that wait.
    await this.authorize(userId, target);
    return { ...target, ...state };
  }

  private async authorize(userId: string, { roomId, targetUserId }: PresenceTarget): Promise<void> {
    if (userId === targetUserId) throw new AppError('PRESENCE_FORBIDDEN', 'Presence unavailable.');
    try {
      const rooms = await Promise.all([
        this.chat.authorizeRoom(userId, roomId),
        this.chat.authorizeRoom(targetUserId, roomId),
      ]);
      // Match Chat transport's fail-closed EVENT policy until N1 owns lifecycle.
      if (rooms.some((room) => room.type === 'EVENT')) throw new Error('Unsupported room');
      // N1 checks pair blocks for MATCH; presence also needs this for group rooms.
      const blocked: unknown[] = await this.database.query(
        `SELECT 1 FROM user_blocks
         WHERE (blocker_user_id = $1 AND blocked_user_id = $2)
            OR (blocker_user_id = $2 AND blocked_user_id = $1) LIMIT 1`, [userId, targetUserId],
      );
      if (blocked.length) throw new Error('Blocked');
    } catch {
      // Unknown targets, unusable accounts and lost memberships are identical.
      throw new AppError('PRESENCE_FORBIDDEN', 'Presence unavailable.');
    }
  }
}
