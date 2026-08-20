/**
 * Public surface of the realtime module, for the Lead to wire into
 * app.module.ts / main.ts. See README-less usage notes in this repo's agent
 * report (Agent D, Phase 2) for exactly what needs to change in those files.
 */
export { ConnectionTracker } from './connection-tracker.service';
export { RealtimeGateway } from './realtime.gateway';
export type { RealtimeSocket, RealtimeSocketData } from './realtime-socket.types';
export { RealtimeModule } from './realtime.module';
export type { RealtimeModuleOptions } from './realtime.module';
export { RedisIoAdapter } from './redis-io.adapter';
export { userRoom } from './rooms';
export { extractHandshakeToken } from './socket-auth.util';
export { RejectingSocketAuthenticator, SOCKET_AUTHENTICATOR } from './socket-authenticator';
export type { AuthenticatedPrincipal, SocketAuthenticator } from './socket-authenticator';
