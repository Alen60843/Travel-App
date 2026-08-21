import { Inject, Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import type { DataSource } from 'typeorm';
import { withTimeout } from '../common/with-timeout';
import { APP_CONFIG, type AppConfig } from '../config/configuration';

/**
 * Contract owned by Agent C (health/readiness). Declared locally rather than
 * imported so this module has zero dependency on src/health/** — the Lead
 * wires this provider into whatever aggregator Agent C builds. Must stay
 * byte-identical in shape to their interface.
 */
export interface ReadinessCheck {
  readonly name: string;
  check(): Promise<{ healthy: boolean; detail?: string }>;
}

/**
 * Confirms the pool can actually round-trip a query and that PostGIS — a
 * hard schema dependency (geography columns, ST_DWithin, GIST opclasses) —
 * is installed in the connected database. A connection that succeeds but
 * lacks PostGIS would pass a naive `SELECT 1` check and then fail the first
 * spatial query in production, so both are checked here.
 */
@Injectable()
export class DatabaseReadinessCheck implements ReadinessCheck {
  readonly name = 'database';
  private probeInFlight: Promise<{ healthy: boolean; detail?: string }> | null = null;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  check(): Promise<{ healthy: boolean; detail?: string }> {
    if (!this.probeInFlight) {
      let probe: Promise<{ healthy: boolean; detail?: string }>;
      probe = this.runProbe().finally(() => {
        if (this.probeInFlight === probe) this.probeInFlight = null;
      });
      this.probeInFlight = probe;
    }

    const timeoutMs = this.config.app.dependencyCheckTimeoutMs;
    return withTimeout(
      this.probeInFlight,
      timeoutMs,
      `database readiness probe timed out after ${timeoutMs}ms`,
    ).catch((error: unknown) => ({
      healthy: false,
      detail: `connection failed: ${describeError(error)}`,
    }));
  }

  private async runProbe(): Promise<{ healthy: boolean; detail?: string }> {
    try {
      await this.dataSource.query('SELECT 1');
    } catch (error) {
      return { healthy: false, detail: `connection failed: ${describeError(error)}` };
    }

    try {
      const rows = (await this.dataSource.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'postgis'",
      )) as unknown[];
      if (rows.length === 0) {
        return { healthy: false, detail: 'postgis extension is not installed' };
      }
    } catch (error) {
      return { healthy: false, detail: `postgis check failed: ${describeError(error)}` };
    }

    return { healthy: true };
  }
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
