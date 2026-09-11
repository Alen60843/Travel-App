import { Module } from '@nestjs/common';

import { RedisModule } from '../../redis/redis.module';
import { ChatModule } from '../chat.module';
import { PresenceGateway } from '../presence/presence.gateway';
import { PresenceService } from '../presence/presence.service';
import { PresenceStore } from '../presence/presence.store';
import { ChatGateway } from './chat.gateway';

/** RealtimeModule.forRoot must also be composed to authenticate connections. */
@Module({ imports: [ChatModule, RedisModule], providers: [ChatGateway, PresenceStore, PresenceService, PresenceGateway] })
export class ChatTransportModule {}
