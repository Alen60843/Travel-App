import type { ChatRoomType, MessageType } from './enums';

/** Sequence values follow the API's safe-integer bigint convention. */
export interface ChatRoomView {
  readonly id: string;
  readonly type: ChatRoomType;
  readonly lastSeq: number;
  readonly lastReadSeq: number;
  readonly unreadCount: number;
  readonly lastMessageAt: string | null;
}

export interface SendChatMessage {
  readonly type: 'TEXT';
  readonly clientMessageId: string;
  readonly body: string;
}

export interface ChatMessageView {
  readonly id: string;
  readonly roomId: string;
  readonly seq: number;
  readonly senderUserId: string | null;
  readonly type: MessageType;
  /** Tombstones retain their position but never expose the deleted body. */
  readonly body: string | null;
  readonly clientMessageId: string | null;
  readonly createdAt: string;
  readonly deletedAt: string | null;
}

export interface ChatRoomPage {
  readonly rooms: readonly ChatRoomView[];
  readonly nextAfterRoomId: string | null;
}

export interface ChatMessagePage {
  /** Always ascending, including for backwards history pagination. */
  readonly messages: readonly ChatMessageView[];
  readonly highWaterSeq: number;
  readonly hasMore: boolean;
  /** Catch-up: pass this as afterSeq; advances across tombstones/absent rows. */
  readonly nextAfterSeq: number | null;
  /** History: pass this as beforeSeq. Null when history is exhausted. */
  readonly nextBeforeSeq: number | null;
}
