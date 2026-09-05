export const ADAPTIVE_ROLES = [
  'implementation',
  'review',
  'correction',
  'testing',
  'synthesis',
  'final_review',
  'escalation',
  'integration_assistance',
] as const;

export type AdaptiveRole = (typeof ADAPTIVE_ROLES)[number];
export type RiskLevel = 'low' | 'medium' | 'high' | 'critical';
export type ResourceMode = 'read' | 'write';
export type WorkUnitStatus =
  | 'REQUESTED'
  | 'WAITING'
  | 'GRANTED'
  | 'RUNNING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'TIMED_OUT'
  | 'DENIED'
  | 'SKIPPED';

export interface EvidenceReference {
  readonly kind: 'diff' | 'file' | 'test' | 'schema' | 'runtime' | 'finding';
  readonly reference: string;
  readonly summary: string;
}

export interface CorrectionPolicy {
  readonly allowedOwnership: readonly string[];
  readonly allowedRoles: readonly Extract<AdaptiveRole, 'correction' | 'testing'>[];
  readonly requireCanonicalFinding: boolean;
  readonly maxRounds: number;
}

export interface AdaptiveContinuationConfig {
  readonly sourceRunId: string;
  readonly sourceWorkUnitId: string;
  readonly sourceArtifactType: 'review';
  readonly expectedBaseSha: string;
  /** Optional pin for source systems that already record an artifact digest. */
  readonly expectedArtifactSha256?: string;
  readonly mode: 'canonical_findings';
}

export interface ImportedCanonicalFinding {
  readonly canonicalFindingKey: string;
  readonly finding: import('../review/findings').ReviewFinding;
  readonly sourceRunId: string;
  readonly sourceWorkUnitId: string;
  readonly sourceArtifactPath: string;
  readonly sourceBaseSha: string;
  readonly sourceArtifactSha256: string;
  readonly importedAt: string;
  readonly round: 1;
}

export interface AdaptiveContinuationState extends AdaptiveContinuationConfig {
  readonly sourceBaseSha: string;
  readonly sourceArtifactPath: string;
  readonly sourceArtifactSha256: string;
  readonly sourceReviewStatus: 'changes_requested';
  readonly importedAt: string;
  readonly findings: readonly ImportedCanonicalFinding[];
}

export interface ImportedFindingSource {
  readonly sourceRunId: string;
  readonly sourceWorkUnitId: string;
  readonly sourceBaseSha: string;
  readonly artifactPath: string;
  readonly artifactSha256: string;
}

/** Trusted orchestrator provenance. This field is never accepted from an agent draft. */
export interface CanonicalFindingAuthorization {
  readonly kind: 'canonical_finding';
  readonly purpose: 'correction' | 'reverification';
  readonly canonicalFindingKey: string;
  readonly findingReference: string;
  readonly sourceWorkUnitId: string;
  readonly artifactPath: string;
  readonly round: number;
  /** Present only on a first-round correction seeded from a validated prior run. */
  readonly importedSource?: ImportedFindingSource;
}

export interface CapabilityRequirement {
  readonly capability: string;
  readonly minimumLevel?: number;
}

export interface ResourceClaim {
  readonly kind: 'repository_path' | 'database' | 'service' | 'logical';
  readonly key: string;
  readonly mode: ResourceMode;
}

export interface ResourceBoundary {
  readonly kind: Exclude<ResourceClaim['kind'], 'repository_path'>;
  readonly key: string;
  /** Maximum authorized access. A write boundary contains read; read never contains write. */
  readonly mode: ResourceMode;
}

/** Untrusted proposal shape. Identity, depth, state, provider and grant are absent by design. */
export interface WorkRequestDraft {
  readonly role: AdaptiveRole;
  readonly concern: string;
  readonly objective: string;
  readonly reason: string;
  readonly dependencies?: readonly string[];
  readonly capabilities?: readonly CapabilityRequirement[];
  readonly resourceClaims?: readonly ResourceClaim[];
  readonly evidence?: readonly EvidenceReference[];
  readonly risk?: RiskLevel;
  readonly priority?: number;
  readonly estimatedCostUnits?: number;
}

export interface WorkRequest extends Required<Omit<WorkRequestDraft, 'estimatedCostUnits'>> {
  readonly id: string;
  readonly parentWorkUnitId?: string;
  readonly depth: number;
  readonly sequence: number;
  readonly createdAt: string;
  readonly source: 'planner' | 'agent' | 'orchestrator';
  readonly estimatedCostUnits?: number;
  readonly authorization?: CanonicalFindingAuthorization;
}

export const GRANT_REASONS = [
  'ELIGIBLE',
  'DEPENDENCY_NOT_READY',
  'INVALID_DEPENDENCY',
  'OWNERSHIP_CONFLICT',
  'RESOURCE_BUSY',
  'GLOBAL_CONCURRENCY_LIMIT',
  'MAX_TOTAL_WORK_UNITS',
  'MAX_AGENT_INVOCATIONS',
  'MAX_DECOMPOSITION_DEPTH',
  'MAX_FAN_OUT',
  'BUDGET_EXCEEDED',
  'WALL_CLOCK_BUDGET_EXCEEDED',
  'INSUFFICIENT_EVIDENCE',
  'OUTSIDE_ALLOWED_CONCERN',
  'OUTSIDE_ALLOWED_OWNERSHIP',
  'NO_CAPABLE_PROVIDER',
  'PROVIDER_TEMPORARILY_UNAVAILABLE',
  'DUPLICATE_REQUEST',
  'ALREADY_SATISFIED',
  'HUMAN_APPROVAL_REQUIRED',
] as const;

export type GrantReason = (typeof GRANT_REASONS)[number];

export interface GrantDecision {
  readonly id: string;
  readonly requestId: string;
  readonly outcome: 'GRANTED' | 'WAITING' | 'DENIED';
  readonly reason: GrantReason;
  readonly detail: string;
  readonly effectivePriority: number;
  readonly decidedAt: string;
  readonly sequence: number;
}

export interface WorkAttempt {
  readonly number: number;
  readonly grantDecisionId: string;
  readonly status: 'GRANTED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT';
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly resultEvidence?: readonly EvidenceReference[];
  readonly error?: string;
}

export interface DynamicWorkUnit {
  readonly id: string;
  readonly requestId: string;
  readonly parentWorkUnitId?: string;
  readonly role: AdaptiveRole;
  readonly concern: string;
  readonly objective: string;
  readonly reason: string;
  readonly dependencyRequestIds: readonly string[];
  readonly capabilities: readonly CapabilityRequirement[];
  readonly resourceClaims: readonly ResourceClaim[];
  readonly depth: number;
  readonly status: WorkUnitStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly attempts: readonly WorkAttempt[];
  readonly route?: AdaptiveExecutionRoute;
}

export interface AdaptiveExecutionRoute {
  readonly executorId: string;
  readonly adapter: 'codex' | 'claude';
  readonly routedAt: string;
}

export interface AdaptiveLimits {
  readonly maxConcurrentAgents: number;
  readonly maxAgentInvocations: number;
  readonly maxTotalWorkUnits: number;
  readonly maxDecompositionDepth: number;
  readonly maxFanOutPerWorkUnit: number;
  readonly maxSynthesisInputs: number;
  readonly maxWallClockMs: number;
  readonly maxEstimatedCostUnits?: number;
}

export interface AdaptivePolicy {
  readonly allowedConcerns: readonly string[];
  readonly allowedOwnership: readonly string[];
  readonly allowedResources: readonly ResourceBoundary[];
  readonly limits: AdaptiveLimits;
  readonly requireEvidenceForExpansion: boolean;
  readonly agingIntervalMs: number;
  readonly agingStep: number;
  readonly humanApprovalRisks: readonly RiskLevel[];
  readonly correctionPolicy?: CorrectionPolicy;
}

export const ADAPTIVE_EVENT_TYPES = [
  'REQUEST_CREATED',
  'REQUEST_DEDUPLICATED',
  'GRANT_DECIDED',
  'WORK_UNIT_CREATED',
  'WORK_UNIT_STARTED',
  'WORK_UNIT_FINISHED',
  'RESOURCE_RELEASED',
  'WORK_UNIT_RETRY_AUTHORIZED',
  'WORK_UNIT_RECOVERED',
  'SYNTHESIS_TREE_CREATED',
  'CANONICAL_FINDINGS_IMPORTED',
  'CORRECTION_PLAN_CREATED',
  'CORRECTION_REQUEST_CREATED',
  'CORRECTION_GRANTED',
  'REVERIFICATION_CREATED',
] as const;
export type AdaptiveEventType = (typeof ADAPTIVE_EVENT_TYPES)[number];

export interface AdaptiveEvent {
  readonly sequence: number;
  readonly type: AdaptiveEventType;
  readonly occurredAt: string;
  readonly requestId?: string;
  readonly workUnitId?: string;
  readonly decisionId?: string;
  readonly detail: string;
}

export interface AdaptiveRunState {
  readonly schemaVersion: 1;
  readonly goal: string;
  readonly policy: AdaptivePolicy;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly workRequests: readonly WorkRequest[];
  readonly grantDecisions: readonly GrantDecision[];
  readonly workUnits: readonly DynamicWorkUnit[];
  readonly events: readonly AdaptiveEvent[];
  readonly totalAgentInvocations: number;
  readonly grantedEstimatedCostUnits: number;
  /** Immutable evidence copied into this run before any continuation agent launches. */
  readonly continuation?: AdaptiveContinuationState;
}

export interface CapabilityAvailability {
  readonly status: 'AVAILABLE' | 'TEMPORARILY_UNAVAILABLE' | 'UNAVAILABLE';
  readonly detail?: string;
}

/** Capability discovery only. It deliberately cannot select a provider. */
export interface CapabilityCatalog {
  check(request: Pick<WorkRequest, 'role' | 'capabilities'>): CapabilityAvailability;
}

export interface RouteCandidate {
  readonly executorId: string;
  readonly capabilities: readonly CapabilityRequirement[];
  readonly available: boolean;
  readonly roles?: readonly AdaptiveRole[];
}

export interface RouteDecision {
  readonly executorId: string;
  readonly reason: string;
}

/** Routing happens only after an orchestrator grant. */
export interface AgentRouter {
  route(request: WorkRequest, candidates: readonly RouteCandidate[]): RouteDecision;
}

export interface ExecutionResult {
  readonly outcome: 'completed' | 'failed' | 'timed_out';
  readonly evidence: readonly EvidenceReference[];
  readonly error?: string;
}

/** Execution consumes an authorized unit and a separate post-grant route. */
export interface WorkExecutor {
  execute(unit: DynamicWorkUnit, route: RouteDecision, signal: AbortSignal): Promise<ExecutionResult>;
}

export interface ResultEvaluation {
  readonly outcome: 'accepted' | 'failed' | 'needs_correction' | 'needs_synthesis';
  readonly evidence: readonly EvidenceReference[];
  readonly additionalWorkRequests: readonly WorkRequestDraft[];
}

/** Evaluators may propose follow-up requests; they cannot grant them. */
export interface ResultEvaluator {
  evaluate(unit: DynamicWorkUnit, result: ExecutionResult): ResultEvaluation;
}

export interface DeterministicGateResult {
  readonly passed: boolean;
  readonly checks: readonly { readonly command: string; readonly passed: boolean }[];
}
