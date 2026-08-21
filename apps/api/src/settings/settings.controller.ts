import { Body, Controller, Get, Patch, UseGuards } from '@nestjs/common';

import { CurrentUser, TripWithAuthGuard, type AuthenticatedUser } from '../auth';
import { SettingsService, type UserSettingsView } from './settings.service';
import { UpdateSettingsDto } from './update-settings.dto';

@Controller({ path: 'me/settings', version: '1' })
@UseGuards(TripWithAuthGuard)
export class SettingsController {
  constructor(private readonly settings: SettingsService) {}

  @Get()
  getOwn(@CurrentUser() user: AuthenticatedUser): Promise<UserSettingsView> {
    return this.settings.getOwn(user.id);
  }

  @Patch()
  updateOwn(
    @CurrentUser() user: AuthenticatedUser,
    @Body() patch: UpdateSettingsDto,
  ): Promise<UserSettingsView> {
    return this.settings.updateOwn(user.id, patch);
  }
}
