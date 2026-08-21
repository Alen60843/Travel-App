import { Injectable } from '@nestjs/common';
import { TripVisibility } from '@tripwith/shared';
import type { EntityManager } from 'typeorm';

import { GeoService } from '../database/geo';
import type { TripEntity, TripSegmentEntity } from '../database/entities';
import { FeedGenerationService } from '../matching/feed-generation.service';
import type {
  CreateTripDto,
  CreateTripSegmentDto,
  UpdateTripDto,
  UpdateTripSegmentDto,
} from './dto';
import {
  InvalidSegmentOrderError,
  InvalidTripValueError,
  TripNotFoundError,
  TripSegmentNotFoundError,
} from './trips.errors';
import {
  assertOrderedRange,
  assertSegmentContained,
  normaliseBoundedText,
  normaliseMetadata,
} from './trip-validation';
import { TripsRepository } from './trips.repository';
import type { TripSegmentView, TripView } from './trips.types';

const VISIBILITIES = new Set<string>(Object.values(TripVisibility));
const COUNTRY_CODE = /^[A-Z]{2}$/;

@Injectable()
export class TripsService {
  constructor(
    private readonly repository: TripsRepository,
    private readonly geo: GeoService,
    private readonly feedGeneration?: FeedGenerationService,
  ) {}

  async createTrip(userId: string, dto: CreateTripDto): Promise<TripView> {
    const title = normaliseBoundedText(dto.title, 'title', 1, 120);
    assertOrderedRange({ start: dto.startDate, end: dto.endDate });
    const visibility = dto.visibility ?? TripVisibility.MatchesOnly;
    this.assertVisibility(visibility);
    const metadata = dto.metadata === undefined ? {} : normaliseMetadata(dto.metadata);

    const view = await this.repository.transaction(async (manager) => {
      const trip = this.repository.createTrip(manager, {
        userId,
        title,
        startDate: dto.startDate,
        endDate: dto.endDate,
        visibility,
        metadata,
      });
      return this.toTripView(await this.repository.saveTrip(manager, trip), []);
    });
    await this.feedGeneration?.bump(userId);
    return view;
  }

  async listTrips(userId: string): Promise<readonly TripView[]> {
    const trips = await this.repository.findOwnedTrips(userId);
    return trips.map((trip) => this.toTripView(trip, this.orderSegments(trip.segments ?? [])));
  }

  async getTrip(userId: string, tripId: string): Promise<TripView> {
    const trip = await this.repository.findOwnedTripWithSegments(userId, tripId);
    if (!trip) throw new TripNotFoundError();
    return this.toTripView(trip, this.orderSegments(trip.segments ?? []));
  }

  async updateTrip(userId: string, tripId: string, dto: UpdateTripDto): Promise<TripView> {
    this.assertNonEmptyPatch(dto);
    await this.repository.transaction(async (manager) => {
      const trip = await this.requireOwnedTrip(manager, userId, tripId);
      const segments = await this.repository.findSegments(manager, userId, tripId, true);
      const nextStart = dto.startDate ?? trip.startDate;
      const nextEnd = dto.endDate ?? trip.endDate;
      assertOrderedRange({ start: nextStart, end: nextEnd });
      for (const segment of segments) {
        assertSegmentContained(
          { start: segment.startDate, end: segment.endDate },
          { start: nextStart, end: nextEnd },
        );
      }

      if (dto.title !== undefined) {
        trip.title = normaliseBoundedText(dto.title, 'title', 1, 120);
      }
      trip.startDate = nextStart;
      trip.endDate = nextEnd;
      if (dto.visibility !== undefined) {
        this.assertVisibility(dto.visibility);
        trip.visibility = dto.visibility;
      }
      if (dto.metadata !== undefined) trip.metadata = normaliseMetadata(dto.metadata);
      await this.repository.saveTrip(manager, trip);
    });
    await this.feedGeneration?.bump(userId);
    return this.getTrip(userId, tripId);
  }

  async deleteTrip(userId: string, tripId: string): Promise<void> {
    await this.repository.transaction(async (manager) => {
      const trip = await this.requireOwnedTrip(manager, userId, tripId);
      await this.repository.deleteTrip(manager, trip);
    });
    await this.feedGeneration?.bump(userId);
  }

  async createSegment(
    userId: string,
    tripId: string,
    dto: CreateTripSegmentDto,
  ): Promise<TripSegmentView> {
    const view = await this.repository.transaction(async (manager) => {
      const trip = await this.requireOwnedTrip(manager, userId, tripId);
      const segments = await this.repository.findSegments(manager, userId, tripId, true);
      assertSegmentContained(
        { start: dto.startDate, end: dto.endDate },
        { start: trip.startDate, end: trip.endDate },
      );
      const position = dto.sortOrder ?? segments.length;
      if (position < 0 || position > segments.length || position > 32767) {
        throw new InvalidSegmentOrderError();
      }
      const point = this.point(dto.latitude, dto.longitude);
      const segment = this.repository.createSegment(manager, {
        tripId,
        userId,
        destinationPlaceId: this.normalisePlaceId(dto.destinationPlaceId),
        destinationName: normaliseBoundedText(dto.destinationName, 'destinationName', 1, 160),
        countryCode: this.normaliseCountryCode(dto.countryCode),
        location: point,
        startDate: dto.startDate,
        endDate: dto.endDate,
        sortOrder: position,
        metadata: dto.metadata === undefined ? {} : normaliseMetadata(dto.metadata),
      });
      const ordered = [...this.orderSegments(segments)];
      ordered.splice(position, 0, segment);
      this.assignDenseOrder(ordered);
      const saved = await this.repository.saveSegments(manager, ordered);
      const created = saved.find((item) => item === segment || item.id === segment.id);
      if (!created) throw new Error('New trip segment was not returned after save.');
      return this.toSegmentView(created);
    });
    await this.feedGeneration?.bump(userId);
    return view;
  }

  async updateSegment(
    userId: string,
    tripId: string,
    segmentId: string,
    dto: UpdateTripSegmentDto,
  ): Promise<TripSegmentView> {
    this.assertNonEmptyPatch(dto);
    const view = await this.repository.transaction(async (manager) => {
      const trip = await this.requireOwnedTrip(manager, userId, tripId);
      const ordered = [...this.orderSegments(
        await this.repository.findSegments(manager, userId, tripId, true),
      )];
      const currentIndex = ordered.findIndex((segment) => segment.id === segmentId);
      if (currentIndex < 0) throw new TripSegmentNotFoundError();
      const segment = ordered[currentIndex] as TripSegmentEntity;
      const nextStart = dto.startDate ?? segment.startDate;
      const nextEnd = dto.endDate ?? segment.endDate;
      assertSegmentContained(
        { start: nextStart, end: nextEnd },
        { start: trip.startDate, end: trip.endDate },
      );

      if ((dto.latitude === undefined) !== (dto.longitude === undefined)) {
        throw new InvalidTripValueError(
          'location',
          'latitude and longitude must be supplied together.',
        );
      }
      if (dto.latitude !== undefined && dto.longitude !== undefined) {
        segment.location = this.point(dto.latitude, dto.longitude);
      }
      if (dto.destinationPlaceId !== undefined) {
        segment.destinationPlaceId = this.normalisePlaceId(dto.destinationPlaceId);
      }
      if (dto.destinationName !== undefined) {
        segment.destinationName = normaliseBoundedText(
          dto.destinationName,
          'destinationName',
          1,
          160,
        );
      }
      if (dto.countryCode !== undefined) {
        segment.countryCode = this.normaliseCountryCode(dto.countryCode);
      }
      segment.startDate = nextStart;
      segment.endDate = nextEnd;
      if (dto.metadata !== undefined) segment.metadata = normaliseMetadata(dto.metadata);

      if (dto.sortOrder !== undefined) {
        if (dto.sortOrder < 0 || dto.sortOrder >= ordered.length || dto.sortOrder > 32767) {
          throw new InvalidSegmentOrderError();
        }
        ordered.splice(currentIndex, 1);
        ordered.splice(dto.sortOrder, 0, segment);
      }
      this.assignDenseOrder(ordered);
      const saved = await this.repository.saveSegments(manager, ordered);
      const updated = saved.find((item) => item.id === segmentId);
      if (!updated) throw new TripSegmentNotFoundError();
      return this.toSegmentView(updated);
    });
    await this.feedGeneration?.bump(userId);
    return view;
  }

  async deleteSegment(userId: string, tripId: string, segmentId: string): Promise<void> {
    await this.repository.transaction(async (manager) => {
      await this.requireOwnedTrip(manager, userId, tripId);
      const segments = [...this.orderSegments(
        await this.repository.findSegments(manager, userId, tripId, true),
      )];
      const index = segments.findIndex((segment) => segment.id === segmentId);
      if (index < 0) throw new TripSegmentNotFoundError();
      const [segment] = segments.splice(index, 1);
      if (!segment) throw new TripSegmentNotFoundError();
      await this.repository.deleteSegment(manager, segment);
      this.assignDenseOrder(segments);
      if (segments.length > 0) await this.repository.saveSegments(manager, segments);
    });
    await this.feedGeneration?.bump(userId);
  }

  private async requireOwnedTrip(
    manager: EntityManager,
    userId: string,
    tripId: string,
  ): Promise<TripEntity> {
    const trip = await this.repository.findOwnedTrip(manager, userId, tripId, true);
    if (!trip) throw new TripNotFoundError();
    return trip;
  }

  private assertVisibility(value: string): asserts value is TripVisibility {
    if (!VISIBILITIES.has(value)) {
      throw new InvalidTripValueError('visibility', 'visibility is not supported.');
    }
  }

  private assertNonEmptyPatch(value: object): void {
    if (Object.keys(value).length === 0) {
      throw new InvalidTripValueError('body', 'At least one mutable field is required.');
    }
  }

  private point(latitude: number, longitude: number): ReturnType<GeoService['point']> {
    try {
      return this.geo.point(latitude, longitude);
    } catch {
      throw new InvalidTripValueError(
        'location',
        'latitude must be within [-90,90] and longitude within [-180,180].',
      );
    }
  }

  private normalisePlaceId(value: string | null | undefined): string | null {
    return value == null ? null : normaliseBoundedText(value, 'destinationPlaceId', 1, 512);
  }

  private normaliseCountryCode(value: string | null | undefined): string | null {
    if (value == null) return null;
    if (!COUNTRY_CODE.test(value)) {
      throw new InvalidTripValueError('countryCode', 'countryCode must be two uppercase letters.');
    }
    return value;
  }

  private orderSegments(segments: readonly TripSegmentEntity[]): TripSegmentEntity[] {
    return [...segments].sort(
      (a, b) =>
        a.sortOrder - b.sortOrder ||
        a.startDate.localeCompare(b.startDate) ||
        a.id.localeCompare(b.id),
    );
  }

  private assignDenseOrder(segments: TripSegmentEntity[]): void {
    if (segments.length > 32768) throw new InvalidSegmentOrderError();
    segments.forEach((segment, index) => {
      segment.sortOrder = index;
    });
  }

  private toTripView(trip: TripEntity, segments: readonly TripSegmentEntity[]): TripView {
    return {
      id: trip.id,
      title: trip.title,
      startDate: trip.startDate,
      endDate: trip.endDate,
      visibility: trip.visibility,
      metadata: trip.metadata,
      segments: segments.map((segment) => this.toSegmentView(segment)),
      createdAt: trip.createdAt.toISOString(),
      updatedAt: trip.updatedAt.toISOString(),
    };
  }

  private toSegmentView(segment: TripSegmentEntity): TripSegmentView {
    return {
      id: segment.id,
      destinationPlaceId: segment.destinationPlaceId,
      destinationName: segment.destinationName,
      countryCode: segment.countryCode,
      latitude: segment.location.coordinates[1],
      longitude: segment.location.coordinates[0],
      startDate: segment.startDate,
      endDate: segment.endDate,
      sortOrder: segment.sortOrder,
      metadata: segment.metadata,
      createdAt: segment.createdAt.toISOString(),
      updatedAt: segment.updatedAt.toISOString(),
    };
  }
}
