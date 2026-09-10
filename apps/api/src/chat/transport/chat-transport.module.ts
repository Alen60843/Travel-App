import { Module } from '@nestjs/common';

import { ChatModule } from '../chat.module';
import { ChatGateway } from './chat.gateway';

/** RealtimeModule.forRoot must also be composed to authenticate connections. */
@Module({ imports: [ChatModule], providers: [ChatGateway] })
export class ChatTransportModule {}
