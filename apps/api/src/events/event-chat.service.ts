import { Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { z } from 'zod';

import { ChatRoomForbiddenError } from '../chat/chat.errors';
import { parseChat } from '../chat/chat.validation';
import { EventsRepository } from './events.repository';

/** Caller must hold the event lock in its existing transaction. Never allocates seats. */
export async function reconcileEventChat(manager: EntityManager, eventId: string, userId: string): Promise<string> {
  await manager.query(
    `INSERT INTO chat_rooms (type, event_id) VALUES ('EVENT', $1)
     ON CONFLICT (event_id) WHERE type = 'EVENT' DO NOTHING`, [eventId],
  );
  const [room]: { id: string }[] = await manager.query(
    `SELECT id FROM chat_rooms WHERE type = 'EVENT' AND event_id = $1 FOR UPDATE`, [eventId],
  );
  if (!room) throw new ChatRoomForbiddenError();
  // The existing PK makes retries safe. In particular, reconciliation must
  // neither reset a cursor nor revive a durable left_at membership.
  await manager.query(
    `INSERT INTO chat_members (room_id, user_id)
     SELECT $1, members.user_id FROM (
       SELECT host_user_id AS user_id FROM events WHERE id = $2 AND host_user_id IS NOT NULL
       UNION
       SELECT user_id FROM event_participants WHERE event_id = $2 AND cancelled_at IS NULL
     ) members ORDER BY members.user_id
     ON CONFLICT (room_id, user_id) DO NOTHING`, [room.id, eventId],
  );
  const active = await manager.query(
    `SELECT 1 FROM chat_members WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL`,
    [room.id, userId],
  );
  if (!active.length) throw new ChatRoomForbiddenError();
  return room.id;
}

@Injectable()
export class EventChatService {
  constructor(private readonly events: EventsRepository) {}

  /** Idempotent bootstrap for hosts and participants predating chat provisioning. */
  async resolveRoom(userId: string, eventId: string): Promise<{ roomId: string; canSend: boolean }> {
    parseChat(z.object({ userId: z.string().uuid(), eventId: z.string().uuid() }), { userId, eventId });
    return this.events.transaction(async (manager) => {
      const authorizedEvent = `SELECT e.status FROM events e
         WHERE e.id = $2 AND e.host_type = 'USER'
           AND e.status IN ('ACTIVE', 'FULL', 'IN_PROGRESS', 'COMPLETED')
           AND (e.host_user_id = $1 OR EXISTS (
             SELECT 1 FROM event_participants p
             WHERE p.event_id = e.id AND p.user_id = $1 AND p.cancelled_at IS NULL
           ))
         `;
      const locked = await manager.query(`${authorizedEvent} FOR UPDATE OF e`, [userId, eventId]);
      if (!locked.length) throw new ChatRoomForbiddenError();
      // A participant cancellation may have committed while the event lock was
      // pending. Re-read the subquery with a fresh READ COMMITTED snapshot.
      const [event]: { status: string }[] = await manager.query(authorizedEvent, [userId, eventId]);
      if (!event) throw new ChatRoomForbiddenError();
      const roomId = await reconcileEventChat(manager, eventId, userId);
      // Fresh account policy after any room-lock wait; denial rolls back bootstrap.
      const usable = await manager.query(
        `SELECT 1 FROM users u WHERE u.id = $1
           AND u.account_status = 'ACTIVE' AND u.deleted_at IS NULL
           AND NOT EXISTS (
             SELECT 1 FROM account_restrictions ar WHERE ar.user_id = u.id
               AND ar.type IN ('FULL_SUSPENSION', 'MESSAGING_SUSPENDED')
               AND ar.starts_at <= statement_timestamp()
               AND (ar.ends_at IS NULL OR ar.ends_at > statement_timestamp())
               AND ar.lifted_at IS NULL
           )
        `, [userId],
      );
      if (!usable.length) throw new ChatRoomForbiddenError();
      return { roomId, canSend: event.status !== 'COMPLETED' };
    });
  }
}
