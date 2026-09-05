import { ERROR_CODES, OrchestratorError, type ErrorCode } from '../errors';
import { parseAdaptiveRunState } from '../adaptive/state-validation';
import type { AdaptiveRunState } from '../adaptive/types';
import { parseRecoveryPolicyOverlay, type RecoveryPolicyOverlay } from '../recovery/policy';
import { TASK_STATUSES, type TaskStatus } from '../tasks/scheduler';
import type { AgentName, TaskSpec } from '../tasks/task-schema';

export const RUN_STATUSES = [
  'CREATED',
  'RUNNING',
  'BLOCKED',
  'COMPLETED',
  'FAILED',
  'CANCELLED',
] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

export const INTEGRATION_STATUSES = [
  'PENDING',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'BLOCKED',
  'CANCELLED',
] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export interface StoredError {
  readonly code: ErrorCode;
  readonly message: string;
  readonly at: string;
  readonly details?: Readonly<Record<string, unknown>>;
}

export interface AgentAttemptState {
  readonly attempt: number;
  readonly agent: AgentName;
  readonly startedAt: string;
  readonly finishedAt?: string;
  readonly pid?: number;
  readonly outcome?: 'succeeded' | 'failed' | 'timed_out' | 'aborted';
  readonly error?: StoredError;
  /** Effective configured budget and observed runtime, persisted for timeout diagnosis. */
  readonly timeoutMs?: number;
  readonly durationMs?: number;
}

/**
 * One recorded attempt at repairing a task's structured handoff output
 * (framing extraction, deterministic key repair, or a bounded read-only
 * agent call). Append-only — never rewritten or removed — so a task's
 * repair history remains an auditable trail rather than a single flag.
 * `method: 'legacy_unknown'` and `failureReason: 'legacy_unknown'` are used
 * only when normalizing a persisted state written before this array
 * existed (the old handoffRepairAttempted/handoffRepairSucceeded booleans),
 * where the exact method/reason were never actually recorded — never
 * fabricated for a native attempt.
 */
export interface HandoffRepairAttemptRecord {
  readonly method: 'framing' | 'deterministic' | 'agent' | 'none' | 'legacy_unknown';
  readonly failureReason?: 'agent_invocation_failed' | 'evidence_insufficient' | 'contradiction_detected' | 'legacy_unknown';
  readonly succeeded: boolean;
  /** Absent only for a migrated legacy attempt that predates this field — its real time was never persisted. */
  readonly timestamp?: string;
}

export interface TaskCommitState {
  readonly sha: string;
  readonly parentSha: string;
  readonly changedFiles: readonly string[];
}

/**
 * Append-only evidence captured when a human explicitly authorizes retrying a
 * task that stopped at the agent/process boundary. The original
 * `agentAttempts` entry also remains in place; this snapshot preserves the
 * task/run terminal context that is cleared when the task becomes READY.
 */
export interface AgentFailureRecoveryState {
  readonly recovery: number;
  readonly authorizedAt: string;
  readonly previousRunStatus: 'FAILED' | 'BLOCKED';
  readonly previousTaskStatus: 'FAILED';
  readonly error: StoredError;
  readonly attempt: AgentAttemptState;
  readonly reopenedTaskIds: readonly string[];
}

export interface TaskRunState {
  readonly id: string;
  readonly status: TaskStatus;
  readonly worktreePath?: string;
  readonly branch?: string;
  /** HEAD after dependency commits are prepared, before this task agent starts. */
  readonly preparedHeadSha?: string;
  readonly preparation?: IntegrationPreparationState;
  readonly commit?: TaskCommitState;
  readonly agentAttempts: readonly AgentAttemptState[];
  readonly reviewRounds: number;
  readonly handoffPath?: string;
  readonly reviewPaths: readonly string[];
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly error?: StoredError;
  /** Present only when status is SKIPPED: why the task's condition was not satisfied. */
  readonly skipReason?: string;
  /**
   * §7 (real Phase 5 dogfood recovery): distinguishes an agent-implementation
   * failure from a protocol/handoff failure — a task whose process succeeded
   * can still end up here as 'invalid' if handoff repair also failed. Set
   * once a handoff (or review) has actually been parsed, whether the first
   * attempt succeeded or only a repair did; absent for tasks that never got
   * that far (e.g. the agent process itself failed, or the task is SKIPPED).
   */
  readonly handoffOutcome?: 'valid' | 'invalid';
  /**
   * Append-only history of bounded handoff-repair attempts for this task's
   * structured output. Replaces the old handoffRepairAttempted/
   * handoffRepairSucceeded booleans (still accepted on read and migrated —
   * see normalizeHandoffRepairAttempts).
   */
  readonly handoffRepairAttempts: readonly HandoffRepairAttemptRecord[];
  /** Explicit agent/process failure recoveries, oldest first; never rewritten or removed. */
  readonly agentFailureRecoveries?: readonly AgentFailureRecoveryState[];
  /**
   * Crash-safety checkpoints for salvaging a timed-out writer's dirty
   * worktree (AgentOrchestrator.salvageTask). Present only once salvage has
   * been authorized for this task. `verification` is present only once
   * salvage.verify has actually passed, and is bound to the exact diff/
   * config it validated — see SalvageVerificationCheckpoint.
   */
  readonly salvage?: {
    readonly authorizedAt: string;
    readonly verification?: SalvageVerificationCheckpoint;
  };
}

/**
 * Binds a passing salvage.verify result to the exact tracked-file diff and
 * verify command list it validated, so a crash-resumed salvage only reuses
 * this checkpoint (skipping a costly re-run) when nothing relevant has
 * changed since it was recorded — never against a since-mutated worktree or
 * a since-edited config.
 */
export interface SalvageVerificationCheckpoint {
  readonly worktreeHeadSha: string;
  readonly trackedDiffFingerprint: string;
  readonly verifyConfigFingerprint: string;
  readonly result: 'passed';
}

export interface IntegrationRunState {
  readonly status: IntegrationStatus;
  readonly worktreePath?: string;
  readonly branch?: string;
  /** Exact integration HEAD after all task cherry-picks and before the gate. */
  readonly headSha?: string;
  readonly integratedTaskCommits: readonly string[];
  /**
   * §8 (real Phase 5 dogfood recovery, THIRD structural finding): distinct
   * from integratedTaskCommits (the cherry-picked task commits) — each entry
   * here is a narrow, auditable integration-only correction applied via
   * AgentOrchestrator.applyIntegrationFix after a real INTEGRATION_TEST_FAILED,
   * never a completed task's own work. Empty/absent for a run that never
   * needed one.
   */
  readonly integrationFixCommits?: readonly string[];
  readonly currentCommand?: number;
  readonly error?: StoredError;
  readonly preparation?: IntegrationPreparationState;
}

export interface IntegrationCommandState {
  readonly command: string;
  readonly required: boolean;
  readonly timeoutMs: number;
  readonly termination: 'timeout' | 'aborted' | null;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface IntegrationPreparationState {
  readonly status: 'RUNNING' | 'SUCCEEDED' | 'FAILED';
  readonly worktreePath: string;
  readonly headSha: string;
  readonly commands: readonly IntegrationCommandState[];
  readonly startedAt: string;
  readonly finishedAt?: string;
}

export interface RunState {
  readonly schemaVersion: 1;
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly phase: number | string;
  readonly repositoryRoot: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly status: RunStatus;
  /** Absent means the original static strategy, preserving existing run JSON byte shape. */
  readonly strategy?: 'adaptive';
  readonly tasks: Readonly<Record<string, TaskRunState>>;
  readonly integration: IntegrationRunState;
  /**
   * §7 (real Phase 5 dogfood recovery): archived, terminal integration
   * attempts, oldest first — populated only by AgentOrchestrator's
   * retryIntegrationGate, which archives the current (BLOCKED,
   * INTEGRATION_TEST_FAILED) `integration` snapshot here before resetting
   * the run so the deterministic gate can run again. Never rewritten or
   * removed: this is the durable record that a first attempt genuinely
   * failed, preserved rather than silently overwritten by a later success.
   */
  readonly integrationAttempts?: readonly IntegrationRunState[];
  readonly errors: readonly StoredError[];
  /**
   * §13: the EXACT executable path each real (non-injected) agent adapter
   * was constructed with at `start()` time, persisted so `resume()` uses the
   * identical binary rather than re-resolving it. Re-resolving on resume
   * would let PATH, CODEX_EXECUTABLE, or which VS Code extension version is
   * newest change out from under an in-progress run — the same class of bug
   * as the immutable base SHA this orchestrator already protects elsewhere.
   * Absent entries mean that agent was test-injected or genuinely unused by
   * this phase's tasks.
   */
  readonly agentExecutables?: Readonly<Partial<Record<AgentName, string>>>;
  /** Optional adaptive topology. Static v1 run files remain valid without it. */
  readonly adaptive?: AdaptiveRunState;
  /**
   * Append-only, oldest first — never rewritten or removed. Each entry is an
   * explicitly authorized (AgentOrchestrator.authorizeRecoveryPolicy),
   * hashed recovery-only policy overlay for THIS run, layered on top of the
   * run's immutable phase.yaml snapshot at load time (never editing it).
   * Absent for a run that has never had a recovery policy authorized —
   * every existing/modern run continues to load and recover exactly as
   * before. The most recent entry is the one currently in effect.
   */
  readonly recoveryPolicyHistory?: readonly RecoveryPolicySnapshot[];
}

/** One authorized, hashed recovery-policy overlay snapshot — see RunState.recoveryPolicyHistory. */
export interface RecoveryPolicySnapshot {
  readonly authorizedAt: string;
  /** sha256 of the canonical (normalized) policy representation — see hashRecoveryPolicy. Never a hash of raw YAML. */
  readonly policyHash: string;
  /** The normalized, validated overlay itself — not the raw YAML that produced it. */
  readonly policy: RecoveryPolicyOverlay;
}

export const RUN_EVENT_NAMES = [
  'RUN_CREATED',
  'RUN_RESUMED',
  'TASK_READY',
  'TASK_STARTED',
  'AGENT_STARTED',
  'AGENT_FINISHED',
  'AGENT_WORKTREE_PREPARATION_STARTED',
  'AGENT_WORKTREE_PREPARATION_COMMAND_FINISHED',
  'AGENT_WORKTREE_PREPARATION_FAILED',
  'HANDOFF_WRITTEN',
  'HANDOFF_REPAIR_ATTEMPTED',
  'AGENT_RETRY_AUTHORIZED',
  'TASK_DEPENDENCY_REOPENED',
  'REVIEW_STARTED',
  'FINDING_REPORTED',
  'TASK_COMMITTED',
  'TASK_SUCCEEDED',
  'TASK_SKIPPED',
  'TASK_FAILED',
  'INTEGRATION_STARTED',
  'INTEGRATION_COMMAND_FINISHED',
  'INTEGRATION_FIX_APPLIED',
  'RUN_BLOCKED',
  'RUN_CANCELLED',
  'RUN_COMPLETED',
  'ADAPTIVE_REQUEST_CREATED',
  'ADAPTIVE_GRANT_DECIDED',
  'ADAPTIVE_REQUEST_GRANTED',
  'ADAPTIVE_REQUEST_WAITING',
  'ADAPTIVE_REQUEST_DENIED',
  'ADAPTIVE_WORK_UNIT_CREATED',
  'ADAPTIVE_WORK_UNIT_READY',
  'ADAPTIVE_WORK_UNIT_STARTED',
  'ADAPTIVE_WORK_UNIT_FINISHED',
  'ADAPTIVE_WORK_UNIT_SUCCEEDED',
  'ADAPTIVE_WORK_UNIT_FAILED',
  'ADAPTIVE_RESOURCE_RELEASED',
  'ADAPTIVE_SYNTHESIS_CREATED',
  'ADAPTIVE_CANONICAL_FINDINGS_IMPORTED',
  'ADAPTIVE_CORRECTION_PLAN_CREATED',
  'ADAPTIVE_CORRECTION_REQUEST_CREATED',
  'ADAPTIVE_CORRECTION_GRANTED',
  'ADAPTIVE_REVERIFICATION_CREATED',
  'INTEGRATION_PREPARATION_STARTED',
  'INTEGRATION_PREPARATION_COMMAND_FINISHED',
  'INTEGRATION_PREPARATION_FAILED',
  'SALVAGE_AUTHORIZED',
  'SALVAGE_VERIFIED',
  'SALVAGE_VERIFICATION_FAILED',
  'RECOVERY_POLICY_AUTHORIZED',
] as const;
export type RunEventName = (typeof RUN_EVENT_NAMES)[number];

export interface RunEvent {
  readonly name: RunEventName;
  readonly timestamp: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly data?: Readonly<Record<string, unknown>>;
}

function nowIso(clock: () => Date): string {
  return clock().toISOString();
}

export function createRunState(options: {
  readonly runId: string;
  readonly phase: number | string;
  readonly repositoryRoot: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly tasks: readonly TaskSpec[];
  readonly clock?: () => Date;
  readonly agentExecutables?: Readonly<Partial<Record<AgentName, string>>>;
  readonly strategy?: 'adaptive';
  readonly adaptive?: AdaptiveRunState;
}): RunState {
  assertSafeRunId(options.runId);
  assertFullSha(options.baseSha, 'baseSha');
  if (!options.repositoryRoot.startsWith('/')) {
    throw new OrchestratorError('STATE_CORRUPT', 'repositoryRoot must be absolute');
  }
  const timestamp = nowIso(options.clock ?? (() => new Date()));
  const tasks: Record<string, TaskRunState> = {};
  for (const task of options.tasks) {
    tasks[task.id] = {
      id: task.id,
      status: task.dependsOn.length === 0 ? 'READY' : 'PENDING',
      agentAttempts: [],
      reviewRounds: 0,
      reviewPaths: [],
      handoffRepairAttempts: [],
    };
  }
  return {
    schemaVersion: 1,
    runId: options.runId,
    createdAt: timestamp,
    updatedAt: timestamp,
    phase: options.phase,
    repositoryRoot: options.repositoryRoot,
    baseBranch: options.baseBranch,
    baseSha: options.baseSha,
    status: 'CREATED',
    ...(options.strategy === undefined ? {} : { strategy: options.strategy }),
    tasks,
    integration: {
      status: 'PENDING',
      integratedTaskCommits: [],
    },
    errors: [],
    ...(options.agentExecutables === undefined ? {} : { agentExecutables: options.agentExecutables }),
    ...(options.adaptive === undefined ? {} : { adaptive: options.adaptive }),
  };
}

export function assertSafeRunId(runId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(runId)) {
    throw new OrchestratorError('STATE_CORRUPT', `Unsafe run id: ${runId}`);
  }
}

export function assertFullSha(sha: string, path: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(sha)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} is not a full commit SHA`);
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function string(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be a non-empty string`);
  }
  return value;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < minimum) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an integer >= ${minimum}`);
  }
  return value;
}

function timestamp(value: unknown, path: string): string {
  const result = string(value, path);
  if (!/^\d{4}-\d{2}-\d{2}T/.test(result) || Number.isNaN(Date.parse(result))) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an ISO timestamp`);
  }
  return result;
}

function optionalString(value: unknown, path: string): string | undefined {
  return value === undefined ? undefined : string(value, path);
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'boolean') {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be a boolean`);
  }
  return value;
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an array`);
  }
  return value.map((entry, index) => string(entry, `${path}[${index}]`));
}

function parseStoredError(value: unknown, path: string): StoredError {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  const code = string(value.code, `${path}.code`);
  if (!(ERROR_CODES as readonly string[]).includes(code)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.code is invalid`);
  }
  return {
    code: code as ErrorCode,
    message: string(value.message, `${path}.message`),
    at: timestamp(value.at, `${path}.at`),
    ...(isObject(value.details) ? { details: value.details } : {}),
  };
}

function parseAttempt(value: unknown, path: string): AgentAttemptState {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  const agent = string(value.agent, `${path}.agent`);
  if (agent !== 'codex' && agent !== 'claude') {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.agent is invalid`);
  }
  const outcome = optionalString(value.outcome, `${path}.outcome`);
  if (
    outcome !== undefined &&
    !['succeeded', 'failed', 'timed_out', 'aborted'].includes(outcome)
  ) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.outcome is invalid`);
  }
  const pid = value.pid === undefined ? undefined : integer(value.pid, `${path}.pid`, 1);
  return {
    attempt: integer(value.attempt, `${path}.attempt`, 1),
    agent,
    startedAt: timestamp(value.startedAt, `${path}.startedAt`),
    ...(value.finishedAt === undefined
      ? {}
      : { finishedAt: timestamp(value.finishedAt, `${path}.finishedAt`) }),
    ...(pid === undefined ? {} : { pid }),
    ...(outcome === undefined
      ? {}
      : { outcome: outcome as NonNullable<AgentAttemptState['outcome']> }),
    ...(value.error === undefined
      ? {}
      : { error: parseStoredError(value.error, `${path}.error`) }),
    ...(value.timeoutMs === undefined
      ? {}
      : { timeoutMs: integer(value.timeoutMs, `${path}.timeoutMs`, 1) }),
    ...(value.durationMs === undefined
      ? {}
      : { durationMs: integer(value.durationMs, `${path}.durationMs`) }),
  };
}

function parseTaskPreparation(value: unknown, path: string): IntegrationPreparationState {
  if (!isObject(value)) throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  const status = string(value.status, `${path}.status`);
  if (!['RUNNING', 'SUCCEEDED', 'FAILED'].includes(status)) throw new OrchestratorError('STATE_CORRUPT', `${path}.status is invalid`);
  if (!Array.isArray(value.commands)) throw new OrchestratorError('STATE_CORRUPT', `${path}.commands must be an array`);
  const headSha = string(value.headSha, `${path}.headSha`);
  assertFullSha(headSha, `${path}.headSha`);
  return {
    status: status as IntegrationPreparationState['status'],
    worktreePath: string(value.worktreePath, `${path}.worktreePath`), headSha,
    commands: value.commands.map((entry, index) => {
      const commandPath = `${path}.commands[${index}]`;
      if (!isObject(entry)) throw new OrchestratorError('STATE_CORRUPT', `${commandPath} must be an object`);
      const termination = entry.termination;
      if (termination !== null && termination !== 'timeout' && termination !== 'aborted') throw new OrchestratorError('STATE_CORRUPT', `${commandPath}.termination is invalid`);
      const exitCode = entry.exitCode;
      if (exitCode !== null && (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0)) throw new OrchestratorError('STATE_CORRUPT', `${commandPath}.exitCode is invalid`);
      const signal = entry.signal;
      if (signal !== null && typeof signal !== 'string') throw new OrchestratorError('STATE_CORRUPT', `${commandPath}.signal is invalid`);
      if (typeof entry.required !== 'boolean' || typeof entry.timedOut !== 'boolean') throw new OrchestratorError('STATE_CORRUPT', `${commandPath} booleans are invalid`);
      return {
        command: string(entry.command, `${commandPath}.command`), required: entry.required,
        timeoutMs: integer(entry.timeoutMs, `${commandPath}.timeoutMs`, 1), termination,
        timedOut: entry.timedOut, exitCode: exitCode as number | null, signal: signal as string | null,
        durationMs: integer(entry.durationMs, `${commandPath}.durationMs`),
        stdoutPath: string(entry.stdoutPath, `${commandPath}.stdoutPath`), stderrPath: string(entry.stderrPath, `${commandPath}.stderrPath`),
      };
    }),
    startedAt: timestamp(value.startedAt, `${path}.startedAt`),
    ...(value.finishedAt === undefined ? {} : { finishedAt: timestamp(value.finishedAt, `${path}.finishedAt`) }),
  };
}

function parseAgentFailureRecovery(
  value: unknown,
  path: string,
  expectedRecovery: number,
): AgentFailureRecoveryState {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  const recovery = integer(value.recovery, `${path}.recovery`, 1);
  if (recovery !== expectedRecovery) {
    throw new OrchestratorError(
      'STATE_CORRUPT',
      `${path}.recovery must be the append-only sequence number ${expectedRecovery}`,
    );
  }
  const previousRunStatus = string(value.previousRunStatus, `${path}.previousRunStatus`);
  if (previousRunStatus !== 'FAILED' && previousRunStatus !== 'BLOCKED') {
    throw new OrchestratorError(
      'STATE_CORRUPT',
      `${path}.previousRunStatus must be FAILED or BLOCKED`,
    );
  }
  if (value.previousTaskStatus !== 'FAILED') {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.previousTaskStatus must be FAILED`);
  }
  return {
    recovery,
    authorizedAt: timestamp(value.authorizedAt, `${path}.authorizedAt`),
    previousRunStatus,
    previousTaskStatus: 'FAILED',
    error: parseStoredError(value.error, `${path}.error`),
    attempt: parseAttempt(value.attempt, `${path}.attempt`),
    reopenedTaskIds: stringArray(value.reopenedTaskIds, `${path}.reopenedTaskIds`),
  };
}

/**
 * Factored out (previously inline in validateRunState) so the same parser
 * validates both the live `integration` field and each archived entry in
 * `integrationAttempts` — see AgentOrchestrator.retryIntegrationGate, which
 * archives a BLOCKED/INTEGRATION_TEST_FAILED attempt here before letting the
 * gate run again, rather than ever overwriting it in place.
 */
function parseIntegrationState(value: unknown, path: string): IntegrationRunState {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  const integrationStatus = string(value.status, `${path}.status`);
  if (!(INTEGRATION_STATUSES as readonly string[]).includes(integrationStatus)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.status is invalid`);
  }
  const integratedTaskCommits = stringArray(
    value.integratedTaskCommits,
    `${path}.integratedTaskCommits`,
  );
  integratedTaskCommits.forEach((sha, index) =>
    assertFullSha(sha, `${path}.integratedTaskCommits[${index}]`),
  );
  let integrationFixCommits: string[] | undefined;
  if (value.integrationFixCommits !== undefined) {
    integrationFixCommits = stringArray(value.integrationFixCommits, `${path}.integrationFixCommits`);
    integrationFixCommits.forEach((sha, index) =>
      assertFullSha(sha, `${path}.integrationFixCommits[${index}]`),
    );
  }
  let preparation: IntegrationPreparationState | undefined;
  if (value.preparation !== undefined) {
    const prep = value.preparation;
    if (!isObject(prep)) throw new OrchestratorError('STATE_CORRUPT', `${path}.preparation must be an object`);
    const prepStatus = string(prep.status, `${path}.preparation.status`);
    if (!['RUNNING', 'SUCCEEDED', 'FAILED'].includes(prepStatus)) throw new OrchestratorError('STATE_CORRUPT', `${path}.preparation.status is invalid`);
    if (!Array.isArray(prep.commands)) throw new OrchestratorError('STATE_CORRUPT', `${path}.preparation.commands must be an array`);
    const headSha = string(prep.headSha, `${path}.preparation.headSha`);
    assertFullSha(headSha, `${path}.preparation.headSha`);
    preparation = {
      status: prepStatus as IntegrationPreparationState['status'],
      worktreePath: string(prep.worktreePath, `${path}.preparation.worktreePath`),
      headSha,
      commands: prep.commands.map((entry, index) => {
        const commandPath = `${path}.preparation.commands[${index}]`;
        if (!isObject(entry)) throw new OrchestratorError('STATE_CORRUPT', `${commandPath} must be an object`);
        const termination = entry.termination;
        if (termination !== null && termination !== 'timeout' && termination !== 'aborted') throw new OrchestratorError('STATE_CORRUPT', `${commandPath}.termination is invalid`);
        const exitCode = entry.exitCode;
        if (exitCode !== null && (!Number.isSafeInteger(exitCode) || (exitCode as number) < 0)) throw new OrchestratorError('STATE_CORRUPT', `${commandPath}.exitCode is invalid`);
        const signal = entry.signal;
        if (signal !== null && typeof signal !== 'string') throw new OrchestratorError('STATE_CORRUPT', `${commandPath}.signal is invalid`);
        if (typeof entry.required !== 'boolean' || typeof entry.timedOut !== 'boolean') throw new OrchestratorError('STATE_CORRUPT', `${commandPath} booleans are invalid`);
        return {
          command: string(entry.command, `${commandPath}.command`), required: entry.required,
          timeoutMs: integer(entry.timeoutMs, `${commandPath}.timeoutMs`, 1), termination,
          timedOut: entry.timedOut, exitCode: exitCode as number | null, signal: signal as string | null,
          durationMs: integer(entry.durationMs, `${commandPath}.durationMs`),
          stdoutPath: string(entry.stdoutPath, `${commandPath}.stdoutPath`), stderrPath: string(entry.stderrPath, `${commandPath}.stderrPath`),
        };
      }),
      startedAt: timestamp(prep.startedAt, `${path}.preparation.startedAt`),
      ...(prep.finishedAt === undefined ? {} : { finishedAt: timestamp(prep.finishedAt, `${path}.preparation.finishedAt`) }),
    };
  }
  return {
    status: integrationStatus as IntegrationStatus,
    ...(value.worktreePath === undefined
      ? {}
      : { worktreePath: string(value.worktreePath, `${path}.worktreePath`) }),
    ...(value.branch === undefined ? {} : { branch: string(value.branch, `${path}.branch`) }),
    ...(value.headSha === undefined
      ? {}
      : {
          headSha: (() => {
            const sha = string(value.headSha, `${path}.headSha`);
            assertFullSha(sha, `${path}.headSha`);
            return sha;
          })(),
        }),
    integratedTaskCommits,
    ...(integrationFixCommits === undefined ? {} : { integrationFixCommits }),
    ...(value.currentCommand === undefined
      ? {}
      : { currentCommand: integer(value.currentCommand, `${path}.currentCommand`) }),
    ...(value.error === undefined ? {} : { error: parseStoredError(value.error, `${path}.error`) }),
    ...(preparation === undefined ? {} : { preparation }),
  };
}

const HANDOFF_REPAIR_METHODS = new Set(['framing', 'deterministic', 'agent', 'none', 'legacy_unknown']);
const HANDOFF_REPAIR_FAILURE_REASONS = new Set([
  'agent_invocation_failed', 'evidence_insufficient', 'contradiction_detected', 'legacy_unknown',
]);

function parseHandoffRepairAttemptRecord(value: unknown, path: string): HandoffRepairAttemptRecord {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  const method = string(value.method, `${path}.method`);
  if (!HANDOFF_REPAIR_METHODS.has(method)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.method is invalid`);
  }
  const succeeded = value.succeeded;
  if (typeof succeeded !== 'boolean') {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.succeeded must be a boolean`);
  }
  let failureReason: HandoffRepairAttemptRecord['failureReason'];
  if (value.failureReason !== undefined) {
    const reason = string(value.failureReason, `${path}.failureReason`);
    if (!HANDOFF_REPAIR_FAILURE_REASONS.has(reason)) {
      throw new OrchestratorError('STATE_CORRUPT', `${path}.failureReason is invalid`);
    }
    failureReason = reason as HandoffRepairAttemptRecord['failureReason'];
  }
  return {
    method: method as HandoffRepairAttemptRecord['method'],
    succeeded,
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(value.timestamp === undefined ? {} : { timestamp: timestamp(value.timestamp, `${path}.timestamp`) }),
  };
}

/**
 * Legacy compatibility: a persisted TaskRunState written before
 * handoffRepairAttempts existed carries handoffRepairAttempted/
 * handoffRepairSucceeded booleans instead. Normalize both shapes to the
 * same array representation so old run state keeps loading without a
 * manual migration. Never fabricates a method, failureReason, or timestamp
 * beyond what the booleans themselves proved — a migrated record uses
 * 'legacy_unknown' for method (and failureReason, when failed) and omits
 * timestamp entirely, because the boolean-only shape never persisted one.
 */
function normalizeHandoffRepairAttempts(
  value: Record<string, unknown>,
  path: string,
): readonly HandoffRepairAttemptRecord[] {
  if (value.handoffRepairAttempts !== undefined) {
    if (!Array.isArray(value.handoffRepairAttempts)) {
      throw new OrchestratorError('STATE_CORRUPT', `${path}.handoffRepairAttempts must be an array`);
    }
    return value.handoffRepairAttempts.map((entry, index) =>
      parseHandoffRepairAttemptRecord(entry, `${path}.handoffRepairAttempts[${index}]`));
  }
  const attempted = optionalBoolean(value.handoffRepairAttempted, `${path}.handoffRepairAttempted`);
  if (attempted !== true) {
    return [];
  }
  const succeeded = optionalBoolean(value.handoffRepairSucceeded, `${path}.handoffRepairSucceeded`) === true;
  return [{
    method: 'legacy_unknown',
    succeeded,
    ...(succeeded ? {} : { failureReason: 'legacy_unknown' as const }),
  }];
}

function parseSalvageVerificationCheckpoint(value: unknown, path: string): SalvageVerificationCheckpoint {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  const result = string(value.result, `${path}.result`);
  if (result !== 'passed') {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.result is invalid`);
  }
  return {
    worktreeHeadSha: (() => {
      const sha = string(value.worktreeHeadSha, `${path}.worktreeHeadSha`);
      assertFullSha(sha, `${path}.worktreeHeadSha`);
      return sha;
    })(),
    trackedDiffFingerprint: string(value.trackedDiffFingerprint, `${path}.trackedDiffFingerprint`),
    verifyConfigFingerprint: string(value.verifyConfigFingerprint, `${path}.verifyConfigFingerprint`),
    result: 'passed',
  };
}

function parseSalvageState(
  value: unknown,
  path: string,
): { readonly authorizedAt: string; readonly verification?: SalvageVerificationCheckpoint } {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  return {
    authorizedAt: timestamp(value.authorizedAt, `${path}.authorizedAt`),
    ...(value.verification === undefined
      ? {}
      : { verification: parseSalvageVerificationCheckpoint(value.verification, `${path}.verification`) }),
  };
}

function parseTask(value: unknown, key: string): TaskRunState {
  const path = `tasks.${key}`;
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(key)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} has an invalid task id`);
  }
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  const id = string(value.id, `${path}.id`);
  if (id !== key) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.id does not match its key`);
  }
  const status = string(value.status, `${path}.status`);
  if (!(TASK_STATUSES as readonly string[]).includes(status)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.status is invalid`);
  }
  if (!Array.isArray(value.agentAttempts)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.agentAttempts must be an array`);
  }
  const commitValue = value.commit;
  let commit: TaskCommitState | undefined;
  if (commitValue !== undefined) {
    if (!isObject(commitValue)) {
      throw new OrchestratorError('STATE_CORRUPT', `${path}.commit must be an object`);
    }
    const sha = string(commitValue.sha, `${path}.commit.sha`);
    const parentSha = string(commitValue.parentSha, `${path}.commit.parentSha`);
    assertFullSha(sha, `${path}.commit.sha`);
    assertFullSha(parentSha, `${path}.commit.parentSha`);
    commit = {
      sha,
      parentSha,
      changedFiles: stringArray(commitValue.changedFiles, `${path}.commit.changedFiles`).map(
        (changedPath) => {
          if (
            changedPath.startsWith('/') ||
            changedPath.includes('\\') ||
            changedPath.split('/').some((part) => part === '' || part === '.' || part === '..')
          ) {
            throw new OrchestratorError(
              'STATE_CORRUPT',
              `${path}.commit.changedFiles contains an unsafe path`,
            );
          }
          return changedPath;
        },
      ),
    };
  }
  let agentFailureRecoveries: AgentFailureRecoveryState[] | undefined;
  if (value.agentFailureRecoveries !== undefined) {
    if (!Array.isArray(value.agentFailureRecoveries)) {
      throw new OrchestratorError(
        'STATE_CORRUPT',
        `${path}.agentFailureRecoveries must be an array`,
      );
    }
    agentFailureRecoveries = value.agentFailureRecoveries.map((recovery, index) =>
      parseAgentFailureRecovery(
        recovery,
        `${path}.agentFailureRecoveries[${index}]`,
        index + 1,
      ),
    );
  }
  return {
    id,
    status: status as TaskStatus,
    ...(value.worktreePath === undefined
      ? {}
      : { worktreePath: string(value.worktreePath, `${path}.worktreePath`) }),
    ...(value.branch === undefined ? {} : { branch: string(value.branch, `${path}.branch`) }),
    ...(value.preparedHeadSha === undefined
      ? {}
      : {
          preparedHeadSha: (() => {
            const sha = string(value.preparedHeadSha, `${path}.preparedHeadSha`);
            assertFullSha(sha, `${path}.preparedHeadSha`);
            return sha;
          })(),
        }),
    ...(commit === undefined ? {} : { commit }),
    ...(value.preparation === undefined
      ? {}
      : { preparation: parseTaskPreparation(value.preparation, `${path}.preparation`) }),
    agentAttempts: value.agentAttempts.map((attempt, index) =>
      parseAttempt(attempt, `${path}.agentAttempts[${index}]`),
    ),
    reviewRounds: integer(value.reviewRounds, `${path}.reviewRounds`),
    ...(value.handoffPath === undefined
      ? {}
      : { handoffPath: string(value.handoffPath, `${path}.handoffPath`) }),
    reviewPaths: stringArray(value.reviewPaths, `${path}.reviewPaths`),
    ...(value.startedAt === undefined
      ? {}
      : { startedAt: timestamp(value.startedAt, `${path}.startedAt`) }),
    ...(value.finishedAt === undefined
      ? {}
      : { finishedAt: timestamp(value.finishedAt, `${path}.finishedAt`) }),
    ...(value.error === undefined
      ? {}
      : { error: parseStoredError(value.error, `${path}.error`) }),
    ...(value.skipReason === undefined
      ? {}
      : { skipReason: string(value.skipReason, `${path}.skipReason`) }),
    ...(value.handoffOutcome === undefined
      ? {}
      : {
          handoffOutcome: (() => {
            const outcome = string(value.handoffOutcome, `${path}.handoffOutcome`);
            if (outcome !== 'valid' && outcome !== 'invalid') {
              throw new OrchestratorError('STATE_CORRUPT', `${path}.handoffOutcome is invalid`);
            }
            return outcome;
          })(),
        }),
    handoffRepairAttempts: normalizeHandoffRepairAttempts(value, path),
    ...(agentFailureRecoveries === undefined ? {} : { agentFailureRecoveries }),
    ...(value.salvage === undefined ? {} : { salvage: parseSalvageState(value.salvage, `${path}.salvage`) }),
  };
}

function parseRecoveryPolicySnapshot(value: unknown, path: string): RecoveryPolicySnapshot {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  const authorizedAt = timestamp(value.authorizedAt, `${path}.authorizedAt`);
  const policyHash = string(value.policyHash, `${path}.policyHash`);
  if (!/^[0-9a-f]{64}$/i.test(policyHash)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.policyHash must be a sha256 hex digest`);
  }
  let policy: RecoveryPolicyOverlay;
  try {
    policy = parseRecoveryPolicyOverlay(value.policy);
  } catch (error) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.policy is invalid`, { cause: error });
  }
  return { authorizedAt, policyHash, policy };
}

export function validateRunState(value: unknown): RunState {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', 'Run state must be an object');
  }
  if (value.schemaVersion !== 1) {
    throw new OrchestratorError('STATE_CORRUPT', 'Unsupported run state schemaVersion');
  }
  const runId = string(value.runId, 'runId');
  assertSafeRunId(runId);
  const status = string(value.status, 'status');
  if (!(RUN_STATUSES as readonly string[]).includes(status)) {
    throw new OrchestratorError('STATE_CORRUPT', 'Run status is invalid');
  }
  const baseSha = string(value.baseSha, 'baseSha');
  assertFullSha(baseSha, 'baseSha');
  if (!isObject(value.tasks)) {
    throw new OrchestratorError('STATE_CORRUPT', 'tasks must be an object');
  }
  const tasks = Object.fromEntries(
    Object.entries(value.tasks).map(([key, task]) => [key, parseTask(task, key)]),
  );
  const strategy = value.strategy === undefined ? undefined : string(value.strategy, 'strategy');
  if (strategy !== undefined && strategy !== 'adaptive') {
    throw new OrchestratorError('STATE_CORRUPT', 'strategy must be adaptive when present');
  }
  if (Object.keys(tasks).length === 0 && strategy !== 'adaptive') {
    throw new OrchestratorError('STATE_CORRUPT', 'tasks must not be empty');
  }
  if (!Array.isArray(value.errors)) {
    throw new OrchestratorError('STATE_CORRUPT', 'errors must be an array');
  }
  const phase = value.phase;
  if (
    !(
      (typeof phase === 'string' && phase.length > 0) ||
      (typeof phase === 'number' && Number.isSafeInteger(phase) && phase > 0)
    )
  ) {
    throw new OrchestratorError(
      'STATE_CORRUPT',
      'phase must be a positive integer or non-empty string',
    );
  }
  const integration = parseIntegrationState(value.integration, 'integration');
  let integrationAttempts: IntegrationRunState[] | undefined;
  if (value.integrationAttempts !== undefined) {
    if (!Array.isArray(value.integrationAttempts)) {
      throw new OrchestratorError('STATE_CORRUPT', 'integrationAttempts must be an array');
    }
    integrationAttempts = value.integrationAttempts.map((entry, index) =>
      parseIntegrationState(entry, `integrationAttempts[${index}]`),
    );
  }
  let recoveryPolicyHistory: RecoveryPolicySnapshot[] | undefined;
  if (value.recoveryPolicyHistory !== undefined) {
    if (!Array.isArray(value.recoveryPolicyHistory)) {
      throw new OrchestratorError('STATE_CORRUPT', 'recoveryPolicyHistory must be an array');
    }
    recoveryPolicyHistory = value.recoveryPolicyHistory.map((entry, index) =>
      parseRecoveryPolicySnapshot(entry, `recoveryPolicyHistory[${index}]`),
    );
  }
  const repositoryRoot = string(value.repositoryRoot, 'repositoryRoot');
  if (!repositoryRoot.startsWith('/')) {
    throw new OrchestratorError('STATE_CORRUPT', 'repositoryRoot must be absolute');
  }
  let agentExecutables: Partial<Record<AgentName, string>> | undefined;
  if (value.agentExecutables !== undefined) {
    if (!isObject(value.agentExecutables)) {
      throw new OrchestratorError('STATE_CORRUPT', 'agentExecutables must be an object');
    }
    agentExecutables = {};
    for (const [agentName, path] of Object.entries(value.agentExecutables)) {
      if (agentName !== 'codex' && agentName !== 'claude') {
        throw new OrchestratorError('STATE_CORRUPT', `agentExecutables.${agentName} is not a known agent`);
      }
      agentExecutables[agentName] = string(path, `agentExecutables.${agentName}`);
    }
  }
  const adaptive = value.adaptive === undefined
    ? undefined
    : parseAdaptiveRunState(value.adaptive);
  if (strategy === 'adaptive' && adaptive === undefined) {
    throw new OrchestratorError(
      'STATE_CORRUPT',
      'adaptive strategy requires a persisted adaptive topology',
    );
  }
  if (adaptive !== undefined) {
    for (const request of adaptive.workRequests) {
      const authorization = request.authorization;
      if (authorization === undefined) continue;
      if (authorization.importedSource !== undefined) {
        const imported = adaptive.continuation?.findings.find(
          (finding) => finding.canonicalFindingKey === authorization.canonicalFindingKey,
        );
        if (authorization.purpose !== 'correction' || imported === undefined
          || authorization.findingReference !== imported.finding.id
          || authorization.artifactPath !== imported.sourceArtifactPath
          || authorization.sourceWorkUnitId !== imported.sourceWorkUnitId
          || authorization.importedSource.sourceRunId !== imported.sourceRunId
          || authorization.importedSource.sourceBaseSha !== imported.sourceBaseSha
          || authorization.importedSource.artifactSha256 !== imported.sourceArtifactSha256) {
          throw new OrchestratorError('STATE_CORRUPT', `${request.id} imported authorization does not match persisted continuation evidence`);
        }
        continue;
      }
      const sourceTask = tasks[authorization.sourceWorkUnitId];
      const artifactMatches = authorization.purpose === 'correction'
        ? sourceTask?.reviewPaths.includes(authorization.artifactPath) === true
        : sourceTask?.handoffPath === authorization.artifactPath;
      if (!artifactMatches) {
        throw new OrchestratorError('STATE_CORRUPT', `${request.id} canonical authorization does not match its persisted source artifact`);
      }
    }
  }
  return {
    schemaVersion: 1,
    runId,
    createdAt: timestamp(value.createdAt, 'createdAt'),
    updatedAt: timestamp(value.updatedAt, 'updatedAt'),
    phase,
    repositoryRoot,
    baseBranch: string(value.baseBranch, 'baseBranch'),
    baseSha,
    status: status as RunStatus,
    ...(strategy === undefined ? {} : { strategy: 'adaptive' as const }),
    tasks,
    integration,
    ...(integrationAttempts === undefined ? {} : { integrationAttempts }),
    ...(recoveryPolicyHistory === undefined ? {} : { recoveryPolicyHistory }),
    errors: value.errors.map((error, index) => parseStoredError(error, `errors[${index}]`)),
    ...(agentExecutables === undefined ? {} : { agentExecutables }),
    ...(adaptive === undefined ? {} : { adaptive }),
  };
}

export function withUpdatedTimestamp(
  state: RunState,
  clock: () => Date = () => new Date(),
): RunState {
  return { ...state, updatedAt: nowIso(clock) };
}
