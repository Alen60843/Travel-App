import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL } from '@nestjs/common';

import type { HttpResponseLike } from '../common/http.types';
import type { ReadinessCheckResult } from './readiness.service';
import { ReadinessService } from './readiness.service';

interface LivenessBody {
  readonly status: 'ok';
  readonly timestamp: string;
}

interface ReadinessBody {
  readonly status: 'ok' | 'error';
  readonly timestamp: string;
  readonly checks: readonly ReadinessCheckResult[];
}

/**
 * `version: VERSION_NEUTRAL` — orchestrator health probes are configured
 * with a fixed path and don't know (or care) about the API's version
 * scheme, so these routes are exempt from URI versioning. main.ts also
 * excludes `health/live` and `health/ready` from the global API prefix, so
 * both are reachable at exactly `/health/live` and `/health/ready`.
 */
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(private readonly readiness: ReadinessService) {}

  /**
   * Liveness: is the process itself alive and able to handle a request?
   * Deliberately checks NOTHING external. A dependency outage must not make
   * an orchestrator kill an otherwise-healthy pod — that only adds churn
   * (restart storms, cold starts, dropped in-flight work) on top of an
   * outage it can't fix by restarting this process.
   */
  @Get('live')
  live(@Res({ passthrough: true }) res: HttpResponseLike): LivenessBody {
    res.status(HttpStatus.OK);
    return { status: 'ok', timestamp: new Date().toISOString() };
  }

  /**
   * Readiness: can this instance serve traffic right now? Aggregates every
   * registered `ReadinessCheck`. 503 (with a per-dependency breakdown) if
   * any of them is unhealthy, so a load balancer/orchestrator can pull this
   * instance out of rotation without killing the process.
   */
  @Get('ready')
  async ready(@Res({ passthrough: true }) res: HttpResponseLike): Promise<ReadinessBody> {
    const result = await this.readiness.evaluate();
    res.status(result.healthy ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return {
      status: result.healthy ? 'ok' : 'error',
      timestamp: new Date().toISOString(),
      checks: result.checks,
    };
  }
}
