import { createHash } from 'node:crypto';

import {
  boundedInteger,
  invalid,
  isRecord,
  nonEmptyString,
  parseCommandList,
  type IntegrationCommand,
  type PhaseConfig,
} from '../config';
import { AGENT_NAMES, type AgentName } from '../tasks/task-schema';

/**
 * Recovery-only roles a configured executor may serve. Deliberately a
 * separate, smaller vocabulary from AdaptiveRole — handoff_repair is never a
 * plannable adaptive work role (see the §6 comment on repairHandoffViaAgent),
 * so it doesn't belong in that union. Extend here, not there, if a future
 * recovery-only role is ever needed.
 */
export const RECOVERY_ROLES = ['handoff_repair'] as const;
export type RecoveryRole = (typeof RECOVERY_ROLES)[number];

export interface RecoveryCapabilityRequirement {
  readonly capability: string;
  readonly minimumLevel?: number;
}

/**
 * adapter is intentionally typed AgentName ('codex' | 'claude') — the same
 * closed union every adapter in this codebase uses today, including the
 * existing "provider-neutral" AdaptiveExecutorConfig. Real multi-provider
 * support (Gemini, NVIDIA, local models, ...) does not exist anywhere in
 * this codebase yet and would require widening AgentName across every call
 * site that uses it; that's a separate, larger provider-expansion milestone,
 * not part of this recovery hardening. This routing seam is designed so
 * that widening later only means changing this type and its validation, not
 * the routing/fail-closed logic around it.
 */
export interface RecoveryExecutorConfig {
  readonly id: string;
  readonly adapter: AgentName;
  readonly roles: readonly RecoveryRole[];
  readonly capabilities: readonly RecoveryCapabilityRequirement[];
  readonly model?: string;
  readonly available: boolean;
}

/**
 * A recovery-time policy overlay for a historical run. Deliberately unable
 * to touch anything about the original execution topology — the type has no
 * fields for task ownership, dependencies, base SHA, or canonical findings,
 * so there is nothing here that COULD widen or rewrite them, by
 * construction, not just by convention.
 */
export interface RecoveryPolicyOverlay {
  readonly salvage?: { readonly verify: readonly IntegrationCommand[] };
  readonly executors?: readonly RecoveryExecutorConfig[];
  readonly handoffRepair?: { readonly additionalAttempts: number };
  readonly recoveryBudget?: { readonly maxWallClockMs: number };
  readonly integrationRecovery?: { readonly prepare: readonly IntegrationCommand[] };
}

const TOP_LEVEL_KEYS = new Set(['salvage', 'executors', 'handoffRepair', 'recoveryBudget', 'integrationRecovery']);
const SALVAGE_KEYS = new Set(['verify']);
const EXECUTOR_KEYS = new Set(['id', 'adapter', 'roles', 'capabilities', 'model', 'available']);
const CAPABILITY_KEYS = new Set(['capability', 'minimumLevel']);
const HANDOFF_REPAIR_KEYS = new Set(['additionalAttempts']);
const RECOVERY_BUDGET_KEYS = new Set(['maxWallClockMs']);
const INTEGRATION_RECOVERY_KEYS = new Set(['prepare']);

/**
 * Bounded well above any realistic authorized extension — this is an
 * audited, human-authorized budget increase, not an open-ended dial. The
 * bound exists only to reject obvious config mistakes (a stray extra zero),
 * not to express a real operational ceiling.
 */
const MAX_ADDITIONAL_HANDOFF_REPAIR_ATTEMPTS = 100;

/** 30 days — rejects an obvious config mistake (a stray extra digit), not a real operational ceiling on a legitimate long recovery window. */
const MAX_RECOVERY_WALL_CLOCK_MS = 30 * 24 * 60 * 60 * 1000;

function assertKnownKeys(value: Record<string, unknown>, allowed: ReadonlySet<string>, path: string): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`${path}.${key}`, 'is not a supported field');
    }
  }
}

function parseCapability(value: unknown, path: string): RecoveryCapabilityRequirement {
  if (!isRecord(value)) invalid(path, 'must be an object');
  assertKnownKeys(value, CAPABILITY_KEYS, path);
  const capability = nonEmptyString(value.capability, `${path}.capability`);
  const minimumLevel = value.minimumLevel === undefined
    ? undefined
    : boundedInteger(value.minimumLevel, `${path}.minimumLevel`, 0, 100);
  return { capability, ...(minimumLevel === undefined ? {} : { minimumLevel }) };
}

function parseExecutor(value: unknown, path: string): RecoveryExecutorConfig {
  if (!isRecord(value)) invalid(path, 'must be an object');
  assertKnownKeys(value, EXECUTOR_KEYS, path);
  const id = nonEmptyString(value.id, `${path}.id`);
  const adapterValue = nonEmptyString(value.adapter, `${path}.adapter`);
  if (!(AGENT_NAMES as readonly string[]).includes(adapterValue)) {
    invalid(`${path}.adapter`, `must be one of ${AGENT_NAMES.join(', ')}`);
  }
  if (!Array.isArray(value.roles) || value.roles.length === 0) {
    invalid(`${path}.roles`, 'must be a non-empty array');
  }
  const roles = value.roles.map((role, index) => {
    const roleValue = nonEmptyString(role, `${path}.roles[${index}]`);
    if (!(RECOVERY_ROLES as readonly string[]).includes(roleValue)) {
      invalid(`${path}.roles[${index}]`, `must be one of ${RECOVERY_ROLES.join(', ')}`);
    }
    return roleValue as RecoveryRole;
  });
  const capabilities = value.capabilities === undefined
    ? []
    : (Array.isArray(value.capabilities)
      ? value.capabilities.map((entry, index) => parseCapability(entry, `${path}.capabilities[${index}]`))
      : invalid(`${path}.capabilities`, 'must be an array'));
  const model = value.model === undefined ? undefined : nonEmptyString(value.model, `${path}.model`);
  if (typeof value.available !== 'boolean') {
    invalid(`${path}.available`, 'must be a boolean');
  }
  return {
    id,
    adapter: adapterValue as AgentName,
    roles,
    capabilities,
    ...(model === undefined ? {} : { model }),
    available: value.available,
  };
}

/** Validate a decoded YAML/JSON value into a normalized RecoveryPolicyOverlay. */
export function parseRecoveryPolicyOverlay(value: unknown): RecoveryPolicyOverlay {
  if (!isRecord(value)) {
    invalid('$', 'recovery policy must be an object');
  }
  assertKnownKeys(value, TOP_LEVEL_KEYS, '$');
  let salvage: { readonly verify: readonly IntegrationCommand[] } | undefined;
  if (value.salvage !== undefined) {
    if (!isRecord(value.salvage)) invalid('salvage', 'must be an object');
    assertKnownKeys(value.salvage, SALVAGE_KEYS, 'salvage');
    salvage = { verify: parseCommandList(value.salvage.verify, 'salvage.verify', true) };
  }
  let executors: readonly RecoveryExecutorConfig[] | undefined;
  if (value.executors !== undefined) {
    if (!Array.isArray(value.executors)) invalid('executors', 'must be an array');
    executors = value.executors.map((entry, index) => parseExecutor(entry, `executors[${index}]`));
  }
  let handoffRepair: { readonly additionalAttempts: number } | undefined;
  if (value.handoffRepair !== undefined) {
    if (!isRecord(value.handoffRepair)) invalid('handoffRepair', 'must be an object');
    assertKnownKeys(value.handoffRepair, HANDOFF_REPAIR_KEYS, 'handoffRepair');
    const additionalAttempts = boundedInteger(
      value.handoffRepair.additionalAttempts,
      'handoffRepair.additionalAttempts',
      0,
      MAX_ADDITIONAL_HANDOFF_REPAIR_ATTEMPTS,
    );
    handoffRepair = { additionalAttempts };
  }
  let recoveryBudget: { readonly maxWallClockMs: number } | undefined;
  if (value.recoveryBudget !== undefined) {
    if (!isRecord(value.recoveryBudget)) invalid('recoveryBudget', 'must be an object');
    assertKnownKeys(value.recoveryBudget, RECOVERY_BUDGET_KEYS, 'recoveryBudget');
    const maxWallClockMs = boundedInteger(
      value.recoveryBudget.maxWallClockMs,
      'recoveryBudget.maxWallClockMs',
      1,
      MAX_RECOVERY_WALL_CLOCK_MS,
    );
    recoveryBudget = { maxWallClockMs };
  }
  let integrationRecovery: { readonly prepare: readonly IntegrationCommand[] } | undefined;
  if (value.integrationRecovery !== undefined) {
    if (!isRecord(value.integrationRecovery)) invalid('integrationRecovery', 'must be an object');
    assertKnownKeys(value.integrationRecovery, INTEGRATION_RECOVERY_KEYS, 'integrationRecovery');
    integrationRecovery = { prepare: parseCommandList(value.integrationRecovery.prepare, 'integrationRecovery.prepare', true) };
  }
  return {
    ...(salvage === undefined ? {} : { salvage }),
    ...(executors === undefined ? {} : { executors }),
    ...(handoffRepair === undefined ? {} : { handoffRepair }),
    ...(recoveryBudget === undefined ? {} : { recoveryBudget }),
    ...(integrationRecovery === undefined ? {} : { integrationRecovery }),
  };
}

/**
 * Deterministic serialization of a normalized RecoveryPolicyOverlay: object
 * keys are sorted so equivalent policies differing only by key order hash
 * identically; array element order is preserved, since it's semantically
 * significant (verify command execution order, executor priority).
 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === 'object') {
    const sortedKeys = Object.keys(value as Record<string, unknown>).sort();
    const result: Record<string, unknown> = {};
    for (const key of sortedKeys) {
      result[key] = canonicalize((value as Record<string, unknown>)[key]);
    }
    return result;
  }
  return value;
}

export function canonicalizeRecoveryPolicy(policy: RecoveryPolicyOverlay): string {
  return JSON.stringify(canonicalize(policy));
}

/** SHA-256 of the canonical (normalized, key-sorted) policy representation — never of raw YAML bytes. */
export function hashRecoveryPolicy(policy: RecoveryPolicyOverlay): string {
  return createHash('sha256').update(canonicalizeRecoveryPolicy(policy), 'utf8').digest('hex');
}

/**
 * The single implementation of "what an authorized RecoveryPolicyOverlay
 * does to a PhaseConfig" — every caller that needs an effective,
 * recovery-aware config (loadRunForContinuation at load time,
 * advanceAdaptiveScheduling on every adaptive re-scheduling pass) must go
 * through this, so there is exactly one place these semantics can drift.
 *
 * `baseConfig` MUST be a fresh, un-overlaid config (the historical
 * phase.yaml's own values, or a freshly-computed runtimePhaseConfig() for
 * an adaptive run) — never the result of a previous call to this function.
 * handoffRepair.additionalAttempts is STATE semantics (base + additional),
 * not transaction semantics: applying this function to an already-overlaid
 * config would silently stack the extension on every call
 * (base + additional + additional + ...), which is exactly the bug this
 * discipline exists to prevent.
 *
 * recoveryBudget is deliberately never applied here — it governs adaptive
 * wall-clock epoch state (AdaptiveRunState.recoveryEpochs), not anything
 * PhaseConfig carries, so copying it in would be meaningless at best and
 * misleading at worst.
 */
export function applyRecoveryPolicyOverlay(
  baseConfig: PhaseConfig,
  policy: RecoveryPolicyOverlay | undefined,
): PhaseConfig {
  if (policy === undefined) return baseConfig;
  let config = baseConfig;
  // salvage.verify, when the overlay supplies it, replaces the phase's own
  // entirely for the duration of this load — never merged/concatenated.
  if (policy.salvage !== undefined) {
    config = { ...config, salvage: policy.salvage };
  }
  // Always computed from baseConfig's own value, never from `config` —
  // config only ever diverges from baseConfig in fields this function
  // itself just set, so reading baseConfig here vs. config makes no
  // observable difference today, but it makes the non-stacking invariant
  // self-evident regardless of how this function's body is reordered later.
  if (policy.handoffRepair !== undefined) {
    config = {
      ...config,
      maxHandoffRepairAttempts: baseConfig.maxHandoffRepairAttempts + policy.handoffRepair.additionalAttempts,
    };
  }
  // Replacement, not concatenation: the historical phase.yaml's own
  // integration.prepare remains truthful, immutable history. An authorized
  // integrationRecovery.prepare entirely replaces the effective list for
  // every later attempt.
  if (policy.integrationRecovery !== undefined) {
    config = { ...config, integration: { ...config.integration, prepare: policy.integrationRecovery.prepare } };
  }
  return config;
}
