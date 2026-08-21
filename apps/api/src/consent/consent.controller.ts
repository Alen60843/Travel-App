import { isIP } from 'node:net';

import { Body, Controller, Get, Post, Req, UseGuards } from '@nestjs/common';

import { CurrentUser, TripWithAuthGuard, type AuthenticatedUser } from '../auth';
import {
  ConsentService,
  type ConsentEventView,
  type ConsentSourceMetadata,
} from './consent.service';
import { RecordConsentDto } from './record-consent.dto';

interface ConsentHttpRequest {
  readonly ip?: string;
  readonly socket?: { readonly remoteAddress?: string };
  readonly headers: Record<string, string | string[] | undefined>;
}

@Controller({ path: 'me/consents', version: '1' })
@UseGuards(TripWithAuthGuard)
export class ConsentController {
  constructor(private readonly consents: ConsentService) {}

  @Post()
  recordOwn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() input: RecordConsentDto,
    @Req() request: ConsentHttpRequest,
  ): Promise<ConsentEventView> {
    return this.consents.recordOwn(user.id, input, this.sourceMetadata(request));
  }

  /** Current state is the latest append-only event for each consent type. */
  @Get()
  getCurrentOwn(@CurrentUser() user: AuthenticatedUser): Promise<readonly ConsentEventView[]> {
    return this.consents.getCurrentOwn(user.id);
  }

  @Get('history')
  getHistoryOwn(@CurrentUser() user: AuthenticatedUser): Promise<readonly ConsentEventView[]> {
    return this.consents.getHistoryOwn(user.id);
  }

  private sourceMetadata(request: ConsentHttpRequest): ConsentSourceMetadata {
    const rawIp = request.ip ?? request.socket?.remoteAddress ?? '';
    const normalizedIp = rawIp.startsWith('::ffff:') ? rawIp.slice(7) : rawIp;
    const header = request.headers['user-agent'];
    const rawUserAgent = Array.isArray(header) ? header[0] : header;
    const safeUserAgent = rawUserAgent?.replaceAll('\0', '').trim().slice(0, 500) ?? '';

    return {
      sourceIp: isIP(normalizedIp) === 0 ? null : normalizedIp,
      userAgent: safeUserAgent.length === 0 ? null : safeUserAgent,
    };
  }
}
