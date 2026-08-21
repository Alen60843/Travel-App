import { randomBytes } from 'node:crypto';
import { open, readFile, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { ClaudeAgent, CodexAgent, type Agent, type AgentRequest, type AgentResult } from './agents';
import type { PhaseConfig } from './config';
import { OrchestratorError, type ErrorCode } from './errors';
import { findExecutable } from './executable';
import {
  GitClient,
  WorktreeManager,
  assertBaseBranchUnmoved,
  ensureTaskCommit,
  inspectTaskCommits,
  integrateTaskCommits,
  integrationConflictError,
  resolveBaseSha,
  type IntegrationCommit,
  type OwnedWorktree,
} from './git';
import { parseHandoff, writeHandoff, type StructuredHandoff } from './handoff';
import { IntegrationGate } from './integration/integration-gate';
import { parseReview, type StructuredReview } from './review/findings';
import {
  StateStore,
  assertResumeBaseUnmoved,
  createRunState,
  reconcileInterruptedTasks,
  withUpdatedTimestamp,
  type AgentAttemptState,
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
  type TaskSpec,
  type TaskStatus,
} from './tasks';
import { loadAnyPhaseConfig } from './workflow/solver-verifier';

export interface PlanResult {
  readonly repositoryRoot: string;
  readonly config: PhaseConfig;
  readonly baseSha: string;
  readonly agentExecutables: Readonly<Record<'codex' | 'claude', string>>;
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

const REVIEW_MODES = new Set(['review', 'final_review']);
const MAX_AGENT_DIFF_BYTES = 2 * 1024 * 1024;
const INFRASTRUCTURE_FAILURES = new Set(['not_found', 'spawn_error', 'timed_out']);

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
  for (const agent of requiredAgents) {
    if (options.agents?.[agent] !== undefined) {
      executables[agent] = 'injected-adapter';
      continue;
    }
    const executable = await findExecutable(agent);
    if (executable === null) {
      throw new OrchestratorError('AGENT_NOT_FOUND', `Required agent executable not found: ${agent}`, {
        details: { agent },
      });
    }
    executables[agent] = executable;
  }
  // Keep the result shape stable even if a phase happens to use one model.
  executables.codex ??= options.agents?.codex === undefined
    ? (await findExecutable('codex')) ?? 'not-required'
    : 'injected-adapter';
  executables.claude ??= options.agents?.claude === undefined
    ? (await findExecutable('claude')) ?? 'not-required'
    : 'injected-adapter';

  return {
    repositoryRoot,
    config,
    baseSha,
    agentExecutables: executables as Record<'codex' | 'claude', string>,
    waves: new TaskGraph(config.tasks).executionWaves(config.concurrency),
  };
}

export class AgentOrchestrator {
  readonly config: PhaseConfig;
  readonly repositoryRoot: string;
  readonly runsRoot: string;
  readonly stateStore: StateStore;

  private state: RunState;
  private readonly git: GitClient;
  private readonly worktrees: WorktreeManager;
  private readonly agents: Readonly<Record<'codex' | 'claude', Agent>>;
  private readonly clock: () => Date;
  private readonly signal: AbortSignal | undefined;
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
  }

  static async start(phaseFile: string, options: OrchestratorOptions): Promise<AgentOrchestrator> {
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
      agents: createAgents(options.agents),
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

  static async resume(runId: string, options: OrchestratorOptions): Promise<AgentOrchestrator> {
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
    const config = await loadAnyPhaseConfig(join(stateStore.runDirectory, 'phase.yaml'));
    if (config.baseBranch !== state.baseBranch) {
      throw new OrchestratorError('STATE_CORRUPT', 'Stored phase base branch differs from run state');
    }
    const actualBaseSha = await resolveBaseSha(git, repositoryRoot, state.baseBranch);
    assertResumeBaseUnmoved(state.baseSha, actualBaseSha);
    const orchestrator = new AgentOrchestrator({
      config,
      repositoryRoot,
      runsRoot,
      stateStore,
      state,
      git,
      worktrees: await WorktreeManager.create({ repositoryPath: repositoryRoot, git }),
      agents: createAgents(options.agents),
      clock: options.clock ?? (() => new Date()),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    await orchestrator.reconcile();
    await orchestrator.event('RUN_RESUMED');
    return orchestrator;
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
        if (Object.values(this.state.tasks).every((task) => task.status === 'SUCCEEDED')) {
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
    const results = await this.worktrees.cleanupRun(this.state.runId);
    return results.map((result) => result.entry.path);
  }

  private async executeTask(task: TaskSpec): Promise<void> {
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

    const inspection = await inspectTaskCommits(this.git, worktree.path, this.state.baseSha);
    if (!inspection.clean) {
      throw new OrchestratorError(
        'AGENT_FAILED',
        `Task ${task.id} worktree is dirty before invocation; preserving it for inspection`,
      );
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
    const attemptNumber = await this.allocateAttempt(task.id, agent.name);
    await this.event('AGENT_STARTED', task.id, { agent: agent.name, attempt: attemptNumber });

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
        responseSchema: REVIEW_MODES.has(task.mode)
          ? reviewResponseSchema()
          : handoffResponseSchema(),
      },
      canonicalDesignDocumentPath: join(
        this.repositoryRoot,
        this.config.canonicalDesignDocument,
      ),
      allowedFileOwnership: task.files,
      dependencyHandoffs: prepared.dependencyHandoffs,
      previousReviewFindings: prepared.previousReviewFindings,
      requestedEffort: task.effort,
      ...(task.model === undefined ? {} : { requestedModel: task.model }),
      timeoutMs: task.timeoutMs ?? this.config.agentTimeoutMs,
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
      await this.mutate((state) => updateTask(state, prepared.task.id, (task) => ({
        ...task,
        status: 'READY',
        error: storedError(
          result.failureCode === 'AGENT_TIMEOUT' ? 'AGENT_TIMEOUT' : 'AGENT_FAILED',
          result.errorMessage ?? `Agent process ended as ${result.status}`,
          this.clock,
        ),
      })));
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
    const handoff = parseHandoff(result.structuredHandoff);
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

    await this.succeedTask(prepared.task.id, handoffPath, commit);
  }

  private async finishReview(prepared: PreparedTask, result: AgentResult): Promise<void> {
    await this.assertReadOnlyTaskClean(prepared);
    const review = parseReview(result.structuredHandoff);
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
    // remains the exact behavior for every phase that does not opt in. It
    // changes ONLY when this specific task has an escalation-mode (JUDGE)
    // dependent in the graph: then the disagreement is handed to the Judge
    // for one bounded arbitration attempt instead. Detected structurally from
    // the DAG, not from configuration, so nothing needs to be threaded
    // through the phase config to enable it, and a phase with no escalation
    // task literally cannot exercise this branch.
    const routeToEscalation =
      prepared.task.mode === 'final_review'
      && review.status !== 'approved'
      && this.hasEscalationDependent(prepared.task.id);
    if (
      !routeToEscalation
      && (review.status === 'blocked'
        || (prepared.task.mode === 'final_review' && review.status !== 'approved'))
    ) {
      await this.failTask(
        prepared.task.id,
        new OrchestratorError(
          prepared.task.mode === 'final_review'
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
  private hasEscalationDependent(taskId: string): boolean {
    return this.config.tasks.some(
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
      if (
        !inspection.clean
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

    const gate = await new IntegrationGate().run({
      cwd: worktree.path,
      logsDirectory: join(this.stateStore.runDirectory, 'logs', 'integration'),
      commands: this.config.integration.commands,
      diagnostics: this.config.integration.diagnostics,
      ...(this.signal === undefined ? {} : { signal: this.signal }),
    });
    for (const [index, command] of gate.commands.entries()) {
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
    if (!gate.passed) {
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
          : join(
              this.stateStore.runDirectory,
              'logs',
              `${this.state.runId}.${task.id}.${lastAttempt.agent}.attempt-${lastAttempt.attempt}.stdout.log`,
            );
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
    this.state = reconciled.state;
    await this.stateStore.save(this.state);
    for (const [taskId, action] of Object.entries(reconciled.actions)) {
      if (action === 'RETRY_PROCESS_LOSS') {
        await this.event('TASK_READY', taskId, { recovered: true });
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
  private async allocateAttempt(taskId: string, agent: 'codex' | 'claude'): Promise<number> {
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

function createAgents(
  overrides: OrchestratorOptions['agents'],
): Readonly<Record<'codex' | 'claude', Agent>> {
  return {
    codex: overrides?.codex ?? new CodexAgent(),
    claude: overrides?.claude ?? new ClaudeAgent(),
  };
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
      ? { ...attempt, finishedAt: result.endedAt, outcome }
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

function handoffResponseSchema(): unknown {
  return {
    status: 'complete | blocked | failed',
    summary: 'string',
    filesChanged: ['repository-relative path'],
    decisions: ['string'],
    tests: [{ command: 'string', result: 'pass | fail | not_run', details: 'string' }],
    openQuestions: ['string'],
    reviewRequested: ['string'],
    'assumptions (optional; implementation tasks)':
      ['non-obvious constraint or choice a reviewer could not derive from the diff alone'],
    'knownRisks (optional; implementation tasks)': ['known gap or trade-off, stated up front'],
    'attackSurface (optional; implementation tasks)':
      ['where an adversarial reviewer is most likely to find a real defect'],
    'findingResponses (optional; correction tasks — one entry per finding you are responding to)': [{
      findingId: 'F001',
      decision: 'confirmed | rejected',
      evidence: 'string',
      'fix (when confirmed)': 'string',
      'verification (when confirmed)': 'string',
      'reason (when rejected)': 'string',
    }],
  };
}

function reviewResponseSchema(): unknown {
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
      'counterexample (optional, prefer supplying)': 'concrete input/state that triggers the defect',
      'reproduction (optional, prefer supplying)': 'exact steps or a failing test to reproduce it',
      'expectedBehavior (optional, prefer supplying)': 'string',
      'violatingBehavior (optional, prefer supplying)': 'string',
    }],
  };
}
