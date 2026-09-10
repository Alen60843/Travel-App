import { Injectable } from '@nestjs/common';
import type { ChatMessagePage, ChatMessageView, ChatRoomPage, ChatRoomView } from '@tripwith/shared';
import { DataSource, type EntityManager } from 'typeorm';
import { z } from 'zod';

import { ValidationError } from '../common/errors/app-error';
import { bigintTransformer } from '../database/entities/transformers';
import { ChatMessageConflictError, ChatRoomForbiddenError } from './chat.errors';
import {
  chatIdentitySchema, historyChatSchema, listChatSchema, parseChat,
  readChatSchema, sendChatMessageSchema,
} from './chat.validation';

interface RoomRow {
  id: string;
  type: ChatRoomView['type'];
  last_seq: string;
  last_read_seq: string;
  last_message_at: Date | null;
}
interface MessageRow {
  id: string;
  room_id: string;
  seq: string;
  sender_user_id: string | null;
  type: ChatMessageView['type'];
  body: string | null;
  client_message_id: string | null;
  created_at: Date;
  deleted_at: Date | null;
}

// Discovery preferences and MATCHING_SUSPENDED are deliberately not chat bans.
const usableAccount = (alias: string) => `
  ${alias}.account_status = 'ACTIVE' AND ${alias}.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM account_restrictions ar WHERE ar.user_id = ${alias}.id
      AND ar.type IN ('FULL_SUSPENSION', 'MESSAGING_SUSPENDED')
      AND ar.starts_at <= statement_timestamp()
      AND (ar.ends_at IS NULL OR ar.ends_at > statement_timestamp())
      AND ar.lifted_at IS NULL
  )`;

// One policy for listing, joins, history, sends and read cursors. $1 is always
// the authenticated internal user ID, never an ID taken from a message body.
const authorizedRooms = `
  FROM chat_rooms r
  JOIN chat_members cm ON cm.room_id = r.id AND cm.user_id = $1 AND cm.left_at IS NULL
  JOIN users u ON u.id = cm.user_id
  WHERE ${usableAccount('u')}
    AND (r.type <> 'MATCH' OR EXISTS (
      SELECT 1 FROM matches m
      JOIN users peer ON peer.id = CASE WHEN m.user_a_id = $1 THEN m.user_b_id ELSE m.user_a_id END
      WHERE m.chat_room_id = r.id AND m.unmatched_at IS NULL
        AND $1 IN (m.user_a_id, m.user_b_id)
        AND ${usableAccount('peer')}
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
          WHERE b.blocker_user_id = $1 AND b.blocked_user_id = peer.id)
        AND NOT EXISTS (SELECT 1 FROM user_blocks b
          WHERE b.blocker_user_id = peer.id AND b.blocked_user_id = $1)
    ))`;
const roomColumns = 'r.id, r.type, r.last_seq, r.last_message_at, cm.last_read_seq';
const messageColumns = 'id, room_id, seq, sender_user_id, type, body, client_message_id, created_at, deleted_at';

function toRoom(row: RoomRow): ChatRoomView {
  const lastSeq = bigintTransformer.from(row.last_seq) as number;
  const lastReadSeq = bigintTransformer.from(row.last_read_seq) as number;
  return {
    id: row.id, type: row.type, lastSeq, lastReadSeq,
    unreadCount: lastSeq - lastReadSeq,
    lastMessageAt: row.last_message_at?.toISOString() ?? null,
  };
}

function toMessage(row: MessageRow): ChatMessageView {
  return {
    id: row.id, roomId: row.room_id, seq: bigintTransformer.from(row.seq) as number,
    senderUserId: row.sender_user_id, type: row.type,
    body: row.deleted_at ? null : row.body,
    clientMessageId: row.client_message_id,
    createdAt: row.created_at.toISOString(), deletedAt: row.deleted_at?.toISOString() ?? null,
  };
}

@Injectable()
export class ChatService {
  constructor(private readonly dataSource: DataSource) {}

  /** Recheck this for every operation; Socket.IO room membership is not proof. */
  async authorizeRoom(userId: string, roomId: string): Promise<ChatRoomView> {
    parseChat(chatIdentitySchema, { userId, roomId });
    return toRoom(await this.authorizedRoom(this.dataSource.manager, userId, roomId));
  }

  async listRooms(userId: string, input: unknown = {}): Promise<ChatRoomPage> {
    parseChat(z.string().uuid(), userId);
    const query = parseChat(listChatSchema, input);
    const rows: RoomRow[] = await this.dataSource.query(
      `SELECT ${roomColumns} ${authorizedRooms}
       AND ($2::uuid IS NULL OR r.id > $2) ORDER BY r.id LIMIT $3`,
      [userId, query.afterRoomId ?? null, query.limit + 1],
    );
    const rooms = rows.slice(0, query.limit).map(toRoom);
    return { rooms, nextAfterRoomId: rows.length > query.limit ? rooms.at(-1)!.id : null };
  }

  async sendMessage(userId: string, roomId: string, input: unknown): Promise<ChatMessageView> {
    parseChat(chatIdentitySchema, { userId, roomId });
    const message = parseChat(sendChatMessageSchema, input);
    return this.withRoom(userId, roomId, async (manager) => {
      // Acquire the trigger's room lock BEFORE looking up the dedupe key.
      // A losing concurrent retry sees the committed row in this new statement.
      const [existing]: MessageRow[] = await manager.query(
        `SELECT ${messageColumns} FROM messages
         WHERE room_id = $1 AND sender_user_id = $2 AND client_message_id = $3`,
        [roomId, userId, message.clientMessageId],
      );
      if (existing) {
        if (existing.type !== message.type || existing.body !== message.body) {
          throw new ChatMessageConflictError();
        }
        return toMessage(existing);
      }
      // No seq, sender override, timestamp override, or ON CONFLICT. The trigger
      // allocates the sequence transactionally; any failure rolls it back too.
      const [inserted]: MessageRow[] = await manager.query(
        `INSERT INTO messages (room_id, sender_user_id, type, body, client_message_id)
         VALUES ($1, $2, 'TEXT', $3, $4) RETURNING ${messageColumns}`,
        [roomId, userId, message.body, message.clientMessageId],
      );
      return toMessage(inserted!);
    });
  }

  async history(userId: string, roomId: string, input: unknown = {}): Promise<ChatMessagePage> {
    parseChat(chatIdentitySchema, { userId, roomId });
    const query = parseChat(historyChatSchema, input);
    return this.withRoom(userId, roomId, async (manager, room) => {
      const highWaterSeq = toRoom(room).lastSeq;
      const catchingUp = query.afterSeq !== undefined;
      if (catchingUp && query.afterSeq! > highWaterSeq) {
        throw new ValidationError('afterSeq exceeds the room high-water sequence.');
      }
      const rows: MessageRow[] = await manager.query(
        `SELECT ${messageColumns} FROM messages
         WHERE room_id = $1 AND seq <= $2
           AND ($3::bigint IS NULL OR seq > $3)
           AND ($4::bigint IS NULL OR seq < $4)
         ORDER BY seq ${catchingUp ? 'ASC' : 'DESC'} LIMIT $5`,
        [roomId, room.last_seq, query.afterSeq ?? null, query.beforeSeq ?? null, query.limit + 1],
      );
      const hasMore = rows.length > query.limit;
      const messages = rows.slice(0, query.limit).map(toMessage);
      if (!catchingUp) messages.reverse();
      return {
        messages, highWaterSeq, hasMore,
        nextAfterSeq: catchingUp ? (hasMore ? messages.at(-1)!.seq : highWaterSeq) : null,
        nextBeforeSeq: !catchingUp && hasMore ? messages[0]!.seq : null,
      };
    });
  }

  async advanceReadCursor(userId: string, roomId: string, input: unknown): Promise<ChatRoomView> {
    parseChat(chatIdentitySchema, { userId, roomId });
    const { lastReadSeq } = parseChat(readChatSchema, input);
    return this.withRoom(userId, roomId, async (manager, room) => {
      const [rows]: [{ last_read_seq: string }[], number] = await manager.query(
        `UPDATE chat_members
         SET last_read_seq = GREATEST(last_read_seq, LEAST($3::bigint, $4::bigint))
         WHERE room_id = $1 AND user_id = $2 AND left_at IS NULL RETURNING last_read_seq`,
        [roomId, userId, lastReadSeq, room.last_seq],
      );
      if (!rows[0]) throw new ChatRoomForbiddenError();
      return toRoom({ ...room, last_read_seq: rows[0].last_read_seq });
    });
  }

  private async authorizedRoom(manager: EntityManager, userId: string, roomId: string): Promise<RoomRow> {
    const [room]: RoomRow[] = await manager.query(
      `SELECT ${roomColumns} ${authorizedRooms} AND r.id = $2`, [userId, roomId],
    );
    if (!room) throw new ChatRoomForbiddenError();
    return room;
  }

  private async withRoom<T>(
    userId: string, roomId: string,
    action: (manager: EntityManager, room: RoomRow) => Promise<T>,
  ): Promise<T> {
    return this.dataSource.transaction('READ COMMITTED', async (manager) => {
      // Avoid allowing nonmembers to lock arbitrary rooms. Recheck all policy
      // in a separate statement AFTER any lock wait, with a fresh snapshot.
      const locked = await manager.query(
        `SELECT r.id FROM chat_rooms r JOIN chat_members cm ON cm.room_id = r.id
         WHERE r.id = $1 AND cm.user_id = $2 AND cm.left_at IS NULL FOR UPDATE OF r`,
        [roomId, userId],
      );
      if (!locked.length) throw new ChatRoomForbiddenError();
      const room = await this.authorizedRoom(manager, userId, roomId);
      return action(manager, room);
    });
  }
}
