import { OrchestratorError } from '../errors';
import { normalizeRepositoryPath } from '../tasks/ownership';
import {
  ADAPTIVE_ROLES,
  type AdaptiveLimits,
  type AdaptivePolicy,
  type CorrectionPolicy,
  type CapabilityRequirement,
  type EvidenceReference,
  type ResourceClaim,
  type WorkRequestDraft,
} from './types';

function invalid(message: string, details: Record<string, unknown> = {}): never {
  throw new OrchestratorError('CONFIG_INVALID', message, { details });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) invalid(`${label} has unknown fields: ${extras.join(', ')}`);
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') invalid(`${label} must be non-empty`);
  return value.trim();
}

function positiveInteger(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) <= 0) invalid(`${label} must be a positive integer`);
  return value as number;
}

function nonNegativeNumber(value: unknown, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) invalid(`${label} must be a non-negative finite number`);
  return value;
}

function stringArray(value: unknown, label: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) invalid(`${label} must be a${allowEmpty ? '' : ' non-empty'} string array`);
  const values = value.map((item, index) => text(item, `${label}[${index}]`));
  if (new Set(values).size !== values.length) invalid(`${label} must not contain duplicates`);
  return values;
}

export function parseAdaptiveLimits(value: unknown): AdaptiveLimits {
  const input = record(value, 'adaptive limits');
  strictKeys(input, [
    'maxConcurrentAgents', 'maxAgentInvocations', 'maxTotalWorkUnits',
    'maxDecompositionDepth', 'maxFanOutPerWorkUnit', 'maxSynthesisInputs',
    'maxWallClockMs', 'maxEstimatedCostUnits',
  ], 'adaptive limits');
  const maxConcurrentAgents = positiveInteger(input.maxConcurrentAgents, 'maxConcurrentAgents');
  const maxAgentInvocations = positiveInteger(input.maxAgentInvocations, 'maxAgentInvocations');
  const maxTotalWorkUnits = positiveInteger(input.maxTotalWorkUnits, 'maxTotalWorkUnits');
  const maxDecompositionDepth = positiveInteger(input.maxDecompositionDepth, 'maxDecompositionDepth');
  const maxFanOutPerWorkUnit = positiveInteger(input.maxFanOutPerWorkUnit, 'maxFanOutPerWorkUnit');
  const maxSynthesisInputs = positiveInteger(input.maxSynthesisInputs, 'maxSynthesisInputs');
  if (maxSynthesisInputs < 2) invalid('maxSynthesisInputs must be at least 2');
  const maxWallClockMs = positiveInteger(input.maxWallClockMs, 'maxWallClockMs');
  if (maxConcurrentAgents > maxAgentInvocations || maxAgentInvocations > maxTotalWorkUnits * 10) {
    invalid('adaptive limits are internally inconsistent');
  }
  const maxEstimatedCostUnits = input.maxEstimatedCostUnits === undefined
    ? undefined
    : nonNegativeNumber(input.maxEstimatedCostUnits, 'maxEstimatedCostUnits');
  return { maxConcurrentAgents, maxAgentInvocations, maxTotalWorkUnits, maxDecompositionDepth,
    maxFanOutPerWorkUnit, maxSynthesisInputs, maxWallClockMs, ...(maxEstimatedCostUnits === undefined ? {} : { maxEstimatedCostUnits }) };
}

export function parseAdaptivePolicy(value: unknown): AdaptivePolicy {
  const input = record(value, 'adaptive policy');
  strictKeys(input, ['allowedConcerns', 'allowedOwnership', 'allowedResources', 'limits', 'requireEvidenceForExpansion', 'agingIntervalMs', 'agingStep', 'humanApprovalRisks', 'correctionPolicy'], 'adaptive policy');
  const allowedOwnership = stringArray(input.allowedOwnership, 'allowedOwnership');
  for (const pattern of allowedOwnership) normalizeRepositoryPath(pattern);
  if (typeof input.requireEvidenceForExpansion !== 'boolean') invalid('requireEvidenceForExpansion must be boolean');
  let correctionPolicy: CorrectionPolicy | undefined;
  if (input.correctionPolicy !== undefined) {
    const correction = record(input.correctionPolicy, 'correctionPolicy');
    strictKeys(correction, ['allowedOwnership', 'allowedRoles', 'requireCanonicalFinding', 'maxRounds'], 'correctionPolicy');
    const correctionOwnership = stringArray(correction.allowedOwnership, 'correctionPolicy.allowedOwnership');
    for (const pattern of correctionOwnership) normalizeRepositoryPath(pattern);
    const roles = stringArray(correction.allowedRoles, 'correctionPolicy.allowedRoles');
    if (roles.some((role) => role !== 'correction' && role !== 'testing')) {
      invalid('correctionPolicy.allowedRoles may contain only correction and testing');
    }
    if (correction.requireCanonicalFinding !== true) {
      invalid('correctionPolicy.requireCanonicalFinding must be true');
    }
    correctionPolicy = {
      allowedOwnership: correctionOwnership,
      allowedRoles: roles as CorrectionPolicy['allowedRoles'],
      requireCanonicalFinding: true,
      maxRounds: positiveInteger(correction.maxRounds, 'correctionPolicy.maxRounds'),
    };
    if (correctionPolicy.maxRounds > 5) invalid('correctionPolicy.maxRounds must be at most 5');
  }
  return {
    allowedConcerns: stringArray(input.allowedConcerns, 'allowedConcerns'),
    allowedOwnership,
    allowedResources: input.allowedResources === undefined ? [] : (() => {
      if (!Array.isArray(input.allowedResources)) invalid('allowedResources must be an array');
      return input.allowedResources.map((entry, index) => {
        const item = record(entry, `allowedResources[${index}]`);
        strictKeys(item, ['kind', 'key', 'mode'], `allowedResources[${index}]`);
        if (!['database', 'service', 'logical'].includes(String(item.kind))) invalid(`allowedResources[${index}].kind is invalid`);
        const mode = item.mode ?? 'read';
        if (mode !== 'read' && mode !== 'write') invalid(`allowedResources[${index}].mode is invalid`);
        return { kind: item.kind as 'database' | 'service' | 'logical', key: text(item.key, `allowedResources[${index}].key`), mode };
      });
    })(),
    limits: parseAdaptiveLimits(input.limits),
    requireEvidenceForExpansion: input.requireEvidenceForExpansion,
    agingIntervalMs: positiveInteger(input.agingIntervalMs, 'agingIntervalMs'),
    agingStep: positiveInteger(input.agingStep, 'agingStep'),
    humanApprovalRisks: input.humanApprovalRisks === undefined
      ? []
      : stringArray(input.humanApprovalRisks, 'humanApprovalRisks', true).map((risk) => {
          if (!['low', 'medium', 'high', 'critical'].includes(risk)) invalid(`Invalid human approval risk: ${risk}`);
          return risk as AdaptivePolicy['humanApprovalRisks'][number];
        }),
    ...(correctionPolicy === undefined ? {} : { correctionPolicy }),
  };
}

function parseCapabilities(value: unknown): CapabilityRequirement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid('capabilities must be an array');
  return value.map((entry, index) => {
    const item = record(entry, `capabilities[${index}]`);
    strictKeys(item, ['capability', 'minimumLevel'], `capabilities[${index}]`);
    const minimumLevel = item.minimumLevel === undefined ? undefined : nonNegativeNumber(item.minimumLevel, `capabilities[${index}].minimumLevel`);
    return { capability: text(item.capability, `capabilities[${index}].capability`), ...(minimumLevel === undefined ? {} : { minimumLevel }) };
  });
}

function parseClaims(value: unknown): ResourceClaim[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid('resourceClaims must be an array');
  return value.map((entry, index) => {
    const item = record(entry, `resourceClaims[${index}]`);
    strictKeys(item, ['kind', 'key', 'mode'], `resourceClaims[${index}]`);
    if (!['repository_path', 'database', 'service', 'logical'].includes(String(item.kind))) invalid(`resourceClaims[${index}].kind is invalid`);
    if (!['read', 'write'].includes(String(item.mode))) invalid(`resourceClaims[${index}].mode is invalid`);
    const key = text(item.key, `resourceClaims[${index}].key`);
    if (item.kind === 'repository_path') normalizeRepositoryPath(key);
    return { kind: item.kind as ResourceClaim['kind'], key, mode: item.mode as ResourceClaim['mode'] };
  });
}

function parseEvidence(value: unknown): EvidenceReference[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) invalid('evidence must be an array');
  return value.map((entry, index) => {
    const item = record(entry, `evidence[${index}]`);
    strictKeys(item, ['kind', 'reference', 'summary'], `evidence[${index}]`);
    if (!['diff', 'file', 'test', 'schema', 'runtime', 'finding'].includes(String(item.kind))) invalid(`evidence[${index}].kind is invalid`);
    return { kind: item.kind as EvidenceReference['kind'], reference: text(item.reference, `evidence[${index}].reference`), summary: text(item.summary, `evidence[${index}].summary`) };
  });
}

export function parseWorkRequestDraft(value: unknown): WorkRequestDraft {
  const input = record(value, 'work request');
  strictKeys(input, ['role', 'concern', 'objective', 'reason', 'dependencies', 'capabilities', 'resourceClaims', 'evidence', 'risk', 'priority', 'estimatedCostUnits'], 'work request');
  if (!ADAPTIVE_ROLES.includes(input.role as never)) invalid('work request role is invalid');
  if (input.risk !== undefined && !['low', 'medium', 'high', 'critical'].includes(String(input.risk))) invalid('work request risk is invalid');
  const priority = input.priority === undefined ? 50 : nonNegativeNumber(input.priority, 'priority');
  if (!Number.isInteger(priority) || priority > 100) invalid('priority must be an integer from 0 through 100');
  const estimatedCostUnits = input.estimatedCostUnits === undefined ? undefined : nonNegativeNumber(input.estimatedCostUnits, 'estimatedCostUnits');
  return {
    role: input.role as WorkRequestDraft['role'], concern: text(input.concern, 'concern'), objective: text(input.objective, 'objective'), reason: text(input.reason, 'reason'),
    dependencies: input.dependencies === undefined ? [] : stringArray(input.dependencies, 'dependencies', true),
    capabilities: parseCapabilities(input.capabilities), resourceClaims: parseClaims(input.resourceClaims), evidence: parseEvidence(input.evidence),
    risk: (input.risk ?? 'medium') as NonNullable<WorkRequestDraft['risk']>, priority,
    ...(estimatedCostUnits === undefined ? {} : { estimatedCostUnits }),
  };
}
