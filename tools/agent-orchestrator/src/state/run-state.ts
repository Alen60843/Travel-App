import { ERROR_CODES, OrchestratorError, type ErrorCode } from '../errors';
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
}

export interface TaskCommitState {
  readonly sha: string;
  readonly parentSha: string;
  readonly changedFiles: readonly string[];
}

export interface TaskRunState {
  readonly id: string;
  readonly status: TaskStatus;
  readonly worktreePath?: string;
  readonly branch?: string;
  /** HEAD after dependency commits are prepared, before this task agent starts. */
  readonly preparedHeadSha?: string;
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
  /** Whether a bounded handoff-repair attempt (deterministic and/or a single read-only agent call) was made for this task's most recent structured output. */
  readonly handoffRepairAttempted?: boolean;
  /** Present only when handoffRepairAttempted is true: whether that attempt produced a schema-valid result. */
  readonly handoffRepairSucceeded?: boolean;
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
}

export const RUN_EVENT_NAMES = [
  'RUN_CREATED',
  'RUN_RESUMED',
  'TASK_READY',
  'TASK_STARTED',
  'AGENT_STARTED',
  'AGENT_FINISHED',
  'HANDOFF_WRITTEN',
  'HANDOFF_REPAIR_ATTEMPTED',
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
    tasks,
    integration: {
      status: 'PENDING',
      integratedTaskCommits: [],
    },
    errors: [],
    ...(options.agentExecutables === undefined ? {} : { agentExecutables: options.agentExecutables }),
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
    ...((): { handoffRepairAttempted?: boolean } => {
      const parsed = optionalBoolean(value.handoffRepairAttempted, `${path}.handoffRepairAttempted`);
      return parsed === undefined ? {} : { handoffRepairAttempted: parsed };
    })(),
    ...((): { handoffRepairSucceeded?: boolean } => {
      const parsed = optionalBoolean(value.handoffRepairSucceeded, `${path}.handoffRepairSucceeded`);
      return parsed === undefined ? {} : { handoffRepairSucceeded: parsed };
    })(),
  };
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
  if (Object.keys(tasks).length === 0) {
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
    tasks,
    integration,
    ...(integrationAttempts === undefined ? {} : { integrationAttempts }),
    errors: value.errors.map((error, index) => parseStoredError(error, `errors[${index}]`)),
    ...(agentExecutables === undefined ? {} : { agentExecutables }),
  };
}

export function withUpdatedTimestamp(
  state: RunState,
  clock: () => Date = () => new Date(),
): RunState {
  return { ...state, updatedAt: nowIso(clock) };
}
