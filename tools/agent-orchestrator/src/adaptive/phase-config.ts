import { readFile } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import {
  boundedInteger,
  invalid,
  isRecord,
  nonEmptyString,
  parseIntegration,
  parseAgentWorktree,
  parseSalvage,
  repositoryRelativePath,
  type AgentWorktreeConfig,
  type IntegrationConfig,
  type SalvageConfig,
} from '../config';
import { OrchestratorError } from '../errors';
import { AGENT_NAMES, EFFORT_LEVELS, type AgentName, type EffortLevel } from '../tasks/task-schema';
import type { DecompositionCandidate } from './planner';
import type { AdaptiveContinuationConfig, AdaptivePolicy, AdaptiveRole, CapabilityRequirement } from './types';
import { ADAPTIVE_ROLES } from './types';
import { parseAdaptivePolicy, parseWorkRequestDraft } from './validation';

export interface AdaptiveExecutorConfig {
  readonly id: string;
  readonly adapter: AgentName;
  readonly capabilities: readonly CapabilityRequirement[];
  readonly roles: readonly AdaptiveRole[];
  readonly effort: EffortLevel;
  readonly model?: string;
  readonly available: boolean;
}

export interface AdaptivePhaseConfig {
  /** Explicit opt-in discriminator. Existing files do not contain this field. */
  readonly mode: 'adaptive';
  readonly phase: number | string;
  readonly name: string;
  readonly baseBranch: string;
  readonly canonicalDesignDocument: string;
  readonly goal: string;
  readonly constraints: readonly string[];
  readonly policy: AdaptivePolicy;
  readonly initialCandidates: readonly DecompositionCandidate[];
  readonly executors: readonly AdaptiveExecutorConfig[];
  readonly agentRetries: number;
  readonly agentTimeoutMs: number;
  readonly agentWorktree: AgentWorktreeConfig;
  readonly integration: IntegrationConfig;
  readonly continuation?: AdaptiveContinuationConfig;
  /** Generic recovery config, not adaptive-specific — see PhaseConfig.maxHandoffRepairAttempts in src/config.ts. */
  readonly maxHandoffRepairAttempts: number;
  /** Generic recovery config, not adaptive-specific — see PhaseConfig.salvage in src/config.ts. */
  readonly salvage: SalvageConfig;
}

const TOP_LEVEL_KEYS = new Set([
  'mode', 'phase', 'name', 'baseBranch', 'canonicalDesignDocument', 'goal',
  'constraints', 'policy', 'initialCandidates', 'executors', 'agentRetries',
  'agentTimeoutMs', 'agentWorktree', 'integration', 'continuation',
  'maxHandoffRepairAttempts', 'salvage',
]);
const EXECUTOR_KEYS = new Set(['id', 'adapter', 'capabilities', 'roles', 'effort', 'model', 'available']);
const CONTINUATION_KEYS = new Set(['sourceRunId', 'sourceWorkUnitId', 'sourceArtifactType', 'expectedBaseSha', 'expectedArtifactSha256', 'mode']);

function assertKeys(input: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(input)) {
    if (!allowed.has(key)) invalid(`${path}.${key}`, 'is not a supported field');
  }
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) invalid(path, 'must be an array');
  const result = value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
  if (new Set(result).size !== result.length) invalid(path, 'must not contain duplicates');
  return result;
}

function parseCandidate(value: unknown, index: number): DecompositionCandidate {
  const parsed = parseWorkRequestDraft(value);
  for (const dependency of parsed.dependencies ?? []) {
    const match = /^request-(\d{6})$/.exec(dependency);
    if (match === null || Number(match[1]) >= index + 1) {
      invalid(`initialCandidates[${index}].dependencies`, 'must reference an earlier deterministic request id');
    }
  }
  return {
    role: parsed.role,
    concern: parsed.concern,
    objective: parsed.objective,
    reason: parsed.reason,
    dependencies: parsed.dependencies ?? [],
    capabilities: parsed.capabilities ?? [],
    resourceClaims: parsed.resourceClaims ?? [],
    evidence: parsed.evidence ?? [],
    risk: parsed.risk ?? 'medium',
    priority: parsed.priority ?? 50,
    ...(parsed.estimatedCostUnits === undefined ? {} : { estimatedCostUnits: parsed.estimatedCostUnits }),
  };
}

function parseExecutor(value: unknown, index: number): AdaptiveExecutorConfig {
  const path = `executors[${index}]`;
  if (!isRecord(value)) invalid(path, 'must be an object');
  assertKeys(value, EXECUTOR_KEYS, path);
  const id = nonEmptyString(value.id, `${path}.id`);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) invalid(`${path}.id`, 'must match /^[a-z][a-z0-9-]{0,63}$/');
  const adapter = nonEmptyString(value.adapter, `${path}.adapter`);
  if (!(AGENT_NAMES as readonly string[]).includes(adapter)) invalid(`${path}.adapter`, `must be one of ${AGENT_NAMES.join(', ')}`);
  const roles = stringArray(value.roles, `${path}.roles`);
  if (roles.length === 0 || roles.some((role) => !ADAPTIVE_ROLES.includes(role as AdaptiveRole))) invalid(`${path}.roles`, `must contain values from ${ADAPTIVE_ROLES.join(', ')}`);
  const effort = nonEmptyString(value.effort ?? 'high', `${path}.effort`);
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) invalid(`${path}.effort`, `must be one of ${EFFORT_LEVELS.join(', ')}`);
  const model = value.model === undefined ? undefined : nonEmptyString(value.model, `${path}.model`);
  const available = value.available ?? true;
  if (typeof available !== 'boolean') invalid(`${path}.available`, 'must be boolean');
  const capabilities = parseWorkRequestDraft({
    role: 'review', concern: 'capability-validation', objective: 'validate executor', reason: 'configuration',
    capabilities: value.capabilities ?? [], evidence: [], resourceClaims: [], dependencies: [],
  }).capabilities ?? [];
  return {
    id, adapter: adapter as AgentName, capabilities, roles: roles as AdaptiveRole[],
    effort: effort as EffortLevel, ...(model === undefined ? {} : { model }), available,
  };
}

function parseContinuation(value: unknown): AdaptiveContinuationConfig {
  if (!isRecord(value)) invalid('continuation', 'must be an object');
  assertKeys(value, CONTINUATION_KEYS, 'continuation');
  const sourceRunId = nonEmptyString(value.sourceRunId, 'continuation.sourceRunId');
  const sourceWorkUnitId = nonEmptyString(value.sourceWorkUnitId, 'continuation.sourceWorkUnitId');
  const expectedBaseSha = nonEmptyString(value.expectedBaseSha, 'continuation.expectedBaseSha');
  const expectedArtifactSha256 = value.expectedArtifactSha256 === undefined
    ? undefined
    : nonEmptyString(value.expectedArtifactSha256, 'continuation.expectedArtifactSha256');
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(sourceRunId)) invalid('continuation.sourceRunId', 'must be a safe run id');
  if (!/^work-[0-9]{6}$/.test(sourceWorkUnitId)) invalid('continuation.sourceWorkUnitId', 'must be a work unit id');
  if (!/^[0-9a-f]{40,64}$/i.test(expectedBaseSha)) invalid('continuation.expectedBaseSha', 'must be a full commit SHA');
  if (expectedArtifactSha256 !== undefined && !/^[0-9a-f]{64}$/i.test(expectedArtifactSha256)) invalid('continuation.expectedArtifactSha256', 'must be a SHA-256 digest');
  if (value.sourceArtifactType !== 'review') invalid('continuation.sourceArtifactType', 'must be review');
  if (value.mode !== 'canonical_findings') invalid('continuation.mode', 'must be canonical_findings');
  return {
    sourceRunId, sourceWorkUnitId, sourceArtifactType: 'review', expectedBaseSha: expectedBaseSha.toLowerCase(),
    ...(expectedArtifactSha256 === undefined ? {} : { expectedArtifactSha256: expectedArtifactSha256.toLowerCase() }),
    mode: 'canonical_findings',
  };
}

export function parseAdaptivePhaseConfig(value: unknown): AdaptivePhaseConfig {
  if (!isRecord(value)) invalid('$', 'adaptive phase config must be an object');
  assertKeys(value, TOP_LEVEL_KEYS, '$');
  if (value.mode !== 'adaptive') invalid('mode', 'must be adaptive');
  const phase = value.phase;
  if (!((typeof phase === 'number' && Number.isSafeInteger(phase) && phase > 0) || (typeof phase === 'string' && phase.trim() !== ''))) invalid('phase', 'must be a positive integer or non-empty string');
  const baseBranch = nonEmptyString(value.baseBranch, 'baseBranch');
  if (baseBranch.startsWith('-') || /[\u0000-\u001f\u007f]/.test(baseBranch)) invalid('baseBranch', 'contains unsafe branch-name characters');
  const constraints = value.constraints === undefined ? [] : stringArray(value.constraints, 'constraints');
  if (value.initialCandidates !== undefined && !Array.isArray(value.initialCandidates)) invalid('initialCandidates', 'must be an array');
  if (value.executors !== undefined && !Array.isArray(value.executors)) invalid('executors', 'must be an array');
  const initialCandidates = (value.initialCandidates ?? []).map(parseCandidate);
  const executors = (value.executors ?? []).map(parseExecutor);
  const executorIds = executors.map((executor) => executor.id);
  if (new Set(executorIds).size !== executorIds.length) invalid('executors', 'executor ids must be unique');
  const policy = parseAdaptivePolicy(value.policy);
  if (initialCandidates.length > policy.limits.maxTotalWorkUnits) invalid('initialCandidates', 'exceeds maxTotalWorkUnits');
  const continuation = value.continuation === undefined ? undefined : parseContinuation(value.continuation);
  if (continuation !== undefined && initialCandidates.length > 0) invalid('initialCandidates', 'must be empty when continuation imports canonical findings');
  if (continuation !== undefined && policy.correctionPolicy === undefined) invalid('policy.correctionPolicy', 'is required for canonical finding continuation');
  return {
    mode: 'adaptive', phase: typeof phase === 'string' ? phase.trim() : phase,
    name: nonEmptyString(value.name, 'name'), baseBranch,
    canonicalDesignDocument: repositoryRelativePath(value.canonicalDesignDocument ?? 'docs/superpowers/specs/2026-08-20-tripwith-phase-1-design.md', 'canonicalDesignDocument'),
    goal: nonEmptyString(value.goal, 'goal'), constraints, policy, initialCandidates, executors,
    agentRetries: boundedInteger(value.agentRetries ?? 1, 'agentRetries', 0, 5),
    agentTimeoutMs: boundedInteger(value.agentTimeoutMs ?? 60 * 60 * 1_000, 'agentTimeoutMs', 1_000, 24 * 60 * 60 * 1_000),
    agentWorktree: parseAgentWorktree(value.agentWorktree),
    integration: parseIntegration(value.integration),
    maxHandoffRepairAttempts: boundedInteger(value.maxHandoffRepairAttempts ?? 2, 'maxHandoffRepairAttempts', 1, 100),
    salvage: parseSalvage(value.salvage),
    ...(continuation === undefined ? {} : { continuation }),
  };
}

export function parseAdaptivePhaseConfigYaml(source: string): AdaptivePhaseConfig {
  let document;
  try { document = parseDocument(source, { prettyErrors: false, strict: true, uniqueKeys: true }); }
  catch (error) { invalid('$', 'could not parse YAML', error); }
  if (document.errors.length > 0) invalid('$', document.errors.map((error) => error.message).join('; '));
  try { return parseAdaptivePhaseConfig(document.toJS({ maxAliasCount: 0 })); }
  catch (error) {
    if (error instanceof OrchestratorError) throw error;
    invalid('$', 'could not decode YAML', error);
  }
}

export async function loadAdaptivePhaseConfig(path: string): Promise<AdaptivePhaseConfig> {
  try { return parseAdaptivePhaseConfigYaml(await readFile(path, 'utf8')); }
  catch (error) {
    if (error instanceof OrchestratorError) throw error;
    throw new OrchestratorError('CONFIG_INVALID', `Unable to load adaptive phase config: ${path}`, { cause: error, details: { path } });
  }
}

export async function isAdaptivePhaseFile(path: string): Promise<boolean> {
  let document;
  try { document = parseDocument(await readFile(path, 'utf8'), { prettyErrors: false, strict: true, uniqueKeys: true }); }
  catch (error) { throw new OrchestratorError('CONFIG_INVALID', `Could not inspect phase file: ${path}`, { cause: error, details: { path } }); }
  if (document.errors.length > 0) invalid('$', document.errors.map((error) => error.message).join('; '));
  const decoded = document.toJS({ maxAliasCount: 0 }) as unknown;
  return isRecord(decoded) && decoded.mode === 'adaptive';
}
