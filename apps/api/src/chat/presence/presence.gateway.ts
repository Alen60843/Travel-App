import { randomUUID } from 'node:crypto';

import { OnModuleDestroy } from '@nestjs/common';
import { ConnectedSocket, MessageBody, OnGatewayConnection, OnGatewayDisconnect, OnGatewayInit, SubscribeMessage, WebSocketGateway } from '@nestjs/websockets';

import { AppError } from '../../common/errors/app-error';
import { parseChat } from '../chat.validation';
import type { PresenceAck, PresenceServer, PresenceSocket, PresenceView } from './presence.events';
import { presenceRequest, PresenceService, type PresenceTarget } from './presence.service';
import { PresenceStore } from './presence.store';

export const PRESENCE_POLL_MS = 5000;
const MAX_SUBSCRIPTIONS = 100;
interface Subscription { target: PresenceTarget; last?: string }
interface Session {
  userId: string;
  leaseId: string;
  closed: boolean;
  pending?: Promise<void>;
  heartbeat: () => void;
  subscriptions: Map<string, Subscription>;
}

@WebSocketGateway()
export class PresenceGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy {
  private readonly sessions = new Map<PresenceSocket, Session>();
  private timer?: NodeJS.Timeout;
  private refreshing = false;

  constructor(private readonly presence: PresenceService, private readonly store: PresenceStore) {}

  afterInit(_server: PresenceServer): void {
    // Poll shared leases at the socket owner. No privacy data is broadcast via
    // Redis rooms, and expiry/process death needs no pubsub notification.
    this.timer = setInterval(() => { void this.refresh(); }, PRESENCE_POLL_MS);
    this.timer.unref();
  }

  handleConnection(socket: PresenceSocket): void {
    if (!socket.connected || !socket.data.userId || this.sessions.has(socket)) return;
    const session: Session = {
      userId: socket.data.userId, leaseId: randomUUID(), closed: false,
      subscriptions: new Map(),
      heartbeat: () => { this.touch(socket, session); },
    };
    this.sessions.set(socket, session);
    // Engine.IO verifies liveness; clients cannot supply a user/lease/timestamp.
    socket.conn.on('heartbeat', session.heartbeat);
    this.touch(socket, session);
  }

  handleDisconnect(socket: PresenceSocket): void {
    const session = this.sessions.get(socket);
    if (!session) return;
    session.closed = true;
    session.subscriptions.clear();
    this.sessions.delete(socket);
    socket.conn.off('heartbeat', session.heartbeat);
    // Serialize removal after an in-flight heartbeat. Reordered disconnects
    // can only remove this unique lease, never a reconnected device's lease.
    void (session.pending ?? Promise.resolve()).then(() => this.store.remove(session.userId, session.leaseId));
  }

  onModuleDestroy(): void {
    clearInterval(this.timer);
    for (const socket of this.sessions.keys()) this.handleDisconnect(socket);
  }

  @SubscribeMessage('presence:query')
  query(@ConnectedSocket() socket: PresenceSocket, @MessageBody() input: unknown) {
    return this.reply(() => this.presence.query(this.session(socket).userId, input));
  }

  @SubscribeMessage('presence:subscribe')
  subscribe(@ConnectedSocket() socket: PresenceSocket, @MessageBody() input: unknown) {
    return this.reply(async () => {
      const session = this.session(socket);
      const target = parseChat(presenceRequest, input);
      const key = this.key(target);
      if (!session.subscriptions.has(key) && session.subscriptions.size >= MAX_SUBSCRIPTIONS) {
        throw new AppError('PRESENCE_LIMIT', 'Too many presence subscriptions.');
      }
      const subscription: Subscription = { target };
      session.subscriptions.set(key, subscription);
      try {
        const view = await this.presence.query(session.userId, target);
        subscription.last = JSON.stringify(view);
        return view;
      } catch (error) {
        if (session.subscriptions.get(key) === subscription) session.subscriptions.delete(key);
        throw error;
      }
    });
  }

  @SubscribeMessage('presence:unsubscribe')
  unsubscribe(@ConnectedSocket() socket: PresenceSocket, @MessageBody() input: unknown) {
    return this.reply(async () => {
      const session = this.session(socket);
      const target = parseChat(presenceRequest, input);
      session.subscriptions.delete(this.key(target));
      return target;
    });
  }

  /** Also callable in bounded integration tests without waiting five seconds. */
  async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      for (const [socket, session] of this.sessions) {
        for (const [key, subscription] of session.subscriptions) {
          if (!subscription.last) continue; // Initial authorization is pending.
          let view: PresenceView;
          try {
            view = await this.presence.query(session.userId, subscription.target);
          } catch {
            if (!session.closed && session.subscriptions.get(key) === subscription) {
              session.subscriptions.delete(key);
              if (socket.connected) socket.emit('presence:revoked', subscription.target);
            }
            continue;
          }
          if (!socket.connected || session.closed || session.subscriptions.get(key) !== subscription) continue;
          const serialized = JSON.stringify(view);
          if (serialized !== subscription.last) {
            subscription.last = serialized;
            socket.emit('presence:update', view);
          }
        }
      }
    } finally {
      this.refreshing = false;
    }
  }

  private touch(socket: PresenceSocket, session: Session): void {
    if (session.closed || !socket.connected || session.pending) return;
    session.pending = this.store.touch(session.userId, session.leaseId).then(() => undefined)
      .finally(() => { delete session.pending; });
  }

  private session(socket: PresenceSocket): Session {
    const session = this.sessions.get(socket);
    if (!socket.connected || !session || session.closed) throw new AppError('UNAUTHENTICATED', 'Authentication required.');
    return session;
  }

  private key(target: PresenceTarget): string { return `${target.roomId}:${target.targetUserId}`; }

  private async reply<T>(action: () => Promise<T>): Promise<PresenceAck<T>> {
    try {
      return { ok: true, data: await action() };
    } catch (error) {
      const code = error instanceof AppError ? error.code : 'INTERNAL_ERROR';
      const messages = {
        UNAUTHENTICATED: 'Authentication required.', VALIDATION_FAILED: 'Invalid presence request.',
        PRESENCE_FORBIDDEN: 'Presence unavailable.', PRESENCE_LIMIT: 'Too many presence subscriptions.',
        INTERNAL_ERROR: 'Presence request failed.',
      };
      const safeCode = Object.hasOwn(messages, code) ? code as keyof typeof messages : 'INTERNAL_ERROR';
      return { ok: false, error: { code: safeCode, message: messages[safeCode] } };
    }
  }
}
