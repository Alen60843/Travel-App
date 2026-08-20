import { Injectable } from '@nestjs/common';

/**
 * In-memory count of currently-authenticated live sockets on *this* process.
 *
 * Deliberately per-process, not cross-instance: aggregating across the fleet
 * is an observability concern (Phase 2's ObservabilityModule / a later
 * metrics endpoint), not something this gateway should reach into Redis for.
 * This is just the hook — a number later code can read.
 */
@Injectable()
export class ConnectionTracker {
  private count = 0;

  increment(): void {
    this.count += 1;
  }

  decrement(): void {
    this.count = Math.max(0, this.count - 1);
  }

  get activeConnections(): number {
    return this.count;
  }
}
