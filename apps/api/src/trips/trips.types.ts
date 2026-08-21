import type { TripVisibility } from '@tripwith/shared';

export interface TripSegmentView {
  readonly id: string;
  readonly destinationPlaceId: string | null;
  readonly destinationName: string;
  readonly countryCode: string | null;
  readonly latitude: number;
  readonly longitude: number;
  readonly startDate: string;
  readonly endDate: string;
  readonly sortOrder: number;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** Owner representation. Matching must expose a separate discovery-safe view. */
export interface TripView {
  readonly id: string;
  readonly title: string;
  readonly startDate: string;
  readonly endDate: string;
  readonly visibility: TripVisibility;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly segments: readonly TripSegmentView[];
  readonly createdAt: string;
  readonly updatedAt: string;
}
