import type { EventStatus } from '@tripwith/shared';

export interface ExplorerCoordinate {
  readonly latitude: number;
  readonly longitude: number;
}

export interface ExplorerCategoryView {
  readonly code: string;
  readonly label: string;
  readonly icon: string | null;
}

/** Minimal, map-safe event projection. This is never a serialized EventEntity. */
export interface ExplorerEventPin {
  readonly kind: 'event';
  readonly id: string;
  readonly title: string;
  readonly status: EventStatus;
  readonly coordinate: ExplorerCoordinate;
  readonly category: ExplorerCategoryView;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly meetingPointLabel: string | null;
}

export interface ExplorerClusterCategorySummary {
  readonly code: string;
  readonly eventCount: number;
}

export interface ExplorerClusterMarker {
  readonly kind: 'cluster';
  /** Stable for the normalized grid cell, zoom, and adaptive scale. */
  readonly id: string;
  readonly coordinate: ExplorerCoordinate;
  readonly eventCount: number;
  readonly categories: readonly ExplorerClusterCategorySummary[];
}

export type ExplorerMarker = ExplorerEventPin | ExplorerClusterMarker;

export interface ExplorerEventsView {
  readonly spatialMode: 'viewport' | 'radius';
  readonly windowStart: string;
  readonly windowEnd: string;
  /** Exact number considered for this response, before output clustering. */
  readonly eventCount: number;
  readonly markers: readonly ExplorerMarker[];
}

export interface ExplorerViewport {
  readonly kind: 'viewport';
  readonly south: number;
  readonly west: number;
  readonly north: number;
  readonly east: number;
  readonly crossesAntimeridian: boolean;
}

export interface ExplorerRadius {
  readonly kind: 'radius';
  readonly center: ExplorerCoordinate;
  readonly radiusMeters: number;
}

export type ExplorerSpatialQuery = ExplorerViewport | ExplorerRadius;

export interface NormalizedExplorerQuery {
  readonly spatial: ExplorerSpatialQuery;
  readonly windowStart: Date;
  readonly windowEnd: Date;
  readonly categoryCodes: readonly string[];
  readonly zoom: number;
  readonly limit: number;
}
