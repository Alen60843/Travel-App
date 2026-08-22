import { Injectable } from '@nestjs/common';

import type { GetExplorerEventsQueryDto } from './dto/get-explorer-events-query.dto';
import { clusterExplorerEvents } from './explorer-clustering';
import { ExplorerQueryInvalidError } from './explorer.errors';
import { normalizeExplorerQuery } from './explorer-query';
import { ExplorerRepository } from './explorer.repository';
import type { ExplorerEventsView } from './explorer.types';

@Injectable()
export class ExplorerService {
  constructor(private readonly repository: ExplorerRepository) {}

  async discoverEvents(
    authenticatedUserId: string,
    query: GetExplorerEventsQueryDto,
    now = new Date(),
  ): Promise<ExplorerEventsView> {
    // The current endpoint has no per-user ranking, but deliberately takes the
    // guard-derived internal UUID so future personalization cannot grow a
    // parallel client-selected identity seam.
    if (authenticatedUserId.length === 0) throw new TypeError('authenticatedUserId is required');
    const normalized = normalizeExplorerQuery(query, now);
    if (normalized.categoryCodes.length > 0) {
      const knownCodes = await this.repository.findKnownCategoryCodes(normalized.categoryCodes);
      if (knownCodes.length !== normalized.categoryCodes.length) {
        throw new ExplorerQueryInvalidError(
          'Every categoryCodes value must identify an existing event category.',
          'categoryCodes',
        );
      }
    }

    const events = await this.repository.findDiscoverableEvents(normalized);
    return {
      spatialMode: normalized.spatial.kind,
      windowStart: normalized.windowStart.toISOString(),
      windowEnd: normalized.windowEnd.toISOString(),
      eventCount: events.length,
      markers: clusterExplorerEvents(events, normalized.zoom, normalized.limit),
    };
  }
}
