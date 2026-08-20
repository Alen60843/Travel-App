import type { DynamicModule, Provider } from '@nestjs/common';
import { Module } from '@nestjs/common';

import { ConnectionTracker } from './connection-tracker.service';
import { RealtimeGateway } from './realtime.gateway';
import { RejectingSocketAuthenticator, SOCKET_AUTHENTICATOR } from './socket-authenticator';

export interface RealtimeModuleOptions {
  /**
   * Provider bound to SOCKET_AUTHENTICATOR. Omit to keep the fail-closed
   * default (`RejectingSocketAuthenticator`). Phase 3 supplies its Firebase
   * implementation here, e.g.:
   *
   *   RealtimeModule.forRoot({
   *     authenticatorProvider: {
   *       provide: SOCKET_AUTHENTICATOR,
   *       useClass: FirebaseSocketAuthenticator,
   *     },
   *   })
   */
  authenticatorProvider?: Provider;
}

/**
 * Socket.IO infrastructure shell: the gateway, the auth extension point, and
 * connection tracking. No chat/messaging/domain logic — see the module-level
 * comments in `realtime.gateway.ts` and `rooms.ts` for what is deliberately
 * left out and why.
 *
 * A dynamic module (`forRoot()`) rather than a plain `@Module` because the
 * authenticator is meant to be swapped by whichever phase implements real
 * verification. Nest module encapsulation means a sibling module cannot
 * silently override a provider declared inside this one — the composition
 * root (AppModule) has to pass the real provider in here explicitly, which
 * is exactly the point: it's an explicit decision at the wiring site, not an
 * implicit one a later import order could accidentally change.
 */
@Module({})
export class RealtimeModule {
  static forRoot(options: RealtimeModuleOptions = {}): DynamicModule {
    const authenticatorProvider: Provider = options.authenticatorProvider ?? {
      provide: SOCKET_AUTHENTICATOR,
      useClass: RejectingSocketAuthenticator,
    };

    return {
      module: RealtimeModule,
      providers: [authenticatorProvider, ConnectionTracker, RealtimeGateway],
      exports: [SOCKET_AUTHENTICATOR, ConnectionTracker],
    };
  }
}
