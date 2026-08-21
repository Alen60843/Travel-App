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
}

export interface IntegrationRunState {
  readonly status: IntegrationStatus;
  readonly worktreePath?: string;
  readonly branch?: string;
  /** Exact integration HEAD after all task cherry-picks and before the gate. */
  readonly headSha?: string;
  readonly integratedTaskCommits: readonly string[];
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
  readonly errors: readonly StoredError[];
}

export const RUN_EVENT_NAMES = [
  'RUN_CREATED',
  'RUN_RESUMED',
  'TASK_READY',
  'TASK_STARTED',
  'AGENT_STARTED',
  'AGENT_FINISHED',
  'HANDOFF_WRITTEN',
  'REVIEW_STARTED',
  'FINDING_REPORTED',
  'TASK_COMMITTED',
  'TASK_SUCCEEDED',
  'TASK_FAILED',
  'INTEGRATION_STARTED',
  'INTEGRATION_COMMAND_FINISHED',
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
  if (!isObject(value.integration)) {
    throw new OrchestratorError('STATE_CORRUPT', 'integration must be an object');
  }
  const integrationStatus = string(value.integration.status, 'integration.status');
  if (!(INTEGRATION_STATUSES as readonly string[]).includes(integrationStatus)) {
    throw new OrchestratorError('STATE_CORRUPT', 'integration.status is invalid');
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
  const integratedTaskCommits = stringArray(
    value.integration.integratedTaskCommits,
    'integration.integratedTaskCommits',
  );
  integratedTaskCommits.forEach((sha, index) =>
    assertFullSha(sha, `integration.integratedTaskCommits[${index}]`),
  );
  const integration: IntegrationRunState = {
    status: integrationStatus as IntegrationStatus,
    ...(value.integration.worktreePath === undefined
      ? {}
      : { worktreePath: string(value.integration.worktreePath, 'integration.worktreePath') }),
    ...(value.integration.branch === undefined
      ? {}
      : { branch: string(value.integration.branch, 'integration.branch') }),
    ...(value.integration.headSha === undefined
      ? {}
      : {
          headSha: (() => {
            const sha = string(value.integration.headSha, 'integration.headSha');
            assertFullSha(sha, 'integration.headSha');
            return sha;
          })(),
        }),
    integratedTaskCommits,
    ...(value.integration.currentCommand === undefined
      ? {}
      : {
          currentCommand: integer(
            value.integration.currentCommand,
            'integration.currentCommand',
          ),
        }),
    ...(value.integration.error === undefined
      ? {}
      : { error: parseStoredError(value.integration.error, 'integration.error') }),
  };
  const repositoryRoot = string(value.repositoryRoot, 'repositoryRoot');
  if (!repositoryRoot.startsWith('/')) {
    throw new OrchestratorError('STATE_CORRUPT', 'repositoryRoot must be absolute');
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
    errors: value.errors.map((error, index) => parseStoredError(error, `errors[${index}]`)),
  };
}

export function withUpdatedTimestamp(
  state: RunState,
  clock: () => Date = () => new Date(),
): RunState {
  return { ...state, updatedAt: nowIso(clock) };
}
