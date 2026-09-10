import { Logger } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayInit, SubscribeMessage, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import { z } from 'zod';

import { AppError } from '../../common/errors/app-error';
import { chatRoom } from '../../realtime/rooms';
import { ChatService } from '../chat.service';
import { parseChat, sendChatMessageSchema } from '../chat.validation';
import type { ChatAck, ChatCommitted, ChatErrorCode, ChatServer, ChatSocket } from './chat.events';

const roomRequest = z.object({ roomId: z.string().uuid() }).strict();
const sequence = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const sendRequest = roomRequest.extend({ message: sendChatMessageSchema });
const catchUpRequest = roomRequest.extend({ afterSeq: sequence, limit: z.number().int().min(1).max(100).optional() });
const committedReference = roomRequest.extend({ seq: sequence.min(1) });
const errors: Partial<Record<ChatErrorCode, string>> = {
  UNAUTHENTICATED: 'Authentication required.',
  VALIDATION_FAILED: 'Invalid chat request.',
  CHAT_ROOM_FORBIDDEN: 'This chat room is unavailable.',
  CHAT_MESSAGE_CONFLICT: 'This clientMessageId was used for a different message.',
  CHAT_ROOM_UNSUPPORTED: 'Event chat is not available yet.',
};

@WebSocketGateway()
export class ChatGateway implements OnGatewayInit {
  @WebSocketServer()
  server!: ChatServer;
  private readonly logger = new Logger(ChatGateway.name);

  constructor(private readonly chat: ChatService) {}

  afterInit(server: ChatServer): void {
    server.on('chat:committed', (reference) => { void this.deliver(reference); });
  }

  @SubscribeMessage('chat:join')
  join(@ConnectedSocket() socket: ChatSocket, @MessageBody() input: unknown) {
    return this.reply(async () => {
      const userId = this.userId(socket);
      const { roomId } = parseChat(roomRequest, input);
      const room = await this.authorize(userId, roomId);
      if (socket.connected) await socket.join(chatRoom(roomId));
      return room;
    });
  }

  @SubscribeMessage('chat:send')
  send(@ConnectedSocket() socket: ChatSocket, @MessageBody() input: unknown) {
    return this.reply(async () => {
      const userId = this.userId(socket);
      const { roomId, message } = parseChat(sendRequest, input);
      await this.authorize(userId, roomId);
      // N1 resolves only after COMMIT, including identical retry lookups.
      const committed = await this.chat.sendMessage(userId, roomId, message);
      // Fanout is best-effort and cannot change the durable success ack.
      this.publish({ roomId: committed.roomId, seq: committed.seq });
      return committed;
    });
  }

  @SubscribeMessage('chat:catch-up')
  catchUp(@ConnectedSocket() socket: ChatSocket, @MessageBody() input: unknown) {
    return this.reply(async () => {
      const userId = this.userId(socket);
      const { roomId, ...query } = parseChat(catchUpRequest, input);
      await this.authorize(userId, roomId);
      const page = await this.chat.history(userId, roomId, query);
      // History uses a snapshot; recheck after loading, before content leaves.
      await this.authorize(userId, roomId);
      return page;
    });
  }

  private publish(reference: ChatCommitted): void {
    void this.deliver(reference);
    try {
      this.server.serverSideEmit('chat:committed', reference);
    } catch {
      this.logger.warn('Chat fanout failed; recover through sequence catch-up.');
    }
  }

  private async deliver(input: unknown): Promise<void> {
    const parsed = committedReference.safeParse(input);
    if (!parsed.success) return;
    const { roomId, seq } = parsed.data;
    const room = chatRoom(roomId);
    // Only local sockets: authorizing remotely then emitting through Redis
    // would leave a queue between the policy check and content delivery.
    const ids = this.server.sockets.adapter.rooms.get(room);
    for (const id of ids ? [...ids] : []) {
      const socket = this.server.sockets.sockets.get(id);
      if (!socket?.connected || !socket.rooms.has(room)) continue;
      try {
        const userId = this.userId(socket);
        const page = await this.chat.history(userId, roomId, { afterSeq: seq - 1, limit: 1 });
        const message = page.messages.find((candidate) => candidate.roomId === roomId && candidate.seq === seq);
        await this.authorize(userId, roomId);
        if (message && socket.connected && socket.rooms.has(room)) socket.emit('chat:message', message);
      } catch {
        // Cleanup is local and optional for security: every delivery rechecks.
        await Promise.resolve(socket.leave(room)).catch(() => undefined);
      }
    }
  }

  private async authorize(userId: string, roomId: string) {
    const room = await this.chat.authorizeRoom(userId, roomId);
    // N1 has no EVENT lifecycle policy yet. Do not duplicate it in a gateway
    // or enable content delivery which cancellation could not revoke.
    if (room.type === 'EVENT') throw new AppError('CHAT_ROOM_UNSUPPORTED', errors.CHAT_ROOM_UNSUPPORTED!);
    return room;
  }

  private userId(socket: ChatSocket): string {
    if (!socket.connected || !socket.data.userId) throw new AppError('UNAUTHENTICATED', errors.UNAUTHENTICATED!);
    return socket.data.userId;
  }

  private async reply<T>(action: () => Promise<T>): Promise<ChatAck<T>> {
    try {
      return { ok: true, data: await action() };
    } catch (error) {
      const code = error instanceof AppError ? error.code as ChatErrorCode : 'INTERNAL_ERROR';
      const message = errors[code];
      return { ok: false, error: message ? { code, message } : { code: 'INTERNAL_ERROR', message: 'Chat request failed.' } };
    }
  }
}
