import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  UseGuards,
} from '@nestjs/common';

import { type AuthenticatedUser, CurrentUser, TripWithAuthGuard } from '../auth';
import {
  CreateTripDto,
  CreateTripSegmentDto,
  UpdateTripDto,
  UpdateTripSegmentDto,
} from './dto';
import { TripsService } from './trips.service';
import type { TripSegmentView, TripView } from './trips.types';

@Controller({ path: 'me/trips', version: '1' })
@UseGuards(TripWithAuthGuard)
export class TripsController {
  constructor(private readonly tripsService: TripsService) {}

  @Post()
  createTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Body() dto: CreateTripDto,
  ): Promise<TripView> {
    return this.tripsService.createTrip(user.id, dto);
  }

  @Get()
  listTrips(@CurrentUser() user: AuthenticatedUser): Promise<readonly TripView[]> {
    return this.tripsService.listTrips(user.id);
  }

  @Get(':tripId')
  getTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', new ParseUUIDPipe({ version: '4' })) tripId: string,
  ): Promise<TripView> {
    return this.tripsService.getTrip(user.id, tripId);
  }

  @Patch(':tripId')
  updateTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', new ParseUUIDPipe({ version: '4' })) tripId: string,
    @Body() dto: UpdateTripDto,
  ): Promise<TripView> {
    return this.tripsService.updateTrip(user.id, tripId, dto);
  }

  @Delete(':tripId')
  @HttpCode(204)
  deleteTrip(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', new ParseUUIDPipe({ version: '4' })) tripId: string,
  ): Promise<void> {
    return this.tripsService.deleteTrip(user.id, tripId);
  }

  @Post(':tripId/segments')
  createSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', new ParseUUIDPipe({ version: '4' })) tripId: string,
    @Body() dto: CreateTripSegmentDto,
  ): Promise<TripSegmentView> {
    return this.tripsService.createSegment(user.id, tripId, dto);
  }

  @Patch(':tripId/segments/:segmentId')
  updateSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', new ParseUUIDPipe({ version: '4' })) tripId: string,
    @Param('segmentId', new ParseUUIDPipe({ version: '4' })) segmentId: string,
    @Body() dto: UpdateTripSegmentDto,
  ): Promise<TripSegmentView> {
    return this.tripsService.updateSegment(user.id, tripId, segmentId, dto);
  }

  @Delete(':tripId/segments/:segmentId')
  @HttpCode(204)
  deleteSegment(
    @CurrentUser() user: AuthenticatedUser,
    @Param('tripId', new ParseUUIDPipe({ version: '4' })) tripId: string,
    @Param('segmentId', new ParseUUIDPipe({ version: '4' })) segmentId: string,
  ): Promise<void> {
    return this.tripsService.deleteSegment(user.id, tripId, segmentId);
  }
}
