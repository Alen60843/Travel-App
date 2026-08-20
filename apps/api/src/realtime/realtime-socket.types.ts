import type { Socket } from 'socket.io';

/** Per-socket state the gateway attaches once a connection is authenticated. */
export interface RealtimeSocketData {
  userId?: string;
}

/**
 * A Socket.IO socket carrying our custom `data` shape. The event maps
 * (listen/emit/server-side) are left as `any`: this module defines no
 * events of its own — Phase 7 owns the chat protocol and narrows these when
 * it adds `@SubscribeMessage` handlers for real events.
 */
export type RealtimeSocket = Socket<any, any, any, RealtimeSocketData>;
