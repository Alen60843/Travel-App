import type {
  AdaptivePolicy,
  CapabilityRequirement,
  EvidenceReference,
  ResourceClaim,
  RiskLevel,
  WorkRequestDraft,
} from './types';

export interface DecompositionCandidate {
  readonly concern: string;
  readonly objective: string;
  readonly reason: string;
  readonly role: WorkRequestDraft['role'];
  readonly evidence: readonly EvidenceReference[];
  readonly capabilities?: readonly CapabilityRequirement[];
  readonly resourceClaims?: readonly ResourceClaim[];
  readonly risk?: RiskLevel;
  readonly priority?: number;
  readonly estimatedCostUnits?: number;
  /** Stable request ids of earlier candidates; forward references are rejected by replay validation. */
  readonly dependencies?: readonly string[];
}

export interface PlanningInput {
  readonly goal: string;
  /** Candidates come from repository analysis, not a fixed list of agent personas. */
  readonly candidates: readonly DecompositionCandidate[];
}

export interface DecompositionPlanner {
  plan(input: PlanningInput, policy: AdaptivePolicy): readonly WorkRequestDraft[];
}

/**
 * Transparent deterministic-first planner. It preserves configured candidates
 * and their evidence; the Arbiter, not the planner, records policy denials.
 */
export class EvidenceDrivenPlanner implements DecompositionPlanner {
  plan(input: PlanningInput, policy: AdaptivePolicy): readonly WorkRequestDraft[] {
    if (input.goal.trim() === '') return [];
    // Candidates remain visible even when policy will deny them. Filtering
    // here would erase the request and its evidence instead of producing an
    // auditable Arbiter decision.
    return input.candidates
      .slice(0, policy.limits.maxTotalWorkUnits)
      .map((candidate) => ({
        role: candidate.role,
        concern: candidate.concern,
        objective: candidate.objective,
        reason: candidate.reason,
        dependencies: candidate.dependencies ?? [],
        capabilities: candidate.capabilities ?? [],
        resourceClaims: candidate.resourceClaims ?? [],
        evidence: candidate.evidence,
        risk: candidate.risk ?? 'medium',
        priority: candidate.priority ?? 50,
        ...(candidate.estimatedCostUnits === undefined
          ? {}
          : { estimatedCostUnits: candidate.estimatedCostUnits }),
      }));
  }
}
