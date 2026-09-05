import { OrchestratorError } from '../errors';
import type {
  AdaptiveContinuationState,
  AdaptiveEvent,
  AdaptiveRunState,
  DynamicWorkUnit,
  GrantDecision,
  RecoveryEpochState,
  WorkRequest,
} from './types';
import { ADAPTIVE_EVENT_TYPES, GRANT_REASONS } from './types';
import { parseAdaptivePolicy, parseWorkRequestDraft } from './validation';
import { validateReview } from '../review/findings';

function corrupt(message: string): never {
  throw new OrchestratorError('STATE_CORRUPT', `Invalid adaptive state: ${message}`);
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) corrupt(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0) corrupt(`${label} must be non-empty`);
  return value;
}

function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) corrupt(`${label} must be a non-negative integer`);
  return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) corrupt(`${label} must be a non-negative finite number`);
  return value;
}

function array(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) corrupt(`${label} must be an array`);
  return value;
}

function iso(value: unknown, label: string): string {
  const result = string(value, label);
  if (!Number.isFinite(Date.parse(result))) corrupt(`${label} must be an ISO timestamp`);
  return result;
}

function strict(input: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(input).filter((key) => !allowed.includes(key));
  if (extras.length > 0) corrupt(`${label} has unknown fields: ${extras.join(', ')}`);
}

function sha(value: unknown, label: string): string {
  const result = string(value, label).toLowerCase();
  if (!/^[0-9a-f]{40,64}$/.test(result)) corrupt(`${label} must be a full SHA`);
  return result;
}

function hash(value: unknown, label: string): string {
  const result = string(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(result)) corrupt(`${label} must be a SHA-256 digest`);
  return result;
}

function parseContinuation(value: unknown): AdaptiveContinuationState {
  const input = object(value, 'continuation');
  strict(input, [
    'sourceRunId', 'sourceWorkUnitId', 'sourceArtifactType', 'expectedBaseSha', 'expectedArtifactSha256', 'mode',
    'sourceBaseSha', 'sourceArtifactPath', 'sourceArtifactSha256', 'sourceReviewStatus',
    'importedAt', 'findings',
  ], 'continuation');
  const sourceRunId = string(input.sourceRunId, 'continuation.sourceRunId');
  const sourceWorkUnitId = string(input.sourceWorkUnitId, 'continuation.sourceWorkUnitId');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(sourceRunId)) corrupt('continuation.sourceRunId is unsafe');
  if (!/^work-[0-9]{6}$/.test(sourceWorkUnitId)) corrupt('continuation.sourceWorkUnitId is invalid');
  if (input.sourceArtifactType !== 'review' || input.mode !== 'canonical_findings'
    || input.sourceReviewStatus !== 'changes_requested') corrupt('continuation discriminator/status is invalid');
  const expectedBaseSha = sha(input.expectedBaseSha, 'continuation.expectedBaseSha');
  const sourceBaseSha = sha(input.sourceBaseSha, 'continuation.sourceBaseSha');
  if (expectedBaseSha !== sourceBaseSha) corrupt('continuation source and expected base differ');
  const sourceArtifactPath = string(input.sourceArtifactPath, 'continuation.sourceArtifactPath');
  if (!sourceArtifactPath.startsWith('/')) corrupt('continuation.sourceArtifactPath must be absolute');
  const sourceArtifactSha256 = hash(input.sourceArtifactSha256, 'continuation.sourceArtifactSha256');
  const expectedArtifactSha256 = input.expectedArtifactSha256 === undefined
    ? undefined
    : hash(input.expectedArtifactSha256, 'continuation.expectedArtifactSha256');
  if (expectedArtifactSha256 !== undefined && expectedArtifactSha256 !== sourceArtifactSha256) {
    corrupt('continuation expected and imported artifact hashes differ');
  }
  const importedAt = iso(input.importedAt, 'continuation.importedAt');
  const findings = array(input.findings, 'continuation.findings').map((entry, index) => {
    const item = object(entry, `continuation.findings[${index}]`);
    strict(item, [
      'canonicalFindingKey', 'finding', 'sourceRunId', 'sourceWorkUnitId',
      'sourceArtifactPath', 'sourceBaseSha', 'sourceArtifactSha256', 'importedAt', 'round',
    ], `continuation.findings[${index}]`);
    let finding;
    try {
      finding = validateReview({ status: 'changes_requested', findings: [item.finding] }).findings[0]!;
    } catch (error) {
      corrupt(`continuation.findings[${index}].finding is invalid: ${error instanceof Error ? error.message : String(error)}`);
    }
    const canonicalFindingKey = string(item.canonicalFindingKey, `continuation.findings[${index}].canonicalFindingKey`);
    if (canonicalFindingKey !== `${sourceRunId}:${sourceWorkUnitId}:${finding!.id}`
      || item.sourceRunId !== sourceRunId
      || item.sourceWorkUnitId !== sourceWorkUnitId
      || item.sourceArtifactPath !== sourceArtifactPath
      || sha(item.sourceBaseSha, `continuation.findings[${index}].sourceBaseSha`) !== sourceBaseSha
      || hash(item.sourceArtifactSha256, `continuation.findings[${index}].sourceArtifactSha256`) !== sourceArtifactSha256
      || item.importedAt !== importedAt
      || item.round !== 1) {
      corrupt(`continuation.findings[${index}] provenance does not exactly match its continuation`);
    }
    return {
      canonicalFindingKey, finding: finding!, sourceRunId, sourceWorkUnitId,
      sourceArtifactPath, sourceBaseSha, sourceArtifactSha256, importedAt, round: 1 as const,
    };
  });
  if (findings.length === 0 || new Set(findings.map((finding) => finding.canonicalFindingKey)).size !== findings.length) {
    corrupt('continuation.findings must be non-empty and unique');
  }
  return {
    sourceRunId, sourceWorkUnitId, sourceArtifactType: 'review', expectedBaseSha,
    mode: 'canonical_findings', sourceBaseSha, sourceArtifactPath, sourceArtifactSha256,
    ...(expectedArtifactSha256 === undefined ? {} : { expectedArtifactSha256 }),
    sourceReviewStatus: 'changes_requested', importedAt, findings,
  };
}

function parseRequest(value: unknown, index: number): WorkRequest {
  const input = object(value, `workRequests[${index}]`);
  strict(input, ['id', 'parentWorkUnitId', 'depth', 'sequence', 'createdAt', 'source', 'role', 'concern', 'objective', 'reason', 'dependencies', 'capabilities', 'resourceClaims', 'evidence', 'risk', 'priority', 'estimatedCostUnits', 'authorization'], `workRequests[${index}]`);
  let draft;
  try {
    draft = parseWorkRequestDraft({
      role: input.role, concern: input.concern, objective: input.objective, reason: input.reason,
      dependencies: input.dependencies, capabilities: input.capabilities,
      resourceClaims: input.resourceClaims, evidence: input.evidence, risk: input.risk,
      priority: input.priority, estimatedCostUnits: input.estimatedCostUnits,
    });
  } catch (error) {
    corrupt(`workRequests[${index}] draft is invalid: ${error instanceof Error ? error.message : String(error)}`);
  }
  const source = string(input.source, `workRequests[${index}].source`);
  if (!['planner', 'agent', 'orchestrator'].includes(source)) corrupt(`workRequests[${index}].source is invalid`);
  let authorization: WorkRequest['authorization'];
  if (input.authorization !== undefined) {
    const auth = object(input.authorization, `workRequests[${index}].authorization`);
    strict(auth, ['kind', 'purpose', 'canonicalFindingKey', 'findingReference', 'sourceWorkUnitId', 'artifactPath', 'round', 'importedSource'], `workRequests[${index}].authorization`);
    if (auth.kind !== 'canonical_finding' || (auth.purpose !== 'correction' && auth.purpose !== 'reverification')) corrupt(`workRequests[${index}].authorization is invalid`);
    let importedSource: NonNullable<WorkRequest['authorization']>['importedSource'];
    if (auth.importedSource !== undefined) {
      const imported = object(auth.importedSource, `workRequests[${index}].authorization.importedSource`);
      strict(imported, ['sourceRunId', 'sourceWorkUnitId', 'sourceBaseSha', 'artifactPath', 'artifactSha256'], `workRequests[${index}].authorization.importedSource`);
      importedSource = {
        sourceRunId: string(imported.sourceRunId, 'importedSource.sourceRunId'),
        sourceWorkUnitId: string(imported.sourceWorkUnitId, 'importedSource.sourceWorkUnitId'),
        sourceBaseSha: sha(imported.sourceBaseSha, 'importedSource.sourceBaseSha'),
        artifactPath: string(imported.artifactPath, 'importedSource.artifactPath'),
        artifactSha256: hash(imported.artifactSha256, 'importedSource.artifactSha256'),
      };
    }
    authorization = {
      kind: 'canonical_finding', purpose: auth.purpose,
      canonicalFindingKey: string(auth.canonicalFindingKey, 'canonicalFindingKey'),
      findingReference: string(auth.findingReference, 'findingReference'),
      sourceWorkUnitId: string(auth.sourceWorkUnitId, 'sourceWorkUnitId'),
      artifactPath: string(auth.artifactPath, 'artifactPath'),
      round: integer(auth.round, 'round'),
      ...(importedSource === undefined ? {} : { importedSource }),
    };
    if (authorization.round < 1) corrupt('canonical finding round must be positive');
  }
  return {
    ...draft!, id: string(input.id, `workRequests[${index}].id`),
    ...(input.parentWorkUnitId === undefined ? {} : { parentWorkUnitId: string(input.parentWorkUnitId, `workRequests[${index}].parentWorkUnitId`) }),
    depth: integer(input.depth, `workRequests[${index}].depth`), sequence: integer(input.sequence, `workRequests[${index}].sequence`),
    createdAt: iso(input.createdAt, `workRequests[${index}].createdAt`), source: source as WorkRequest['source'],
    ...(authorization === undefined ? {} : { authorization }),
  } as WorkRequest;
}

function parseDecision(value: unknown, index: number): GrantDecision {
  const input = object(value, `grantDecisions[${index}]`);
  strict(input, ['id', 'requestId', 'outcome', 'reason', 'detail', 'effectivePriority', 'decidedAt', 'sequence', 'recoveryEpochNumber'], `grantDecisions[${index}]`);
  const outcome = string(input.outcome, 'decision outcome');
  const reason = string(input.reason, 'decision reason');
  if (!['GRANTED', 'WAITING', 'DENIED'].includes(outcome)) corrupt('decision outcome is invalid');
  if (!GRANT_REASONS.includes(reason as never)) corrupt('decision reason is invalid');
  const recoveryEpochNumber = input.recoveryEpochNumber === undefined ? undefined : integer(input.recoveryEpochNumber, 'decision recoveryEpochNumber');
  return {
    id: string(input.id, 'decision id'), requestId: string(input.requestId, 'decision requestId'),
    outcome: outcome as GrantDecision['outcome'], reason: reason as GrantDecision['reason'], detail: string(input.detail, 'decision detail'),
    effectivePriority: integer(input.effectivePriority, 'decision effectivePriority'), decidedAt: iso(input.decidedAt, 'decision decidedAt'), sequence: integer(input.sequence, 'decision sequence'),
    ...(recoveryEpochNumber === undefined ? {} : { recoveryEpochNumber }),
  };
}

function parseUnit(value: unknown, index: number): DynamicWorkUnit {
  const input = object(value, `workUnits[${index}]`);
  strict(input, ['id', 'requestId', 'parentWorkUnitId', 'role', 'concern', 'objective', 'reason', 'dependencyRequestIds', 'capabilities', 'resourceClaims', 'depth', 'status', 'createdAt', 'updatedAt', 'attempts', 'route'], `workUnits[${index}]`);
  const status = string(input.status, 'work unit status');
  if (!['REQUESTED', 'WAITING', 'GRANTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT', 'DENIED', 'SKIPPED'].includes(status)) corrupt('work unit status is invalid');
  const draft = parseWorkRequestDraft({
    role: input.role, concern: input.concern, objective: input.objective, reason: input.reason,
    dependencies: input.dependencyRequestIds, capabilities: input.capabilities,
    resourceClaims: input.resourceClaims, evidence: [{ kind: 'finding', reference: 'persisted', summary: 'state validation' }],
  });
  const attempts = array(input.attempts, 'work unit attempts').map((value, attemptIndex) => {
    const attempt = object(value, `attempts[${attemptIndex}]`);
    strict(attempt, ['number', 'grantDecisionId', 'status', 'startedAt', 'finishedAt', 'resultEvidence', 'error'], `attempts[${attemptIndex}]`);
    const attemptStatus = string(attempt.status, 'attempt status');
    if (!['GRANTED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'].includes(attemptStatus)) corrupt('attempt status is invalid');
    const number = integer(attempt.number, `attempts[${attemptIndex}].number`);
    if (number !== attemptIndex + 1) corrupt('attempt numbers must be append-only and sequential');
    return {
      number,
      grantDecisionId: string(attempt.grantDecisionId, `attempts[${attemptIndex}].grantDecisionId`),
      status: attemptStatus as DynamicWorkUnit['attempts'][number]['status'],
      ...(attempt.startedAt === undefined ? {} : { startedAt: iso(attempt.startedAt, `attempts[${attemptIndex}].startedAt`) }),
      ...(attempt.finishedAt === undefined ? {} : { finishedAt: iso(attempt.finishedAt, `attempts[${attemptIndex}].finishedAt`) }),
      ...(attempt.resultEvidence === undefined ? {} : { resultEvidence: array(attempt.resultEvidence, `attempts[${attemptIndex}].resultEvidence`) as NonNullable<DynamicWorkUnit['attempts'][number]['resultEvidence']> }),
      ...(attempt.error === undefined ? {} : { error: string(attempt.error, `attempts[${attemptIndex}].error`) }),
    };
  });
  let route: DynamicWorkUnit['route'];
  if (input.route !== undefined) {
    const routeInput = object(input.route, 'work unit route');
    strict(routeInput, ['executorId', 'adapter', 'routedAt'], 'work unit route');
    const adapter = string(routeInput.adapter, 'work unit route adapter');
    if (adapter !== 'codex' && adapter !== 'claude') corrupt('work unit route adapter is invalid');
    route = { executorId: string(routeInput.executorId, 'work unit route executorId'), adapter, routedAt: iso(routeInput.routedAt, 'work unit route routedAt') };
  }
  return {
    id: string(input.id, 'work unit id'), requestId: string(input.requestId, 'work unit requestId'),
    ...(input.parentWorkUnitId === undefined ? {} : { parentWorkUnitId: string(input.parentWorkUnitId, 'work unit parentWorkUnitId') }),
    role: draft.role, concern: draft.concern, objective: draft.objective, reason: draft.reason,
    dependencyRequestIds: draft.dependencies ?? [], capabilities: draft.capabilities ?? [], resourceClaims: draft.resourceClaims ?? [],
    depth: integer(input.depth, 'work unit depth'), status: status as DynamicWorkUnit['status'],
    createdAt: iso(input.createdAt, 'work unit createdAt'), updatedAt: iso(input.updatedAt, 'work unit updatedAt'), attempts,
    ...(route === undefined ? {} : { route }),
  };
}

function parseRecoveryEpoch(value: unknown, knownRequestIds: ReadonlySet<string>, path: string): RecoveryEpochState {
  const input = object(value, path);
  strict(input, ['number', 'policyHash', 'startedAt', 'maxWallClockMs', 'requestIds'], path);
  const number = integer(input.number, `${path}.number`);
  if (number < 1) corrupt(`${path}.number must be at least 1`);
  const policyHash = hash(input.policyHash, `${path}.policyHash`);
  const startedAt = iso(input.startedAt, `${path}.startedAt`);
  const maxWallClockMs = integer(input.maxWallClockMs, `${path}.maxWallClockMs`);
  if (maxWallClockMs < 1) corrupt(`${path}.maxWallClockMs must be positive`);
  const requestIds = array(input.requestIds, `${path}.requestIds`)
    .map((id, index) => string(id, `${path}.requestIds[${index}]`));
  if (new Set(requestIds).size !== requestIds.length) corrupt(`${path}.requestIds must be unique`);
  if (requestIds.some((id) => !knownRequestIds.has(id))) corrupt(`${path}.requestIds references an unknown request`);
  return { number, policyHash, startedAt, maxWallClockMs, requestIds };
}

/**
 * Accepts either the current append-only `recoveryEpochs` array (plus
 * `activeRecoveryEpochNumber`) or the legacy single-`recoveryEpoch` shape a
 * run persisted before multi-epoch history existed — normalizing the
 * legacy shape into a one-entry array/active-number pair. Never both at
 * once: that combination is never legitimately produced and is rejected as
 * corrupt rather than guessed at.
 */
function parseRecoveryEpochHistory(
  input: Record<string, unknown>,
  knownRequestIds: ReadonlySet<string>,
): { readonly recoveryEpochs?: readonly RecoveryEpochState[]; readonly activeRecoveryEpochNumber?: number } {
  const hasLegacy = input.recoveryEpoch !== undefined;
  const hasCurrent = input.recoveryEpochs !== undefined || input.activeRecoveryEpochNumber !== undefined;
  if (hasLegacy && hasCurrent) {
    corrupt('recoveryEpoch (legacy) must not coexist with recoveryEpochs/activeRecoveryEpochNumber');
  }
  if (hasLegacy) {
    const legacyEpoch = parseRecoveryEpoch(input.recoveryEpoch, knownRequestIds, 'recoveryEpoch');
    return { recoveryEpochs: [legacyEpoch], activeRecoveryEpochNumber: legacyEpoch.number };
  }
  if (!hasCurrent) return {};
  const recoveryEpochs = array(input.recoveryEpochs, 'recoveryEpochs')
    .map((entry, index) => parseRecoveryEpoch(entry, knownRequestIds, `recoveryEpochs[${index}]`));
  recoveryEpochs.forEach((epoch, index) => {
    if (epoch.number !== index + 1) corrupt('recoveryEpochs numbers must be contiguous, unique, and in append order starting at 1');
  });
  const activeRecoveryEpochNumber = integer(input.activeRecoveryEpochNumber, 'activeRecoveryEpochNumber');
  if (!recoveryEpochs.some((epoch) => epoch.number === activeRecoveryEpochNumber)) {
    corrupt('activeRecoveryEpochNumber references an unknown epoch');
  }
  return { recoveryEpochs, activeRecoveryEpochNumber };
}

export function parseAdaptiveRunState(value: unknown): AdaptiveRunState {
  const input = object(value, 'adaptive state');
  strict(input, ['schemaVersion', 'goal', 'policy', 'startedAt', 'updatedAt', 'workRequests', 'grantDecisions', 'workUnits', 'events', 'totalAgentInvocations', 'grantedEstimatedCostUnits', 'continuation', 'recoveryEpoch', 'recoveryEpochs', 'activeRecoveryEpochNumber'], 'adaptive state');
  if (input.schemaVersion !== 1) corrupt('schemaVersion must be 1');
  let policy;
  try { policy = parseAdaptivePolicy(input.policy); } catch (error) { corrupt(error instanceof Error ? error.message : String(error)); }
  const workRequests = array(input.workRequests, 'workRequests').map(parseRequest);
  const grantDecisions = array(input.grantDecisions, 'grantDecisions').map(parseDecision);
  const workUnits = array(input.workUnits, 'workUnits').map(parseUnit);
  workRequests.forEach((request, index) => {
    if (request.sequence !== index + 1) corrupt('work request sequences must be append-only and contiguous');
  });
  grantDecisions.forEach((decision, index) => {
    if (decision.sequence !== index + 1) corrupt('grant decision sequences must be append-only and contiguous');
  });
  const requestIds = new Set(workRequests.map((request) => request.id));
  if (requestIds.size !== workRequests.length) corrupt('work request ids must be unique');
  if (workUnits.some((unit) => !requestIds.has(unit.requestId))) corrupt('work unit references an unknown request');
  if (new Set(workUnits.map((unit) => unit.id)).size !== workUnits.length || new Set(workUnits.map((unit) => unit.requestId)).size !== workUnits.length) corrupt('work-unit ids and request mappings must be unique');
  const workUnitIds = new Set(workUnits.map((unit) => unit.id));
  const continuation = input.continuation === undefined ? undefined : parseContinuation(input.continuation);
  for (const unit of workUnits) {
    const request = workRequests.find((candidate) => candidate.id === unit.requestId)!;
    if (unit.parentWorkUnitId !== request.parentWorkUnitId
      || unit.role !== request.role
      || unit.concern !== request.concern
      || unit.objective !== request.objective
      || unit.reason !== request.reason
      || unit.depth !== request.depth
      || JSON.stringify(unit.dependencyRequestIds) !== JSON.stringify(request.dependencies)
      || JSON.stringify(unit.capabilities) !== JSON.stringify(request.capabilities)
      || JSON.stringify(unit.resourceClaims) !== JSON.stringify(request.resourceClaims)) {
      corrupt(`${unit.id} does not exactly materialize ${request.id}`);
    }
  }
  for (const request of workRequests) {
    if (request.parentWorkUnitId !== undefined && !workUnitIds.has(request.parentWorkUnitId)) corrupt(`${request.id} references an unknown parent work unit`);
    if (request.source === 'agent' && request.parentWorkUnitId === undefined) corrupt(`${request.id} is agent-sourced without a parent work unit`);
    if (request.authorization !== undefined) {
      if (request.source !== 'orchestrator' || request.parentWorkUnitId !== undefined) corrupt(`${request.id} canonical authorization must belong to an orchestrator root request`);
      if (request.authorization.importedSource !== undefined) {
        const imported = continuation?.findings.find((finding) => finding.canonicalFindingKey === request.authorization!.canonicalFindingKey);
        const source = request.authorization.importedSource;
        if (request.authorization.purpose !== 'correction' || request.authorization.round !== 1 || imported === undefined
          || request.authorization.findingReference !== imported.finding.id
          || source.sourceRunId !== imported.sourceRunId
          || source.sourceWorkUnitId !== imported.sourceWorkUnitId
          || source.sourceBaseSha !== imported.sourceBaseSha
          || source.artifactPath !== imported.sourceArtifactPath
          || source.artifactSha256 !== imported.sourceArtifactSha256
          || request.authorization.sourceWorkUnitId !== imported.sourceWorkUnitId
          || request.authorization.artifactPath !== imported.sourceArtifactPath) {
          corrupt(`${request.id} imported authorization does not match persisted continuation evidence`);
        }
      } else {
        if (!workUnitIds.has(request.authorization.sourceWorkUnitId)) corrupt(`${request.id} authorization references an unknown source work unit`);
        const source = workUnits.find((unit) => unit.id === request.authorization!.sourceWorkUnitId)!;
        const validSource = request.authorization.purpose === 'correction'
          ? ['review', 'synthesis', 'final_review'].includes(source.role)
          : ['correction', 'testing'].includes(source.role);
        if (!validSource || source.status !== 'SUCCEEDED') corrupt(`${request.id} authorization source is not an eligible successful unit`);
      }
      if ((request.authorization.purpose === 'correction' && request.role !== 'correction' && request.role !== 'testing')
        || (request.authorization.purpose === 'reverification' && request.role !== 'review')) corrupt(`${request.id} authorization purpose does not match its role`);
      if (request.authorization.purpose === 'correction' && !request.resourceClaims.some((claim) => claim.mode === 'write')) corrupt(`${request.id} canonical correction has no write claim`);
      if (!request.evidence.some((entry) => entry.kind === 'finding' && entry.reference === request.authorization!.findingReference)) corrupt(`${request.id} lacks matching canonical finding evidence`);
    }
  }
  if (grantDecisions.some((decision) => !requestIds.has(decision.requestId))) corrupt('grant decision references an unknown request');
  const grantedDecisionIds = new Set(grantDecisions.filter((decision) => decision.outcome === 'GRANTED').map((decision) => decision.id));
  if (workUnits.some((unit) => unit.attempts.some((attempt) => !grantedDecisionIds.has(attempt.grantDecisionId)))) corrupt('work attempt references a non-grant decision');
  for (const request of workRequests) {
    if (request.dependencies.some((dependency) => !requestIds.has(dependency))) corrupt(`${request.id} has an unknown dependency`);
    if (request.dependencies.some((dependency) => (workRequests.find((candidate) => candidate.id === dependency)?.sequence ?? Infinity) >= request.sequence)) corrupt(`${request.id} has a forward/cyclic dependency`);
  }
  const events = array(input.events, 'events').map((value, index) => {
    const event = object(value, `events[${index}]`);
    strict(event, ['sequence', 'type', 'occurredAt', 'requestId', 'workUnitId', 'decisionId', 'detail'], `events[${index}]`);
    if (integer(event.sequence, `events[${index}].sequence`) !== index + 1) corrupt('event sequences must be append-only and contiguous');
    const type = string(event.type, `events[${index}].type`);
    if (!ADAPTIVE_EVENT_TYPES.includes(type as never)) corrupt(`events[${index}].type is invalid`);
    iso(event.occurredAt, `events[${index}].occurredAt`);
    string(event.detail, `events[${index}].detail`);
    return event as unknown as AdaptiveEvent;
  });
  const decisionIds = new Set(grantDecisions.map((decision) => decision.id));
  if (events.some((event) => event.requestId !== undefined && !requestIds.has(event.requestId))) corrupt('event references an unknown request');
  if (events.some((event) => event.decisionId !== undefined && !decisionIds.has(event.decisionId))) corrupt('event references an unknown decision');
  if (events.some((event) => event.workUnitId !== undefined && !workUnitIds.has(event.workUnitId))) corrupt('event references an unknown work unit');
  const totalAgentInvocations = integer(input.totalAgentInvocations, 'totalAgentInvocations');
  if (totalAgentInvocations !== grantDecisions.filter((decision) => decision.outcome === 'GRANTED').length) corrupt('agent invocation counter does not equal grants');
  const grantedEstimatedCostUnits = nonNegativeNumber(input.grantedEstimatedCostUnits, 'grantedEstimatedCostUnits');
  const expectedCost = grantDecisions
    .filter((decision) => decision.outcome === 'GRANTED')
    .reduce((sum, decision) => sum + (workRequests.find((request) => request.id === decision.requestId)?.estimatedCostUnits ?? 0), 0);
  if (Math.abs(grantedEstimatedCostUnits - expectedCost) > Number.EPSILON * Math.max(1, expectedCost)) corrupt('estimated-cost counter does not equal granted request costs');
  const { recoveryEpochs, activeRecoveryEpochNumber } = parseRecoveryEpochHistory(input, requestIds);
  // Historical provenance: a decision stamped with epoch N is validated
  // against epoch N's OWN persisted record, wherever it sits in
  // recoveryEpochs — never only against whichever epoch is currently
  // active. A later epoch N+1 must never invalidate an N decision.
  if (grantDecisions.some((decision) => {
    if (decision.recoveryEpochNumber === undefined) return false;
    const epoch = recoveryEpochs?.find((candidate) => candidate.number === decision.recoveryEpochNumber);
    return epoch === undefined || !epoch.requestIds.includes(decision.requestId);
  })) {
    corrupt('a grant decision references a recovery epoch that does not match any persisted epoch/scope');
  }
  return {
    schemaVersion: 1, goal: string(input.goal, 'goal'), policy: policy!,
    startedAt: iso(input.startedAt, 'startedAt'), updatedAt: iso(input.updatedAt, 'updatedAt'),
    workRequests, grantDecisions, workUnits, events,
    totalAgentInvocations, grantedEstimatedCostUnits,
    ...(continuation === undefined ? {} : { continuation }),
    ...(recoveryEpochs === undefined ? {} : { recoveryEpochs, activeRecoveryEpochNumber: activeRecoveryEpochNumber! }),
  };
}
