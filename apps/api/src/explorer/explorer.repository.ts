import { EventStatus, EventVisibility } from '@tripwith/shared';
import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type {
  EntityTarget,
  ObjectLiteral,
  Repository,
  SelectQueryBuilder,
} from 'typeorm';

import { EventEntity } from '../database/entities';
import { GeoService, type SqlFragment } from '../database/geo';
import { ExplorerQueryTooBroadError } from './explorer.errors';
import type { ExplorerEventPin, NormalizedExplorerQuery } from './explorer.types';

interface ExplorerRawEvent {
  readonly eventId: string;
  readonly title: string;
  readonly status: EventStatus;
  readonly latitude: string | number;
  readonly longitude: string | number;
  readonly categoryCode: string;
  readonly categoryLabel: string;
  readonly categoryIcon: string | null;
  readonly startsAt: Date | string;
  readonly endsAt: Date | string;
  readonly meetingPointLabel: string | null;
}

export const EXPLORER_CANDIDATE_LIMIT = 5_000;

interface ExplorerDatabase {
  query<T = unknown>(query: string, parameters?: unknown[]): Promise<T>;
  getRepository<Entity extends ObjectLiteral>(target: EntityTarget<Entity>): Repository<Entity>;
}

/**
 * Explorer owns the event-specific SQL. GeoService supplies only the shared,
 * index-aware spatial predicates; this repository composes them with the
 * exact partial-index visibility/status predicate and generated time_range.
 */
@Injectable()
export class ExplorerRepository {
  constructor(
    @InjectDataSource() private readonly dataSource: ExplorerDatabase,
    private readonly geo: GeoService,
  ) {}

  async findKnownCategoryCodes(codes: readonly string[]): Promise<readonly string[]> {
    if (codes.length === 0) return [];
    const rows = await this.dataSource.query<{ code: string }[]>(
      `SELECT code
         FROM event_categories
        WHERE code = ANY($1::text[])
        ORDER BY code ASC
        LIMIT 20`,
      [[...codes]],
    );
    return rows.map(({ code }) => code);
  }

  async findDiscoverableEvents(query: NormalizedExplorerQuery): Promise<readonly ExplorerEventPin[]> {
    const fragments = this.spatialFragments(query);
    const pages = await Promise.all(fragments.map((fragment) => this.queryFragment(query, fragment)));

    // An antimeridian viewport is deliberately issued as two individually safe
    // GeoService predicates. De-duplicate on the event UUID and restore a total
    // order so the merge result never depends on query completion order.
    const merged = new Map<string, ExplorerEventPin>();
    for (const page of pages) {
      for (const event of page) merged.set(event.id, event);
    }
    const events = [...merged.values()].sort(compareEventPins);
    if (events.length > EXPLORER_CANDIDATE_LIMIT) throw new ExplorerQueryTooBroadError();
    return events;
  }

  private spatialFragments(query: NormalizedExplorerQuery): readonly SqlFragment[] {
    if (query.spatial.kind === 'radius') {
      return [
        this.geo.withinRadius(
          'event.meeting_point',
          query.spatial.center,
          query.spatial.radiusMeters,
          'explorerRadius',
        ),
      ];
    }

    const { south, west, north, east, crossesAntimeridian } = query.spatial;
    if (!crossesAntimeridian) {
      return [
        this.geo.withinBoundingBox(
          'event.meeting_point',
          { latitude: south, longitude: west },
          { latitude: north, longitude: east },
          'explorerViewport',
        ),
      ];
    }

    return [
      this.geo.withinBoundingBox(
        'event.meeting_point',
        { latitude: south, longitude: west },
        { latitude: north, longitude: 180 },
        'explorerViewportWest',
      ),
      this.geo.withinBoundingBox(
        'event.meeting_point',
        { latitude: south, longitude: -180 },
        { latitude: north, longitude: east },
        'explorerViewportEast',
      ),
    ];
  }

  private async queryFragment(
    query: NormalizedExplorerQuery,
    spatial: SqlFragment,
  ): Promise<readonly ExplorerEventPin[]> {
    const builder = this.baseQuery(query)
      .andWhere(spatial.sql, spatial.parameters)
      .orderBy('event.starts_at', 'ASC')
      .addOrderBy('event.id', 'ASC')
      .take(EXPLORER_CANDIDATE_LIMIT + 1);
    const rows = await builder.getRawMany<ExplorerRawEvent>();
    return rows.map(toEventPin);
  }

  private baseQuery(query: NormalizedExplorerQuery): SelectQueryBuilder<EventEntity> {
    const builder = this.dataSource
      .getRepository(EventEntity)
      .createQueryBuilder('event')
      .innerJoin('event.category', 'category')
      .select('event.id', 'eventId')
      .addSelect('event.title', 'title')
      .addSelect('event.status', 'status')
      .addSelect('ST_Y(event.meeting_point::geometry)', 'latitude')
      .addSelect('ST_X(event.meeting_point::geometry)', 'longitude')
      .addSelect('category.code', 'categoryCode')
      .addSelect('category.label', 'categoryLabel')
      .addSelect('category.icon', 'categoryIcon')
      .addSelect('event.starts_at', 'startsAt')
      .addSelect('event.ends_at', 'endsAt')
      .addSelect('event.meeting_point_label', 'meetingPointLabel')
      .where('event.visibility = :publicVisibility', {
        publicVisibility: EventVisibility.Public,
      })
      .andWhere('event.status IN (:...discoverableStatuses)', {
        discoverableStatuses: [EventStatus.Active, EventStatus.Full],
      })
      .andWhere(`event.time_range && tstzrange(:windowStart, :windowEnd, '[)')`, {
        windowStart: query.windowStart,
        windowEnd: query.windowEnd,
      });
    if (query.categoryCodes.length > 0) {
      builder.andWhere('category.code IN (:...categoryCodes)', {
        categoryCodes: [...query.categoryCodes],
      });
    }
    return builder;
  }
}

function finiteCoordinate(value: string | number, name: string): number {
  const result = Number(value);
  if (!Number.isFinite(result)) throw new TypeError(`Explorer query returned invalid ${name}`);
  return result;
}

function isoInstant(value: Date | string, name: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new TypeError(`Explorer query returned invalid ${name}`);
  return parsed.toISOString();
}

function toEventPin(row: ExplorerRawEvent): ExplorerEventPin {
  return {
    kind: 'event',
    id: row.eventId,
    title: row.title,
    status: row.status,
    coordinate: {
      latitude: finiteCoordinate(row.latitude, 'latitude'),
      longitude: finiteCoordinate(row.longitude, 'longitude'),
    },
    category: { code: row.categoryCode, label: row.categoryLabel, icon: row.categoryIcon },
    startsAt: isoInstant(row.startsAt, 'startsAt'),
    endsAt: isoInstant(row.endsAt, 'endsAt'),
    meetingPointLabel: row.meetingPointLabel,
  };
}

function compareEventPins(left: ExplorerEventPin, right: ExplorerEventPin): number {
  return compareText(left.startsAt, right.startsAt) || compareText(left.id, right.id);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
