import type { Server, Socket } from 'socket.io';

import type { RealtimeSocketData } from '../../realtime/realtime-socket.types';
import type { PresenceTarget } from './presence.service';
import type { PresenceState } from './presence.store';

export type PresenceView = PresenceTarget & PresenceState;
export type PresenceAck<T> = { ok: true; data: T } | {
  ok: false;
  error: { code: 'UNAUTHENTICATED' | 'VALIDATION_FAILED' | 'PRESENCE_FORBIDDEN' | 'PRESENCE_LIMIT' | 'INTERNAL_ERROR'; message: string };
};
type Reply<T> = (ack: PresenceAck<T>) => void;
export interface PresenceClientEvents {
  'presence:query': (input: PresenceTarget, ack: Reply<PresenceView>) => void;
  'presence:subscribe': (input: PresenceTarget, ack: Reply<PresenceView>) => void;
  'presence:unsubscribe': (input: PresenceTarget, ack: Reply<PresenceTarget>) => void;
}
export interface PresenceServerEvents {
  'presence:update': (presence: PresenceView) => void;
  'presence:revoked': (target: PresenceTarget) => void;
}
export type PresenceSocket = Socket<PresenceClientEvents, PresenceServerEvents, {}, RealtimeSocketData>;
export type PresenceServer = Server<PresenceClientEvents, PresenceServerEvents, {}, RealtimeSocketData>;
