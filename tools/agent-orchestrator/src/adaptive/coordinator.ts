import { OrchestratorError } from '../errors';
import { ownershipGlobsOverlap } from '../tasks/ownership';
import type {
  AdaptiveEvent,
  AdaptivePolicy,
  AdaptiveRunState,
  CapabilityCatalog,
  EvidenceReference,
  GrantDecision,
  GrantReason,
  ResourceClaim,
  WorkAttempt,
  WorkRequest,
  WorkRequestDraft,
  DynamicWorkUnit,
  CanonicalFindingAuthorization,
  RecoveryEpochState,
} from './types';
import { parseAdaptivePolicy, parseWorkRequestDraft } from './validation';
import { parseAdaptiveRunState } from './state-validation';

export interface Clock {
  now(): Date;
}

const SYSTEM_CLOCK: Clock = { now: () => new Date() };
const AVAILABLE_CATALOG: CapabilityCatalog = {
  check: () => ({ status: 'AVAILABLE' }),
};

function iso(clock: Clock): string {
  return clock.now().toISOString();
}

function nextId(prefix: string, count: number): string {
  return `${prefix}-${String(count + 1).padStart(6, '0')}`;
}

function claimAllowed(claim: string, boundaries: readonly string[]): boolean {
  return boundaries.some((boundary) => {
    if (boundary === '**' || boundary === claim) return true;
    if (boundary.endsWith('/**')) {
      const prefix = boundary.slice(0, -3);
      return claim === prefix || claim.startsWith(`${prefix}/`);
    }
    return false;
  });
}

function claimsConflict(left: ResourceClaim, right: ResourceClaim): boolean {
  if (left.mode === 'read' && right.mode === 'read') return false;
  if (left.kind !== right.kind) return false;
  return left.kind === 'repository_path'
    ? ownershipGlobsOverlap(left.key, right.key)
    : left.key === right.key;
}

function fingerprint(request: WorkRequest): string {
  return JSON.stringify({
    role: request.role,
    concern: request.concern,
    objective: request.objective,
    reason: request.reason,
    dependencies: [...request.dependencies].sort(),
    capabilities: [...request.capabilities].sort((a, b) => a.capability.localeCompare(b.capability)),
    resourceClaims: [...request.resourceClaims].sort((a, b) => `${a.kind}:${a.key}:${a.mode}`.localeCompare(`${b.kind}:${b.key}:${b.mode}`)),
    authorization: request.authorization,
  });
}

function replaceUnit(state: AdaptiveRunState, unit: DynamicWorkUnit): AdaptiveRunState {
  return { ...state, workUnits: state.workUnits.map((item) => item.id === unit.id ? unit : item), updatedAt: unit.updatedAt };
}

export class AdaptiveCoordinator {
  private state: AdaptiveRunState;

  constructor(
    state: AdaptiveRunState,
    private readonly catalog: CapabilityCatalog = AVAILABLE_CATALOG,
    private readonly clock: Clock = SYSTEM_CLOCK,
  ) {
    this.state = parseAdaptiveRunState(structuredClone(state));
  }

  static create(goal: string, policyValue: unknown, clock: Clock = SYSTEM_CLOCK): AdaptiveCoordinator {
    if (goal.trim() === '') throw new OrchestratorError('CONFIG_INVALID', 'Adaptive goal must be non-empty');
    const policy = parseAdaptivePolicy(policyValue);
    const now = iso(clock);
    return new AdaptiveCoordinator({
      schemaVersion: 1,
      goal: goal.trim(),
      policy,
      startedAt: now,
      updatedAt: now,
      workRequests: [],
      grantDecisions: [],
      workUnits: [],
      events: [],
      totalAgentInvocations: 0,
      grantedEstimatedCostUnits: 0,
    }, AVAILABLE_CATALOG, clock);
  }

  snapshot(): AdaptiveRunState {
    return structuredClone(this.state);
  }

  submit(
    draftValue: unknown,
    options: { parentWorkUnitId?: string; source?: WorkRequest['source'] } = {},
  ): WorkRequest {
    const draft = parseWorkRequestDraft(draftValue);
    const parent = options.parentWorkUnitId === undefined
      ? undefined
      : this.state.workUnits.find((unit) => unit.id === options.parentWorkUnitId);
    if (options.parentWorkUnitId !== undefined && parent === undefined) {
      throw new OrchestratorError('TASK_STATE_INVALID', `Unknown parent work unit ${options.parentWorkUnitId}`);
    }
    if (options.source === 'agent' && parent === undefined) {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Agent-proposed work must identify its parent work unit');
    }
    const request: WorkRequest = {
      ...draft,
      dependencies: draft.dependencies ?? [],
      capabilities: draft.capabilities ?? [],
      resourceClaims: draft.resourceClaims ?? [],
      evidence: draft.evidence ?? [],
      risk: draft.risk ?? 'medium',
      priority: draft.priority ?? 50,
      id: nextId('request', this.state.workRequests.length),
      ...(parent === undefined ? {} : { parentWorkUnitId: parent.id }),
      depth: parent === undefined ? 0 : parent.depth + 1,
      sequence: this.state.workRequests.length + 1,
      createdAt: iso(this.clock),
      source: options.source ?? (parent === undefined ? 'planner' : 'agent'),
    };
    this.state = {
      ...this.state,
      workRequests: [...this.state.workRequests, request],
      updatedAt: request.createdAt,
    };
    this.event('REQUEST_CREATED', `request proposed by ${request.source}`, { requestId: request.id });
    return request;
  }

  submitMany(drafts: readonly unknown[], options: { parentWorkUnitId?: string; source?: WorkRequest['source'] } = {}): WorkRequest[] {
    return drafts.map((draft) => this.submit(draft, options));
  }

  /** Mint a privileged ROOT request only from persisted canonical review provenance. */
  submitCanonicalFindingWork(
    draftValue: unknown,
    authorization: CanonicalFindingAuthorization,
  ): WorkRequest {
    const draft = parseWorkRequestDraft(draftValue);
    const source = this.state.workUnits.find((unit) => unit.id === authorization.sourceWorkUnitId);
    if (authorization.importedSource !== undefined) {
      const imported = this.state.continuation?.findings.find(
        (finding) => finding.canonicalFindingKey === authorization.canonicalFindingKey,
      );
      if (authorization.purpose !== 'correction' || authorization.round !== 1 || imported === undefined
        || authorization.findingReference !== imported.finding.id
        || authorization.sourceWorkUnitId !== imported.sourceWorkUnitId
        || authorization.artifactPath !== imported.sourceArtifactPath
        || authorization.importedSource.sourceRunId !== imported.sourceRunId
        || authorization.importedSource.sourceWorkUnitId !== imported.sourceWorkUnitId
        || authorization.importedSource.sourceBaseSha !== imported.sourceBaseSha
        || authorization.importedSource.artifactPath !== imported.sourceArtifactPath
        || authorization.importedSource.artifactSha256 !== imported.sourceArtifactSha256) {
        throw new OrchestratorError('TASK_STATE_INVALID', 'Imported canonical finding authorization does not match persisted continuation evidence');
      }
    } else {
      const validSourceRole = authorization.purpose === 'correction'
        ? ['review', 'synthesis', 'final_review'].includes(source?.role ?? '')
        : ['correction', 'testing'].includes(source?.role ?? '');
      if (source === undefined || source.status !== 'SUCCEEDED' || !validSourceRole) {
        throw new OrchestratorError('TASK_STATE_INVALID', 'Canonical finding source must be a successful persisted review unit');
      }
    }
    if ((authorization.purpose === 'correction' && draft.role !== 'correction' && draft.role !== 'testing')
      || (authorization.purpose === 'reverification' && draft.role !== 'review')) {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Canonical finding purpose does not match requested role');
    }
    if (authorization.purpose === 'correction'
      && !(draft.resourceClaims ?? []).some((claim) => claim.mode === 'write')) {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Canonical correction must request explicit write authority');
    }
    if (authorization.kind !== 'canonical_finding' || authorization.round < 1
      || authorization.findingReference.trim() === '' || authorization.artifactPath.trim() === '') {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Canonical finding authorization is incomplete');
    }
    if (!(draft.evidence ?? []).some((item) => item.kind === 'finding' && item.reference === authorization.findingReference)) {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Correction evidence does not reference its canonical finding');
    }
    const duplicate = this.state.workRequests.find((request) =>
      request.authorization?.purpose === authorization.purpose
      && request.authorization.canonicalFindingKey === authorization.canonicalFindingKey
      && request.authorization.round === authorization.round,
    );
    if (duplicate !== undefined) return duplicate;
    const request = this.submit(draft, { source: 'orchestrator' });
    this.state = {
      ...this.state,
      workRequests: this.state.workRequests.map((item) => item.id === request.id
        ? { ...item, authorization }
        : item),
    };
    this.event(
      authorization.purpose === 'correction' ? 'CORRECTION_PLAN_CREATED' : 'REVERIFICATION_CREATED',
      `${authorization.canonicalFindingKey} round ${authorization.round}`,
      authorization.importedSource === undefined
        ? { requestId: request.id, workUnitId: authorization.sourceWorkUnitId }
        : { requestId: request.id },
    );
    if (authorization.purpose === 'correction') {
      this.event('CORRECTION_REQUEST_CREATED', authorization.findingReference, { requestId: request.id });
    }
    return this.state.workRequests.find((item) => item.id === request.id)!;
  }

  private event(
    type: AdaptiveEvent['type'],
    detail: string,
    ids: Pick<AdaptiveEvent, 'requestId' | 'workUnitId' | 'decisionId'> = {},
  ): void {
    const event: AdaptiveEvent = {
      sequence: this.state.events.length + 1,
      type,
      occurredAt: iso(this.clock),
      ...ids,
      detail,
    };
    this.state = { ...this.state, events: [...this.state.events, event], updatedAt: event.occurredAt };
  }

  private effectivePriority(request: WorkRequest): number {
    const waitedMs = Math.max(0, this.clock.now().getTime() - Date.parse(request.createdAt));
    return request.priority + Math.floor(waitedMs / this.state.policy.agingIntervalMs) * this.state.policy.agingStep;
  }

  private latestDecision(requestId: string): GrantDecision | undefined {
    return [...this.state.grantDecisions].reverse().find((decision) => decision.requestId === requestId);
  }

  private decide(request: WorkRequest, outcome: GrantDecision['outcome'], reason: GrantReason, detail: string): GrantDecision {
    const previous = this.latestDecision(request.id);
    if (previous?.outcome === outcome && previous.reason === reason && outcome === 'WAITING') return previous;
    const recoveryEpochNumber = this.state.recoveryEpoch?.requestIds.includes(request.id) === true
      ? this.state.recoveryEpoch.number
      : undefined;
    const decision: GrantDecision = {
      id: nextId('decision', this.state.grantDecisions.length),
      requestId: request.id,
      outcome,
      reason,
      detail,
      effectivePriority: this.effectivePriority(request),
      decidedAt: iso(this.clock),
      sequence: this.state.grantDecisions.length + 1,
      ...(recoveryEpochNumber === undefined ? {} : { recoveryEpochNumber }),
    };
    this.state = { ...this.state, grantDecisions: [...this.state.grantDecisions, decision], updatedAt: decision.decidedAt };
    this.event('GRANT_DECIDED', `${outcome}: ${reason} — ${detail}`, { requestId: request.id, decisionId: decision.id });
    if (reason === 'DUPLICATE_REQUEST') {
      this.event('REQUEST_DEDUPLICATED', detail, { requestId: request.id, decisionId: decision.id });
    }
    return decision;
  }

  private existingUnit(requestId: string): DynamicWorkUnit | undefined {
    return this.state.workUnits.find((unit) => unit.requestId === requestId);
  }

  private terminalDecision(requestId: string): boolean {
    const latest = this.latestDecision(requestId);
    const unit = this.existingUnit(requestId);
    return latest?.outcome === 'DENIED' || ['SUCCEEDED', 'SKIPPED'].includes(unit?.status ?? '');
  }

  private activeUnits(): DynamicWorkUnit[] {
    return this.state.workUnits.filter((unit) => unit.status === 'GRANTED' || unit.status === 'RUNNING');
  }

  private validateEligibility(request: WorkRequest): { outcome: 'WAITING' | 'DENIED'; reason: GrantReason; detail: string } | undefined {
    const policy = this.state.policy;
    const duplicate = this.state.workRequests.find((candidate) => candidate.sequence < request.sequence && fingerprint(candidate) === fingerprint(request));
    if (duplicate !== undefined) return { outcome: 'DENIED', reason: 'DUPLICATE_REQUEST', detail: `duplicates ${duplicate.id}` };
    if (request.depth > policy.limits.maxDecompositionDepth) return { outcome: 'DENIED', reason: 'MAX_DECOMPOSITION_DEPTH', detail: `depth ${request.depth} exceeds ${policy.limits.maxDecompositionDepth}` };
    if (!policy.allowedConcerns.includes(request.concern)) return { outcome: 'DENIED', reason: 'OUTSIDE_ALLOWED_CONCERN', detail: `${request.concern} is outside policy` };
    if (policy.requireEvidenceForExpansion && request.evidence.length === 0) return { outcome: 'DENIED', reason: 'INSUFFICIENT_EVIDENCE', detail: 'no evidence supports expansion' };
    if (policy.humanApprovalRisks.includes(request.risk)) return { outcome: 'WAITING', reason: 'HUMAN_APPROVAL_REQUIRED', detail: `${request.risk} risk requires human approval` };
    const repositoryClaims = request.resourceClaims.filter((claim) => claim.kind === 'repository_path');
    if (repositoryClaims.some((claim) => !claimAllowed(claim.key, policy.allowedOwnership))) return { outcome: 'DENIED', reason: 'OUTSIDE_ALLOWED_OWNERSHIP', detail: 'repository claim exceeds phase ownership' };
    const nonRepositoryClaims = request.resourceClaims.filter((claim) => claim.kind !== 'repository_path');
    if (nonRepositoryClaims.some((claim) => !policy.allowedResources.some((boundary) =>
      boundary.kind === claim.kind
      && boundary.key === claim.key
      && (boundary.mode === 'write' || claim.mode === 'read')))) {
      return { outcome: 'DENIED', reason: 'OUTSIDE_ALLOWED_OWNERSHIP', detail: 'resource claim key or mode exceeds phase policy' };
    }
    if (request.parentWorkUnitId !== undefined) {
      const siblings = this.state.workRequests.filter((candidate) => candidate.parentWorkUnitId === request.parentWorkUnitId && candidate.sequence <= request.sequence);
      if (siblings.length > policy.limits.maxFanOutPerWorkUnit) return { outcome: 'DENIED', reason: 'MAX_FAN_OUT', detail: 'parent fan-out limit reached' };
      const parentRequest = this.state.workRequests.find((candidate) => this.existingUnit(candidate.id)?.id === request.parentWorkUnitId);
      const parentClaims = parentRequest?.resourceClaims ?? [];
      const expandsParent = request.resourceClaims
        .filter((claim) => claim.kind === 'repository_path')
        .some((claim) => !parentClaims.some((parentClaim) =>
        parentClaim.kind === claim.kind &&
        claimAllowed(claim.key, [parentClaim.key]) &&
        (parentClaim.mode === 'write' || claim.mode === 'read'),
      ));
      if (expandsParent) return { outcome: 'DENIED', reason: 'OUTSIDE_ALLOWED_OWNERSHIP', detail: 'child expanded beyond parent ownership' };
    }
    const correctionWrite = (request.role === 'correction' || request.role === 'testing')
      && request.resourceClaims.some((claim) => claim.kind === 'repository_path' && claim.mode === 'write');
    if (correctionWrite && request.parentWorkUnitId === undefined) {
      const correctionPolicy = policy.correctionPolicy;
      if (correctionPolicy === undefined || request.authorization?.purpose !== 'correction') {
        return { outcome: 'DENIED', reason: 'INSUFFICIENT_EVIDENCE', detail: 'root write correction lacks canonical finding authorization' };
      }
      if (!correctionPolicy.allowedRoles.includes(request.role)) {
        return { outcome: 'DENIED', reason: 'OUTSIDE_ALLOWED_CONCERN', detail: `${request.role} is outside correction policy` };
      }
      if (request.authorization.round > correctionPolicy.maxRounds) {
        return { outcome: 'DENIED', reason: 'MAX_DECOMPOSITION_DEPTH', detail: 'correction round limit reached' };
      }
      const writeClaims = request.resourceClaims.filter((claim) => claim.kind === 'repository_path' && claim.mode === 'write');
      if (writeClaims.some((claim) => !claimAllowed(claim.key, correctionPolicy.allowedOwnership))) {
        return { outcome: 'DENIED', reason: 'OUTSIDE_ALLOWED_OWNERSHIP', detail: 'write claim exceeds correction policy' };
      }
    }
    const missing = request.dependencies.find((dependency) => !this.state.workRequests.some((candidate) => candidate.id === dependency));
    if (missing !== undefined) return { outcome: 'DENIED', reason: 'INVALID_DEPENDENCY', detail: `dependency ${missing} does not exist` };
    const failedDependency = request.dependencies.find((dependency) => {
      const unit = this.existingUnit(dependency);
      return this.latestDecision(dependency)?.outcome === 'DENIED' || unit?.status === 'DENIED';
    });
    if (failedDependency !== undefined) return { outcome: 'DENIED', reason: 'INVALID_DEPENDENCY', detail: `dependency ${failedDependency} cannot succeed` };
    const retryableDependency = request.dependencies.find((dependency) =>
      ['FAILED', 'TIMED_OUT'].includes(this.existingUnit(dependency)?.status ?? ''),
    );
    if (retryableDependency !== undefined) return { outcome: 'WAITING', reason: 'DEPENDENCY_NOT_READY', detail: `dependency ${retryableDependency} is awaiting recovery` };
    const pending = request.dependencies.find((dependency) => !['SUCCEEDED', 'SKIPPED'].includes(this.existingUnit(dependency)?.status ?? ''));
    if (pending !== undefined) return { outcome: 'WAITING', reason: 'DEPENDENCY_NOT_READY', detail: `dependency ${pending} is not complete` };
    const capability = this.catalog.check(request);
    if (capability.status === 'UNAVAILABLE') return { outcome: 'DENIED', reason: 'NO_CAPABLE_PROVIDER', detail: capability.detail ?? 'no executor has the required capabilities' };
    if (capability.status === 'TEMPORARILY_UNAVAILABLE') return { outcome: 'WAITING', reason: 'PROVIDER_TEMPORARILY_UNAVAILABLE', detail: capability.detail ?? 'capable executors are temporarily unavailable' };
    if (this.state.workUnits.length >= policy.limits.maxTotalWorkUnits && this.existingUnit(request.id) === undefined) return { outcome: 'DENIED', reason: 'MAX_TOTAL_WORK_UNITS', detail: 'work-unit budget exhausted' };
    if (this.state.totalAgentInvocations >= policy.limits.maxAgentInvocations) return { outcome: 'DENIED', reason: 'MAX_AGENT_INVOCATIONS', detail: 'agent-invocation budget exhausted' };
    // A request bound to an authorized recovery epoch (see
    // authorizeRecoveryEpoch) is measured against that epoch's own
    // independently-tracked start/budget instead of the original run's —
    // the original wall-clock rule/history is never touched for any other
    // request, and this request itself keeps using the epoch clock on
    // every future arbitration pass, not just the one that admitted it.
    const recoveryEpoch = this.state.recoveryEpoch?.requestIds.includes(request.id) === true
      ? this.state.recoveryEpoch
      : undefined;
    const wallClockStartedAt = recoveryEpoch?.startedAt ?? this.state.startedAt;
    const wallClockBudgetMs = recoveryEpoch?.maxWallClockMs ?? policy.limits.maxWallClockMs;
    if (this.clock.now().getTime() - Date.parse(wallClockStartedAt) > wallClockBudgetMs) {
      return recoveryEpoch === undefined
        ? { outcome: 'DENIED', reason: 'WALL_CLOCK_BUDGET_EXCEEDED', detail: 'run wall-clock budget exhausted' }
        : { outcome: 'DENIED', reason: 'RECOVERY_WALL_CLOCK_BUDGET_EXCEEDED', detail: `recovery epoch ${recoveryEpoch.number} wall-clock budget exhausted` };
    }
    const projectedCost = this.state.grantedEstimatedCostUnits + (request.estimatedCostUnits ?? 0);
    if (policy.limits.maxEstimatedCostUnits !== undefined && projectedCost > policy.limits.maxEstimatedCostUnits) return { outcome: 'DENIED', reason: 'BUDGET_EXCEEDED', detail: 'estimated-cost budget exhausted' };
    const conflicting = this.activeUnits().find((unit) => unit.resourceClaims.some((held) => request.resourceClaims.some((wanted) => claimsConflict(held, wanted))));
    if (conflicting !== undefined) return { outcome: 'WAITING', reason: 'OWNERSHIP_CONFLICT', detail: `conflicts with active ${conflicting.id}` };
    if (this.activeUnits().length >= policy.limits.maxConcurrentAgents) return { outcome: 'WAITING', reason: 'GLOBAL_CONCURRENCY_LIMIT', detail: 'global concurrency limit reached' };
    return undefined;
  }

  /** Evaluate every pending request in deterministic priority/age/sequence order. */
  arbitrate(): GrantDecision[] {
    const candidates = this.state.workRequests
      .filter((request) => {
        const unit = this.existingUnit(request.id);
        return !this.terminalDecision(request.id) && (unit === undefined || unit.status === 'REQUESTED' || unit.status === 'WAITING');
      })
      .sort((left, right) => this.effectivePriority(right) - this.effectivePriority(left) || left.sequence - right.sequence);
    return candidates.map((request) => this.evaluateRequest(request));
  }

  /** The single per-request evaluate-and-grant body, shared by arbitrate() and authorizeRecoveryEpoch()'s re-arbitration pass. */
  private evaluateRequest(request: WorkRequest): GrantDecision {
    const ineligible = this.validateEligibility(request);
    if (ineligible !== undefined) {
      return this.decide(request, ineligible.outcome, ineligible.reason, ineligible.detail);
    }
    const decision = this.decide(request, 'GRANTED', 'ELIGIBLE', 'deterministic policy checks passed');
    const existing = this.existingUnit(request.id);
    const attempt: WorkAttempt = { number: (existing?.attempts.length ?? 0) + 1, grantDecisionId: decision.id, status: 'GRANTED' };
    const unit: DynamicWorkUnit = existing === undefined ? {
      id: nextId('work', this.state.workUnits.length), requestId: request.id,
      ...(request.parentWorkUnitId === undefined ? {} : { parentWorkUnitId: request.parentWorkUnitId }),
      role: request.role, concern: request.concern, objective: request.objective, reason: request.reason,
      dependencyRequestIds: request.dependencies, capabilities: request.capabilities,
      resourceClaims: request.resourceClaims, depth: request.depth, status: 'GRANTED',
      createdAt: decision.decidedAt, updatedAt: decision.decidedAt, attempts: [attempt],
    } : { ...existing, status: 'GRANTED', updatedAt: decision.decidedAt, attempts: [...existing.attempts, attempt] };
    this.state = existing === undefined
      ? { ...this.state, workUnits: [...this.state.workUnits, unit] }
      : replaceUnit(this.state, unit);
    this.state = { ...this.state, totalAgentInvocations: this.state.totalAgentInvocations + 1, grantedEstimatedCostUnits: this.state.grantedEstimatedCostUnits + (request.estimatedCostUnits ?? 0) };
    if (existing === undefined) this.event('WORK_UNIT_CREATED', 'work unit materialized after grant', { requestId: request.id, workUnitId: unit.id, decisionId: decision.id });
    if (request.authorization?.purpose === 'correction') {
      this.event('CORRECTION_GRANTED', request.authorization.canonicalFindingKey, { requestId: request.id, workUnitId: unit.id, decisionId: decision.id });
    }
    return decision;
  }

  /**
   * Binds (or reuses) an operator-authorized recovery execution budget
   * epoch, then performs the one, narrow, explicit re-arbitration pass this
   * feature exists for: requests already in `requestIds` (recovery-scoped,
   * proven by the caller via real evidence — never inferred here from
   * request IDs or names) whose ONLY current blocker is the original run's
   * exhausted wall-clock budget get exactly one fresh GrantDecision
   * appended, evaluated under the (now-active) epoch clock. The prior
   * DENIED decision is never removed or rewritten — decide() always
   * appends. A request already resolved (GRANTED/WAITING/terminal for a
   * non-wall-clock reason) is left completely alone, which is what makes
   * this safe to call repeatedly: re-authorizing the same policyHash binds
   * the SAME epoch (no clock reset, no extra budget) and re-arbitrates only
   * whatever, if anything, is still stuck in DENIED/WALL_CLOCK_BUDGET_EXCEEDED.
   */
  authorizeRecoveryEpoch(options: {
    readonly policyHash: string;
    readonly maxWallClockMs: number;
    readonly requestIds: readonly string[];
  }): GrantDecision[] {
    const existing = this.state.recoveryEpoch;
    const now = iso(this.clock);
    const freshRequestIds = [...new Set(options.requestIds)];
    const epoch: RecoveryEpochState = existing === undefined
      ? { number: 1, policyHash: options.policyHash, startedAt: now, maxWallClockMs: options.maxWallClockMs, requestIds: freshRequestIds }
      : existing.policyHash === options.policyHash
        // Same semantic policy still active: reuse this exact epoch identity
        // (no clock reset, no extra budget) — only ever widen its tracked
        // scope with newly-discovered recovery-scoped requests.
        ? { ...existing, requestIds: [...new Set([...existing.requestIds, ...options.requestIds])] }
        // A genuinely different policy authorizes the NEXT epoch, scoped to
        // exactly what this authorization covers — a prior epoch's scope
        // belongs to that prior epoch's identity, not this one.
        : { number: existing.number + 1, policyHash: options.policyHash, startedAt: now, maxWallClockMs: options.maxWallClockMs, requestIds: freshRequestIds };
    this.state = { ...this.state, recoveryEpoch: epoch, updatedAt: now };
    this.event('RECOVERY_EPOCH_AUTHORIZED', `epoch ${epoch.number}`, {});
    const reconsider = epoch.requestIds
      .map((id) => this.state.workRequests.find((request) => request.id === id))
      .filter((request): request is WorkRequest => request !== undefined)
      .filter((request) => this.terminalDecision(request.id) && this.latestDecision(request.id)?.reason === 'WALL_CLOCK_BUDGET_EXCEEDED');
    return reconsider.map((request) => this.evaluateRequest(request));
  }

  start(workUnitId: string): void {
    const unit = this.requireUnit(workUnitId);
    if (unit.status !== 'GRANTED') throw new OrchestratorError('TASK_STATE_INVALID', `${workUnitId} is not granted`);
    const now = iso(this.clock);
    const attempts = unit.attempts.map((attempt, index) => index === unit.attempts.length - 1 ? { ...attempt, status: 'RUNNING' as const, startedAt: now } : attempt);
    this.state = replaceUnit(this.state, { ...unit, status: 'RUNNING', updatedAt: now, attempts });
    this.event('WORK_UNIT_STARTED', 'executor started granted work', { requestId: unit.requestId, workUnitId });
  }

  recordRoute(workUnitId: string, route: Omit<NonNullable<DynamicWorkUnit['route']>, 'routedAt'>): void {
    const unit = this.requireUnit(workUnitId);
    if (unit.status !== 'GRANTED' || unit.route !== undefined) {
      throw new OrchestratorError('TASK_STATE_INVALID', `${workUnitId} is not an unrouted grant`);
    }
    const now = iso(this.clock);
    this.state = replaceUnit(this.state, { ...unit, route: { ...route, routedAt: now }, updatedAt: now });
  }

  finish(workUnitId: string, status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED', options: { resultEvidence?: readonly EvidenceReference[]; error?: string } = {}): void {
    const unit = this.requireUnit(workUnitId);
    if (!['GRANTED', 'RUNNING'].includes(unit.status)) throw new OrchestratorError('TASK_STATE_INVALID', `${workUnitId} is not active`);
    const now = iso(this.clock);
    const attempts = unit.attempts.map((attempt, index) => index === unit.attempts.length - 1 ? {
      ...attempt, status: status === 'SKIPPED' ? 'SUCCEEDED' as const : status, finishedAt: now,
      ...(options.resultEvidence === undefined ? {} : { resultEvidence: options.resultEvidence }),
      ...(options.error === undefined ? {} : { error: options.error.slice(0, 2_000) }),
    } : attempt);
    this.state = replaceUnit(this.state, { ...unit, status, updatedAt: now, attempts });
    this.event('WORK_UNIT_FINISHED', status, { requestId: unit.requestId, workUnitId });
    this.event('RESOURCE_RELEASED', `${unit.resourceClaims.length} claim(s) released`, { requestId: unit.requestId, workUnitId });
  }

  /**
   * Transitions an already-TERMINAL FAILED/TIMED_OUT unit to SUCCEEDED after
   * an explicit, out-of-band recovery (handoff repair or salvage) has
   * already proven the underlying task actually completed. Distinct from
   * finish(): finish() only ever closes an ACTIVE (GRANTED/RUNNING) unit
   * with its real outcome, and refuses (throws) for a unit that is already
   * terminal — this is the one narrow, explicitly-named exception to that.
   * It never touches `attempts`: the original TIMED_OUT/FAILED attempt
   * stays exactly as recorded, since recovery did not retry the original
   * agent invocation — it recovered evidence about work that already
   * existed. The caller alone is responsible for proving recovery evidence
   * before calling this; this method only enforces the state-machine
   * precondition (and is therefore itself idempotent-unsafe by design — a
   * second call on an already-SUCCEEDED unit throws, exactly like finish()
   * does, so callers must check first, which is why completeRecoveredAdaptiveTask
   * in orchestrator.ts always does).
   */
  recoverFinishedUnit(workUnitId: string, recoveryKind: 'handoff_repair' | 'salvage'): void {
    const unit = this.requireUnit(workUnitId);
    if (!['FAILED', 'TIMED_OUT'].includes(unit.status)) {
      throw new OrchestratorError('TASK_STATE_INVALID', `${workUnitId} is not a recoverable terminal failure`);
    }
    const now = iso(this.clock);
    this.state = replaceUnit(this.state, { ...unit, status: 'SUCCEEDED', updatedAt: now });
    this.event('WORK_UNIT_RECOVERED', recoveryKind, { requestId: unit.requestId, workUnitId });
  }

  authorizeRetry(workUnitId: string): void {
    const unit = this.requireUnit(workUnitId);
    if (!['FAILED', 'TIMED_OUT'].includes(unit.status)) throw new OrchestratorError('TASK_STATE_INVALID', `${workUnitId} is not retryable`);
    const now = iso(this.clock);
    this.state = replaceUnit(this.state, { ...unit, status: 'REQUESTED', updatedAt: now });
    this.event('WORK_UNIT_RETRY_AUTHORIZED', 'only the failed work unit was reopened', { requestId: unit.requestId, workUnitId });
  }

  private requireUnit(workUnitId: string): DynamicWorkUnit {
    const unit = this.state.workUnits.find((candidate) => candidate.id === workUnitId);
    if (unit === undefined) throw new OrchestratorError('TASK_STATE_INVALID', `Unknown work unit ${workUnitId}`);
    return unit;
  }

  /** Build a bounded fan-in tree. Generated synthesis nodes remain subject to arbitration. */
  createSynthesisTree(inputRequestIds: readonly string[], objective = 'Synthesize verified work results'): WorkRequest[] {
    if (inputRequestIds.length === 0) return [];
    if (inputRequestIds.some((id) => !this.state.workRequests.some((request) => request.id === id))) {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Synthesis input references an unknown request');
    }
    const created: WorkRequest[] = [];
    let level = [...inputRequestIds];
    while (level.length > 1) {
      const next: string[] = [];
      for (let offset = 0; offset < level.length; offset += this.state.policy.limits.maxSynthesisInputs) {
        const dependencies = level.slice(offset, offset + this.state.policy.limits.maxSynthesisInputs);
        const request = this.submit({
          role: 'synthesis', concern: 'synthesis', objective, reason: 'bounded fan-in is required before deterministic verification',
          dependencies, capabilities: [{ capability: 'synthesis' }], resourceClaims: [],
          evidence: dependencies.map((reference) => ({ kind: 'finding' as const, reference, summary: 'upstream work result' })),
          risk: 'medium', priority: 60,
        }, { source: 'orchestrator' });
        created.push(request);
        next.push(request.id);
      }
      level = next;
    }
    const rootRequestId = level[0];
    this.event('SYNTHESIS_TREE_CREATED', `${created.length} bounded synthesis request(s) created`, rootRequestId === undefined ? {} : { requestId: rootRequestId });
    return created;
  }

  completionStatus(deterministicGatePassed: boolean): 'ACTIVE' | 'BLOCKED' | 'FAILED' | 'HUMAN_APPROVAL_REQUIRED' | 'READY_TO_COMPLETE' {
    const units = this.state.workUnits;
    if (units.some((unit) => ['FAILED', 'TIMED_OUT'].includes(unit.status))) return 'FAILED';
    if (this.state.workRequests.some((request) => {
      const latest = this.latestDecision(request.id);
      return latest?.outcome === 'WAITING' && latest.reason === 'HUMAN_APPROVAL_REQUIRED';
    })) return 'HUMAN_APPROVAL_REQUIRED';
    if (this.state.workRequests.some((request) => this.latestDecision(request.id)?.outcome === 'DENIED' && request.source !== 'agent')) return 'BLOCKED';
    const pendingRequest = this.state.workRequests.some((request) => !this.terminalDecision(request.id));
    if (pendingRequest || units.some((unit) => !['SUCCEEDED', 'SKIPPED', 'DENIED'].includes(unit.status))) return 'ACTIVE';
    return deterministicGatePassed ? 'READY_TO_COMPLETE' : 'ACTIVE';
  }
}
