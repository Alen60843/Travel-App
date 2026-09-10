import type { ChatMessagePage, ChatMessageView, ChatRoomView, SendChatMessage } from '@tripwith/shared';
import type { Server, Socket } from 'socket.io';

import type { RealtimeSocketData } from '../../realtime/realtime-socket.types';

export type ChatErrorCode = 'UNAUTHENTICATED' | 'VALIDATION_FAILED' | 'CHAT_ROOM_FORBIDDEN'
  | 'CHAT_MESSAGE_CONFLICT' | 'CHAT_ROOM_UNSUPPORTED' | 'INTERNAL_ERROR';
export type ChatAck<T> = { ok: true; data: T } | { ok: false; error: { code: ChatErrorCode; message: string } };
export type ChatReply<T> = (ack: ChatAck<T>) => void;

export interface ChatClientEvents {
  'chat:join': (input: { roomId: string }, ack: ChatReply<ChatRoomView>) => void;
  'chat:send': (input: { roomId: string; message: SendChatMessage }, ack: ChatReply<ChatMessageView>) => void;
  'chat:catch-up': (input: { roomId: string; afterSeq: number; limit?: number }, ack: ChatReply<ChatMessagePage>) => void;
}
export interface ChatServerEvents {
  /** Best-effort; duplicates/out-of-order delivery reconcile by roomId + seq. */
  'chat:message': (message: ChatMessageView) => void;
}
export interface ChatCommitted {
  roomId: string;
  seq: number;
}
export interface ChatInterServerEvents {
  /** No content crosses the adapter: each socket owner loads it through N1. */
  'chat:committed': (reference: ChatCommitted) => void;
}
export type ChatSocket = Socket<ChatClientEvents, ChatServerEvents, ChatInterServerEvents, RealtimeSocketData>;
export type ChatServer = Server<ChatClientEvents, ChatServerEvents, ChatInterServerEvents, RealtimeSocketData>;
