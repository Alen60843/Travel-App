import { ChatRoomType, MessageType, SwipeDirection } from '@tripwith/shared';
import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  JoinColumn,
  ManyToOne,
  OneToMany,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

import type { GeoPoint } from '../geo/geo-point';
import { bigintTransformer } from './transformers';

/**
 * SOCIAL MATCHING domain — swipes, matches and chat. chat_rooms.last_seq and
 * messages.seq are the gapless per-room ordering pair maintained entirely by
 * triggers (tw_assign_message_seq); both are mapped read-only here.
 */

@Entity('swipes')
export class SwipeEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'source_user_id' })
  sourceUserId!: string;

  @Column({ type: 'uuid', name: 'target_user_id' })
  targetUserId!: string;

  @Column({
    type: 'enum',
    enum: SwipeDirection,
    enumName: 'swipe_direction',
    name: 'direction',
  })
  direction!: SwipeDirection;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;
}

@Entity('chat_rooms')
export class ChatRoomEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({
    type: 'enum',
    enum: ChatRoomType,
    enumName: 'chat_room_type',
    name: 'type',
  })
  type!: ChatRoomType;

  @Column({ type: 'uuid', name: 'event_id', nullable: true })
  eventId!: string | null;

  @Column({ type: 'uuid', name: 'provider_id', nullable: true })
  providerId!: string | null;

  /**
   * Monotonic per-room message counter, advanced only by
   * tw_assign_message_seq. Unread counts are last_seq - chat_members's
   * last_read_seq (O(1), no COUNT(*)) — never write this column.
   */
  @Column({
    type: 'bigint',
    name: 'last_seq',
    transformer: bigintTransformer,
    insert: false,
    update: false,
  })
  readonly lastSeq!: number;

  @Column({ type: 'timestamptz', name: 'last_message_at', nullable: true })
  lastMessageAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @OneToMany(() => MessageEntity, (message) => message.room)
  messages?: MessageEntity[];

  @OneToMany(() => ChatMemberEntity, (member) => member.room)
  members?: ChatMemberEntity[];
}

@Entity('matches')
export class MatchEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  /** Canonical ordering (user_a_id < user_b_id) — enforced by a DB CHECK, not here. */
  @Column({ type: 'uuid', name: 'user_a_id' })
  userAId!: string;

  @Column({ type: 'uuid', name: 'user_b_id' })
  userBId!: string;

  @Column({ type: 'uuid', name: 'chat_room_id' })
  chatRoomId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'matched_at' })
  readonly matchedAt!: Date;

  @Column({ type: 'timestamptz', name: 'unmatched_at', nullable: true })
  unmatchedAt!: Date | null;

  @Column({ type: 'uuid', name: 'unmatched_by_user_id', nullable: true })
  unmatchedByUserId!: string | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @ManyToOne(() => ChatRoomEntity)
  @JoinColumn({ name: 'chat_room_id' })
  chatRoom?: ChatRoomEntity;
}

@Entity('chat_members')
export class ChatMemberEntity {
  @PrimaryColumn({ type: 'uuid', name: 'room_id' })
  roomId!: string;

  @PrimaryColumn({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'joined_at' })
  readonly joinedAt!: Date;

  @Column({ type: 'timestamptz', name: 'left_at', nullable: true })
  leftAt!: Date | null;

  /** App-writable read cursor — advanced when the member reads new messages. */
  @Column({
    type: 'bigint',
    name: 'last_read_seq',
    transformer: bigintTransformer,
  })
  lastReadSeq!: number;

  @Column({ type: 'timestamptz', name: 'muted_until', nullable: true })
  mutedUntil!: Date | null;

  @Column({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @ManyToOne(() => ChatRoomEntity, (room) => room.members)
  @JoinColumn({ name: 'room_id' })
  room?: ChatRoomEntity;
}

@Entity('messages')
export class MessageEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'room_id' })
  roomId!: string;

  /**
   * Assigned by tw_assign_message_seq (BEFORE INSERT trigger) from
   * chat_rooms.last_seq — gapless and totally ordered within a room, unlike
   * created_at which can tie under clock skew. insert:false means the
   * trigger's NEW.seq assignment is what lands in the row regardless of
   * whatever this property held before save(); never set it explicitly.
   */
  @Column({
    type: 'bigint',
    name: 'seq',
    transformer: bigintTransformer,
    insert: false,
    update: false,
  })
  readonly seq!: number;

  /** NULL only for SYSTEM messages. */
  @Column({ type: 'uuid', name: 'sender_user_id', nullable: true })
  senderUserId!: string | null;

  @Column({
    type: 'enum',
    enum: MessageType,
    enumName: 'message_type',
    name: 'type',
  })
  type!: MessageType;

  @Column({ type: 'text', name: 'body', nullable: true })
  body!: string | null;

  @Column({ type: 'text', name: 'media_storage_key', nullable: true })
  mediaStorageKey!: string | null;

  /**
   * User-initiated point share inside a conversation. Explicit, one-shot,
   * and never read by any discovery query — distinct from passive tracking.
   */
  @Column({
    type: 'geography',
    spatialFeatureType: 'Point',
    srid: 4326,
    name: 'shared_location',
    nullable: true,
  })
  sharedLocation!: GeoPoint | null;

  /** Client-supplied dedupe key; makes send-retry safe over flaky mobile links. */
  @Column({ type: 'text', name: 'client_message_id', nullable: true })
  clientMessageId!: string | null;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @Column({ type: 'timestamptz', name: 'edited_at', nullable: true })
  editedAt!: Date | null;

  /** Soft: moderation must retain evidence even after a "delete". */
  @DeleteDateColumn({ type: 'timestamptz', name: 'deleted_at' })
  deletedAt!: Date | null;

  @ManyToOne(() => ChatRoomEntity, (room) => room.messages)
  @JoinColumn({ name: 'room_id' })
  room?: ChatRoomEntity;
}
