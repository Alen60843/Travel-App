import type {
  ExplorerClusterCategorySummary,
  ExplorerEventPin,
  ExplorerMarker,
} from './explorer.types';

const CLUSTER_THROUGH_ZOOM = 14;
const WORLD_LONGITUDE_DEGREES = 360;
const TILE_SIZE_PX = 256;
const CLUSTER_CELL_PX = 64;

interface GroupedMarker {
  readonly marker: ExplorerMarker;
  readonly firstStartsAt: string;
}

/**
 * A deterministic Web-Mercator-style degree grid, without a new extension:
 * one cell is 64px of a 256px world tile at the requested zoom. Low zooms
 * always group populated cells; high zooms return pins unless the requested
 * marker limit requires an adaptive 2x cell expansion. Discovery SQL has
 * already removed every non-public/non-discoverable row before this function,
 * so hidden events cannot affect a cluster's existence, count, centroid, id,
 * or category summary.
 */
export function clusterExplorerEvents(
  events: readonly ExplorerEventPin[],
  zoom: number,
  markerLimit: number,
): readonly ExplorerMarker[] {
  if (events.length === 0) return [];
  if (zoom > CLUSTER_THROUGH_ZOOM && events.length <= markerLimit) return [...events];

  const baseCellDegrees =
    WORLD_LONGITUDE_DEGREES / 2 ** zoom / (TILE_SIZE_PX / CLUSTER_CELL_PX);
  let scale = 1;
  let grouped = groupIntoGrid(events, zoom, baseCellDegrees, scale);
  while (grouped.length > markerLimit) {
    scale *= 2;
    grouped = groupIntoGrid(events, zoom, baseCellDegrees, scale);
  }
  return grouped
    .sort(
      (left, right) =>
        compareText(left.firstStartsAt, right.firstStartsAt) ||
        compareText(left.marker.id, right.marker.id),
    )
    .map(({ marker }) => marker);
}

function groupIntoGrid(
  events: readonly ExplorerEventPin[],
  zoom: number,
  baseCellDegrees: number,
  scale: number,
): GroupedMarker[] {
  const cellDegrees = baseCellDegrees * scale;
  const xCellCount = Math.max(1, Math.ceil(360 / cellDegrees));
  const yCellCount = Math.max(1, Math.ceil(180 / cellDegrees));
  const groups = new Map<string, { x: number; y: number; events: ExplorerEventPin[] }>();
  for (const event of events) {
    const x = Math.min(
      xCellCount - 1,
      Math.max(0, Math.floor((event.coordinate.longitude + 180) / cellDegrees)),
    );
    const y = Math.min(
      yCellCount - 1,
      Math.max(0, Math.floor((event.coordinate.latitude + 90) / cellDegrees)),
    );
    const key = `${x}:${y}`;
    const group = groups.get(key) ?? { x, y, events: [] };
    group.events.push(event);
    groups.set(key, group);
  }

  return [...groups.values()].map((group) => {
    const ordered = group.events.sort(
      (left, right) => compareText(left.startsAt, right.startsAt) || compareText(left.id, right.id),
    );
    const first = ordered[0]!;
    if (ordered.length === 1) return { marker: first, firstStartsAt: first.startsAt };
    const latitude = ordered.reduce((sum, event) => sum + event.coordinate.latitude, 0) / ordered.length;
    const longitude = circularLongitudeMean(ordered);
    return {
      marker: {
        kind: 'cluster',
        id: `cluster:z${zoom}:s${scale}:x${group.x}:y${group.y}`,
        coordinate: {
          latitude: roundedCoordinate(latitude),
          longitude: roundedCoordinate(longitude),
        },
        eventCount: ordered.length,
        categories: categorySummary(ordered),
      },
      firstStartsAt: first.startsAt,
    };
  });
}

function roundedCoordinate(value: number): number {
  return Number(value.toFixed(6));
}

function circularLongitudeMean(events: readonly ExplorerEventPin[]): number {
  let sine = 0;
  let cosine = 0;
  for (const event of events) {
    const radians = event.coordinate.longitude * Math.PI / 180;
    sine += Math.sin(radians);
    cosine += Math.cos(radians);
  }
  return Math.atan2(sine / events.length, cosine / events.length) * 180 / Math.PI;
}

function categorySummary(events: readonly ExplorerEventPin[]): ExplorerClusterCategorySummary[] {
  const counts = new Map<string, number>();
  for (const event of events) {
    counts.set(event.category.code, (counts.get(event.category.code) ?? 0) + 1);
  }
  return [...counts]
    .map(([code, eventCount]) => ({ code, eventCount }))
    .sort((left, right) => right.eventCount - left.eventCount || compareText(left.code, right.code));
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
