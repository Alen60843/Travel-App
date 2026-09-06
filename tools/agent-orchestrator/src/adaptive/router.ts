import { OrchestratorError } from '../errors';
import type {
  AgentRouter,
  CapabilityCatalog,
  CapabilityRequirement,
  RouteCandidate,
  RouteDecision,
  WorkRequest,
} from './types';

function satisfies(
  request: Pick<WorkRequest, 'role' | 'capabilities'>,
  candidate: RouteCandidate,
): boolean {
  return (candidate.roles === undefined || candidate.roles.includes(request.role)) && request.capabilities.every((required) => {
    const provided = candidate.capabilities.find(
      (item) => item.capability === required.capability,
    );
    return provided !== undefined &&
      (provided.minimumLevel ?? 0) >= (required.minimumLevel ?? 0);
  });
}

/** Provider-neutral availability view used by the arbiter; no executor is selected. */
export class StaticCapabilityCatalog implements CapabilityCatalog {
  constructor(private readonly candidates: readonly RouteCandidate[]) {}

  check(request: Pick<WorkRequest, 'role' | 'capabilities'>) {
    const capable = this.candidates.filter((candidate) => satisfies(request, candidate));
    if (capable.some((candidate) => candidate.available)) return { status: 'AVAILABLE' as const };
    if (capable.length > 0) return { status: 'TEMPORARILY_UNAVAILABLE' as const };
    return { status: 'UNAVAILABLE' as const };
  }
}

/** Stable, capability-first routing. This is intentionally called only after grant. */
export class DeterministicCapabilityRouter implements AgentRouter {
  route(request: WorkRequest, candidates: readonly RouteCandidate[]): RouteDecision {
    const selected = candidates
      .filter((candidate) => candidate.available && satisfies(request, candidate))
      .sort((left, right) => left.executorId.localeCompare(right.executorId))[0];
    if (selected === undefined) {
      throw new OrchestratorError(
        'AGENT_NOT_FOUND',
        `No available executor satisfies request ${request.id}`,
        { details: { requestId: request.id, capabilities: request.capabilities } },
      );
    }
    return {
      executorId: selected.executorId,
      reason: `capabilities satisfied for granted request ${request.id}`,
    };
  }
}
