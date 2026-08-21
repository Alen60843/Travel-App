import { OrchestratorError } from '../errors';
import type { StructuredHandoff } from '../handoff/schemas';
import type { StructuredReview } from '../review/findings';
import type { TaskCommitState, TaskRunState, RunState, StoredError } from './run-state';
import { withUpdatedTimestamp } from './run-state';

export interface ResumeTaskObservation {
  readonly processAlive: boolean;
  readonly commit?: TaskCommitState;
  readonly handoff?: StructuredHandoff;
  readonly handoffPath?: string;
  readonly handoffInvalid?: boolean;
  readonly ownershipValid?: boolean;
  readonly writer?: boolean;
  readonly review?: StructuredReview;
  readonly reviewPath?: string;
  readonly finalReview?: boolean;
}

export type ReconciliationAction =
  | 'UNCHANGED'
  | 'RECOVERED_COMMIT'
  | 'RECOVERED_READ_ONLY'
  | 'RECOVERED_REVIEW'
  | 'RETRY_PROCESS_LOSS'
  | 'BLOCKED_MISSING_HANDOFF'
  | 'BLOCKED_INVALID_HANDOFF'
  | 'BLOCKED_OWNERSHIP'
  | 'BLOCKED_BY_HANDOFF'
  | 'FAILED_BY_HANDOFF'
  | 'FAILED_RETRIES_EXHAUSTED';

export interface ReconciliationResult {
  readonly state: RunState;
  readonly actions: Readonly<Record<string, ReconciliationAction>>;
}

export function assertResumeBaseUnmoved(expectedBaseSha: string, actualBaseSha: string): void {
  if (expectedBaseSha !== actualBaseSha) {
    throw new OrchestratorError(
      'BASE_BRANCH_MOVED',
      `Run base moved from ${expectedBaseSha} to ${actualBaseSha}`,
      { details: { expectedBaseSha, actualBaseSha } },
    );
  }
}

function storedError(
  code: StoredError['code'],
  message: string,
  timestamp: string,
): StoredError {
  return { code, message, at: timestamp };
}

/**
 * Reconcile tasks left RUNNING by a crash. A commit is accepted only with a
 * valid complete handoff and successful ownership validation; ambiguous work is
 * stopped for inspection rather than silently rerun.
 */
export function reconcileInterruptedTasks(
  state: RunState,
  observations: Readonly<Record<string, ResumeTaskObservation>>,
  options: { readonly agentRetries: number; readonly clock?: () => Date },
): ReconciliationResult {
  const timestamp = (options.clock ?? (() => new Date()))().toISOString();
  const actions: Record<string, ReconciliationAction> = {};
  const tasks: Record<string, TaskRunState> = { ...state.tasks };
  let runBlocked = false;
  let runFailed = false;

  for (const [taskId, task] of Object.entries(state.tasks)) {
    if (task.status !== 'RUNNING') {
      actions[taskId] = 'UNCHANGED';
      continue;
    }
    const observation = observations[taskId];
    if (observation?.processAlive === true) {
      actions[taskId] = 'UNCHANGED';
      continue;
    }

    let next: TaskRunState;
    let action: ReconciliationAction;
    if (
      observation?.ownershipValid === false ||
      (observation?.commit !== undefined && observation.ownershipValid !== true)
    ) {
      next = {
        ...task,
        status: 'BLOCKED',
        finishedAt: timestamp,
        error: storedError(
          'OWNERSHIP_VIOLATION',
          observation?.ownershipValid === false
            ? 'Recovered task commit violates declared ownership'
            : 'Recovered task commit has not passed ownership validation',
          timestamp,
        ),
      };
      action = 'BLOCKED_OWNERSHIP';
      runBlocked = true;
    } else if (observation?.handoffInvalid === true) {
      next = {
        ...task,
        status: 'BLOCKED',
        finishedAt: timestamp,
        error: storedError('HANDOFF_INVALID', 'Recovered handoff is invalid', timestamp),
      };
      action = 'BLOCKED_INVALID_HANDOFF';
      runBlocked = true;
    } else if (observation?.review !== undefined) {
      const reviewBlocked = observation.review.status === 'blocked'
        || (observation.finalReview === true && observation.review.status !== 'approved');
      next = {
        ...task,
        status: reviewBlocked ? 'BLOCKED' : 'SUCCEEDED',
        reviewRounds: task.reviewRounds + 1,
        ...(observation.reviewPath === undefined
          ? {}
          : { reviewPaths: [...task.reviewPaths, observation.reviewPath] }),
        finishedAt: timestamp,
        ...(reviewBlocked
          ? {
              error: storedError(
                observation.finalReview === true
                  ? 'BLOCKED_FOR_HUMAN_REVIEW'
                  : 'REVIEW_BLOCKED',
                'Recovered review still requires human or correction work',
                timestamp,
              ),
            }
          : {}),
      };
      action = reviewBlocked ? 'BLOCKED_BY_HANDOFF' : 'RECOVERED_REVIEW';
      runBlocked ||= reviewBlocked;
    } else if (observation?.handoff?.status === 'blocked') {
      next = {
        ...task,
        status: 'BLOCKED',
        finishedAt: timestamp,
        ...(observation.handoffPath === undefined
          ? {}
          : { handoffPath: observation.handoffPath }),
      };
      action = 'BLOCKED_BY_HANDOFF';
      runBlocked = true;
    } else if (observation?.handoff?.status === 'failed') {
      next = {
        ...task,
        status: 'FAILED',
        finishedAt: timestamp,
        ...(observation.handoffPath === undefined
          ? {}
          : { handoffPath: observation.handoffPath }),
      };
      action = 'FAILED_BY_HANDOFF';
      runFailed = true;
    } else if (observation?.commit !== undefined) {
      if (observation.handoff?.status !== 'complete') {
        next = {
          ...task,
          status: 'BLOCKED',
          commit: observation.commit,
          finishedAt: timestamp,
          error: storedError(
            'HANDOFF_INVALID',
            'Recovered commit has no complete structured handoff',
            timestamp,
          ),
        };
        action = 'BLOCKED_MISSING_HANDOFF';
        runBlocked = true;
      } else {
        next = {
          ...task,
          status: 'SUCCEEDED',
          commit: observation.commit,
          ...(observation.handoffPath === undefined
            ? {}
            : { handoffPath: observation.handoffPath }),
          finishedAt: timestamp,
        };
        action = 'RECOVERED_COMMIT';
      }
    } else if (observation?.writer === false && observation?.handoff?.status === 'complete') {
      next = {
        ...task,
        status: 'SUCCEEDED',
        ...(observation.handoffPath === undefined
          ? {}
          : { handoffPath: observation.handoffPath }),
        finishedAt: timestamp,
      };
      action = 'RECOVERED_READ_ONLY';
    } else if (observation?.handoff?.status === 'complete') {
      next = {
        ...task,
        status: 'BLOCKED',
        ...(observation.handoffPath === undefined
          ? {}
          : { handoffPath: observation.handoffPath }),
        finishedAt: timestamp,
        error: storedError(
          'HANDOFF_INVALID',
          'Recovered complete writer handoff has no task commit',
          timestamp,
        ),
      };
      action = 'BLOCKED_MISSING_HANDOFF';
      runBlocked = true;
    } else {
      const attemptsUsed = task.agentAttempts.length;
      const retryAllowed = attemptsUsed <= options.agentRetries;
      if (retryAllowed) {
        next = {
          ...task,
          status: 'READY',
          error: storedError(
            'AGENT_FAILED',
            'Agent process disappeared without producing a commit',
            timestamp,
          ),
        };
        action = 'RETRY_PROCESS_LOSS';
      } else {
        next = {
          ...task,
          status: 'FAILED',
          finishedAt: timestamp,
          error: storedError(
            'AGENT_FAILED',
            'Agent process disappeared and infrastructure retries are exhausted',
            timestamp,
          ),
        };
        action = 'FAILED_RETRIES_EXHAUSTED';
        runFailed = true;
      }
    }
    tasks[taskId] = next;
    actions[taskId] = action;
  }

  const reconciled: RunState = {
    ...state,
    tasks,
    status: runBlocked ? 'BLOCKED' : runFailed ? 'FAILED' : state.status,
  };
  return {
    state: withUpdatedTimestamp(reconciled, () => new Date(timestamp)),
    actions,
  };
}
