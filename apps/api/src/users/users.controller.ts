import { isIP } from 'node:net';

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Patch,
  Post,
  Put,
  Req,
  UseGuards,
} from '@nestjs/common';

import {
  AuthenticatedUser,
  CurrentFirebaseIdentity,
  CurrentUser,
  RevocationCheckedFirebaseAuthGuard,
  TripWithAuthGuard,
  VerifiedFirebaseIdentity,
} from '../auth';
import { ProvisionAccountDto } from './dto/provision-account.dto';
import { ReplaceInterestsDto } from './dto/replace-interests.dto';
import { UpdateProfileDto } from './dto/update-profile.dto';
import { UsersService } from './users.service';
import type { CurrentUserView, InterestView, ProfileView } from './users.types';

interface ProvisionRequestMetadata {
  readonly ip?: string;
  readonly socket?: { readonly remoteAddress?: string };
  readonly headers: Readonly<Record<string, string | string[] | undefined>>;
}

export function safeProvisionSourceIp(request: ProvisionRequestMetadata): string | null {
  const candidate = request.ip ?? request.socket?.remoteAddress;
  if (!candidate) return null;
  // Node accepts IPv6 zone identifiers but PostgreSQL inet deliberately does
  // not store an interface-local scope. Keep only the address portion.
  const address = candidate.split('%', 1)[0];
  return address && isIP(address) !== 0 ? address : null;
}

export function safeProvisionUserAgent(
  headers: ProvisionRequestMetadata['headers'],
): string | null {
  const raw = headers['user-agent'];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return null;
  const sanitised = value.replace(/\0/g, '').slice(0, 1000);
  return sanitised || null;
}

@Controller({ path: 'auth', version: '1' })
export class ProvisioningController {
  constructor(private readonly usersService: UsersService) {}

  @Post('provision')
  @HttpCode(200)
  @UseGuards(RevocationCheckedFirebaseAuthGuard)
  provision(
    @CurrentFirebaseIdentity() identity: VerifiedFirebaseIdentity,
    @Body() dto: ProvisionAccountDto,
    @Req() request: ProvisionRequestMetadata,
  ): Promise<CurrentUserView> {
    return this.usersService.provision(identity, dto, {
      sourceIp: safeProvisionSourceIp(request),
      userAgent: safeProvisionUserAgent(request.headers),
    });
  }
}

@Controller({ path: 'me', version: '1' })
@UseGuards(TripWithAuthGuard)
export class CurrentUserController {
  constructor(private readonly usersService: UsersService) {}

  @Get()
  getMe(@CurrentUser() user: AuthenticatedUser): Promise<CurrentUserView> {
    return this.usersService.getCurrentUser(user.id);
  }

  @Get('profile')
  getProfile(@CurrentUser() user: AuthenticatedUser): Promise<ProfileView> {
    return this.usersService.getProfile(user.id);
  }

  @Patch('profile')
  updateProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: UpdateProfileDto,
  ): Promise<ProfileView> {
    return this.usersService.updateProfile(user.id, dto);
  }

  @Get('interests/available')
  listInterests(): Promise<readonly InterestView[]> {
    return this.usersService.listActiveInterests();
  }

  @Put('interests')
  replaceInterests(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: ReplaceInterestsDto,
  ): Promise<ProfileView> {
    return this.usersService.replaceInterests(user.id, dto);
  }
}
