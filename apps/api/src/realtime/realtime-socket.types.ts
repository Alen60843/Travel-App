import type { Socket } from 'socket.io';

/** Per-socket state the gateway attaches once a connection is authenticated. */
export interface RealtimeSocketData {
  userId?: string;
}

/**
 * A Socket.IO socket carrying our custom `data` shape. The event maps
 * (listen/emit/server-side) are left as `any` for infrastructure; ChatSocket
 * in chat/transport/chat.events.ts supplies the typed chat protocol.
 */
export type RealtimeSocket = Socket<any, any, any, RealtimeSocketData>;
