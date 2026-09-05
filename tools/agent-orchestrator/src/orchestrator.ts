import { createHash, randomBytes } from 'node:crypto';
import { mkdir, open, readFile, rename, rm, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import {
  ClaudeAgent,
  CodexAgent,
  parseJsonOrNull,
  readBoundedStdoutText,
  resolveAgentExecutable,
  type Agent,
  type AgentRequest,
  type AgentResult,
  type ExecutableSource,
} from './agents';
import type { PhaseConfig } from './config';
import { OrchestratorError, isOrchestratorError, type ErrorCode } from './errors';
import {
  GitClient,
  WorktreeManager,
  assertBaseBranchUnmoved,
  computeTrackedDiffFingerprint,
  ensureTaskCommit,
  inspectTaskCommits,
  integrateTaskCommits,
  integrationConflictError,
  resolveBaseSha,
  type IntegrationCommit,
  type OwnedWorktree,
} from './git';
import {
  deterministicallyRepairHandoffKeys,
  parseHandoff,
  validateCanonicalFindingResponses,
  validateHandoff,
  writeHandoff,
  type RequiredCanonicalFinding,
  type StructuredHandoff,
} from './handoff';
import { IntegrationGate, canReuseIntegrationPreparation } from './integration/integration-gate';
import {
  hashRecoveryPolicy,
  parseRecoveryPolicyOverlay,
  type RecoveryExecutorConfig,
  type RecoveryPolicyOverlay,
} from './recovery/policy';
import { extractStructuredPayload } from './protocol';
import { parseReview, validateReview, type StructuredReview } from './review/findings';
import {
  StateStore,
  assertResumeBaseUnmoved,
  createRunState,
  reconcileInterruptedTasks,
  withUpdatedTimestamp,
  type AgentAttemptState,
  type AgentFailureRecoveryState,
  type HandoffRepairAttemptRecord,
  type RecoveryPolicySnapshot,
  type RunEventName,
  type RunState,
  type StoredError,
  type TaskCommitState,
  type TaskRunState,
} from './state';
import {
  TaskGraph,
  TaskScheduler,
  assertChangedFileOwnership,
  assertNoParallelOwnershipOverlap,
  assertReviewRoundAllowed,
  matchesOwnershipPattern,
  severityAtLeast,
  validateChangedFileOwnership,
  type AgentName,
  type TaskCondition,
  type TaskSpec,
  type TaskStatus,
} from './tasks';
import { loadAnyPhaseConfig } from './workflow/solver-verifier';
import {
  AdaptiveCoordinator,
  capabilityCatalog,
  isAdaptivePhaseFile,
  loadAdaptivePhaseConfig,
  planAdaptivePhase,
  routeGrantedWork,
  runtimePhaseConfig,
  type AdaptivePhaseConfig,
  type AdaptivePlanResult,
  type AdaptiveEvent,
  type CanonicalFindingAuthorization,
  type WorkRequestDraft,
} from './adaptive';

export interface PlanResult {
  readonly repositoryRoot: string;
  readonly config: PhaseConfig;
  readonly baseSha: string;
  /** Display string per agent: a resolved absolute path, or 'injected-adapter'/'not-required'. */
  readonly agentExecutables: Readonly<Record<'codex' | 'claude', string>>;
  /** §15: how each was found, for plan output. Absent for injected/not-required agents. */
  readonly agentExecutableSources: Readonly<Partial<Record<'codex' | 'claude', ExecutableSource>>>;
  /**
   * §13: the REAL resolved paths only (excludes injected/not-required
   * sentinels) — this is what `AgentOrchestrator.start()` threads into the
   * actual runtime adapters, so plan-time discovery and run-time execution
   * are guaranteed to agree rather than plan merely displaying a path that
   * execution then ignores in favor of a bare command name.
   */
  readonly resolvedAgentExecutables: Readonly<Partial<Record<'codex' | 'claude', string>>>;
  readonly waves: readonly (readonly TaskSpec[])[];
}

export interface OrchestratorOptions {
  readonly repositoryPath: string;
  readonly runsRoot?: string;
  readonly agents?: Partial<Readonly<Record<'codex' | 'claude', Agent>>>;
  readonly git?: GitClient;
  readonly clock?: () => Date;
  readonly signal?: AbortSignal;
}

interface PreparedTask {
  readonly task: TaskSpec;
  readonly worktree: OwnedWorktree;
  readonly preparedHeadSha: string;
  readonly dependencyHandoffs: readonly unknown[];
  readonly previousReviewFindings: readonly unknown[];
  readonly actualDependencyDiff: string;
}

const REVIEW_MODES = new Set(['review', 'synthesis', 'final_review']);
const MAX_AGENT_DIFF_BYTES = 2 * 1024 * 1024;
const INFRASTRUCTURE_FAILURES = new Set(['not_found', 'spawn_error', 'timed_out']);
/** §6: bounded — a repair reformats existing text, it never does real work. */
const HANDOFF_REPAIR_TIMEOUT_MS = 5 * 60 * 1000;

interface HandoffOutcomeRecord {
  readonly outcome: 'valid' | 'invalid';
  readonly repairAttempted: boolean;
  readonly repairRecord?: HandoffRepairAttemptRecord;
}

/**
 * Stable, machine-readable eligibility-failure classification for
 * recover-handoffs, distinct from HandoffRepairAttemptRecord.failureReason
 * (which classifies an execution failure that happened AFTER dispatch).
 * HANDOFF_REPAIR_ALREADY_RESOLVED is deliberately not included: a
 * successful repair always transitions the task out of FAILED, so
 * HANDOFF_TASK_NOT_FAILED already covers that case — there is no reachable
 * branch where a task is still FAILED and its last repair succeeded.
 */
type HandoffRecoveryEligibilityReasonCode =
  | 'HANDOFF_TASK_CONFIG_MISSING'
  | 'HANDOFF_TASK_MODE_MISMATCH'
  | 'HANDOFF_TASK_NOT_FAILED'
  | 'HANDOFF_LAST_ATTEMPT_NOT_SUCCEEDED'
  | 'HANDOFF_COMMIT_ALREADY_RECORDED'
  | 'HANDOFF_WORKTREE_NOT_PRESERVED'
  | 'HANDOFF_WORKTREE_NOT_REGISTERED'
  | 'HANDOFF_WORKTREE_INVALID_DESCENDANT'
  | 'HANDOFF_WORKTREE_HEAD_MOVED'
  | 'HANDOFF_WORKTREE_HAS_FOREIGN_COMMITS'
  | 'HANDOFF_ORIGINAL_LOG_MISSING'
  | 'HANDOFF_REPAIR_BUDGET_EXHAUSTED';

/** Stable, machine-readable eligibility-failure classification for salvage-task — same pattern as HandoffRecoveryEligibilityReasonCode. */
type SalvageEligibilityReasonCode =
  | 'SALVAGE_NOT_TIMED_OUT'
  | 'SALVAGE_COMMIT_ALREADY_RECORDED'
  | 'SALVAGE_WORKTREE_NOT_REGISTERED'
  | 'SALVAGE_WORKTREE_HEAD_MOVED'
  | 'SALVAGE_WORKTREE_HAS_FOREIGN_COMMITS'
  | 'SALVAGE_WORKTREE_CLEAN'
  | 'SALVAGE_OWNERSHIP_VIOLATION'
  | 'SALVAGE_UNEXPECTED_UNTRACKED_FILE'
  | 'SALVAGE_DIFF_CHECK_FAILED'
  | 'SALVAGE_ALREADY_INTEGRATED'
  | 'SALVAGE_DEPENDENCY_UNSATISFIED';

type HandoffRepairMethod = 'framing' | 'deterministic' | 'agent';
type HandoffRepairFailureReason =
  | 'agent_invocation_failed'
  | 'evidence_insufficient'
  | 'contradiction_detected'
  | 'no_eligible_recovery_executor';
type RepairOutcome =
  | {
      readonly ok: true;
      readonly handoff: StructuredHandoff;
      readonly method: HandoffRepairMethod;
      /** Present only for method: 'agent' — see resolveHandoffRepairExecutor. */
      readonly executorId?: string;
      readonly adapter?: AgentName;
    }
  | { readonly ok: false; readonly reason: HandoffRepairFailureReason };

/** Result of recoverHandoffFailures: which persisted FAILED tasks were actually recovered, and why any others were left untouched. */
export interface HandoffRecoveryResult {
  readonly orchestrator: AgentOrchestrator;
  readonly recovered: readonly string[];
  readonly skipped: readonly { readonly taskId: string; readonly reason: string }[];
}

/** Result of an explicit process-layer retry authorization. No agent is run by this operation. */
export interface AgentFailureRetryResult {
  readonly orchestrator: AgentOrchestrator;
  readonly taskId: string;
  readonly recovery: AgentFailureRecoveryState;
  readonly reopenedTasks: readonly string[];
}

/** Result of AgentOrchestrator.salvageTask. */
export interface SalvageResult {
  readonly orchestrator: AgentOrchestrator;
  readonly taskId: string;
  readonly commitSha: string;
}

/** Result of AgentOrchestrator.authorizeRecoveryPolicy. */
export interface RecoveryPolicyAuthorizationResult {
  readonly orchestrator: AgentOrchestrator;
  readonly policyHash: string;
}

export async function planPhase(
  phaseFile: string,
  options: OrchestratorOptions,
): Promise<PlanResult> {
  const config = await loadAnyPhaseConfig(resolve(phaseFile));
  const git = options.git ?? new GitClient();
  const repositoryRoot = await git.repositoryRoot(resolve(options.repositoryPath));
  const baseSha = await resolveBaseSha(git, repositoryRoot, config.baseBranch);
  assertNoParallelOwnershipOverlap(config.tasks);

  const requiredAgents = new Set(config.tasks.map((task) => task.owner));
  if (config.tasks.some((task) => task.mode === 'debate')) {
    requiredAgents.add('codex');
    requiredAgents.add('claude');
  }

  const executables: Partial<Record<'codex' | 'claude', string>> = {};
  const sources: Partial<Record<'codex' | 'claude', ExecutableSource>> = {};
  const resolvedExecutables: Partial<Record<'codex' | 'claude', string>> = {};

  const resolveOne = async (agent: 'codex' | 'claude'): Promise<void> => {
    if (agent in executables) return;
    if (options.agents?.[agent] !== undefined) {
      executables[agent] = 'injected-adapter';
      return;
    }
    const resolution = await resolveAgentExecutable(agent);
    if (resolution === null) {
      executables[agent] = 'not-required';
      return;
    }
    executables[agent] = resolution.path;
    sources[agent] = resolution.source;
    resolvedExecutables[agent] = resolution.path;
  };

  for (const agent of requiredAgents) {
    if (options.agents?.[agent] !== undefined) {
      executables[agent] = 'injected-adapter';
      continue;
    }
    const resolution = await resolveAgentExecutable(agent);
    if (resolution === null) {
      throw new OrchestratorError('AGENT_NOT_FOUND', `Required agent executable not found: ${agent}`, {
        details: { agent },
      });
    }
    executables[agent] = resolution.path;
    sources[agent] = resolution.source;
    resolvedExecutables[agent] = resolution.path;
  }
  // Keep the result shape stable even for an agent no task in this phase
  // actually requires — resolved on a best-effort basis (never throws) so
  // `agents:plan` output is complete without over-constraining phases that
  // only use one agent.
  await resolveOne('codex');
  await resolveOne('claude');

  return {
    repositoryRoot,
    config,
    baseSha,
    agentExecutables: executables as Record<'codex' | 'claude', string>,
    agentExecutableSources: sources,
    resolvedAgentExecutables: resolvedExecutables,
    waves: new TaskGraph(config.tasks).executionWaves(config.concurrency),
  };
}

export type AnyPlanResult = PlanResult | AdaptivePlanResult;

/** Strategy dispatcher. Static planning remains the original default and code path. */
export async function planOrchestrationPhase(
  phaseFile: string,
  options: OrchestratorOptions,
): Promise<AnyPlanResult> {
  return await isAdaptivePhaseFile(resolve(phaseFile))
    ? planAdaptivePhase(phaseFile, options)
    : planPhase(phaseFile, options);
}

export class AgentOrchestrator {
  config: PhaseConfig;
  readonly repositoryRoot: string;
  readonly runsRoot: string;
  readonly stateStore: StateStore;

  private state: RunState;
  private readonly git: GitClient;
  private readonly worktrees: WorktreeManager;
  private readonly agents: Readonly<Record<'codex' | 'claude', Agent>>;
  private readonly clock: () => Date;
  private readonly signal: AbortSignal | undefined;
  private readonly adaptiveConfig: AdaptivePhaseConfig | undefined;
  /** Resolved solely from the most recently authorized recovery-policy overlay — see loadRunForContinuation and resolveHandoffRepairExecutor. */
  private readonly recoveryExecutors: readonly RecoveryExecutorConfig[] | undefined;
  private stateQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    readonly config: PhaseConfig;
    readonly repositoryRoot: string;
    readonly runsRoot: string;
    readonly stateStore: StateStore;
    readonly state: RunState;
    readonly git: GitClient;
    readonly worktrees: WorktreeManager;
    readonly agents: Readonly<Record<'codex' | 'claude', Agent>>;
    readonly clock: () => Date;
    readonly signal?: AbortSignal;
    readonly adaptiveConfig?: AdaptivePhaseConfig;
    readonly recoveryExecutors?: readonly RecoveryExecutorConfig[];
  }) {
    this.config = options.config;
    this.repositoryRoot = options.repositoryRoot;
    this.runsRoot = options.runsRoot;
    this.stateStore = options.stateStore;
    this.state = options.state;
    this.git = options.git;
    this.worktrees = options.worktrees;
    this.agents = options.agents;
    this.clock = options.clock;
    this.signal = options.signal;
    this.adaptiveConfig = options.adaptiveConfig;
    this.recoveryExecutors = options.recoveryExecutors;
  }

  static async start(phaseFile: string, options: OrchestratorOptions): Promise<AgentOrchestrator> {
    if (await isAdaptivePhaseFile(resolve(phaseFile))) {
      return AgentOrchestrator.startAdaptive(phaseFile, options);
    }
    const plan = await planPhase(phaseFile, options);
    const git = options.git ?? new GitClient();
    const runsRoot = resolve(
      options.runsRoot ?? join(plan.repositoryRoot, 'tools/agent-orchestrator/runs'),
    );
    const runId = createRunId(options.clock);
    const stateStore = new StateStore(runsRoot, runId);
    const state = createRunState({
      runId,
      phase: plan.config.phase,
      repositoryRoot: plan.repositoryRoot,
      baseBranch: plan.config.baseBranch,
      baseSha: plan.baseSha,
      tasks: plan.config.tasks,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(Object.keys(plan.resolvedAgentExecutables).length === 0
        ? {}
        : { agentExecutables: plan.resolvedAgentExecutables }),
    });
    await stateStore.initialize(state);
    await copyPhaseSnapshot(resolve(phaseFile), join(stateStore.runDirectory, 'phase.yaml'));
    const orchestrator = new AgentOrchestrator({
      config: plan.config,
      repositoryRoot: plan.repositoryRoot,
      runsRoot,
      stateStore,
      state,
      git,
      worktrees: await WorktreeManager.create({
        repositoryPath: plan.repositoryRoot,
        git,
      }),
      // §13: the SAME resolved paths just validated by planPhase, not a
      // fresh re-resolution — this is the plan/runtime agreement itself.
      agents: createAgents(options.agents, plan.resolvedAgentExecutables),
      clock: options.clock ?? (() => new Date()),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await orchestrator.event('RUN_CREATED', undefined, {
      phase: plan.config.phase,
      baseBranch: plan.config.baseBranch,
      baseSha: plan.baseSha,
    });
    for (const task of Object.values(state.tasks).filter(({ status }) => status === 'READY')) {
      await orchestrator.event('TASK_READY', task.id);
    }
    await orchestrator.mutate((current) => ({ ...current, status: 'RUNNING' }));
    return orchestrator;
  }

  private static async startAdaptive(
    phaseFile: string,
    options: OrchestratorOptions,
  ): Promise<AgentOrchestrator> {
    const plan = await planAdaptivePhase(phaseFile, options);
    const clock = options.clock ?? (() => new Date());
    const coordinator = new AdaptiveCoordinator(plan.preview, capabilityCatalog(plan.config), { now: clock });
    routeGrantedWork(coordinator, plan.config);
    const adaptive = coordinator.snapshot();
    const config = runtimePhaseConfig(plan.config, adaptive);
    const resolved = await resolveRequiredAgentExecutables(
      plan.config.executors.filter((executor) => executor.available).map((executor) => executor.adapter),
      options.agents,
    );
    const git = options.git ?? new GitClient();
    const runsRoot = resolve(options.runsRoot ?? join(plan.repositoryRoot, 'tools/agent-orchestrator/runs'));
    const runId = createRunId(options.clock);
    const stateStore = new StateStore(runsRoot, runId);
    const state = createRunState({
      runId,
      phase: config.phase,
      repositoryRoot: plan.repositoryRoot,
      baseBranch: config.baseBranch,
      baseSha: plan.baseSha,
      tasks: config.tasks,
      strategy: 'adaptive',
      adaptive,
      ...(options.clock === undefined ? {} : { clock: options.clock }),
      ...(Object.keys(resolved).length === 0 ? {} : { agentExecutables: resolved }),
    });
    // State and complete topology are durable before the first agent can launch.
    await stateStore.initialize(state);
    await copyPhaseSnapshot(resolve(phaseFile), join(stateStore.runDirectory, 'phase.yaml'));
    const orchestrator = new AgentOrchestrator({
      config,
      adaptiveConfig: plan.config,
      repositoryRoot: plan.repositoryRoot,
      runsRoot,
      stateStore,
      state,
      git,
      worktrees: await WorktreeManager.create({ repositoryPath: plan.repositoryRoot, git }),
      agents: createAgents(options.agents, resolved),
      clock,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await orchestrator.event('RUN_CREATED', undefined, {
      phase: config.phase, baseBranch: config.baseBranch, baseSha: plan.baseSha, strategy: 'adaptive',
    });
    await orchestrator.emitNewAdaptiveEvents(0);
    for (const task of Object.values(state.tasks).filter(({ status }) => status === 'READY')) {
      await orchestrator.event('ADAPTIVE_WORK_UNIT_READY', task.id, { adaptive: true });
      await orchestrator.event('TASK_READY', task.id);
    }
    await orchestrator.mutate((current) => ({ ...current, status: 'RUNNING' }));
    return orchestrator;
  }

  /**
   * Shared load/validate/construct path for anything that continues an
   * existing run (resume() for interrupted RUNNING tasks; recoverHandoffFailures()
   * for a run whose top-level status already went terminal). Deliberately
   * does not call reconcile() or emit RUN_RESUMED itself — those are specific
   * to the two distinct continuation modes above it, not to this shared step.
   */
  private static async loadRunForContinuation(
    runId: string,
    options: OrchestratorOptions,
  ): Promise<AgentOrchestrator> {
    const git = options.git ?? new GitClient();
    const repositoryRoot = await git.repositoryRoot(resolve(options.repositoryPath));
    const runsRoot = resolve(
      options.runsRoot ?? join(repositoryRoot, 'tools/agent-orchestrator/runs'),
    );
    const stateStore = new StateStore(runsRoot, runId);
    const state = await stateStore.load();
    if (state.repositoryRoot !== repositoryRoot) {
      throw new OrchestratorError('STATE_CORRUPT', 'Run belongs to a different repository', {
        details: { expected: state.repositoryRoot, actual: repositoryRoot },
      });
    }
    const phaseSnapshot = join(stateStore.runDirectory, 'phase.yaml');
    let adaptiveConfig: AdaptivePhaseConfig | undefined;
    let config: PhaseConfig;
    let loadedState = state;
    if (state.strategy === 'adaptive') {
      adaptiveConfig = await loadAdaptivePhaseConfig(phaseSnapshot);
      if (state.adaptive === undefined) {
        throw new OrchestratorError('STATE_CORRUPT', 'Adaptive run has no persisted topology');
      }
      const coordinator = new AdaptiveCoordinator(
        state.adaptive,
        capabilityCatalog(adaptiveConfig),
        { now: options.clock ?? (() => new Date()) },
      );
      // Crash-safe completion of a grant that was persisted immediately before routing.
      routeGrantedWork(coordinator, adaptiveConfig);
      let adaptive = coordinator.snapshot();
      config = runtimePhaseConfig(adaptiveConfig, adaptive);
      const tasks = { ...state.tasks };
      for (const spec of config.tasks) {
        if (tasks[spec.id] !== undefined) continue;
        tasks[spec.id] = {
          id: spec.id,
          status: spec.dependsOn.every((id) => tasks[id]?.status === 'SUCCEEDED' || tasks[id]?.status === 'SKIPPED') ? 'READY' : 'PENDING',
          agentAttempts: [], reviewRounds: 0, reviewPaths: [], handoffRepairAttempts: [],
        };
      }
      // Heal the narrow crash window between the existing task-state commit
      // and its mirrored adaptive lifecycle update. No task or request is
      // recreated; only the already-persisted unit receives the same terminal fact.
      for (const unit of coordinator.snapshot().workUnits) {
        if (!['GRANTED', 'RUNNING'].includes(unit.status)) continue;
        const task = tasks[unit.id];
        if (task?.status === 'SUCCEEDED') coordinator.finish(unit.id, 'SUCCEEDED');
        else if (task?.status === 'SKIPPED') coordinator.finish(unit.id, 'SKIPPED');
        else if (task?.status === 'FAILED' || task?.status === 'BLOCKED') {
          coordinator.finish(unit.id, task.error?.code === 'AGENT_TIMEOUT' ? 'TIMED_OUT' : 'FAILED', {
            error: task.error?.message ?? `Recovered terminal task state ${task.status}`,
          });
        }
      }
      adaptive = coordinator.snapshot();
      config = runtimePhaseConfig(adaptiveConfig, adaptive);
      loadedState = withUpdatedTimestamp({ ...state, adaptive, tasks }, options.clock);
      await stateStore.save(loadedState);
    } else {
      config = await loadAnyPhaseConfig(phaseSnapshot);
    }
    if (config.baseBranch !== loadedState.baseBranch) {
      throw new OrchestratorError('STATE_CORRUPT', 'Stored phase base branch differs from run state');
    }
    const actualBaseSha = await resolveBaseSha(git, repositoryRoot, loadedState.baseBranch);
    // §9: this is the same immutable-base check resume() has always made —
    // recovery must refuse just as loudly as a normal resume would if
    // phase5/explorer (or any other run's base branch) moved underneath it.
    assertResumeBaseUnmoved(loadedState.baseSha, actualBaseSha);
    // The most recently authorized recovery-policy snapshot (if any) is
    // applied here, at every load — never by editing the immutable
    // phase.yaml snapshot on disk. salvage.verify, when the overlay
    // supplies it, replaces the phase's own entirely for the duration of
    // this load; recovery executors are resolved solely from the overlay
    // (see resolveHandoffRepairExecutor) since no adaptive role is ever
    // 'handoff_repair'. A run that has never had a policy authorized
    // behaves exactly as before — recoveryPolicyHistory is simply absent.
    const latestRecoveryPolicy = loadedState.recoveryPolicyHistory?.at(-1)?.policy;
    if (latestRecoveryPolicy?.salvage !== undefined) {
      config = { ...config, salvage: latestRecoveryPolicy.salvage };
    }
    return new AgentOrchestrator({
      config,
      repositoryRoot,
      runsRoot,
      stateStore,
      state: loadedState,
      git,
      worktrees: await WorktreeManager.create({ repositoryPath: repositoryRoot, git }),
      // §7/§13: deliberately NOT a fresh planPhase/resolveAgentExecutable
      // call. Re-resolving here would let PATH, CODEX_EXECUTABLE, or which
      // VS Code extension version is newest change between the original run
      // and a resume — the persisted state.agentExecutables (written once,
      // at start()) is what start() itself validated against, so resume
      // stays bound to that exact same binary even if the environment moved
      // on. A run persisted before this field existed has no recorded path
      // (agentExecutables undefined) and falls back to createAgents'/each
      // adapter's own bare command-name default, matching this orchestrator's
      // pre-existing behavior for that older state shape.
      agents: createAgents(options.agents, loadedState.agentExecutables ?? {}),
      clock: options.clock ?? (() => new Date()),
      ...(adaptiveConfig === undefined ? {} : { adaptiveConfig }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(latestRecoveryPolicy?.executors === undefined ? {} : { recoveryExecutors: latestRecoveryPolicy.executors }),
    });
  }

  static async resume(runId: string, options: OrchestratorOptions): Promise<AgentOrchestrator> {
    const orchestrator = await AgentOrchestrator.loadRunForContinuation(runId, options);
    await orchestrator.reconcile();
    await orchestrator.event('RUN_RESUMED');
    return orchestrator;
  }

  /**
   * Explicitly authorizes one more attempt for a task that failed before any
   * structured output was accepted. This is deliberately separate from
   * resume/reconciliation, structured-output recovery, and integration-gate
   * recovery: the command only changes persisted scheduler state. A later
   * normal resume performs the actual agent invocation.
   */
  static async retryAgentFailure(
    runId: string,
    taskId: string,
    options: OrchestratorOptions,
  ): Promise<AgentFailureRetryResult> {
    const orchestrator = await AgentOrchestrator.loadRunForContinuation(runId, options);
    const checked = await orchestrator.checkAgentFailureRetryEligibility(taskId);
    if (!checked.eligible) {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Refusing agent retry for ${taskId}: ${checked.reason}`,
        { details: { runId, taskId, reason: checked.reason } },
      );
    }

    const previous = orchestrator.state.tasks[taskId]!;
    const previousRunStatus = orchestrator.state.status as 'FAILED' | 'BLOCKED';
    const lastAttempt = previous.agentAttempts.at(-1)!;
    const reopenedTasks = orchestrator.dependencyOnlyDescendantsToReopen(taskId);
    const recovery: AgentFailureRecoveryState = {
      recovery: (previous.agentFailureRecoveries?.length ?? 0) + 1,
      authorizedAt: orchestrator.clock().toISOString(),
      previousRunStatus,
      previousTaskStatus: 'FAILED',
      error: previous.error!,
      attempt: lastAttempt,
      reopenedTaskIds: reopenedTasks,
    };

    const reopenState = (state: RunState): RunState => {
      const target = state.tasks[taskId]!;
      const {
        error: _previousError,
        finishedAt: _previousFinishedAt,
        startedAt: _previousStartedAt,
        skipReason: _previousSkipReason,
        ...retryableTarget
      } = target;
      const tasks: Record<string, TaskRunState> = {
        ...state.tasks,
        [taskId]: {
          ...retryableTarget,
          status: 'READY',
          agentFailureRecoveries: [
            ...(target.agentFailureRecoveries ?? []),
            recovery,
          ],
        },
      };
      for (const reopenedTaskId of reopenedTasks) {
        const blocked = state.tasks[reopenedTaskId]!;
        const {
          error: _dependencyError,
          finishedAt: _dependencyFinishedAt,
          ...waitingTask
        } = blocked;
        tasks[reopenedTaskId] = { ...waitingTask, status: 'PENDING' };
      }
      return { ...state, status: 'RUNNING', tasks };
    };
    if (orchestrator.state.strategy === 'adaptive') {
      await orchestrator.authorizeAdaptiveRetry(
        taskId,
        recovery.error.code === 'AGENT_TIMEOUT',
        recovery.error.message,
        reopenState,
      );
    } else {
      await orchestrator.mutate(reopenState);
    }

    await orchestrator.event('AGENT_RETRY_AUTHORIZED', taskId, {
      recovery: recovery.recovery,
      failedAttempt: lastAttempt.attempt,
      errorCode: recovery.error.code,
      agent: lastAttempt.agent,
    });
    for (const reopenedTaskId of reopenedTasks) {
      await orchestrator.event('TASK_DEPENDENCY_REOPENED', reopenedTaskId, {
        recoveredDependency: taskId,
      });
    }
    await orchestrator.event('RUN_RESUMED', undefined, {
      recoveryMode: 'agent_failure_retry',
      taskId,
      reopenedTasks,
    });
    return { orchestrator, taskId, recovery, reopenedTasks };
  }

  /**
   * §8/§10/§15 (real Phase 5 dogfood recovery): explicit, narrow recovery for
   * a run whose top-level status already went terminal (FAILED) because one
   * or more tasks failed with HANDOFF_INVALID after their agent PROCESS
   * itself succeeded. Never reruns the original implementation, never
   * touches the original worktree's tracked contents, and never makes an
   * arbitrary FAILED task retryable — see checkHandoffRecoveryEligibility for
   * every invariant a task must meet first.
   *
   * All-or-nothing by design: eligibility for every HANDOFF_INVALID/FAILED
   * task is checked BEFORE any state is mutated. If even one fails an
   * invariant, this throws without recovering ANY task — "stop and require
   * human review" means exactly that, not a partial silent recovery that
   * could leave the run in a confusing mixed state.
   */
  /**
   * Authorizes a recovery-only policy overlay for a historical run without
   * ever editing its immutable phase.yaml snapshot. Validates and normalizes
   * the raw policy, hashes the normalized representation (never raw YAML
   * bytes — see hashRecoveryPolicy), and appends one immutable snapshot to
   * recoveryPolicyHistory. Deliberately request -> grant, never request ->
   * execute: this method invokes no agent, salvages no work, repairs no
   * handoff, creates no task commit, and does not resume the run — it only
   * authorizes and persists policy. A later agents:recover-handoffs or
   * agents:salvage-task call picks up the most recently authorized snapshot
   * the next time the run is loaded.
   */
  static async authorizeRecoveryPolicy(
    runId: string,
    rawPolicy: unknown,
    options: OrchestratorOptions,
  ): Promise<RecoveryPolicyAuthorizationResult> {
    const orchestrator = await AgentOrchestrator.loadRunForContinuation(runId, options);
    const policy = parseRecoveryPolicyOverlay(rawPolicy);
    const policyHash = hashRecoveryPolicy(policy);
    const snapshot: RecoveryPolicySnapshot = {
      authorizedAt: orchestrator.clock().toISOString(),
      policyHash,
      policy,
    };
    await orchestrator.mutate((state) => ({
      ...state,
      recoveryPolicyHistory: [...(state.recoveryPolicyHistory ?? []), snapshot],
    }));
    await orchestrator.event('RECOVERY_POLICY_AUTHORIZED', undefined, { policyHash });
    return { orchestrator, policyHash };
  }

  static async recoverHandoffFailures(
    runId: string,
    options: OrchestratorOptions,
  ): Promise<HandoffRecoveryResult> {
    const orchestrator = await AgentOrchestrator.loadRunForContinuation(runId, options);

    // §12 (second real dogfood finding): a FAILED review/final_review task
    // is recoverable the same way, under the review-specific error code
    // REVIEW_BLOCKED — but ONLY when it is a review-mode task, so a
    // superficially-similar debate-mode failure (which can also use
    // REVIEW_BLOCKED, see executeDebate) is never mistaken for one.
    type Kind = 'handoff' | 'review';
    const candidatesOf = (kind: Kind, errorCode: 'HANDOFF_INVALID' | 'REVIEW_BLOCKED') =>
      Object.values(orchestrator.state.tasks)
        .filter((taskState) => taskState.status === 'FAILED' && taskState.error?.code === errorCode)
        .map((taskState) => ({ taskState, kind }));
    const allCandidates = [
      ...candidatesOf('handoff', 'HANDOFF_INVALID'),
      ...candidatesOf('review', 'REVIEW_BLOCKED'),
    ];

    const checked = await Promise.all(
      allCandidates.map(async ({ taskState, kind }) => {
        const task = orchestrator.config.tasks.find((spec) => spec.id === taskState.id);
        if (task === undefined) {
          return {
            taskState,
            task: undefined,
            kind,
            check: {
              eligible: false,
              reason: 'task id not found in the loaded phase config',
              reasonCode: 'HANDOFF_TASK_CONFIG_MISSING' as const,
            },
          };
        }
        if (kind === 'review' && !REVIEW_MODES.has(task.mode)) {
          return {
            taskState,
            task,
            kind,
            check: {
              eligible: false,
              reason: `mode ${task.mode} is not a review/final_review task`,
              reasonCode: 'HANDOFF_TASK_MODE_MISMATCH' as const,
            },
          };
        }
        const check = await orchestrator.checkStructuredOutputRecoveryEligibility(
          taskState,
          kind === 'handoff' ? 'HANDOFF_INVALID' : 'REVIEW_BLOCKED',
        );
        return { taskState, task, kind, check };
      }),
    );
    const ineligible = checked.filter((entry) => !entry.check.eligible);
    if (ineligible.length > 0) {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Refusing structured-output recovery: ${ineligible.length} task(s) failed an eligibility invariant`,
        {
          details: {
            ineligible: ineligible.map((entry) => ({
              taskId: entry.taskState.id,
              reason: entry.check.reason,
              reasonCode: entry.check.reasonCode,
            })),
          },
        },
      );
    }

    const recovered: string[] = [];
    for (const entry of checked) {
      if (entry.kind === 'handoff') {
        await orchestrator.recoverHandoffInvalidTask(entry.task!, entry.taskState);
      } else {
        await orchestrator.recoverReviewBlockedTask(entry.task!, entry.taskState);
      }
      recovered.push(entry.taskState.id);
    }
    const unblocked = await orchestrator.unblockDependencyOnlyFailures();
    if (recovered.length > 0) {
      await orchestrator.mutate((current) =>
        current.status === 'FAILED' ? { ...current, status: 'RUNNING' } : current,
      );
    }
    await orchestrator.event('RUN_RESUMED', undefined, {
      recoveryMode: 'handoff_repair',
      recoveredTasks: recovered,
      unblockedTasks: unblocked,
    });
    return { orchestrator, recovered, skipped: [] };
  }

  /**
   * §7 (real Phase 5 dogfood recovery, run-20260822094645-5b090308): a
   * narrowly-scoped retry of ONLY the deterministic integration gate for a
   * run whose top-level status is BLOCKED specifically because
   * INTEGRATION_TEST_FAILED — never for any other reason (an
   * INTEGRATION_CONFLICT needing real human conflict resolution, or a
   * task-level BLOCKED_FOR_HUMAN_REVIEW, are both left untouched). No task
   * transitions back to RUNNING, no agent is invoked, and no worktree is
   * recreated: integrateAndVerify() already re-validates that the existing
   * integration worktree still matches its persisted headSha checkpoint
   * before re-running the gate, so all this does is archive the failed
   * attempt (so it is never silently overwritten) and unblock the run's own
   * top-level status so its existing execute() loop naturally re-enters
   * integrateAndVerify() on the next call.
   */
  static async retryIntegrationGate(
    runId: string,
    options: OrchestratorOptions,
  ): Promise<AgentOrchestrator> {
    const orchestrator = await AgentOrchestrator.loadRunForContinuation(runId, options);
    const state = orchestrator.state;
    if (state.status !== 'BLOCKED') {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Refusing integration retry: run status is ${state.status}, not BLOCKED`,
      );
    }
    if (state.integration.error?.code !== 'INTEGRATION_TEST_FAILED'
      && state.integration.error?.code !== 'INTEGRATION_PREPARATION_FAILED') {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Refusing integration retry: integration.error.code is ${state.integration.error?.code ?? 'undefined'}, not INTEGRATION_TEST_FAILED or INTEGRATION_PREPARATION_FAILED`,
      );
    }
    const nonTerminalTasks = Object.values(state.tasks).filter(
      (task) => task.status !== 'SUCCEEDED' && task.status !== 'SKIPPED',
    );
    if (nonTerminalTasks.length > 0) {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Refusing integration retry: ${nonTerminalTasks.length} task(s) are not SUCCEEDED/SKIPPED`,
        {
          details: {
            tasks: nonTerminalTasks.map((task) => ({ id: task.id, status: task.status })),
          },
        },
      );
    }
    if (state.integration.worktreePath === undefined || state.integration.headSha === undefined) {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        'Refusing integration retry: no preserved integration worktree/checkpoint recorded',
      );
    }

    await orchestrator.archiveIntegrationAttempt();
    await orchestrator.mutate((current) => {
      const { error: _archivedError, ...integration } = current.integration;
      return { ...current, status: 'RUNNING', integration: { ...integration, status: 'RUNNING' } };
    });
    await orchestrator.event('RUN_RESUMED', undefined, { recoveryMode: 'integration_retry' });
    return orchestrator;
  }

  /**
   * Moves the current (about-to-be-retried) integration log directory aside
   * under an attempt-numbered name, and archives the current `integration`
   * snapshot into `integrationAttempts` — both BEFORE anything is reset, so
   * the original failing command output and the original blocked state
   * remain genuinely inspectable rather than overwritten in place by the
   * next attempt's identically-named log files.
   */
  private async archiveIntegrationAttempt(): Promise<void> {
    const attemptNumber = (this.state.integrationAttempts?.length ?? 0) + 1;
    const currentLogsDirectory = join(this.stateStore.runDirectory, 'logs', 'integration');
    const archivedLogsDirectory = join(
      this.stateStore.runDirectory,
      'logs',
      `integration-attempt-${attemptNumber}`,
    );
    try {
      await rename(currentLogsDirectory, archivedLogsDirectory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
    await this.mutate((state) => ({
      ...state,
      integrationAttempts: [...(state.integrationAttempts ?? []), state.integration],
    }));
  }

  /**
   * §8 (real Phase 5 dogfood recovery, THIRD structural finding): applies a
   * narrow, explicitly-scoped source correction directly in the existing
   * integration worktree after a real INTEGRATION_TEST_FAILED — used when
   * the integrated source itself (not a build-order/protocol problem) needs
   * a small fix, e.g. a test-fixture defect the adversarial review never
   * exercised. This never reruns or rewrites a completed task: it commits
   * ONLY on top of the existing integration worktree/headSha, exactly like
   * ensureTaskCommit already does for a normal task, reusing the same
   * ownership enforcement. The previous integration attempt is archived
   * first (same mechanism as retryIntegrationGate), so the failing state
   * this fix responds to remains genuinely inspectable.
   */
  static async applyIntegrationFix(
    runId: string,
    options: OrchestratorOptions,
    fix: { readonly ownership: readonly string[]; readonly summary: string },
  ): Promise<AgentOrchestrator> {
    const orchestrator = await AgentOrchestrator.loadRunForContinuation(runId, options);
    const state = orchestrator.state;
    if (state.status !== 'BLOCKED') {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Refusing integration fix: run status is ${state.status}, not BLOCKED`,
      );
    }
    if (state.integration.error?.code !== 'INTEGRATION_TEST_FAILED') {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Refusing integration fix: integration.error.code is ${state.integration.error?.code ?? 'undefined'}, not INTEGRATION_TEST_FAILED`,
      );
    }
    const nonTerminalTasks = Object.values(state.tasks).filter(
      (task) => task.status !== 'SUCCEEDED' && task.status !== 'SKIPPED',
    );
    if (nonTerminalTasks.length > 0) {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Refusing integration fix: ${nonTerminalTasks.length} task(s) are not SUCCEEDED/SKIPPED`,
      );
    }
    if (state.integration.worktreePath === undefined || state.integration.headSha === undefined) {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        'Refusing integration fix: no preserved integration worktree/checkpoint recorded',
      );
    }
    if (fix.ownership.length === 0) {
      throw new OrchestratorError('CONFIG_INVALID', 'Refusing integration fix: no ownership globs supplied');
    }

    const worktree = await orchestrator.worktrees.assertRegistered(state.integration.worktreePath);
    const previousHeadSha = state.integration.headSha;
    const ensured = await ensureTaskCommit(orchestrator.git, {
      worktreePath: worktree.path,
      baseSha: previousHeadSha,
      agent: 'human',
      taskId: 'integration-fix',
      summary: fix.summary,
    });
    // Same ownership enforcement every task commit already goes through —
    // an integration fix is not exempt merely because it is a fix.
    assertChangedFileOwnership('integration-fix', ensured.changedFiles, fix.ownership);
    assertNoSmuggledSchemaOrDependencyChange(ensured.changedFiles);

    await orchestrator.archiveIntegrationAttempt();
    await orchestrator.mutate((current) => {
      const { error: _previousError, ...withoutError } = current.integration;
      return {
        ...current,
        status: 'RUNNING',
        integration: {
          ...withoutError,
          status: 'RUNNING',
          headSha: ensured.commitSha,
          integrationFixCommits: [...(current.integration.integrationFixCommits ?? []), ensured.commitSha],
        },
      };
    });
    await orchestrator.event('INTEGRATION_FIX_APPLIED', undefined, {
      commitSha: ensured.commitSha,
      previousHeadSha,
      changedFiles: ensured.changedFiles,
      summary: fix.summary,
    });
    return orchestrator;
  }

  /**
   * Salvages useful work a timed-out writer left behind in its dirty
   * worktree. A dirty diff is only evidence, never success on its own:
   * eligibility (ownership/foreign-commit/diff-check-clean) -> deterministic
   * salvage.verify (never trusting operator prose) -> a diff/config-bound
   * SALVAGE_VERIFIED checkpoint -> the Orchestrator (never salvage code
   * itself) creates the commit via the same ensureTaskCommit/
   * assertChangedFileOwnership path applyIntegrationFix already uses. No
   * canonical-finding handling yet at this step (see the follow-up task
   * that adds it) — a task with no required canonical findings goes
   * straight from a passing verification to a synthesized handoff and
   * succeedTask, exactly like any other task completion.
   */
  static async salvageTask(
    runId: string,
    taskId: string,
    options: OrchestratorOptions,
  ): Promise<SalvageResult> {
    const orchestrator = await AgentOrchestrator.loadRunForContinuation(runId, options);
    const checked = await orchestrator.checkSalvageEligibility(taskId);
    if (!checked.eligible) {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        `Refusing salvage for ${taskId}: ${checked.reason}`,
        { details: { runId, taskId, reason: checked.reason, reasonCode: checked.reasonCode } },
      );
    }
    const taskSpec = orchestrator.config.tasks.find((task) => task.id === taskId)!;
    const preparedHeadSha = orchestrator.state.tasks[taskId]!.preparedHeadSha!;

    if (orchestrator.state.tasks[taskId]?.salvage === undefined) {
      await orchestrator.mutate((state) => updateTask(state, taskId, (task) => ({
        ...task,
        salvage: { authorizedAt: orchestrator.clock().toISOString() },
      })));
      await orchestrator.event('SALVAGE_AUTHORIZED', taskId, {});
    }

    const verifyConfigFingerprint = createHash('sha256')
      .update(JSON.stringify(orchestrator.config.salvage.verify), 'utf8')
      .digest('hex');
    const existingCheckpoint = orchestrator.state.tasks[taskId]?.salvage?.verification;
    const currentDiffFingerprint = await computeTrackedDiffFingerprint(
      orchestrator.git, checked.worktree.path, preparedHeadSha,
    );
    const checkpointValid = existingCheckpoint !== undefined
      && existingCheckpoint.worktreeHeadSha === preparedHeadSha
      && existingCheckpoint.trackedDiffFingerprint === currentDiffFingerprint
      && existingCheckpoint.verifyConfigFingerprint === verifyConfigFingerprint;

    if (!checkpointValid) {
      if (orchestrator.config.agentWorktree.prepare.length > 0) {
        const prepared = await new IntegrationGate().run({
          cwd: checked.worktree.path,
          logsDirectory: join(orchestrator.stateStore.runDirectory, 'logs', taskId, 'salvage-prepare'),
          commands: orchestrator.config.agentWorktree.prepare,
          ...(orchestrator.signal === undefined ? {} : { signal: orchestrator.signal }),
        });
        if (!prepared.passed) {
          throw new OrchestratorError(
            'AGENT_WORKTREE_PREPARATION_FAILED',
            `Refusing salvage for ${taskId}: worktree preparation failed`,
            { details: { runId, taskId } },
          );
        }
      }
      if (orchestrator.config.salvage.verify.length === 0) {
        throw new OrchestratorError(
          'SALVAGE_VERIFICATION_FAILED',
          `Refusing salvage for ${taskId}: no salvage.verify commands configured`,
          { details: { runId, taskId, reason: 'no_verify_configured' } },
        );
      }
      const preFingerprint = await computeTrackedDiffFingerprint(
        orchestrator.git, checked.worktree.path, preparedHeadSha,
      );
      const verified = await new IntegrationGate().run({
        cwd: checked.worktree.path,
        logsDirectory: join(orchestrator.stateStore.runDirectory, 'logs', taskId, 'salvage-verify'),
        commands: orchestrator.config.salvage.verify,
        ...(orchestrator.signal === undefined ? {} : { signal: orchestrator.signal }),
      });
      const postFingerprint = await computeTrackedDiffFingerprint(
        orchestrator.git, checked.worktree.path, preparedHeadSha,
      );
      // Mutation detection takes priority over the commands' own exit
      // codes: a verify command must never silently become another writer,
      // even one that happens to also report success.
      if (postFingerprint !== preFingerprint) {
        await orchestrator.event('SALVAGE_VERIFICATION_FAILED', taskId, { reason: 'verify_mutated_tracked_source' });
        throw new OrchestratorError(
          'SALVAGE_VERIFICATION_FAILED',
          `Refusing salvage for ${taskId}: verify commands modified tracked source`,
          { details: { runId, taskId, reason: 'verify_mutated_tracked_source' } },
        );
      }
      if (!verified.passed) {
        await orchestrator.event('SALVAGE_VERIFICATION_FAILED', taskId, { reason: 'verify_command_failed' });
        throw new OrchestratorError(
          'SALVAGE_VERIFICATION_FAILED',
          `Refusing salvage for ${taskId}: required verify command failed`,
          { details: { runId, taskId, reason: 'verify_command_failed' } },
        );
      }
      await orchestrator.mutate((state) => updateTask(state, taskId, (task) => ({
        ...task,
        salvage: {
          authorizedAt: task.salvage!.authorizedAt,
          verification: {
            worktreeHeadSha: preparedHeadSha,
            trackedDiffFingerprint: postFingerprint,
            verifyConfigFingerprint,
            result: 'passed',
          },
        },
      })));
      await orchestrator.event('SALVAGE_VERIFIED', taskId, {});
    }

    // No Git commit exists yet, and none is created until every
    // semantic/protocol check required for task completion has succeeded —
    // ownership was already proven at eligibility time (checked.changedFiles
    // is exactly the dirty diff's changed-file set, computed from `git
    // status`, not from a commit); reusing it here means the handoff never
    // needs to wait for ensureTaskCommit to learn what changed, and a
    // canonical repair that fails leaves the worktree exactly as dirty and
    // salvageable as it was before this call — never a stranded commit with
    // nothing left to repair.
    //
    // A timed-out writer never produced a handoff at all, so one is
    // synthesized here from the salvaged diff and verify evidence. If the
    // task carries required canonical findings, this shell deliberately
    // omits findingResponses, which routes it through the exact same
    // parseOrRepairHandoff -> repairHandoff -> repairHandoffViaAgent
    // cascade Part A hardened — the identical bounded, evidence-only
    // repair, never a canonical-validation bypass. A task with no required
    // canonical findings passes straight through with no repair attempt at
    // all (validateCanonicalFindingResponses is a no-op for an empty
    // requirement list).
    const requiredCanonicalFindings = orchestrator.requiredCanonicalFindings(taskId);
    const finalDiff = (await orchestrator.git.run(
      checked.worktree.path, ['diff', '--no-ext-diff', '--no-color', preparedHeadSha],
    )).stdout;
    const synthesizedHandoff = {
      status: 'complete',
      summary: `Salvaged timed-out writer work for ${taskId} after deterministic verification.`,
      filesChanged: [...checked.changedFiles],
      decisions: [],
      tests: orchestrator.config.salvage.verify.map((command) => ({
        command: command.command,
        result: 'pass' as const,
        details: 'salvage.verify required command passed',
      })),
      openQuestions: [],
      reviewRequested: [],
    };
    const parsed = await orchestrator.parseOrRepairHandoff(
      taskSpec, synthesizedHandoff, null, requiredCanonicalFindings, finalDiff,
    );
    await orchestrator.recordHandoffOutcome(taskId, parsed.outcome);
    if (parsed.handoff === null) {
      // The worktree is untouched (still dirty, HEAD unmoved) — a later
      // salvage-task call with different/available recovery evidence
      // remains fully eligible and can retry from scratch.
      throw parsed.error;
    }

    // ONLY NOW, with a strictly-validated, accepted canonical handoff in
    // hand, does the Orchestrator (never salvage code calling git itself)
    // create the commit — the same ensureTaskCommit/assertChangedFileOwnership
    // path applyIntegrationFix already uses.
    const ensured = await ensureTaskCommit(orchestrator.git, {
      worktreePath: checked.worktree.path,
      baseSha: preparedHeadSha,
      agent: taskSpec.owner,
      taskId,
      summary: `Salvaged timed-out writer work for ${taskId}`,
    });
    assertChangedFileOwnership(taskId, ensured.changedFiles, taskSpec.files);
    if (JSON.stringify([...ensured.changedFiles].sort()) !== JSON.stringify([...checked.changedFiles].sort())) {
      throw new OrchestratorError(
        'STATE_CORRUPT',
        `Refusing salvage for ${taskId}: the committed changed-file set does not match what was reported pre-commit`,
        { details: { runId, taskId, preCommit: checked.changedFiles, committed: ensured.changedFiles } },
      );
    }

    const handoffPath = await writeHandoff(join(orchestrator.stateStore.runDirectory, 'handoffs'), taskId, parsed.handoff);
    await orchestrator.succeedTask(taskId, handoffPath, {
      sha: ensured.commitSha,
      parentSha: preparedHeadSha,
      changedFiles: [...ensured.changedFiles],
    });

    return { orchestrator, taskId, commitSha: ensured.commitSha };
  }

  snapshot(): RunState {
    return this.state;
  }

  async execute(): Promise<RunState> {
    while (this.state.status === 'RUNNING' || this.state.status === 'CREATED') {
      if (this.signal?.aborted === true) {
        await this.cancelRun('Orchestrator execution was aborted');
        return this.state;
      }
      await assertBaseBranchUnmoved(
        this.git,
        this.repositoryRoot,
        this.state.baseBranch,
        this.state.baseSha,
      );
      await this.advanceAdaptiveScheduling();
      await this.reconcileAdaptiveCorrectionFlow();
      await this.advanceAdaptiveScheduling();
      const scheduler = new TaskScheduler(
        this.config.tasks,
        this.config.concurrency,
        taskStatusRecord(this.state),
      );
      const refreshed = scheduler.snapshot();
      const transitions = Object.entries(refreshed).filter(
        ([id, status]) => this.state.tasks[id]?.status !== status,
      );
      if (transitions.length > 0) {
        const finishedAt = this.clock().toISOString();
        await this.mutate((current) => ({
          ...current,
          tasks: {
            ...current.tasks,
            ...Object.fromEntries(transitions.map(([id, status]) => {
              const task = current.tasks[id]!;
              return [id, status === 'BLOCKED'
                ? {
                    ...task,
                    status,
                    finishedAt,
                    error: storedError(
                      'TASK_DEPENDENCY_FAILED',
                      'A task dependency did not succeed',
                      this.clock,
                    ),
                  }
                : { ...task, status }];
            })),
          },
        }));
        for (const [id, status] of transitions) {
          if (status === 'READY') await this.event('TASK_READY', id);
          if (status === 'BLOCKED') {
            await this.event('TASK_FAILED', id, {
              code: 'TASK_DEPENDENCY_FAILED',
              status,
            });
          }
        }
      }
      const claimed = scheduler.claimReady();
      if (claimed.length === 0) {
        if (Object.values(this.state.tasks).some((task) => task.status === 'RUNNING')) {
          // A resumed child is still alive. Do not duplicate it or busy-wait.
          return this.state;
        }
        // SKIPPED counts alongside SUCCEEDED here — a run where the clean
        // path skipped fix/reverify/judge entirely is still a fully
        // successful run that must reach the deterministic gate, not one
        // stuck waiting for tasks that were correctly never going to run.
        if (
          Object.values(this.state.tasks).every(
            (task) => task.status === 'SUCCEEDED' || task.status === 'SKIPPED',
          )
        ) {
          if (this.state.strategy === 'adaptive') {
            // `true` asks whether topology is otherwise complete; the actual
            // deterministic gate still runs below and alone decides completion.
            const completion = this.adaptiveCoordinator().completionStatus(true);
            if (completion === 'HUMAN_APPROVAL_REQUIRED' || completion === 'BLOCKED') {
              const error = new OrchestratorError(
                'BLOCKED_FOR_HUMAN_REVIEW',
                completion === 'HUMAN_APPROVAL_REQUIRED'
                  ? 'Adaptive work is waiting for explicit human approval'
                  : 'A required adaptive request was denied by policy',
              );
              await this.mutate((current) => ({
                ...current,
                status: 'BLOCKED',
                errors: [...current.errors, normalizeError(error, this.clock)],
              }));
              await this.event('RUN_BLOCKED', undefined, { adaptiveCompletion: completion });
              return this.state;
            }
            if (completion === 'FAILED') {
              await this.mutate((current) => ({ ...current, status: 'FAILED' }));
              return this.state;
            }
            if (completion === 'ACTIVE') return this.state;
            const reviewGate = await this.adaptiveReviewGate();
            if (reviewGate !== 'APPROVED') {
              if (reviewGate === 'ACTIVE') return this.state;
              const error = new OrchestratorError(
                'BLOCKED_FOR_HUMAN_REVIEW',
                'Adaptive review has unresolved material findings after the authorized correction rounds',
              );
              await this.mutate((current) => ({
                ...current,
                status: 'BLOCKED',
                errors: [...current.errors, normalizeError(error, this.clock)],
              }));
              await this.event('RUN_BLOCKED', undefined, { adaptiveReviewGate: reviewGate });
              return this.state;
            }
          }
          await this.integrateAndVerify();
          return this.state;
        }
        const failed = Object.values(this.state.tasks).some((task) => task.status === 'FAILED');
        await this.mutate((current) => ({
          ...current,
          status: failed ? 'FAILED' : 'BLOCKED',
        }));
        await this.event('RUN_BLOCKED', undefined, { failed });
        return this.state;
      }

      const startedAt = this.clock().toISOString();
      await this.mutate((current) => ({
        ...current,
        tasks: {
          ...current.tasks,
          ...Object.fromEntries(claimed.map((task) => [
            task.id,
            { ...current.tasks[task.id]!, status: 'RUNNING', startedAt },
          ])),
        },
      }));
      await this.startAdaptiveUnits(claimed.map((task) => task.id));
      await Promise.all(claimed.map(async (task) => {
        await this.event('TASK_STARTED', task.id);
        try {
          await this.executeTask(task);
        } catch (error) {
          await this.failTask(task.id, error, 'FAILED');
        }
      }));
    }
    return this.state;
  }

  async cleanup(): Promise<readonly string[]> {
    if (this.state.status === 'RUNNING' || Object.values(this.state.tasks).some(
      (task) => task.status === 'RUNNING',
    )) {
      throw new OrchestratorError(
        'TASK_STATE_INVALID',
        'Refusing cleanup while run or tasks are still running',
      );
    }
    const entries = (await this.worktrees.listOwned()).filter((entry) => entry.runId === this.state.runId);
    const results = [];
    for (const entry of entries) {
      results.push(await this.worktrees.cleanup(entry.path, {
        allowUntrackedPreparationArtifacts: entry.kind === 'integration'
          && this.state.integration.preparation?.status === 'SUCCEEDED',
      }));
    }
    return results.map((result) => result.entry.path);
  }

  private adaptiveCoordinator(state: RunState = this.state): AdaptiveCoordinator {
    if (this.adaptiveConfig === undefined || state.adaptive === undefined) {
      throw new OrchestratorError('STATE_CORRUPT', 'Adaptive coordinator requested for a static run');
    }
    return new AdaptiveCoordinator(
      state.adaptive,
      capabilityCatalog(this.adaptiveConfig),
      { now: this.clock },
    );
  }

  /** Re-arbitrate after every completion/release; persist grants and routes before tasks can launch. */
  private async advanceAdaptiveScheduling(): Promise<void> {
    if (this.adaptiveConfig === undefined || this.state.adaptive === undefined) return;
    let emitted: readonly AdaptiveEvent[] = [];
    const added: string[] = [];
    await this.mutate((current) => {
      const coordinator = this.adaptiveCoordinator(current);
      const previousEvents = current.adaptive!.events.length;
      coordinator.arbitrate();
      routeGrantedWork(coordinator, this.adaptiveConfig!);
      const adaptive = coordinator.snapshot();
      emitted = adaptive.events.slice(previousEvents);
      const runtime = runtimePhaseConfig(this.adaptiveConfig!, adaptive);
      const tasks = { ...current.tasks };
      for (const spec of runtime.tasks) {
        if (tasks[spec.id] !== undefined) continue;
        tasks[spec.id] = {
          id: spec.id,
          status: spec.dependsOn.every((id) => tasks[id]?.status === 'SUCCEEDED' || tasks[id]?.status === 'SKIPPED')
            ? 'READY'
            : 'PENDING',
          agentAttempts: [], reviewRounds: 0, reviewPaths: [], handoffRepairAttempts: [],
        };
        added.push(spec.id);
      }
      this.config = runtime;
      return { ...current, adaptive, tasks };
    });
    await this.emitAdaptiveEvents(emitted);
    for (const id of added.filter((taskId) => this.state.tasks[taskId]?.status === 'READY')) {
      await this.event('ADAPTIVE_WORK_UNIT_READY', id, { adaptive: true });
      await this.event('TASK_READY', id, { adaptive: true });
    }
  }

  private async emitNewAdaptiveEvents(previousCount: number): Promise<void> {
    if (this.state.adaptive === undefined) return;
    await this.emitAdaptiveEvents(this.state.adaptive.events.slice(previousCount));
  }

  private async emitAdaptiveEvents(entries: readonly AdaptiveEvent[]): Promise<void> {
    const names: Readonly<Record<string, RunEventName | undefined>> = {
      REQUEST_CREATED: 'ADAPTIVE_REQUEST_CREATED',
      GRANT_DECIDED: 'ADAPTIVE_GRANT_DECIDED',
      WORK_UNIT_CREATED: 'ADAPTIVE_WORK_UNIT_CREATED',
      WORK_UNIT_STARTED: 'ADAPTIVE_WORK_UNIT_STARTED',
      WORK_UNIT_FINISHED: 'ADAPTIVE_WORK_UNIT_FINISHED',
      RESOURCE_RELEASED: 'ADAPTIVE_RESOURCE_RELEASED',
      SYNTHESIS_TREE_CREATED: 'ADAPTIVE_SYNTHESIS_CREATED',
      CANONICAL_FINDINGS_IMPORTED: 'ADAPTIVE_CANONICAL_FINDINGS_IMPORTED',
      CORRECTION_PLAN_CREATED: 'ADAPTIVE_CORRECTION_PLAN_CREATED',
      CORRECTION_REQUEST_CREATED: 'ADAPTIVE_CORRECTION_REQUEST_CREATED',
      CORRECTION_GRANTED: 'ADAPTIVE_CORRECTION_GRANTED',
      REVERIFICATION_CREATED: 'ADAPTIVE_REVERIFICATION_CREATED',
    };
    for (const entry of entries) {
      let name = names[entry.type];
      if (entry.type === 'GRANT_DECIDED') {
        name = entry.detail.startsWith('GRANTED:')
          ? 'ADAPTIVE_REQUEST_GRANTED'
          : entry.detail.startsWith('WAITING:')
            ? 'ADAPTIVE_REQUEST_WAITING'
            : 'ADAPTIVE_REQUEST_DENIED';
      } else if (entry.type === 'WORK_UNIT_FINISHED') {
        name = entry.detail === 'SUCCEEDED' || entry.detail === 'SKIPPED'
          ? 'ADAPTIVE_WORK_UNIT_SUCCEEDED'
          : 'ADAPTIVE_WORK_UNIT_FAILED';
      }
      if (name === undefined) continue;
      await this.event(name, entry.workUnitId, {
        adaptiveSequence: entry.sequence,
        requestId: entry.requestId ?? null,
        decisionId: entry.decisionId ?? null,
        detail: entry.detail,
      });
    }
  }

  private async startAdaptiveUnits(ids: readonly string[]): Promise<void> {
    if (this.state.adaptive === undefined) return;
    let emitted: readonly AdaptiveEvent[] = [];
    await this.mutate((current) => {
      const coordinator = this.adaptiveCoordinator(current);
      const previousEvents = current.adaptive!.events.length;
      for (const id of ids) coordinator.start(id);
      const adaptive = coordinator.snapshot();
      emitted = adaptive.events.slice(previousEvents);
      return { ...current, adaptive };
    });
    await this.emitAdaptiveEvents(emitted);
  }

  private async finishAdaptiveUnit(
    taskId: string,
    status: 'SUCCEEDED' | 'FAILED' | 'TIMED_OUT' | 'SKIPPED',
    error?: string,
  ): Promise<void> {
    if (this.state.adaptive === undefined) return;
    let emitted: readonly AdaptiveEvent[] = [];
    await this.mutate((current) => {
      const coordinator = this.adaptiveCoordinator(current);
      const unit = coordinator.snapshot().workUnits.find((candidate) => candidate.id === taskId);
      if (unit === undefined || !['GRANTED', 'RUNNING'].includes(unit.status)) return current;
      const previousEvents = current.adaptive!.events.length;
      coordinator.finish(taskId, status, error === undefined ? {} : { error });
      const adaptive = coordinator.snapshot();
      emitted = adaptive.events.slice(previousEvents);
      return { ...current, adaptive };
    });
    await this.emitAdaptiveEvents(emitted);
  }

  private async authorizeAdaptiveRetry(
    taskId: string,
    timedOut: boolean,
    message: string,
    stateUpdate: (state: RunState) => RunState = (state) => state,
  ): Promise<void> {
    if (this.state.adaptive === undefined || this.adaptiveConfig === undefined) {
      await this.mutate(stateUpdate);
      return;
    }
    let emitted: readonly AdaptiveEvent[] = [];
    await this.mutate((current) => {
      const coordinator = this.adaptiveCoordinator(current);
      const previousEvents = current.adaptive!.events.length;
      const unit = coordinator.snapshot().workUnits.find((candidate) => candidate.id === taskId);
      if (unit !== undefined && ['GRANTED', 'RUNNING'].includes(unit.status)) {
        coordinator.finish(taskId, timedOut ? 'TIMED_OUT' : 'FAILED', { error: message });
      }
      coordinator.authorizeRetry(taskId);
      coordinator.arbitrate();
      routeGrantedWork(coordinator, this.adaptiveConfig!);
      const adaptive = coordinator.snapshot();
      if (adaptive.workUnits.find((candidate) => candidate.id === taskId)?.status !== 'GRANTED') {
        throw new OrchestratorError('TASK_STATE_INVALID', `Adaptive retry for ${taskId} was not re-granted`);
      }
      emitted = adaptive.events.slice(previousEvents);
      return { ...stateUpdate(current), adaptive };
    });
    await this.emitAdaptiveEvents(emitted);
  }

  private async submitAdditionalAdaptiveRequests(
    parentTaskId: string,
    drafts: readonly WorkRequestDraft[] | undefined,
    arbitrate = true,
  ): Promise<void> {
    if (drafts === undefined || drafts.length === 0 || this.state.adaptive === undefined) return;
    let emitted: readonly AdaptiveEvent[] = [];
    let submitted = false;
    await this.mutate((current) => {
      const coordinator = this.adaptiveCoordinator(current);
      const previousEvents = current.adaptive!.events.length;
      const existing = coordinator.snapshot().workRequests;
      const unseen = drafts.filter((draft) => !existing.some((request) =>
        request.parentWorkUnitId === parentTaskId && workRequestMatchesDraft(request, draft),
      ));
      if (unseen.length === 0) return current;
      const requests = coordinator.submitMany(unseen, { parentWorkUnitId: parentTaskId, source: 'agent' });
      const reviews = requests.filter((request) => request.role === 'review');
      if (reviews.length > 1) coordinator.createSynthesisTree(reviews.map((request) => request.id));
      const adaptive = coordinator.snapshot();
      emitted = adaptive.events.slice(previousEvents);
      submitted = true;
      return { ...current, adaptive };
    });
    if (submitted) await this.emitAdaptiveEvents(emitted);
    if (arbitrate) await this.advanceAdaptiveScheduling();
  }

  /**
   * Deterministically materialize privileged correction roots and their
   * targeted re-review from already-persisted artifacts. Agent proposals
   * remain ordinary children and can never enter this path.
   */
  private async reconcileAdaptiveCorrectionFlow(): Promise<void> {
    const correctionPolicy = this.adaptiveConfig?.policy.correctionPolicy;
    if (this.state.adaptive === undefined || correctionPolicy === undefined) return;
    const snapshot = this.state;
    const adaptive = snapshot.adaptive!;
    const actions: Array<{
      draft: WorkRequestDraft;
      authorization: CanonicalFindingAuthorization;
    }> = [];
    const synthesisRequestIds = new Set(adaptive.workRequests
      .filter((request) => request.role === 'synthesis')
      .flatMap((request) => request.dependencies));

    for (const unit of adaptive.workUnits) {
      if (unit.status !== 'SUCCEEDED') continue;
      const request = adaptive.workRequests.find((candidate) => candidate.id === unit.requestId);
      const task = snapshot.tasks[unit.id];
      if (request === undefined || task === undefined) continue;

      if (request.authorization?.purpose === 'correction') {
        const auth = request.authorization;
        const exists = adaptive.workRequests.some((candidate) =>
          candidate.authorization?.purpose === 'reverification'
          && candidate.authorization.canonicalFindingKey === auth.canonicalFindingKey
          && candidate.authorization.round === auth.round,
        );
        if (!exists) {
          const { importedSource: _importedSource, ...localAuthorization } = auth;
          actions.push({
            draft: {
              role: 'review', concern: request.concern,
              objective: `Re-verify canonical finding ${auth.findingReference} after correction round ${auth.round}`,
              reason: 'A successful correction requires targeted independent verification before integration',
              dependencies: [request.id], capabilities: [{ capability: 'review' }],
              resourceClaims: request.resourceClaims.map((claim) => ({ ...claim, mode: 'read' as const })),
              evidence: [{ kind: 'finding', reference: auth.findingReference, summary: `Canonical finding ${auth.canonicalFindingKey}` }],
              risk: request.risk, priority: Math.min(100, request.priority + 1),
            },
            authorization: { ...localAuthorization, purpose: 'reverification', sourceWorkUnitId: unit.id, artifactPath: task.handoffPath ?? auth.artifactPath },
          });
        }
        continue;
      }

      const isReverification = request.authorization?.purpose === 'reverification';
      const isRootReview = ['review', 'synthesis', 'final_review'].includes(request.role)
        && !synthesisRequestIds.has(request.id);
      if (!isReverification && !isRootReview) continue;
      const reviewPath = task.reviewPaths.at(-1);
      if (reviewPath === undefined) continue;
      const review = parseReview(await readFile(reviewPath, 'utf8'));
      if (review.status !== 'changes_requested') continue;
      const nextRound = isReverification ? request.authorization!.round + 1 : 1;
      if (nextRound > correctionPolicy.maxRounds) continue;
      const sourceFindings = isReverification
        ? [review.findings.find((finding) => finding.id === request.authorization!.findingReference) ?? review.findings[0]!]
        : review.findings;
      for (const finding of sourceFindings) {
        const key = request.authorization?.canonicalFindingKey ?? `${unit.id}:${finding.id}`;
        // Only the accepted canonical artifact may refine the deterministic
        // fallback plan. A shard proposal or arbitrary agent request is never
        // consulted for privileged scope.
        const canonicalProposal = review.additionalWorkRequests?.find((proposal) =>
          (proposal.role === 'correction' || proposal.role === 'testing')
          && proposal.resourceClaims?.some((claim) => claim.mode === 'write')
          && proposal.evidence?.some((entry) => entry.kind === 'finding' && entry.reference === finding.id),
        );
        const desiredRole = canonicalProposal?.role === 'testing' || (canonicalProposal === undefined && finding.category === 'testing')
          ? 'testing' as const
          : 'correction' as const;
        actions.push({
          draft: {
            role: desiredRole,
            concern: canonicalProposal?.concern ?? request.concern,
            objective: canonicalProposal?.objective ?? `Correct ${finding.id}: ${finding.problem}`,
            reason: canonicalProposal?.reason ?? finding.suggestedFix,
            dependencies: [request.id],
            capabilities: canonicalProposal?.capabilities ?? [{ capability: desiredRole === 'testing' ? 'testing' : 'typescript_backend_editing' }],
            resourceClaims: canonicalProposal?.resourceClaims ?? [{ kind: 'repository_path', key: finding.file, mode: 'write' }],
            evidence: canonicalProposal?.evidence ?? [{ kind: 'finding', reference: finding.id, summary: finding.evidence }],
            risk: finding.severity,
            priority: canonicalProposal?.priority ?? (finding.severity === 'critical' ? 100 : finding.severity === 'high' ? 90 : finding.severity === 'medium' ? 75 : 50),
            ...(canonicalProposal?.estimatedCostUnits === undefined ? {} : { estimatedCostUnits: canonicalProposal.estimatedCostUnits }),
          },
          authorization: {
            kind: 'canonical_finding', purpose: 'correction', canonicalFindingKey: key,
            findingReference: finding.id, sourceWorkUnitId: unit.id, artifactPath: reviewPath, round: nextRound,
          },
        });
      }
    }
    if (actions.length === 0) return;
    let emitted: readonly AdaptiveEvent[] = [];
    await this.mutate((current) => {
      const coordinator = this.adaptiveCoordinator(current);
      const previous = current.adaptive!.events.length;
      for (const action of actions) coordinator.submitCanonicalFindingWork(action.draft, action.authorization);
      const adaptive = coordinator.snapshot();
      emitted = adaptive.events.slice(previous);
      return { ...current, adaptive };
    });
    await this.emitAdaptiveEvents(emitted);
  }

  /** Review verdict is an independent prerequisite; task success alone is insufficient. */
  private async adaptiveReviewGate(): Promise<'APPROVED' | 'ACTIVE' | 'BLOCKED'> {
    if (this.state.adaptive === undefined) return 'APPROVED';
    const continuation = this.state.adaptive.continuation;
    if (continuation !== undefined) {
      for (const imported of continuation.findings) {
        const correction = this.state.adaptive.workRequests.find((request) =>
          request.authorization?.purpose === 'correction'
          && request.authorization.canonicalFindingKey === imported.canonicalFindingKey
          && request.authorization.round === 1,
        );
        if (correction === undefined) return 'BLOCKED';
        const correctionDecision = [...this.state.adaptive.grantDecisions].reverse().find(
          (decision) => decision.requestId === correction.id,
        );
        if (correctionDecision?.outcome === 'DENIED') return 'BLOCKED';
        const reverifications = this.state.adaptive.workRequests
          .filter((request) => request.authorization?.purpose === 'reverification'
            && request.authorization.canonicalFindingKey === imported.canonicalFindingKey)
          .sort((left, right) => left.authorization!.round - right.authorization!.round);
        const latest = reverifications.at(-1);
        if (latest === undefined) return 'ACTIVE';
        const verificationUnit = this.state.adaptive.workUnits.find((unit) => unit.requestId === latest.id);
        const verificationPath = verificationUnit === undefined
          ? undefined
          : this.state.tasks[verificationUnit.id]?.reviewPaths.at(-1);
        if (verificationUnit?.status !== 'SUCCEEDED' || verificationPath === undefined) return 'ACTIVE';
        const verdict = parseReview(await readFile(verificationPath, 'utf8'));
        if (verdict.status === 'approved') continue;
        if (verdict.status === 'blocked'
          || latest.authorization!.round >= this.adaptiveConfig!.policy.correctionPolicy!.maxRounds) return 'BLOCKED';
        return 'ACTIVE';
      }
    }
    const synthesisInputs = new Set(this.state.adaptive.workRequests
      .filter((request) => request.role === 'synthesis')
      .flatMap((request) => request.dependencies));
    const canonical = this.state.adaptive.workUnits.filter((unit) => {
      const request = this.state.adaptive!.workRequests.find((candidate) => candidate.id === unit.requestId)!;
      return ['review', 'synthesis', 'final_review'].includes(request.role)
        && request.authorization === undefined
        && !synthesisInputs.has(request.id);
    });
    for (const unit of canonical) {
      const task = this.state.tasks[unit.id];
      if (unit.status !== 'SUCCEEDED' || task?.reviewPaths.at(-1) === undefined) return 'ACTIVE';
      const review = parseReview(await readFile(task.reviewPaths.at(-1)!, 'utf8'));
      if (review.status === 'blocked') return 'BLOCKED';
      if (review.status !== 'changes_requested') continue;
      if (this.adaptiveConfig?.policy.correctionPolicy === undefined) return 'BLOCKED';
      for (const finding of review.findings) {
        const key = `${unit.id}:${finding.id}`;
        const reverifications = this.state.adaptive.workRequests
          .filter((request) => request.authorization?.purpose === 'reverification'
            && request.authorization.canonicalFindingKey === key)
          .sort((left, right) => left.authorization!.round - right.authorization!.round);
        const latest = reverifications.at(-1);
        if (latest === undefined) {
          const correction = this.state.adaptive.workRequests.find((request) =>
            request.authorization?.purpose === 'correction'
            && request.authorization.canonicalFindingKey === key,
          );
          if (correction !== undefined && [...this.state.adaptive.grantDecisions].reverse().find((decision) => decision.requestId === correction.id)?.outcome === 'DENIED') return 'BLOCKED';
          return 'ACTIVE';
        }
        const verificationUnit = this.state.adaptive.workUnits.find((candidate) => candidate.requestId === latest.id);
        const verificationPath = verificationUnit === undefined ? undefined : this.state.tasks[verificationUnit.id]?.reviewPaths.at(-1);
        if (verificationUnit?.status !== 'SUCCEEDED' || verificationPath === undefined) return 'ACTIVE';
        const verdict = parseReview(await readFile(verificationPath, 'utf8'));
        if (verdict.status === 'approved') continue;
        if (verdict.status === 'blocked' || latest.authorization!.round >= this.adaptiveConfig!.policy.correctionPolicy!.maxRounds) return 'BLOCKED';
        return 'ACTIVE';
      }
    }
    return 'APPROVED';
  }

  private async executeTask(task: TaskSpec): Promise<void> {
    // Checked BEFORE prepareTask deliberately: prepareTask is what creates
    // the worktree and applies dependency commits. A task whose condition
    // says skip must never reach that point — no worktree, no agent
    // invocation, no commit — which is also what makes the skip decision
    // safe to redo verbatim on resume (see reconcile()'s fallback path for a
    // RUNNING task with no worktreePath yet: it retries from scratch, which
    // for a conditionally-gated task just re-evaluates the same condition
    // against the same persisted artifact and reaches the same answer).
    if (task.condition !== undefined) {
      const verdict = await this.evaluateCondition(task.condition);
      if (verdict.skip) {
        await this.skipTask(task.id, verdict.reason);
        return;
      }
    }

    const prepared = await this.prepareTask(task);
    if (task.mode === 'debate') {
      await this.executeDebate(prepared);
      return;
    }
    if (REVIEW_MODES.has(task.mode)) {
      const completedRounds = ancestorTasks(task, new TaskGraph(this.config.tasks))
        .filter((ancestor) => REVIEW_MODES.has(ancestor.mode))
        .filter((ancestor) => this.state.tasks[ancestor.id]?.status === 'SUCCEEDED').length;
      assertReviewRoundAllowed(completedRounds, this.config.maxReviewRounds);
      await this.event('REVIEW_STARTED', task.id, { round: completedRounds + 1 });
    }

    const result = await this.runTrackedAgent(prepared, this.agents[task.owner]);
    if (result.status !== 'succeeded') {
      await this.handleAgentProcessFailure(prepared, result);
      return;
    }

    if (REVIEW_MODES.has(task.mode)) {
      await this.finishReview(prepared, result);
    } else {
      await this.finishHandoff(prepared, result);
    }
  }

  /**
   * §5: evaluated purely from the already-validated StructuredReview an
   * ancestor task produced — never free-form text. "No review artifact
   * found" (the referenced task was itself SKIPPED, or genuinely has none)
   * defaults to skip: there is nothing to act on, which is the same
   * conclusion a human would draw and matches how a skip is meant to
   * propagate through a chain of conditionally-gated tasks (see judge's
   * condition on reverify, when reverify was itself skipped because verify
   * approved).
   */
  private async evaluateCondition(
    condition: TaskCondition,
  ): Promise<{ readonly skip: boolean; readonly reason: string }> {
    const reviewPath = this.state.tasks[condition.reviewOf]?.reviewPaths.at(-1);
    if (reviewPath === undefined) {
      return {
        skip: true,
        reason: `${condition.reviewOf} produced no review artifact (it was itself skipped, or has none yet)`,
      };
    }
    const review = parseReview(await readFile(reviewPath, 'utf8'));
    if (condition.skipIfStatus.includes(review.status)) {
      return { skip: true, reason: `${condition.reviewOf} review status is ${review.status}` };
    }
    if (condition.minimumSeverity !== undefined) {
      const minimumSeverity = condition.minimumSeverity;
      const hasMaterialFinding = review.findings.some((finding) =>
        severityAtLeast(finding.severity, minimumSeverity),
      );
      if (!hasMaterialFinding) {
        return {
          skip: true,
          reason: `${condition.reviewOf} review has no finding at or above ${minimumSeverity} severity`,
        };
      }
    }
    return { skip: false, reason: '' };
  }

  private async skipTask(taskId: string, reason: string): Promise<void> {
    await this.mutate((state) => updateTask(state, taskId, (task) => {
      const { error: _previousError, ...withoutError } = task;
      return {
        ...withoutError,
        status: 'SKIPPED',
        skipReason: reason,
        finishedAt: this.clock().toISOString(),
      };
    }));
    await this.event('TASK_SKIPPED', taskId, { reason });
    await this.finishAdaptiveUnit(taskId, 'SKIPPED');
  }

  private async prepareTask(task: TaskSpec): Promise<PreparedTask> {
    const current = this.state.tasks[task.id]!;
    let worktree: OwnedWorktree;
    if (current.worktreePath !== undefined) {
      worktree = await this.worktrees.assertRegistered(current.worktreePath);
    } else {
      worktree = await this.worktrees.createTaskWorktree({
        runId: this.state.runId,
        taskId: task.id,
        baseBranch: this.state.baseBranch,
        baseSha: this.state.baseSha,
      });
      const dependencyCommits = this.dependencyCommits(task);
      if (dependencyCommits.length > 0) {
        const applied = await integrateTaskCommits(this.git, worktree.path, dependencyCommits);
        if (applied.status === 'conflict') throw integrationConflictError(applied);
      }
      await this.mutate((state) => ({
        ...state,
        tasks: {
          ...state.tasks,
          [task.id]: {
            ...state.tasks[task.id]!,
            worktreePath: worktree.path,
            branch: worktree.branch,
          },
        },
      }));
    }

    let inspection = await inspectTaskCommits(this.git, worktree.path, this.state.baseSha);
    if (!inspection.clean) {
      throw new OrchestratorError(
        'AGENT_FAILED',
        `Task ${task.id} worktree is dirty before invocation; preserving it for inspection`,
      );
    }
    const preparationReusable = canReuseIntegrationPreparation(
      this.state.tasks[task.id]?.preparation,
      worktree.path,
      inspection.headSha,
      this.config.agentWorktree.prepare.length,
    );
    if (!preparationReusable) {
      const startedAt = this.clock().toISOString();
      await this.event('AGENT_WORKTREE_PREPARATION_STARTED', task.id, {
        worktreePath: worktree.path, headSha: inspection.headSha,
      });
      await this.mutate((state) => updateTask(state, task.id, (value) => ({
        ...value,
        preparation: {
          status: 'RUNNING', worktreePath: worktree.path, headSha: inspection.headSha,
          commands: [], startedAt,
        },
      })));
      const result = await new IntegrationGate().run({
        cwd: worktree.path,
        logsDirectory: join(this.stateStore.runDirectory, 'logs', task.id, 'preparation'),
        commands: this.config.agentWorktree.prepare,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
        onCommandFinished: async (command, index) => {
          await this.mutate((state) => updateTask(state, task.id, (value) => ({
            ...value,
            preparation: {
              ...value.preparation!,
              commands: [...value.preparation!.commands, command],
            },
          })));
          await this.event('AGENT_WORKTREE_PREPARATION_COMMAND_FINISHED', task.id, {
            index, command: command.command, required: command.required,
            exitCode: command.exitCode, timedOut: command.timedOut,
            termination: command.termination, durationMs: command.durationMs,
            stdoutPath: command.stdoutPath, stderrPath: command.stderrPath,
          });
        },
      });
      const finishedAt = this.clock().toISOString();
      await this.mutate((state) => updateTask(state, task.id, (value) => ({
        ...value,
        preparation: {
          ...value.preparation!, status: result.passed ? 'SUCCEEDED' : 'FAILED',
          commands: result.commands, finishedAt,
        },
      })));
      if (!result.passed) {
        const failed = result.commands.at(-1);
        await this.event('AGENT_WORKTREE_PREPARATION_FAILED', task.id, {
          command: failed?.command ?? null, exitCode: failed?.exitCode ?? null,
          timedOut: failed?.timedOut ?? false, durationMs: failed?.durationMs ?? 0,
        });
        throw new OrchestratorError(
          'AGENT_WORKTREE_PREPARATION_FAILED',
          `Required worktree preparation failed for ${task.id}`,
          { details: failed === undefined ? {} : { ...failed } },
        );
      }
      const afterHead = await this.git.resolveCommit(worktree.path, 'HEAD');
      const trackedChanges = (await this.git.run(worktree.path, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
      if (afterHead !== inspection.headSha || trackedChanges !== '') {
        await this.mutate((state) => updateTask(state, task.id, (value) => ({
          ...value, preparation: { ...value.preparation!, status: 'FAILED' },
        })));
        await this.event('AGENT_WORKTREE_PREPARATION_FAILED', task.id, { afterHead, trackedChanges });
        throw new OrchestratorError(
          'AGENT_WORKTREE_PREPARATION_FAILED',
          `Worktree preparation for ${task.id} modified tracked source or created a commit`,
          { details: { afterHead, trackedChanges } },
        );
      }
      inspection = await inspectTaskCommits(this.git, worktree.path, this.state.baseSha);
    }
    if (current.preparedHeadSha !== inspection.headSha) {
      await this.mutate((state) => updateTask(state, task.id, (value) => ({
        ...value,
        preparedHeadSha: inspection.headSha,
      })));
    }
    const graph = new TaskGraph(this.config.tasks);
    const ancestors = ancestorTasks(task, graph);
    const actualDependencyDiff = (
      await this.git.run(worktree.path, [
        'diff',
        '--no-ext-diff',
        '--no-color',
        '--find-renames',
        `${this.state.baseSha}...${inspection.headSha}`,
      ])
    ).stdout;
    if (Buffer.byteLength(actualDependencyDiff, 'utf8') > MAX_AGENT_DIFF_BYTES) {
      throw new OrchestratorError(
        'AGENT_FAILED',
        `Dependency diff for task ${task.id} exceeds ${MAX_AGENT_DIFF_BYTES} bytes; split or narrow the task before review`,
      );
    }
    return {
      task,
      worktree,
      preparedHeadSha: inspection.headSha,
      dependencyHandoffs: await readArtifacts(
        ancestors.flatMap((ancestor) => {
          const state = this.state.tasks[ancestor.id];
          return state?.handoffPath === undefined ? [] : [state.handoffPath];
        }),
      ),
      previousReviewFindings: (await readArtifacts(
        ancestors.flatMap((ancestor) => this.state.tasks[ancestor.id]?.reviewPaths ?? []),
      )).flatMap((artifact) => isRecord(artifact) && Array.isArray(artifact.findings)
        ? artifact.findings
        : []),
      actualDependencyDiff,
    };
  }

  private async runTrackedAgent(prepared: PreparedTask, agent: Agent): Promise<AgentResult> {
    const task = prepared.task;
    const configuredTimeoutMs = task.timeoutMs ?? this.config.agentTimeoutMs;
    const attemptNumber = await this.allocateAttempt(task.id, agent.name, configuredTimeoutMs);
    await this.event('AGENT_STARTED', task.id, {
      agent: agent.name, attempt: attemptNumber, timeoutMs: configuredTimeoutMs,
    });

    const canonicalFindings = this.requiredCanonicalFindings(task.id, prepared.previousReviewFindings);
    const request: AgentRequest = {
      runId: this.state.runId,
      taskId: task.id,
      role: task.mode,
      worktreePath: prepared.worktree.path,
      baseSha: this.state.baseSha,
      taskSpecification: {
        task,
        ancestorTasks: ancestorTasks(task, new TaskGraph(this.config.tasks)),
        actualDependencyDiff: prepared.actualDependencyDiff,
        ...(this.state.adaptive === undefined ? {} : {
          allowedNonFileResources: this.state.adaptive.policy.allowedResources,
          resourceRequestContract: 'Additional work must request an exact listed kind/key and a contained mode; this list conveys no grant authority.',
        }),
        ...(canonicalFindings.length === 0 ? {} : {
          requiredCanonicalFindings: canonicalFindings,
          canonicalFindingResponseContract: [
            'Return exactly one findingResponses entry for every assigned finding ID.',
            'A generic summary is not a canonical response.',
            'Use decision confirmed/rejected and resolution resolved/unresolved/not_applicable.',
            'Confirmed/resolved requires evidence, fix, and verification; rejected requires evidence and reason.',
            'Do not introduce unassigned finding IDs.',
          ],
        }),
        responseSchema: REVIEW_MODES.has(task.mode)
          ? reviewResponseSchema(this.state.strategy === 'adaptive')
          : handoffResponseSchema(this.state.strategy === 'adaptive'),
        responseSchemaNotes: REVIEW_MODES.has(task.mode)
          ? reviewResponseSchemaNotes(this.state.strategy === 'adaptive')
          : handoffResponseSchemaNotes(this.state.strategy === 'adaptive'),
      },
      ...(this.state.strategy === 'adaptive' ? { adaptive: true } : {}),
      canonicalDesignDocumentPath: join(
        this.repositoryRoot,
        this.config.canonicalDesignDocument,
      ),
      allowedFileOwnership: task.files,
      dependencyHandoffs: prepared.dependencyHandoffs,
      previousReviewFindings: prepared.previousReviewFindings,
      requestedEffort: task.effort,
      ...(task.model === undefined ? {} : { requestedModel: task.model }),
      timeoutMs: configuredTimeoutMs,
      artifactsDirectory: join(this.stateStore.runDirectory, 'logs'),
      access: task.writer ? 'writer' : 'read_only',
      attempt: attemptNumber,
      ...(this.signal === undefined ? {} : { abortSignal: this.signal }),
      onStarted: async (pid) => {
        await this.mutate((state) => updateAttemptPid(state, task.id, attemptNumber, pid));
      },
    };
    const result = await agent.run(request);
    await this.mutate((state) => updateAttemptFinished(state, task.id, attemptNumber, result));
    await this.event('AGENT_FINISHED', task.id, {
      agent: agent.name,
      attempt: attemptNumber,
      status: result.status,
      exitCode: result.exitCode,
      durationMs: result.durationMs,
    });
    return result;
  }

  private async handleAgentProcessFailure(
    prepared: PreparedTask,
    result: AgentResult,
  ): Promise<void> {
    if (result.status === 'aborted' && this.signal?.aborted === true) {
      await this.cancelRun('Agent execution was aborted by the orchestrator signal');
      return;
    }
    const taskState = this.state.tasks[prepared.task.id]!;
    const retryAvailable =
      INFRASTRUCTURE_FAILURES.has(result.status)
      && taskState.agentAttempts.length <= this.config.agentRetries;
    const inspection = await inspectTaskCommits(
      this.git,
      prepared.worktree.path,
      prepared.preparedHeadSha,
    );
    if (retryAvailable && inspection.clean && inspection.commits.length === 0) {
      const retryState = (state: RunState): RunState => updateTask(state, prepared.task.id, (task) => ({
        ...task,
        status: 'READY',
        error: storedError(
          result.failureCode === 'AGENT_TIMEOUT' ? 'AGENT_TIMEOUT' : 'AGENT_FAILED',
          result.errorMessage ?? `Agent process ended as ${result.status}`,
          this.clock,
        ),
      }));
      if (this.state.strategy === 'adaptive') {
        await this.authorizeAdaptiveRetry(
          prepared.task.id,
          result.failureCode === 'AGENT_TIMEOUT',
          result.errorMessage ?? `Agent process ended as ${result.status}`,
          retryState,
        );
      } else {
        await this.mutate(retryState);
      }
      await this.event('TASK_READY', prepared.task.id, { retry: true });
      return;
    }
    await this.failTask(
      prepared.task.id,
      new OrchestratorError(
        result.failureCode === 'AGENT_TIMEOUT' ? 'AGENT_TIMEOUT' : 'AGENT_FAILED',
        result.errorMessage ?? `Agent process ended as ${result.status}`,
      ),
      inspection.clean ? 'FAILED' : 'BLOCKED',
    );
  }

  private async finishHandoff(prepared: PreparedTask, result: AgentResult): Promise<void> {
    const taskDiff = (await this.git.run(prepared.worktree.path, [
      'diff', '--no-ext-diff', '--no-color', prepared.preparedHeadSha,
    ])).stdout;
    const requiredCanonicalFindings = this.requiredCanonicalFindings(
      prepared.task.id,
      prepared.previousReviewFindings,
    );
    const parsed = await this.parseOrRepairHandoff(
      prepared.task,
      result.structuredHandoff,
      result.rawStdout ?? null,
      requiredCanonicalFindings,
      taskDiff,
    );
    await this.recordHandoffOutcome(prepared.task.id, parsed.outcome);
    if (parsed.handoff === null) {
      throw parsed.error;
    }
    await this.finishParsedHandoff(prepared, parsed.handoff);
  }

  /** Trusted assignment context comes from persisted orchestrator state, never agent output. */
  private requiredCanonicalFindings(
    taskId: string,
    immediatelyRelevantFindings: readonly unknown[] = [],
  ): readonly RequiredCanonicalFinding[] {
    const adaptive = this.state.adaptive;
    if (adaptive === undefined) return [];
    const unit = adaptive.workUnits.find((candidate) => candidate.id === taskId);
    const request = adaptive.workRequests.find((candidate) => candidate.id === unit?.requestId);
    const authorization = request?.authorization;
    if (authorization?.purpose !== 'correction') return [];
    const imported = adaptive.continuation?.findings.find(
      (candidate) => candidate.canonicalFindingKey === authorization.canonicalFindingKey,
    );
    const directlyRelevant = immediatelyRelevantFindings.find((candidate) =>
      isRecord(candidate) && candidate.id === authorization.findingReference,
    );
    return [{
      findingId: authorization.findingReference,
      canonicalFindingKey: authorization.canonicalFindingKey,
      sourceWorkUnitId: authorization.sourceWorkUnitId,
      artifactPath: authorization.artifactPath,
      ...(imported?.finding === undefined && directlyRelevant === undefined
        ? {}
        : { finding: imported?.finding ?? directlyRelevant }),
    }];
  }

  /**
   * §11 (real Phase 5 dogfood recovery): the exact same ownership/commit/
   * succeed logic the live run always used, extracted so a repaired-handoff
   * recovery path (recoverHandoffFailures) goes through IDENTICAL gates —
   * never a shortcut merely because it is recovery.
   */
  private async finishParsedHandoff(
    prepared: PreparedTask,
    handoff: StructuredHandoff,
  ): Promise<void> {
    const handoffPath = await writeHandoff(
      join(this.stateStore.runDirectory, 'handoffs'),
      prepared.task.id,
      handoff,
    );
    await this.event('HANDOFF_WRITTEN', prepared.task.id, { handoffPath });
    if (handoff.status !== 'complete') {
      // An escalation (JUDGE) task that cannot resolve the disagreement is
      // exactly the BLOCKED_FOR_HUMAN_REVIEW case final_review already uses
      // below in finishReview — same terminal meaning ("no automated path
      // forward"), so it gets the same stable code rather than the generic
      // REVIEW_BLOCKED a plain review-mode task would report.
      const blockedCode =
        prepared.task.mode === 'escalation' ? 'BLOCKED_FOR_HUMAN_REVIEW' : 'REVIEW_BLOCKED';
      await this.failTask(
        prepared.task.id,
        new OrchestratorError(
          handoff.status === 'blocked' ? blockedCode : 'AGENT_FAILED',
          handoff.summary,
        ),
        handoff.status === 'blocked' ? 'BLOCKED' : 'FAILED',
        handoffPath,
      );
      return;
    }

    let commit: TaskCommitState | undefined;
    if (prepared.task.writer) {
      const ensured = await ensureTaskCommit(this.git, {
        worktreePath: prepared.worktree.path,
        baseSha: prepared.preparedHeadSha,
        agent: prepared.task.owner,
        taskId: prepared.task.id,
        summary: handoff.summary,
        allowEmpty: prepared.task.mode === 'correction',
      });
      assertChangedFileOwnership(prepared.task.id, ensured.changedFiles, prepared.task.files);
      commit = {
        sha: ensured.commitSha,
        parentSha: prepared.preparedHeadSha,
        changedFiles: ensured.changedFiles,
      };
      await this.event('TASK_COMMITTED', prepared.task.id, {
        commitSha: ensured.commitSha,
        changedFiles: ensured.changedFiles,
      });
    } else {
      await this.assertReadOnlyTaskClean(prepared);
    }

    await this.submitAdditionalAdaptiveRequests(prepared.task.id, handoff.additionalWorkRequests, false);
    await this.succeedTask(prepared.task.id, handoffPath, commit);
    await this.reconcileAdaptiveCorrectionFlow();
    await this.advanceAdaptiveScheduling();
  }

  /**
   * §6/§7/§10 bounded handoff repair. Only ever triggered by an actual
   * HANDOFF_INVALID from the real validator (never a broader catch-all) —
   * any other error propagates unchanged. Records handoffOutcome/
   * handoffRepairAttempted/handoffRepairSucceeded either way, so a task that
   * still fails after a failed repair is clearly distinguishable in metrics
   * from an actual agent-implementation failure.
   */
  private async parseOrRepairHandoff(
    task: TaskSpec,
    rawStructuredHandoff: unknown,
    rawStdout: string | null,
    requiredCanonicalFindings: readonly RequiredCanonicalFinding[] = [],
    taskDiff = '',
  ): Promise<
    | { readonly handoff: StructuredHandoff; readonly error: null; readonly outcome: HandoffOutcomeRecord }
    | { readonly handoff: null; readonly error: unknown; readonly outcome: HandoffOutcomeRecord }
  > {
    try {
      const handoff = parseHandoff(rawStructuredHandoff);
      validateCanonicalFindingResponses(handoff, requiredCanonicalFindings);
      return { handoff, error: null, outcome: { outcome: 'valid', repairAttempted: false } };
    } catch (error) {
      if (!isOrchestratorError(error, 'HANDOFF_INVALID')) {
        throw error;
      }
      const repaired = await this.repairHandoff(
        task, rawStructuredHandoff, rawStdout, requiredCanonicalFindings, taskDiff,
      );
      const record: HandoffRepairAttemptRecord = repaired.ok
        ? {
            method: repaired.method,
            succeeded: true,
            timestamp: this.clock().toISOString(),
            ...(repaired.executorId === undefined ? {} : { repairExecutorId: repaired.executorId }),
            ...(repaired.adapter === undefined ? {} : { repairAdapter: repaired.adapter }),
          }
        : { method: 'none', succeeded: false, failureReason: repaired.reason, timestamp: this.clock().toISOString() };
      await this.event('HANDOFF_REPAIR_ATTEMPTED', task.id, {
        method: record.method,
        succeeded: record.succeeded,
        ...(record.failureReason === undefined ? {} : { failureReason: record.failureReason }),
      });
      if (!repaired.ok) {
        return {
          handoff: null,
          error,
          outcome: { outcome: 'invalid', repairAttempted: true, repairRecord: record },
        };
      }
      return {
        handoff: repaired.handoff,
        error: null,
        outcome: { outcome: 'valid', repairAttempted: true, repairRecord: record },
      };
    }
  }

  private async recordHandoffOutcome(taskId: string, outcome: HandoffOutcomeRecord): Promise<void> {
    await this.mutate((state) => updateTask(state, taskId, (task) => ({
      ...task,
      handoffOutcome: outcome.outcome,
      ...(outcome.repairRecord === undefined
        ? {}
        : { handoffRepairAttempts: [...task.handoffRepairAttempts, outcome.repairRecord] }),
    })));
  }

  /**
   * §10 (real Phase 5 dogfood recovery, run-20260822094645-5b090308,
   * explorer-final-review): a second real transport failure — Claude's
   * response was semantically a valid review, but prefaced with prose
   * explaining why it was returning JSON, so whole-text JSON.parse failed
   * before validation ever ran. Framing extraction (Layer A,
   * src/protocol/structured-output.ts) is tried FIRST because it is the
   * cheapest and it is what actually resolves that failure mode; it fails
   * closed immediately on genuine ambiguity (never falls through to a
   * cheaper/costlier guess in that case, since guessing is exactly what
   * ambiguity handling exists to prevent). Deterministic key repair is next
   * — free, and what resolved the FIRST real failure (a description baked
   * into a key). Only if neither resolves it does this fall through to one
   * bounded, read-only agent call. Never loops, never retries the agent
   * step, never touches the original worktree.
   */
  private async repairHandoff(
    task: TaskSpec,
    rawStructuredHandoff: unknown,
    rawStdout: string | null,
    requiredCanonicalFindings: readonly RequiredCanonicalFinding[],
    taskDiff: string,
  ): Promise<RepairOutcome> {
    const validate = (value: unknown): StructuredHandoff => {
      const handoff = validateHandoff(value);
      validateCanonicalFindingResponses(handoff, requiredCanonicalFindings);
      return handoff;
    };
    const framed = extractStructuredPayload(rawStdout, validate);
    if (framed.ok) {
      return { ok: true, handoff: framed.value, method: 'framing' };
    }
    if (framed.reason === 'ambiguous') {
      return { ok: false, reason: 'evidence_insufficient' };
    }

    const deterministic = deterministicallyRepairHandoffKeys(rawStructuredHandoff);
    if (deterministic.changed) {
      try {
        const handoff = parseHandoff(deterministic.value);
        validateCanonicalFindingResponses(handoff, requiredCanonicalFindings);
        return { ok: true, handoff, method: 'deterministic' };
      } catch {
        // The rename didn't fully resolve it (e.g. a second, genuinely
        // unrecognized field) — fall through rather than guessing further.
      }
    }
    const original = (() => {
      try { return parseHandoff(rawStructuredHandoff); } catch { return undefined; }
    })();
    const repaired = await this.repairHandoffViaAgent(
      task, rawStructuredHandoff, requiredCanonicalFindings, taskDiff, original,
    );
    return repaired.ok
      ? { ok: true, handoff: repaired.handoff, method: 'agent', executorId: repaired.executorId, adapter: repaired.adapter }
      : repaired;
  }

  /**
   * Selects who actually runs a bounded handoff_repair call — deliberately
   * NEVER the same thing as task.owner (which continues to truthfully
   * record who produced the original code; see the docs/superpowers spec
   * for this hardening). Recovery routing is resolved solely from the most
   * recently authorized recovery-policy overlay's executors
   * (this.recoveryExecutors, set once at load time in
   * loadRunForContinuation) — adaptive executors are never consulted here,
   * since 'handoff_repair' is deliberately excluded from AdaptiveRole.
   *
   * Backward compatible by design: no policy ever authorized ->
   * this.recoveryExecutors is undefined -> falls back to task.owner, the
   * historical behavior every existing run/test already depends on.
   *
   * FAILS CLOSED once executors are explicitly configured: if
   * recoveryExecutors is a non-undefined (even empty) array and no entry is
   * available, declares the 'handoff_repair' role, AND declares the
   * 'handoff_repair' capability, this returns { ok: false } — it never
   * silently falls back to task.owner in that case. An operator who
   * explicitly configured a specific recovery executor and had it turn out
   * unavailable must see that failure, not have Codex quietly consume an
   * attempt instead.
   */
  private resolveHandoffRepairExecutor(
    task: TaskSpec,
  ): { readonly ok: true; readonly agent: Agent; readonly executorId: string; readonly adapter: AgentName } | { readonly ok: false } {
    if (this.recoveryExecutors === undefined) {
      return { ok: true, agent: this.agents[task.owner], executorId: task.owner, adapter: task.owner };
    }
    const eligible = this.recoveryExecutors.find((executor) =>
      executor.available
      && executor.roles.includes('handoff_repair')
      && executor.capabilities.some((capability) => capability.capability === 'handoff_repair'));
    if (eligible === undefined) {
      return { ok: false };
    }
    return { ok: true, agent: this.agents[eligible.adapter], executorId: eligible.id, adapter: eligible.adapter };
  }

  /**
   * §6: a single, short, read-only invocation that never touches the
   * original task worktree — it runs in its own throwaway directory under
   * the run's own state, because reformatting JSON needs no repository
   * access at all. One attempt only; a failure here means "fail closed", not
   * "retry" — see repairHandoff's caller.
   */
  private async repairHandoffViaAgent(
    task: TaskSpec,
    malformedOutput: unknown,
    requiredCanonicalFindings: readonly RequiredCanonicalFinding[],
    taskDiff: string,
    originalHandoff?: StructuredHandoff,
  ): Promise<
    { readonly ok: true; readonly handoff: StructuredHandoff; readonly executorId: string; readonly adapter: AgentName }
    | { readonly ok: false; readonly reason: HandoffRepairFailureReason }
  > {
    const routing = this.resolveHandoffRepairExecutor(task);
    if (!routing.ok) {
      // Fails closed BEFORE constructing or sending any AgentRequest — an
      // explicitly-configured-but-ineligible recovery policy must never
      // consume an agent call, on any adapter, silently or otherwise.
      return { ok: false, reason: 'no_eligible_recovery_executor' };
    }
    const repairDirectory = join(this.stateStore.runDirectory, 'repairs', task.id);
    await mkdir(repairDirectory, { recursive: true, mode: 0o700 });
    const request: AgentRequest = {
      runId: this.state.runId,
      taskId: `${task.id}-handoff-repair`,
      role: 'handoff_repair',
      worktreePath: repairDirectory,
      baseSha: this.state.baseSha,
      taskSpecification: {
        malformedOutput,
        ...(requiredCanonicalFindings.length === 0 ? {} : {
          repairKind: 'canonical_finding_metadata',
          requiredCanonicalFindings,
          deterministicTaskEvidence: {
            taskDiff,
            tests: originalHandoff?.tests ?? [],
            filesChanged: originalHandoff?.filesChanged ?? [],
          },
          safety: 'Add metadata only. Do not claim resolved unless the supplied diff/tests support it; otherwise use unresolved or fail.',
        }),
        responseSchema: handoffResponseSchema(this.state.strategy === 'adaptive'),
        responseSchemaNotes: handoffResponseSchemaNotes(this.state.strategy === 'adaptive'),
      },
      ...(this.state.strategy === 'adaptive' ? { adaptive: true } : {}),
      canonicalDesignDocumentPath: join(this.repositoryRoot, this.config.canonicalDesignDocument),
      allowedFileOwnership: [],
      dependencyHandoffs: [],
      previousReviewFindings: [],
      requestedEffort: 'medium',
      timeoutMs: HANDOFF_REPAIR_TIMEOUT_MS,
      artifactsDirectory: join(this.stateStore.runDirectory, 'logs'),
      access: 'read_only',
      attempt: 1,
    };
    // §6: "fail closed" means exactly that — an agent that cannot even be
    // invoked (a genuinely unexpected throw, not the ordinary
    // succeeded/failed/timed_out result shape) must fall back to null here,
    // never propagate and overwrite the original, more specific
    // HANDOFF_INVALID with a generic uncaught-error code.
    let result: AgentResult;
    try {
      result = await routing.agent.run(request);
    } catch {
      return { ok: false, reason: 'agent_invocation_failed' };
    }
    if (result.status !== 'succeeded') {
      return { ok: false, reason: 'agent_invocation_failed' };
    }
    try {
      const repaired = parseHandoff(result.structuredHandoff);
      validateCanonicalFindingResponses(repaired, requiredCanonicalFindings);
      if (originalHandoff !== undefined) {
        const withoutResponses = (handoff: StructuredHandoff): unknown => {
          const { findingResponses: _responses, ...rest } = handoff;
          return rest;
        };
        if (JSON.stringify(withoutResponses(repaired)) !== JSON.stringify(withoutResponses(originalHandoff))) {
          return { ok: false, reason: 'contradiction_detected' };
        }
        const claimsResolved = repaired.findingResponses?.some((response) =>
          response.decision === 'confirmed' && response.resolution === 'resolved');
        if (claimsResolved && (taskDiff.trim() === '' || !originalHandoff.tests.some((test) => test.result === 'pass'))) {
          return { ok: false, reason: 'evidence_insufficient' };
        }
      }
      return { ok: true, handoff: repaired, executorId: routing.executorId, adapter: routing.adapter };
    } catch {
      return { ok: false, reason: 'evidence_insufficient' };
    }
  }

  private async finishReview(prepared: PreparedTask, result: AgentResult): Promise<void> {
    await this.assertReadOnlyTaskClean(prepared);
    const parsed = await this.parseOrRecoverReview(
      prepared.task,
      result.structuredHandoff,
      result.rawStdout ?? null,
    );
    await this.recordHandoffOutcome(prepared.task.id, parsed.outcome);
    if (parsed.review === null) {
      throw parsed.error;
    }
    await this.finishParsedReview(prepared, parsed.review);
  }

  /**
   * §10/§11 (real Phase 5 dogfood recovery): review parsing has no
   * deterministic-key-repair or agent-repair tier — Fix A already gives
   * reviews exact bare keys, so the only real failure mode left is framing
   * (surrounding prose), which extractStructuredPayload alone resolves. A
   * candidate that is syntactically valid JSON but semantically wrong (bad
   * status, unknown key, missing evidence, ...) still fails validateReview
   * exactly as before — this never loosens what a "valid" review means.
   */
  private async parseOrRecoverReview(
    task: TaskSpec,
    rawStructuredHandoff: unknown,
    rawStdout: string | null,
  ): Promise<
    | { readonly review: StructuredReview; readonly error: null; readonly outcome: HandoffOutcomeRecord }
    | { readonly review: null; readonly error: unknown; readonly outcome: HandoffOutcomeRecord }
  > {
    try {
      const review = parseReview(rawStructuredHandoff);
      return { review, error: null, outcome: { outcome: 'valid', repairAttempted: false } };
    } catch (error) {
      if (!isOrchestratorError(error, 'REVIEW_BLOCKED')) {
        throw error;
      }
      const framed = extractStructuredPayload(rawStdout, validateReview);
      const record: HandoffRepairAttemptRecord = framed.ok
        ? { method: 'framing', succeeded: true, timestamp: this.clock().toISOString() }
        : { method: 'none', succeeded: false, failureReason: 'evidence_insufficient', timestamp: this.clock().toISOString() };
      await this.event('HANDOFF_REPAIR_ATTEMPTED', task.id, {
        method: record.method,
        succeeded: record.succeeded,
        ...(record.failureReason === undefined ? {} : { failureReason: record.failureReason }),
      });
      if (!framed.ok) {
        return {
          review: null,
          error,
          outcome: { outcome: 'invalid', repairAttempted: true, repairRecord: record },
        };
      }
      return {
        review: framed.value,
        error: null,
        outcome: { outcome: 'valid', repairAttempted: true, repairRecord: record },
      };
    }
  }

  /**
   * §11: the exact same escalation-routing/succeed logic the live run
   * always used, extracted so a recovered-review recovery path
   * (recoverHandoffFailures) goes through IDENTICAL gates.
   */
  private async finishParsedReview(prepared: PreparedTask, review: StructuredReview): Promise<void> {
    const reviewPath = join(
      this.stateStore.runDirectory,
      'reviews',
      `${prepared.task.id}.json`,
    );
    await atomicArtifactWrite(reviewPath, review);
    for (const finding of review.findings) {
      await this.event('FINDING_REPORTED', prepared.task.id, {
        id: finding.id,
        severity: finding.severity,
        category: finding.category,
        file: finding.file,
      });
    }
    // §8 escalation seam: a non-approved final_review normally stops the run
    // as BLOCKED_FOR_HUMAN_REVIEW immediately below, unconditionally — that
    // remains the exact behavior for every phase that does not opt in, AND
    // for one that opts in but whose remaining findings don't clear the
    // severity bar (§5: medium/low alone must not invoke the expensive
    // Judge — the run still stops for a human, it just does so without
    // paying for arbitration first). It changes only when BOTH (a) this task
    // has an escalation-mode (JUDGE) dependent in the graph, detected
    // structurally, and (b) at least one remaining finding meets that
    // dependent's own minimumSeverity (default 'high'): then the
    // disagreement is handed to the Judge for one bounded attempt instead.
    const escalationDependent = this.findEscalationDependent(prepared.task.id);
    const escalationMinimumSeverity = escalationDependent?.condition?.minimumSeverity ?? 'high';
    const routeToEscalation =
      prepared.task.mode === 'final_review'
      && review.status !== 'approved'
      && escalationDependent !== undefined
      && review.findings.some((finding) => severityAtLeast(finding.severity, escalationMinimumSeverity));
    const adaptiveRequestId = this.state.adaptive?.workUnits.find(
      (unit) => unit.id === prepared.task.id,
    )?.requestId;
    const feedsAdaptiveSynthesis = adaptiveRequestId !== undefined && (this.state.adaptive?.workRequests.some(
      (request) => request.role === 'synthesis' && request.dependencies.includes(adaptiveRequestId),
    ) ?? false);
    const adaptiveUnresolvedWithoutCorrection =
      this.state.strategy === 'adaptive'
      && review.status === 'changes_requested'
      && !feedsAdaptiveSynthesis
      && this.adaptiveConfig?.policy.correctionPolicy === undefined;
    if (
      !routeToEscalation
      && (review.status === 'blocked'
        || adaptiveUnresolvedWithoutCorrection
        || (prepared.task.mode === 'final_review' && review.status !== 'approved'
          && this.adaptiveConfig?.policy.correctionPolicy === undefined))
    ) {
      await this.failTask(
        prepared.task.id,
        new OrchestratorError(
          prepared.task.mode === 'final_review' || adaptiveUnresolvedWithoutCorrection
            ? 'BLOCKED_FOR_HUMAN_REVIEW'
            : 'REVIEW_BLOCKED',
          `Review ${prepared.task.id} ended as ${review.status}`,
        ),
        'BLOCKED',
        undefined,
        reviewPath,
      );
      return;
    }
    await this.submitAdditionalAdaptiveRequests(prepared.task.id, review.additionalWorkRequests, false);
    await this.mutate((state) => updateTask(state, prepared.task.id, (task) => {
      const { error: _previousError, ...withoutError } = task;
      return {
        ...withoutError,
        status: 'SUCCEEDED',
        reviewRounds: task.reviewRounds + 1,
        reviewPaths: [...task.reviewPaths, reviewPath],
        finishedAt: this.clock().toISOString(),
      };
    }));
    await this.event('TASK_SUCCEEDED', prepared.task.id, { reviewStatus: review.status });
    await this.finishAdaptiveUnit(prepared.task.id, 'SUCCEEDED');
    await this.reconcileAdaptiveCorrectionFlow();
    await this.advanceAdaptiveScheduling();
  }

  private async executeDebate(prepared: PreparedTask): Promise<void> {
    const proposals = await Promise.all((['codex', 'claude'] as const).map(async (name) => {
      const result = await this.runDebateStage(
        {
          ...prepared,
          task: { ...prepared.task, owner: name },
        },
        this.agents[name],
      );
      return { name, handoff: parseHandoff(result.structuredHandoff) };
    }));
    if (proposals.some(({ handoff }) => handoff.status !== 'complete')) {
      throw new OrchestratorError('REVIEW_BLOCKED', 'Architecture proposal was not completed');
    }
    const critiques = await Promise.all(proposals.map(async ({ name }, index) => {
      const other = proposals[index === 0 ? 1 : 0]!;
      const result = await this.runDebateStage(
        {
          ...prepared,
          task: { ...prepared.task, owner: name },
          dependencyHandoffs: [other.handoff],
        },
        this.agents[name],
      );
      return { name, handoff: parseHandoff(result.structuredHandoff) };
    }));
    const artifact = { status: 'complete', proposals, critiques };
    const path = join(this.stateStore.runDirectory, 'handoffs', `${prepared.task.id}.debate.json`);
    await atomicArtifactWrite(path, artifact);
    await this.succeedTask(prepared.task.id, path);
  }

  private async runDebateStage(prepared: PreparedTask, agent: Agent): Promise<AgentResult> {
    let retriesUsed = 0;
    while (true) {
      const result = await this.runTrackedAgent(prepared, agent);
      if (result.status === 'succeeded') return result;
      const inspection = await inspectTaskCommits(
        this.git,
        prepared.worktree.path,
        prepared.preparedHeadSha,
      );
      if (
        INFRASTRUCTURE_FAILURES.has(result.status)
        && retriesUsed < this.config.agentRetries
        && inspection.clean
        && inspection.commits.length === 0
      ) {
        retriesUsed += 1;
        continue;
      }
      throw new OrchestratorError(
        result.failureCode === 'AGENT_TIMEOUT' ? 'AGENT_TIMEOUT' : 'AGENT_FAILED',
        result.errorMessage ?? `${agent.name} debate stage ended as ${result.status}`,
      );
    }
  }

  private async assertReadOnlyTaskClean(prepared: PreparedTask): Promise<void> {
    const inspection = await inspectTaskCommits(
      this.git,
      prepared.worktree.path,
      prepared.preparedHeadSha,
    );
    if (!inspection.clean || inspection.commits.length > 0) {
      throw new OrchestratorError(
        'OWNERSHIP_VIOLATION',
        `Read-only task ${prepared.task.id} changed its worktree`,
      );
    }
  }

  /** True if any task in the graph both depends on `taskId` and has mode 'escalation'. */
  /**
   * The escalation-mode (JUDGE) task that graph-depends on `taskId`, if any.
   * §5's severity threshold lives on THAT task's own `condition.minimumSeverity`
   * rather than being duplicated in a second config location — 'high' is the
   * MVP default (§5) when the escalation task declares no condition at all,
   * e.g. a hand-authored phase file that didn't opt into the generic
   * condition mechanism.
   */
  private findEscalationDependent(taskId: string): TaskSpec | undefined {
    return this.config.tasks.find(
      (candidate) => candidate.mode === 'escalation' && candidate.dependsOn.includes(taskId),
    );
  }

  private dependencyCommits(task: TaskSpec): IntegrationCommit[] {
    const graph = new TaskGraph(this.config.tasks);
    return ancestorTasks(task, graph).flatMap((ancestor) => {
      const commit = this.state.tasks[ancestor.id]?.commit;
      return commit === undefined ? [] : [{ taskId: ancestor.id, commitSha: commit.sha }];
    });
  }

  private async integrateAndVerify(): Promise<void> {
    const commits = new TaskGraph(this.config.tasks).topologicalOrder().flatMap((task) => {
      const commit = this.state.tasks[task.id]?.commit;
      return commit === undefined ? [] : [{ taskId: task.id, commitSha: commit.sha }];
    });

    let worktree: OwnedWorktree;
    if (this.state.integration.worktreePath !== undefined) {
      worktree = await this.worktrees.assertRegistered(this.state.integration.worktreePath);
    } else {
      const recovered = (await this.worktrees.listOwned()).filter(
        (entry) => entry.runId === this.state.runId && entry.kind === 'integration',
      );
      if (recovered.length > 1) {
        await this.blockIntegration(new OrchestratorError(
          'STATE_CORRUPT',
          'Run owns more than one integration worktree',
        ));
        return;
      }
      worktree = recovered[0] ?? await this.worktrees.createIntegrationWorktree({
        runId: this.state.runId,
        baseBranch: this.state.baseBranch,
        baseSha: this.state.baseSha,
      });
      await this.event('INTEGRATION_STARTED');
      await this.mutate((state) => ({
        ...state,
        integration: {
          ...state.integration,
          status: 'RUNNING',
          worktreePath: worktree.path,
          branch: worktree.branch,
        },
      }));
    }

    if (this.state.integration.headSha === undefined) {
      const before = await inspectTaskCommits(this.git, worktree.path, this.state.baseSha);
      if (!before.clean || before.commits.length > 0) {
        await this.blockIntegration(new OrchestratorError(
          'INTEGRATION_CONFLICT',
          'Interrupted integration worktree is not at its recorded pre-integration base; preserving it for inspection',
          { details: { worktreePath: worktree.path, headSha: before.headSha } },
        ));
        return;
      }
      const integrated = await integrateTaskCommits(this.git, worktree.path, commits);
      if (integrated.status === 'conflict') {
        const error = integrationConflictError(integrated);
        await this.blockIntegration(error);
        return;
      }
      await this.mutate((state) => ({
        ...state,
        integration: {
          ...state.integration,
          status: 'RUNNING',
          headSha: integrated.headSha,
          integratedTaskCommits: integrated.applied.map(({ commitSha }) => commitSha),
        },
      }));
    } else {
      const inspection = await inspectTaskCommits(this.git, worktree.path, this.state.baseSha);
      const expectedCommits = commits.map(({ commitSha }) => commitSha);
      const trackedCheckpointClean = this.state.integration.preparation === undefined
        ? inspection.clean
        : (await this.git.run(worktree.path, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim() === '';
      if (
        !trackedCheckpointClean
        || inspection.headSha !== this.state.integration.headSha
        || !sameStrings(this.state.integration.integratedTaskCommits, expectedCommits)
      ) {
        await this.blockIntegration(new OrchestratorError(
          'STATE_CORRUPT',
          'Integration worktree no longer matches its persisted checkpoint',
          { details: { worktreePath: worktree.path } },
        ));
        return;
      }
    }

    const preparationReusable = canReuseIntegrationPreparation(
      this.state.integration.preparation,
      worktree.path,
      this.state.integration.headSha,
      this.config.integration.prepare.length,
    );
    if (!preparationReusable) {
      const startedAt = this.clock().toISOString();
      await this.event('INTEGRATION_PREPARATION_STARTED', undefined, {
        worktreePath: worktree.path,
        headSha: this.state.integration.headSha,
      });
      await this.mutate((state) => ({
        ...state,
        integration: {
          ...state.integration,
          preparation: {
            status: 'RUNNING', worktreePath: worktree.path, headSha: state.integration.headSha!,
            commands: [], startedAt,
          },
        },
      }));
      const preparation = await new IntegrationGate().run({
        cwd: worktree.path,
        logsDirectory: join(this.stateStore.runDirectory, 'logs', 'integration', 'preparation'),
        commands: this.config.integration.prepare,
        ...(this.signal === undefined ? {} : { signal: this.signal }),
        onCommandFinished: async (command, index) => {
          await this.mutate((state) => ({
            ...state,
            integration: {
              ...state.integration,
              preparation: {
                ...state.integration.preparation!,
                commands: [...state.integration.preparation!.commands, command],
              },
            },
          }));
          await this.event('INTEGRATION_PREPARATION_COMMAND_FINISHED', undefined, {
            index, command: command.command, required: command.required, exitCode: command.exitCode,
            timedOut: command.timedOut, termination: command.termination, durationMs: command.durationMs,
            stdoutPath: command.stdoutPath, stderrPath: command.stderrPath,
          });
        },
      });
      const finishedAt = this.clock().toISOString();
      await this.mutate((state) => ({
        ...state,
        integration: {
          ...state.integration,
          preparation: {
            ...state.integration.preparation!,
            status: preparation.passed ? 'SUCCEEDED' : 'FAILED',
            commands: preparation.commands,
            finishedAt,
          },
        },
      }));
      if (this.signal?.aborted === true) {
        await this.cancelRun('Integration preparation was aborted');
        return;
      }
      if (!preparation.passed) {
        await this.event('INTEGRATION_PREPARATION_FAILED', undefined, { worktreePath: worktree.path });
        await this.blockIntegration(new OrchestratorError(
          'INTEGRATION_PREPARATION_FAILED',
          'A required integration preparation command failed',
        ));
        return;
      }
      const afterPrepareHead = await this.git.resolveCommit(worktree.path, 'HEAD');
      const trackedChanges = (await this.git.run(worktree.path, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
      if (afterPrepareHead !== this.state.integration.headSha || trackedChanges !== '') {
        await this.mutate((state) => ({
          ...state,
          integration: {
            ...state.integration,
            preparation: { ...state.integration.preparation!, status: 'FAILED' },
          },
        }));
        await this.event('INTEGRATION_PREPARATION_FAILED', undefined, {
          worktreePath: worktree.path, afterPrepareHead, trackedChanges,
        });
        await this.blockIntegration(new OrchestratorError(
          'INTEGRATION_PREPARATION_FAILED',
          'Integration preparation modified tracked source or created a commit',
          { details: { afterPrepareHead, trackedChanges } },
        ));
        return;
      }
    }

    const verificationGate = await new IntegrationGate().run({
      cwd: worktree.path,
      logsDirectory: join(this.stateStore.runDirectory, 'logs', 'integration'),
      commands: this.config.integration.commands,
      diagnostics: this.config.integration.diagnostics,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
    for (const [index, command] of verificationGate.commands.entries()) {
      await this.event('INTEGRATION_COMMAND_FINISHED', undefined, {
        index,
        command: command.command,
        required: command.required,
        exitCode: command.exitCode,
        timedOut: command.timedOut,
        termination: command.termination,
        durationMs: command.durationMs,
        stdoutPath: command.stdoutPath,
        stderrPath: command.stderrPath,
      });
    }
    if (this.signal?.aborted === true) {
      await this.cancelRun('Integration verification was aborted');
      return;
    }
    if (!verificationGate.passed) {
      await this.blockIntegration(new OrchestratorError(
        'INTEGRATION_TEST_FAILED',
        'A required integration command failed',
      ));
      return;
    }
    await this.mutate((state) => ({
      ...state,
      status: 'COMPLETED',
      integration: {
        ...state.integration,
        status: 'SUCCEEDED',
      },
    }));
    await this.event('RUN_COMPLETED', undefined, {
      integrationBranch: worktree.branch,
      humanApprovalRequired: true,
    });
  }

  private async blockIntegration(error: OrchestratorError): Promise<void> {
    await this.mutate((state) => ({
      ...state,
      status: 'BLOCKED',
      integration: {
        ...state.integration,
        status: 'BLOCKED',
        error: storedError(error.code, error.message, this.clock, error.details),
      },
      errors: [...state.errors, storedError(error.code, error.message, this.clock, error.details)],
    }));
    await this.event('RUN_BLOCKED', undefined, { code: error.code, message: error.message });
  }

  private async cancelRun(reason: string): Promise<void> {
    if (this.state.status === 'CANCELLED') return;
    const finishedAt = this.clock().toISOString();
    await this.mutate((state) => ({
      ...state,
      status: 'CANCELLED',
      tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [
        id,
        ['PENDING', 'READY', 'RUNNING'].includes(task.status)
          ? { ...task, status: 'CANCELLED' as const, finishedAt }
          : task,
      ])),
      integration: ['PENDING', 'RUNNING'].includes(state.integration.status)
        ? { ...state.integration, status: 'CANCELLED' }
        : state.integration,
    }));
    await this.event('RUN_CANCELLED', undefined, { reason });
  }

  private async succeedTask(
    taskId: string,
    handoffPath: string,
    commit?: TaskCommitState,
  ): Promise<void> {
    await this.mutate((state) => updateTask(state, taskId, (task) => {
      const { error: _previousError, ...withoutError } = task;
      return {
        ...withoutError,
        status: 'SUCCEEDED',
        handoffPath,
        ...(commit === undefined ? {} : { commit }),
        finishedAt: this.clock().toISOString(),
      };
    }));
    await this.event('TASK_SUCCEEDED', taskId);
    await this.finishAdaptiveUnit(taskId, 'SUCCEEDED');
  }

  private async failTask(
    taskId: string,
    error: unknown,
    status: 'FAILED' | 'BLOCKED',
    handoffPath?: string,
    reviewPath?: string,
  ): Promise<void> {
    const normalized = normalizeError(error, this.clock);
    await this.mutate((state) => ({
      ...updateTask(state, taskId, (task) => ({
        ...task,
        status,
        ...(handoffPath === undefined ? {} : { handoffPath }),
        ...(reviewPath === undefined
          ? {}
          : { reviewPaths: [...task.reviewPaths, reviewPath] }),
        finishedAt: this.clock().toISOString(),
        error: normalized,
      })),
      errors: [...state.errors, normalized],
    }));
    await this.event('TASK_FAILED', taskId, {
      code: normalized.code,
      status,
      message: normalized.message,
    });
    await this.finishAdaptiveUnit(
      taskId,
      normalized.code === 'AGENT_TIMEOUT' ? 'TIMED_OUT' : 'FAILED',
      normalized.message,
    );
  }

  private taskAttemptStdoutLogPath(taskId: string, attempt: AgentAttemptState): string {
    return join(
      this.stateStore.runDirectory,
      'logs',
      `${this.state.runId}.${taskId}.${attempt.agent}.attempt-${attempt.attempt}.stdout.log`,
    );
  }

  /**
   * Provider-neutral eligibility for an explicitly requested retry. The
   * decision is made from persisted execution structure, never provider text:
   * a terminal process outcome, no accepted protocol artifact, and an
   * unchanged registered worktree at its prepared checkpoint.
   */
  private async checkAgentFailureRetryEligibility(
    taskId: string,
  ): Promise<{ readonly eligible: boolean; readonly reason: string }> {
    if (this.state.status !== 'FAILED' && this.state.status !== 'BLOCKED') {
      return {
        eligible: false,
        reason: `run status is ${this.state.status}, not FAILED or BLOCKED`,
      };
    }
    if (Object.values(this.state.tasks).some((task) =>
      task.status === 'PENDING' || task.status === 'READY' || task.status === 'RUNNING')) {
      return { eligible: false, reason: 'run still contains non-terminal tasks' };
    }
    if (
      this.state.integration.status !== 'PENDING'
      || this.state.integration.integratedTaskCommits.length > 0
      || (this.state.integration.integrationFixCommits?.length ?? 0) > 0
      || this.state.integration.worktreePath !== undefined
      || this.state.integration.branch !== undefined
      || this.state.integration.headSha !== undefined
      || this.state.integration.currentCommand !== undefined
      || this.state.integration.error !== undefined
      || (this.state.integrationAttempts?.length ?? 0) > 0
    ) {
      return { eligible: false, reason: 'integration has started or has its own recovery state' };
    }

    const taskSpec = this.config.tasks.find((task) => task.id === taskId);
    const taskState = this.state.tasks[taskId];
    if (taskSpec === undefined || taskState === undefined) {
      return { eligible: false, reason: 'task id does not exist in this run' };
    }
    if (taskState.status !== 'FAILED') {
      return { eligible: false, reason: `task status is ${taskState.status}, not FAILED` };
    }
    const lastAttempt = taskState.agentAttempts.at(-1);
    const processFailure =
      (taskState.error?.code === 'AGENT_FAILED' && lastAttempt?.outcome === 'failed')
      || (taskState.error?.code === 'AGENT_TIMEOUT' && lastAttempt?.outcome === 'timed_out');
    if (!processFailure || lastAttempt?.finishedAt === undefined) {
      return {
        eligible: false,
        reason: 'failure is not a completed agent/process-layer AGENT_FAILED or AGENT_TIMEOUT attempt',
      };
    }
    if (lastAttempt.agent !== taskSpec.owner) {
      return { eligible: false, reason: 'last attempt agent does not match the task owner' };
    }
    if (taskState.commit !== undefined) {
      return { eligible: false, reason: 'a successful task commit is already recorded' };
    }
    if (
      taskState.handoffPath !== undefined
      || taskState.reviewPaths.length > 0
      || taskState.handoffOutcome !== undefined
      || taskState.handoffRepairAttempts.length > 0
    ) {
      return { eligible: false, reason: 'a structured handoff/review outcome has already been accepted or evaluated' };
    }
    const unsatisfiedDependencies = taskSpec.dependsOn.filter((dependencyId) => {
      const status = this.state.tasks[dependencyId]?.status;
      return status !== 'SUCCEEDED' && status !== 'SKIPPED';
    });
    if (unsatisfiedDependencies.length > 0) {
      return {
        eligible: false,
        reason: `dependencies are no longer satisfied: ${unsatisfiedDependencies.join(', ')}`,
      };
    }
    if (
      taskState.worktreePath === undefined
      || taskState.branch === undefined
      || taskState.preparedHeadSha === undefined
    ) {
      return { eligible: false, reason: 'preserved task worktree/checkpoint is incomplete' };
    }

    let owned: OwnedWorktree;
    try {
      owned = await this.worktrees.assertRegistered(taskState.worktreePath);
    } catch (error) {
      return { eligible: false, reason: `preserved worktree is not registered: ${errorText(error)}` };
    }
    if (
      owned.kind !== 'task'
      || owned.runId !== this.state.runId
      || owned.taskId !== taskId
      || owned.branch !== taskState.branch
      || owned.baseSha !== this.state.baseSha
    ) {
      return { eligible: false, reason: 'preserved worktree registration does not match the task checkpoint' };
    }
    try {
      const listed = (await this.worktrees.listGitWorktrees()).find(
        (worktree) => worktree.path === owned.path,
      );
      if (listed?.branch !== `refs/heads/${owned.branch}`) {
        return { eligible: false, reason: 'preserved worktree is missing or checked out on another branch' };
      }
      const inspection = await inspectTaskCommits(
        this.git,
        owned.path,
        taskState.preparedHeadSha,
      );
      if (!inspection.clean) {
        return { eligible: false, reason: 'preserved worktree contains uncommitted or untracked changes' };
      }
      if (inspection.headSha !== taskState.preparedHeadSha || inspection.commits.length > 0) {
        return { eligible: false, reason: 'preserved worktree HEAD moved past the prepared checkpoint' };
      }
    } catch (error) {
      return { eligible: false, reason: `preserved worktree checkpoint is invalid: ${errorText(error)}` };
    }
    return { eligible: true, reason: '' };
  }

  /**
   * Salvage eligibility for a timed-out writer's dirty worktree — the
   * structural mirror of checkAgentFailureRetryEligibility, inverted on
   * dirtiness: retry-agent requires a CLEAN preserved worktree (no partial
   * work); salvage requires a DIRTY one whose every changed tracked file is
   * inside the task's own ownership globs, with no foreign commits and no
   * unexpected untracked files. AGENT_FAILED (a process crash) is
   * deliberately out of scope here — only a completed AGENT_TIMEOUT attempt
   * qualifies; a crashed process is a different failure shape and folding it
   * in without a real example to validate against would be scope creep.
   */
  private async checkSalvageEligibility(taskId: string): Promise<
    | {
        readonly eligible: true;
        readonly worktree: OwnedWorktree;
        readonly trackedChanged: readonly string[];
        /** trackedChanged + untrackedNew, sorted — the exact pre-commit changed-file set ensureTaskCommit will later commit. */
        readonly changedFiles: readonly string[];
      }
    | { readonly eligible: false; readonly reason: string; readonly reasonCode: SalvageEligibilityReasonCode }
  > {
    const taskSpec = this.config.tasks.find((task) => task.id === taskId);
    const taskState = this.state.tasks[taskId];
    if (taskSpec === undefined || taskState === undefined) {
      return { eligible: false, reason: 'task id does not exist in this run', reasonCode: 'SALVAGE_NOT_TIMED_OUT' };
    }
    const lastAttempt = taskState.agentAttempts.at(-1);
    const timedOut = taskState.error?.code === 'AGENT_TIMEOUT' && lastAttempt?.outcome === 'timed_out';
    if ((taskState.status !== 'FAILED' && taskState.status !== 'BLOCKED') || !timedOut) {
      return {
        eligible: false,
        reason: 'task did not end in a completed AGENT_TIMEOUT agent attempt',
        reasonCode: 'SALVAGE_NOT_TIMED_OUT',
      };
    }
    if (taskState.commit !== undefined) {
      return {
        eligible: false,
        reason: 'a task commit is already recorded for this task',
        reasonCode: 'SALVAGE_COMMIT_ALREADY_RECORDED',
      };
    }
    if (
      this.state.integration.integratedTaskCommits.length > 0
      || (this.state.integration.integrationFixCommits?.length ?? 0) > 0
    ) {
      return {
        eligible: false,
        reason: 'integration has already consumed committed work for this run',
        reasonCode: 'SALVAGE_ALREADY_INTEGRATED',
      };
    }
    const unsatisfiedDependencies = taskSpec.dependsOn.filter((dependencyId) => {
      const status = this.state.tasks[dependencyId]?.status;
      return status !== 'SUCCEEDED' && status !== 'SKIPPED';
    });
    if (unsatisfiedDependencies.length > 0) {
      return {
        eligible: false,
        reason: `dependencies are not satisfied: ${unsatisfiedDependencies.join(', ')}`,
        reasonCode: 'SALVAGE_DEPENDENCY_UNSATISFIED',
      };
    }
    if (
      taskState.worktreePath === undefined
      || taskState.branch === undefined
      || taskState.preparedHeadSha === undefined
    ) {
      return {
        eligible: false,
        reason: 'no preserved worktree path / prepared SHA recorded for this task',
        reasonCode: 'SALVAGE_WORKTREE_NOT_REGISTERED',
      };
    }
    let worktree: OwnedWorktree;
    try {
      worktree = await this.worktrees.assertRegistered(taskState.worktreePath);
    } catch (error) {
      return {
        eligible: false,
        reason: `preserved worktree is not registered/present: ${errorText(error)}`,
        reasonCode: 'SALVAGE_WORKTREE_NOT_REGISTERED',
      };
    }
    let headSha: string;
    try {
      headSha = await this.git.resolveCommit(worktree.path, 'HEAD');
    } catch (error) {
      return {
        eligible: false,
        reason: `preserved worktree HEAD could not be resolved: ${errorText(error)}`,
        reasonCode: 'SALVAGE_WORKTREE_NOT_REGISTERED',
      };
    }
    if (headSha !== taskState.preparedHeadSha) {
      return {
        eligible: false,
        reason: 'worktree HEAD has moved past the SHA prepared for this task',
        reasonCode: 'SALVAGE_WORKTREE_HEAD_MOVED',
      };
    }
    const ancestorLog = await this.git.run(
      worktree.path, ['log', '--format=%H', `${taskState.preparedHeadSha}..HEAD`],
    );
    if (ancestorLog.stdout.trim().length > 0) {
      return {
        eligible: false,
        reason: 'worktree already has commits beyond the prepared SHA',
        reasonCode: 'SALVAGE_WORKTREE_HAS_FOREIGN_COMMITS',
      };
    }
    const status = await this.git.run(
      worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
    );
    const entries = status.stdout.split('\0').filter((entry) => entry.length > 0);
    if (entries.length === 0) {
      return {
        eligible: false,
        reason: 'worktree has no dirty changes to salvage',
        reasonCode: 'SALVAGE_WORKTREE_CLEAN',
      };
    }
    const trackedChanged: string[] = [];
    const untrackedNew: string[] = [];
    for (const entry of entries) {
      const marker = entry.slice(0, 2);
      const path = entry.slice(3);
      if (marker === '??') {
        untrackedNew.push(path);
      } else {
        trackedChanged.push(path);
      }
    }
    const ownershipCheck = validateChangedFileOwnership(trackedChanged, taskSpec.files);
    if (ownershipCheck.violations.length > 0) {
      return {
        eligible: false,
        reason: `tracked changes outside ownership: ${ownershipCheck.violations.join(', ')}`,
        reasonCode: 'SALVAGE_OWNERSHIP_VIOLATION',
      };
    }
    const untrackedViolations = untrackedNew.filter(
      (path) => !taskSpec.files.some((pattern) => matchesOwnershipPattern(path, pattern)),
    );
    if (untrackedViolations.length > 0) {
      return {
        eligible: false,
        reason: `unexpected untracked files: ${untrackedViolations.join(', ')}`,
        reasonCode: 'SALVAGE_UNEXPECTED_UNTRACKED_FILE',
      };
    }
    const diffCheck = await this.git.run(
      worktree.path, ['diff', '--check', taskState.preparedHeadSha], { allowFailure: true },
    );
    if (diffCheck.exitCode !== 0) {
      return {
        eligible: false,
        reason: 'git diff --check reported whitespace/conflict-marker errors',
        reasonCode: 'SALVAGE_DIFF_CHECK_FAILED',
      };
    }
    return {
      eligible: true,
      worktree,
      trackedChanged,
      changedFiles: [...trackedChanged, ...untrackedNew].sort(),
    };
  }

  /**
   * Reopens only the pristine dependency-failure cascade attributable solely
   * to the retried task. A task with another failed/cancelled dependency is
   * intentionally left BLOCKED.
   */
  private dependencyOnlyDescendantsToReopen(taskId: string): readonly string[] {
    const graph = new TaskGraph(this.config.tasks);
    const recoveredChain = new Set([taskId]);
    const reopened: string[] = [];
    for (const candidate of graph.topologicalOrder()) {
      if (candidate.id === taskId || !graph.hasDependencyPath(candidate.id, taskId)) continue;
      const dependsOnRecoveredChain = candidate.dependsOn.some((id) => recoveredChain.has(id));
      const allOtherDependenciesSatisfied = candidate.dependsOn.every((id) => {
        if (recoveredChain.has(id)) return true;
        const status = this.state.tasks[id]?.status;
        return status === 'SUCCEEDED' || status === 'SKIPPED';
      });
      if (!dependsOnRecoveredChain || !allOtherDependenciesSatisfied) continue;

      const state = this.state.tasks[candidate.id]!;
      if (state.status !== 'BLOCKED' || state.error?.code !== 'TASK_DEPENDENCY_FAILED') continue;
      if (
        state.commit !== undefined
        || state.agentAttempts.length > 0
        || state.worktreePath !== undefined
        || state.branch !== undefined
        || state.preparedHeadSha !== undefined
        || state.handoffPath !== undefined
        || state.reviewPaths.length > 0
        || state.startedAt !== undefined
        || state.skipReason !== undefined
        || state.handoffOutcome !== undefined
        || state.handoffRepairAttempts.length > 0
      ) {
        throw new OrchestratorError(
          'TASK_STATE_INVALID',
          `Refusing agent retry: dependency-blocked task ${candidate.id} contains execution artifacts`,
          { details: { taskId: candidate.id } },
        );
      }
      recoveredChain.add(candidate.id);
      reopened.push(candidate.id);
    }
    return reopened;
  }

  /**
   * §8 (real Phase 5 dogfood recovery): every invariant a persisted FAILED
   * task must meet before recoverHandoffFailures() will touch it. Read-only —
   * this never mutates state, so it is safe to run over every candidate
   * before deciding whether to recover any of them.
   */
  /**
   * §10/§11 (extended for the second real dogfood finding): the SAME
   * invariants apply whether the persisted failure is a writer task's
   * HANDOFF_INVALID or a read-only review task's REVIEW_BLOCKED — both are
   * "the agent process itself already succeeded; only its structured output
   * never validated." A review-mode task's `commit` is always undefined by
   * construction (it is read-only), so the same check is harmless there too.
   */
  private async checkStructuredOutputRecoveryEligibility(
    taskState: TaskRunState,
    expectedErrorCode: 'HANDOFF_INVALID' | 'REVIEW_BLOCKED',
  ): Promise<{ readonly eligible: boolean; readonly reason: string; readonly reasonCode?: HandoffRecoveryEligibilityReasonCode }> {
    if (taskState.status !== 'FAILED' || taskState.error?.code !== expectedErrorCode) {
      return {
        eligible: false,
        reason: `task is not currently FAILED with error code ${expectedErrorCode}`,
        reasonCode: 'HANDOFF_TASK_NOT_FAILED',
      };
    }
    if (
      expectedErrorCode === 'HANDOFF_INVALID'
      && taskState.handoffRepairAttempts.length >= this.config.maxHandoffRepairAttempts
    ) {
      return {
        eligible: false,
        reason: `handoff repair attempt budget (${this.config.maxHandoffRepairAttempts}) exhausted`,
        reasonCode: 'HANDOFF_REPAIR_BUDGET_EXHAUSTED',
      };
    }
    const lastAttempt = taskState.agentAttempts.at(-1);
    if (lastAttempt?.outcome !== 'succeeded') {
      return {
        eligible: false,
        reason: 'the most recent recorded agent attempt did not succeed',
        reasonCode: 'HANDOFF_LAST_ATTEMPT_NOT_SUCCEEDED',
      };
    }
    if (taskState.commit !== undefined) {
      return {
        eligible: false,
        reason: 'a task commit is already recorded for this task',
        reasonCode: 'HANDOFF_COMMIT_ALREADY_RECORDED',
      };
    }
    if (taskState.worktreePath === undefined || taskState.preparedHeadSha === undefined) {
      return {
        eligible: false,
        reason: 'no preserved worktree path / prepared SHA recorded for this task',
        reasonCode: 'HANDOFF_WORKTREE_NOT_PRESERVED',
      };
    }
    let worktree: OwnedWorktree;
    try {
      worktree = await this.worktrees.assertRegistered(taskState.worktreePath);
    } catch (error) {
      return {
        eligible: false,
        reason: `preserved worktree is not registered/present: ${errorText(error)}`,
        reasonCode: 'HANDOFF_WORKTREE_NOT_REGISTERED',
      };
    }
    let inspection: Awaited<ReturnType<typeof inspectTaskCommits>>;
    try {
      inspection = await inspectTaskCommits(this.git, worktree.path, taskState.preparedHeadSha);
    } catch (error) {
      return {
        eligible: false,
        reason: `worktree is not a valid descendant of its own prepared SHA: ${errorText(error)}`,
        reasonCode: 'HANDOFF_WORKTREE_INVALID_DESCENDANT',
      };
    }
    if (inspection.headSha !== taskState.preparedHeadSha) {
      return {
        eligible: false,
        reason: 'worktree HEAD has moved past the SHA prepared for this task',
        reasonCode: 'HANDOFF_WORKTREE_HEAD_MOVED',
      };
    }
    if (inspection.commits.length > 0) {
      return {
        eligible: false,
        reason: 'worktree already has commits beyond the prepared SHA',
        reasonCode: 'HANDOFF_WORKTREE_HAS_FOREIGN_COMMITS',
      };
    }
    try {
      await stat(this.taskAttemptStdoutLogPath(taskState.id, lastAttempt));
    } catch {
      return {
        eligible: false,
        reason: 'original agent stdout log is missing',
        reasonCode: 'HANDOFF_ORIGINAL_LOG_MISSING',
      };
    }
    return { eligible: true, reason: '' };
  }

  /**
   * §10/§11: reconstructs the exact raw structured value the live run would
   * have produced (reading the preserved stdout log, never re-invoking the
   * agent), then reuses parseOrRepairHandoff/finishParsedHandoff verbatim —
   * the same repair attempt and the same ownership/commit/succeed gates a
   * live run always goes through, not a recovery-specific shortcut.
   */
  private async recoverHandoffInvalidTask(task: TaskSpec, taskState: TaskRunState): Promise<void> {
    const worktree = await this.worktrees.assertRegistered(taskState.worktreePath!);
    const lastAttempt = taskState.agentAttempts.at(-1)!;
    const rawStdout = await readBoundedStdoutText(this.taskAttemptStdoutLogPath(task.id, lastAttempt));
    const rawStructuredHandoff = parseJsonOrNull(rawStdout);
    const taskDiff = (await this.git.run(worktree.path, [
      'diff', '--no-ext-diff', '--no-color', taskState.preparedHeadSha!,
    ])).stdout;
    const requiredCanonicalFindings = this.requiredCanonicalFindings(task.id);
    const parsed = await this.parseOrRepairHandoff(
      task, rawStructuredHandoff, rawStdout, requiredCanonicalFindings, taskDiff,
    );
    await this.recordHandoffOutcome(task.id, parsed.outcome);
    if (parsed.handoff === null) {
      throw parsed.error;
    }
    const prepared: PreparedTask = {
      task,
      worktree,
      preparedHeadSha: taskState.preparedHeadSha!,
      dependencyHandoffs: [],
      previousReviewFindings: [],
      actualDependencyDiff: '',
    };
    await this.finishParsedHandoff(prepared, parsed.handoff);
  }

  /**
   * §12/§13 (second real dogfood finding, explorer-final-review): the
   * review-mode analogue of recoverHandoffInvalidTask. Read-only tasks have
   * no ownership/commit step — assertReadOnlyTaskClean is the same guard the
   * live path already uses, run here before recovery for the same reason.
   */
  private async recoverReviewBlockedTask(task: TaskSpec, taskState: TaskRunState): Promise<void> {
    const worktree = await this.worktrees.assertRegistered(taskState.worktreePath!);
    const lastAttempt = taskState.agentAttempts.at(-1)!;
    const rawStdout = await readBoundedStdoutText(this.taskAttemptStdoutLogPath(task.id, lastAttempt));
    const rawStructuredHandoff = parseJsonOrNull(rawStdout);
    const prepared: PreparedTask = {
      task,
      worktree,
      preparedHeadSha: taskState.preparedHeadSha!,
      dependencyHandoffs: [],
      previousReviewFindings: [],
      actualDependencyDiff: '',
    };
    await this.assertReadOnlyTaskClean(prepared);
    const parsed = await this.parseOrRecoverReview(task, rawStructuredHandoff, rawStdout);
    await this.recordHandoffOutcome(task.id, parsed.outcome);
    if (parsed.review === null) {
      throw parsed.error;
    }
    await this.finishParsedReview(prepared, parsed.review);
  }

  /**
   * §12: BLOCKED is terminal for TaskScheduler (scheduler.ts's TRANSITIONS)
   * and is re-seeded directly from persisted state on every construction, so
   * a task blocked purely because a dependency failed stays stuck forever
   * unless something explicitly resets it. TASK_DEPENDENCY_FAILED is, by
   * construction, always a scheduler-computed cascade — never an independent
   * human/business decision like BLOCKED_FOR_HUMAN_REVIEW or an ownership
   * violation — so resetting every such task to PENDING in one pass is
   * always safe: the next scheduler refresh re-derives the correct outcome
   * per task (READY once its own dependency truly succeeded, otherwise still
   * PENDING, never incorrectly promoted).
   */
  private async unblockDependencyOnlyFailures(): Promise<readonly string[]> {
    const eligible = Object.values(this.state.tasks).filter(
      (task) => task.status === 'BLOCKED' && task.error?.code === 'TASK_DEPENDENCY_FAILED',
    );
    if (eligible.length === 0) {
      return [];
    }
    await this.mutate((state) => ({
      ...state,
      tasks: {
        ...state.tasks,
        ...Object.fromEntries(eligible.map((task) => {
          const current = state.tasks[task.id]!;
          const { error: _previousError, finishedAt: _previousFinishedAt, ...withoutTerminal } = current;
          return [task.id, { ...withoutTerminal, status: 'PENDING' as const }];
        })),
      },
    }));
    return eligible.map((task) => task.id);
  }

  private async reconcile(): Promise<void> {
    const observations: Record<string, {
      processAlive: boolean;
      commit?: TaskCommitState;
      handoff?: StructuredHandoff;
      handoffInvalid?: boolean;
      ownershipValid?: boolean;
      writer?: boolean;
      handoffPath?: string;
      review?: StructuredReview;
      reviewPath?: string;
      finalReview?: boolean;
    }> = {};
    for (const task of this.config.tasks) {
      const taskState = this.state.tasks[task.id];
      if (taskState?.status !== 'RUNNING') continue;
      const lastAttempt = taskState.agentAttempts.at(-1);
      const processAlive = lastAttempt?.pid === undefined ? false : isProcessAlive(lastAttempt.pid);
      const observation: (typeof observations)[string] = {
        processAlive,
        writer: task.writer,
        finalReview: task.mode === 'final_review',
      };
      if (!processAlive && taskState.worktreePath !== undefined) {
        if (taskState.preparedHeadSha === undefined) {
          observation.handoffInvalid = true;
        } else {
          try {
            const inspection = await inspectTaskCommits(
              this.git,
              taskState.worktreePath,
              taskState.preparedHeadSha,
            );
            if (!inspection.clean) {
              observation.ownershipValid = false;
            } else if (inspection.commits.length > 0) {
              if (!task.writer || inspection.commits.length !== 1) {
                observation.ownershipValid = false;
              } else {
                try {
                  assertChangedFileOwnership(task.id, inspection.changedFiles, task.files);
                  observation.ownershipValid = true;
                } catch {
                  observation.ownershipValid = false;
                }
                observation.commit = {
                  sha: inspection.headSha,
                  parentSha: taskState.preparedHeadSha,
                  changedFiles: inspection.changedFiles,
                };
              }
            }
          } catch {
            observation.handoffInvalid = true;
          }
        }
        const output = lastAttempt === undefined
          ? undefined
          : this.taskAttemptStdoutLogPath(task.id, lastAttempt);
        if (output !== undefined) {
          let source: string | undefined;
          try {
            source = await readFile(output, 'utf8');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
              observation.handoffInvalid = true;
            }
          }
          try {
            if (source === undefined) {
              observations[task.id] = observation;
              continue;
            }
            if (REVIEW_MODES.has(task.mode)) {
              const review = parseReview(source);
              const reviewPath = join(
                this.stateStore.runDirectory,
                'reviews',
                `${task.id}.json`,
              );
              await atomicArtifactWrite(reviewPath, review);
              observation.review = review;
              observation.reviewPath = reviewPath;
            } else {
              const handoff = parseHandoff(source);
              observation.handoff = handoff;
              observation.handoffPath = await writeHandoff(
                join(this.stateStore.runDirectory, 'handoffs'),
                task.id,
                handoff,
              );
            }
          } catch {
            observation.handoffInvalid = true;
          }
        }
      }
      observations[task.id] = observation;
    }
    const reconciled = reconcileInterruptedTasks(this.state, observations, {
      agentRetries: this.config.agentRetries,
      clock: this.clock,
    });
    const previousAdaptiveEvents = this.state.adaptive?.events.length ?? 0;
    let reconciledState = reconciled.state;
    if (this.state.adaptive !== undefined && this.adaptiveConfig !== undefined) {
      const coordinator = this.adaptiveCoordinator();
      for (const [taskId, action] of Object.entries(reconciled.actions)) {
        if (action === 'RETRY_PROCESS_LOSS') {
          const unit = coordinator.snapshot().workUnits.find((candidate) => candidate.id === taskId);
          if (unit !== undefined && ['GRANTED', 'RUNNING'].includes(unit.status)) {
            coordinator.finish(taskId, 'FAILED', { error: 'Agent process disappeared during interruption' });
          }
          coordinator.authorizeRetry(taskId);
          coordinator.arbitrate();
          routeGrantedWork(coordinator, this.adaptiveConfig);
        } else if (action === 'RECOVERED_COMMIT' || action === 'RECOVERED_READ_ONLY' || action === 'RECOVERED_REVIEW') {
          const unit = coordinator.snapshot().workUnits.find((candidate) => candidate.id === taskId);
          if (unit !== undefined && ['GRANTED', 'RUNNING'].includes(unit.status)) coordinator.finish(taskId, 'SUCCEEDED');
        } else if (['BLOCKED_MISSING_HANDOFF', 'BLOCKED_INVALID_HANDOFF', 'BLOCKED_OWNERSHIP', 'BLOCKED_BY_HANDOFF', 'FAILED_BY_HANDOFF', 'FAILED_RETRIES_EXHAUSTED'].includes(action)) {
          const unit = coordinator.snapshot().workUnits.find((candidate) => candidate.id === taskId);
          if (unit !== undefined && ['GRANTED', 'RUNNING'].includes(unit.status)) coordinator.finish(taskId, 'FAILED', { error: action });
        }
      }
      reconciledState = { ...reconciledState, adaptive: coordinator.snapshot() };
    }
    this.state = reconciledState;
    await this.stateStore.save(this.state);
    await this.emitNewAdaptiveEvents(previousAdaptiveEvents);
    for (const [taskId, action] of Object.entries(reconciled.actions)) {
      if (action === 'RETRY_PROCESS_LOSS') {
        await this.event('TASK_READY', taskId, { recovered: true });
      } else if (action === 'RECOVERED_COMMIT' || action === 'RECOVERED_READ_ONLY') {
        await this.submitAdditionalAdaptiveRequests(taskId, observations[taskId]?.handoff?.additionalWorkRequests);
      } else if (action === 'RECOVERED_REVIEW') {
        await this.submitAdditionalAdaptiveRequests(taskId, observations[taskId]?.review?.additionalWorkRequests);
      }
    }
  }

  private async mutate(update: (state: RunState) => RunState): Promise<void> {
    const operation = this.stateQueue.then(async () => {
      const next = withUpdatedTimestamp(update(this.state), this.clock);
      await this.stateStore.save(next);
      this.state = next;
    });
    this.stateQueue = operation.catch(() => undefined);
    return operation;
  }

  /** Allocate attempt numbers under the same persistence queue used for state writes. */
  private async allocateAttempt(
    taskId: string,
    agent: 'codex' | 'claude',
    timeoutMs: number,
  ): Promise<number> {
    let allocatedAttempt = 0;
    const operation = this.stateQueue.then(async () => {
      const task = this.state.tasks[taskId];
      if (task === undefined) {
        throw new OrchestratorError('STATE_CORRUPT', `Unknown run task ${taskId}`);
      }
      allocatedAttempt = task.agentAttempts.length + 1;
      const attempt: AgentAttemptState = {
        attempt: allocatedAttempt,
        agent,
        startedAt: this.clock().toISOString(),
        timeoutMs,
      };
      const next = withUpdatedTimestamp(
        updateTask(this.state, taskId, (value) => ({
          ...value,
          agentAttempts: [...value.agentAttempts, attempt],
        })),
        this.clock,
      );
      await this.stateStore.save(next);
      this.state = next;
    });
    this.stateQueue = operation.catch(() => undefined);
    await operation;
    return allocatedAttempt;
  }

  private async event(
    name: RunEventName,
    taskId?: string,
    data?: Readonly<Record<string, unknown>>,
  ): Promise<void> {
    await this.stateStore.appendEvent({
      name,
      timestamp: this.clock().toISOString(),
      runId: this.state.runId,
      ...(taskId === undefined ? {} : { taskId }),
      ...(data === undefined ? {} : { data }),
    });
  }
}

/**
 * §13: `resolvedExecutables` is what makes plan-time discovery and run-time
 * execution agree. Without threading it through, `CodexAgent`/`ClaudeAgent`
 * fall back to their bare default command name (`this.executableOverride ??
 * this.defaultExecutable` in process-agent.ts), which Node's own `spawn()`
 * then resolves via the CHILD PROCESS's PATH lookup — entirely independent
 * of whatever `resolveAgentExecutable` found. A phase could `agents:plan`
 * successfully against a VS Code-extension-discovered Codex binary and then
 * fail at `agents:run` with ENOENT, because the two paths were never
 * actually connected.
 */
function createAgents(
  overrides: OrchestratorOptions['agents'],
  resolvedExecutables?: Readonly<Partial<Record<'codex' | 'claude', string>>>,
): Readonly<Record<'codex' | 'claude', Agent>> {
  return {
    codex:
      overrides?.codex
      ?? new CodexAgent(resolvedExecutables?.codex === undefined ? {} : { executable: resolvedExecutables.codex }),
    claude:
      overrides?.claude
      ?? new ClaudeAgent(resolvedExecutables?.claude === undefined ? {} : { executable: resolvedExecutables.claude }),
  };
}

async function resolveRequiredAgentExecutables(
  agents: readonly ('codex' | 'claude')[],
  overrides: OrchestratorOptions['agents'],
): Promise<Partial<Record<'codex' | 'claude', string>>> {
  const result: Partial<Record<'codex' | 'claude', string>> = {};
  const required = new Set(agents);
  for (const agent of required) {
    if (overrides?.[agent] !== undefined) continue;
    const resolution = await resolveAgentExecutable(agent);
    if (resolution === null) {
      throw new OrchestratorError('AGENT_NOT_FOUND', `Required agent executable not found: ${agent}`, {
        details: { agent },
      });
    }
    result[agent] = resolution.path;
  }
  return result;
}

function createRunId(clock?: () => Date): string {
  const timestamp = (clock ?? (() => new Date()))().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14);
  return `run-${timestamp}-${randomBytes(4).toString('hex')}`;
}

function taskStatusRecord(state: RunState): Record<string, TaskStatus> {
  return Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, task.status]));
}

function ancestorTasks(task: TaskSpec, graph: TaskGraph): TaskSpec[] {
  const ancestorIds = new Set<string>();
  const visit = (id: string): void => {
    for (const dependency of graph.get(id).dependsOn) {
      if (!ancestorIds.has(dependency)) {
        ancestorIds.add(dependency);
        visit(dependency);
      }
    }
  };
  visit(task.id);
  return graph.topologicalOrder().filter((candidate) => ancestorIds.has(candidate.id));
}

function updateTask(
  state: RunState,
  taskId: string,
  update: (task: TaskRunState) => TaskRunState,
): RunState {
  const task = state.tasks[taskId];
  if (task === undefined) throw new OrchestratorError('STATE_CORRUPT', `Unknown run task ${taskId}`);
  return { ...state, tasks: { ...state.tasks, [taskId]: update(task) } };
}

function updateAttemptPid(
  state: RunState,
  taskId: string,
  attemptNumber: number,
  pid: number,
): RunState {
  return updateTask(state, taskId, (task) => ({
    ...task,
    agentAttempts: task.agentAttempts.map((attempt) =>
      attempt.attempt === attemptNumber ? { ...attempt, pid } : attempt),
  }));
}

function updateAttemptFinished(
  state: RunState,
  taskId: string,
  attemptNumber: number,
  result: AgentResult,
): RunState {
  const outcome: AgentAttemptState['outcome'] = result.status === 'succeeded'
    ? 'succeeded'
    : result.status === 'timed_out'
      ? 'timed_out'
      : result.status === 'aborted'
        ? 'aborted'
        : 'failed';
  return updateTask(state, taskId, (task) => ({
    ...task,
    agentAttempts: task.agentAttempts.map((attempt) => attempt.attempt === attemptNumber
      ? { ...attempt, finishedAt: result.endedAt, outcome, durationMs: result.durationMs }
      : attempt),
  }));
}

function storedError(
  code: ErrorCode,
  message: string,
  clock: () => Date,
  details?: Readonly<Record<string, unknown>>,
): StoredError {
  return {
    code,
    message,
    at: clock().toISOString(),
    ...(details === undefined ? {} : { details }),
  };
}

/**
 * §8: an integration fix's ownership globs already restrict WHICH files it
 * may touch, but this is a second, independent guard against a narrower and
 * more dangerous category regardless of ownership: no migration, no
 * package.json/lockfile, ever smuggled in as part of what is supposed to be
 * a narrow test/source correction.
 */
function assertNoSmuggledSchemaOrDependencyChange(changedFiles: readonly string[]): void {
  const forbidden = changedFiles.filter(
    (file) =>
      file.includes('/database/migrations/')
      || file === 'package.json'
      || file.endsWith('/package.json')
      || file === 'pnpm-lock.yaml'
      || file.endsWith('/pnpm-lock.yaml'),
  );
  if (forbidden.length > 0) {
    throw new OrchestratorError(
      'OWNERSHIP_VIOLATION',
      'Integration fix touches a forbidden migration/schema/dependency file',
      { details: { files: forbidden } },
    );
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function normalizeError(error: unknown, clock: () => Date): StoredError {
  if (error instanceof OrchestratorError) {
    return storedError(error.code, error.message, clock, error.details);
  }
  return storedError(
    'AGENT_FAILED',
    error instanceof Error ? error.message : String(error),
    clock,
  );
}

async function readArtifacts(paths: readonly string[]): Promise<unknown[]> {
  return Promise.all(paths.map(async (path) => JSON.parse(await readFile(path, 'utf8')) as unknown));
}

async function copyPhaseSnapshot(source: string, target: string): Promise<void> {
  const temporary = `${target}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(await readFile(source));
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, target);
    const directory = await open(dirname(target), 'r').catch(() => undefined);
    if (directory !== undefined) {
      await directory.sync().catch(() => undefined);
      await directory.close().catch(() => undefined);
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

async function atomicArtifactWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomBytes(6).toString('hex')}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    const directory = await open(dirname(path), 'r').catch(() => undefined);
    if (directory !== undefined) {
      await directory.sync().catch(() => undefined);
      await directory.close().catch(() => undefined);
    }
  } catch (error) {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function workRequestMatchesDraft(
  request: NonNullable<RunState['adaptive']>['workRequests'][number],
  draft: WorkRequestDraft,
): boolean {
  return JSON.stringify({
    role: request.role,
    concern: request.concern,
    objective: request.objective,
    reason: request.reason,
    dependencies: request.dependencies,
    capabilities: request.capabilities,
    resourceClaims: request.resourceClaims,
    evidence: request.evidence,
    risk: request.risk,
    priority: request.priority,
    ...(request.estimatedCostUnits === undefined ? {} : { estimatedCostUnits: request.estimatedCostUnits }),
  }) === JSON.stringify(draft);
}

// Recovery note (real Phase 5 dogfood run run-20260822094645-5b090308): these
// two functions previously baked each optional field's description directly
// into its own JSON key, e.g. 'assumptions (optional; implementation tasks)'
// instead of the bare 'assumptions'. A model shown that as "the schema" has
// no way to know the parenthetical is prose, not part of the key — and both
// real Codex Solver tasks reproduced it verbatim, which the strict validator
// then correctly rejected as an unsupported field. The fix is to keep every
// key exactly as the real validator (handoff/schemas.ts's HANDOFF_KEYS,
// review/findings.ts's FINDING_KEYS) accepts it, and move every optionality/
// scope note into the separate, clearly-prose `*ResponseSchemaNotes()` below
// — never back into a key name. See buildAgentPrompt()'s explicit instruction
// not to copy a note into a property name, and
// test/agents/response-schema-prompt.test.ts for the regression coverage.
function handoffResponseSchema(adaptive = false): unknown {
  return {
    status: 'complete | blocked | failed',
    summary: 'string',
    filesChanged: ['repository-relative path'],
    decisions: ['string'],
    tests: [{ command: 'string', result: 'pass | fail | not_run', details: 'string' }],
    openQuestions: ['string'],
    reviewRequested: ['string'],
    assumptions: ['non-obvious constraint or choice a reviewer could not derive from the diff alone'],
    knownRisks: ['known gap or trade-off, stated up front'],
    attackSurface: ['where an adversarial reviewer is most likely to find a real defect'],
    findingResponses: [{
      findingId: 'F001',
      canonicalFindingKey: 'trusted provenance key supplied in requiredCanonicalFindings',
      decision: 'confirmed | rejected',
      resolution: 'resolved | unresolved | not_applicable',
      evidence: 'string',
      fix: 'string',
      verification: 'string',
      reason: 'string',
    }],
    additionalWorkRequests: [additionalWorkRequestResponseSchema()],
  };
}

function handoffResponseSchemaNotes(adaptive = false): readonly string[] {
  return [
    'assumptions, knownRisks, and attackSurface are optional and apply only to implementation tasks. Omit a field entirely if you have nothing real to report for it — do not include it empty.',
    'findingResponses is optional for generic tasks, but mandatory for a canonical correction/testing task: include exactly one entry for every assigned canonical finding, copy its canonicalFindingKey exactly, and include no unassigned ID.',
    'Canonical responses require resolution. confirmed uses resolved or unresolved; confirmed/resolved requires evidence, fix, and verification. rejected uses not_applicable and requires evidence plus reason.',
    'additionalWorkRequests is optional. It proposes bounded evidence-backed work to the orchestrator; it does not grant or launch work.',
  ];
}

function reviewResponseSchema(adaptive = false): unknown {
  return {
    status: 'approved | changes_requested | blocked',
    findings: [{
      id: 'F001',
      severity: 'critical | high | medium | low',
      category: 'correctness | security | performance | concurrency | architecture | testing | maintainability',
      file: 'repository-relative path',
      location: 'symbol/line if known',
      problem: 'string (state your claim precisely)',
      evidence: 'string',
      impact: 'string',
      suggestedFix: 'string',
      verificationRequired: 'string',
      counterexample: 'concrete input/state that triggers the defect',
      reproduction: 'exact steps or a failing test to reproduce it',
      expectedBehavior: 'string',
      violatingBehavior: 'string',
    }],
    additionalWorkRequests: [additionalWorkRequestResponseSchema()],
  };
}

function reviewResponseSchemaNotes(adaptive = false): readonly string[] {
  return [
    'On each finding, counterexample, reproduction, expectedBehavior, and violatingBehavior are optional. Prefer supplying them over a bare claim, but omit any you cannot fill in — do not include it empty.',
    'additionalWorkRequests is optional. It proposes bounded evidence-backed work to the orchestrator; it does not grant or launch work.',
  ];
}

function additionalWorkRequestResponseSchema(): unknown {
  return {
    role: 'implementation | review | correction | testing | synthesis | final_review | escalation | integration_assistance',
    concern: 'allowed concern string',
    objective: 'bounded objective',
    reason: 'evidence-backed reason',
    dependencies: ['request-000001'],
    capabilities: [{ capability: 'string', minimumLevel: 0 }],
    resourceClaims: [{ kind: 'repository_path | database | service | logical', key: 'string', mode: 'read | write' }],
    evidence: [{ kind: 'diff | file | test | schema | runtime | finding', reference: 'string', summary: 'string' }],
    risk: 'low | medium | high | critical',
    priority: 50,
    estimatedCostUnits: 0,
  };
}
