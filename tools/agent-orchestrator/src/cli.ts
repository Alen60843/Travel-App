#!/usr/bin/env node

import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { parseStrictYaml } from './config';
import { GitClient, WorktreeManager } from './git';
import { computeRunMetrics } from './metrics/compute-metrics';
import { AgentOrchestrator, planOrchestrationPhase, type AnyPlanResult, type PlanResult } from './orchestrator';
import { StateStore, type RunState } from './state';
import { loadAnyPhaseConfig } from './workflow/solver-verifier';
import { loadAdaptivePhaseConfig, runtimePhaseConfig } from './adaptive';

const USAGE = `TripWith local agent orchestrator

Usage:
  pnpm agents:plan <phase-file>
  pnpm agents:run <phase-file>
  pnpm agents:resume <run-id>
  pnpm agents:status <run-id>
  pnpm agents:cleanup <run-id>
  pnpm agents:metrics <run-id>
  pnpm agents:recover-handoffs <run-id>
  pnpm agents:retry-agent <run-id> <task-id>
  pnpm agents:salvage-task <run-id> <task-id>
  pnpm agents:authorize-recovery-policy <run-id> <policy-file>
  pnpm agents:retry-integration <run-id>
  pnpm agents:apply-integration-fix <run-id> <summary> <ownership-glob> [more-globs...]

Planning is read-only. Running or resuming may invoke locally authenticated paid agents.
No command merges into the phase branch or pushes to a remote.
metrics is read-only: it recomputes a summary from persisted run artifacts and never
touches agents, worktrees, or state.
recover-handoffs recovers a run's persisted FAILED/HANDOFF_INVALID or FAILED/REVIEW_BLOCKED
tasks whose agent process already succeeded, using a bounded, mostly local repair (never
rerunning the original implementation/review); it refuses (all-or-nothing) if any targeted
task fails an eligibility invariant. It does not itself execute further tasks -- run
agents:resume afterward to continue the run.
retry-agent authorizes one additional attempt only for a FAILED agent/process-layer task
with no commit, accepted structured artifact, dirty work, or unsatisfied dependency. It
archives the failure and reopens only dependency-blocked descendants attributable to that
task. It never invokes an agent itself; run agents:resume afterward.
salvage-task recovers useful work left behind by a task whose process timed out
(AGENT_TIMEOUT) with a dirty, evidence-backed worktree diff -- the inverse case from
retry-agent, which requires a CLEAN worktree. It refuses unless every changed tracked file is
inside the task's own ownership globs, there are no foreign commits or unexpected untracked
files, and git diff --check passes. A dirty diff is only evidence, never success on its own:
it runs agentWorktree.prepare (if configured) and the phase's salvage.verify commands --
categorically separate from prepare, and required for any task to be salvageable at all --
then the Orchestrator itself creates the commit, the same way agents:apply-integration-fix
does. It never invokes an agent for the base flow; a task with a required canonical finding
still needs one bounded, evidence-only repair call to complete its findingResponses, exactly
like recover-handoffs. Run agents:resume afterward to continue the run.
authorize-recovery-policy loads and validates a recovery-only policy overlay (YAML file,
salvage.verify and/or executors only) and appends one immutable, hashed snapshot to the run's
recoveryPolicyHistory -- it NEVER edits the run's immutable phase.yaml snapshot, NEVER invokes
an agent, salvages no work, repairs no handoff, creates no task commit, and does not resume the
run. It only authorizes and persists policy, the same request/grant-before-execute separation
the rest of this Orchestrator already follows. The most recently authorized snapshot is applied
the next time the run is loaded by recover-handoffs, salvage-task, or resume. Recovery-executor
routing is limited honestly to this Orchestrator's two existing adapters (codex, claude); if
executors are explicitly configured and none is eligible for a given repair, that repair fails
closed rather than silently falling back to the original task owner.
retry-integration retries ONLY the deterministic integration gate for a run that is BLOCKED
specifically with INTEGRATION_TEST_FAILED (never for any other blocking reason); it archives
the failed attempt (never overwrites it) and does not invoke any agent or move any task. Run
agents:resume afterward to actually re-run the gate.
apply-integration-fix commits ALREADY-MADE, uncommitted changes in the existing integration
worktree (you make the edit yourself first) as one narrow, auditable fix commit on top of the
existing integration head -- only for a run BLOCKED with INTEGRATION_TEST_FAILED, only within
the given ownership globs, and never touching a migration/package.json/lockfile. It archives
the failed attempt first and never reruns or rewrites a completed task. Run agents:resume
afterward to actually re-run the gate.`;

async function main(argv: readonly string[]): Promise<number> {
  const [command, argument, ...extra] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? 1 : 0;
  }
  if (command === 'apply-integration-fix') {
    const [summary, ...ownership] = extra;
    if (argument === undefined || summary === undefined || ownership.length === 0) {
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    const repositoryPath = await new GitClient().repositoryRoot(process.cwd());
    const orchestrator = await AgentOrchestrator.applyIntegrationFix(
      argument,
      { repositoryPath },
      { summary, ownership },
    );
    process.stdout.write(`${JSON.stringify({
      runId: orchestrator.snapshot().runId,
      runStatus: orchestrator.snapshot().status,
      integrationFixCommits: orchestrator.snapshot().integration.integrationFixCommits ?? [],
      manualNextStep: 'Run `pnpm agents:resume <run-id>` to actually re-run the deterministic gate.',
    }, null, 2)}\n`);
    return 0;
  }
  if (command === 'retry-agent') {
    const [taskId] = extra;
    if (argument === undefined || taskId === undefined || extra.length !== 1) {
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    const repositoryPath = await new GitClient().repositoryRoot(process.cwd());
    const result = await AgentOrchestrator.retryAgentFailure(argument, taskId, {
      repositoryPath,
    });
    process.stdout.write(`${JSON.stringify({
      runId: result.orchestrator.snapshot().runId,
      runStatus: result.orchestrator.snapshot().status,
      taskId: result.taskId,
      archivedRecovery: result.recovery.recovery,
      reopenedTasks: result.reopenedTasks,
      manualNextStep: 'Run `pnpm agents:resume <run-id>` to execute the authorized retry.',
    }, null, 2)}\n`);
    return 0;
  }
  if (command === 'salvage-task') {
    const [taskId] = extra;
    if (argument === undefined || taskId === undefined || extra.length !== 1) {
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    const repositoryPath = await new GitClient().repositoryRoot(process.cwd());
    const result = await AgentOrchestrator.salvageTask(argument, taskId, {
      repositoryPath,
    });
    process.stdout.write(`${JSON.stringify({
      runId: result.orchestrator.snapshot().runId,
      runStatus: result.orchestrator.snapshot().status,
      taskId: result.taskId,
      commitSha: result.commitSha,
      manualNextStep: 'Inspect the salvaged commit above, then run `pnpm agents:resume <run-id>` to continue the run.',
    }, null, 2)}\n`);
    return 0;
  }
  if (command === 'authorize-recovery-policy') {
    const [policyFile] = extra;
    if (argument === undefined || policyFile === undefined || extra.length !== 1) {
      process.stderr.write(`${USAGE}\n`);
      return 1;
    }
    const repositoryPath = await new GitClient().repositoryRoot(process.cwd());
    const source = await readFile(resolve(policyFile), 'utf8');
    const rawPolicy = parseStrictYaml(source);
    const result = await AgentOrchestrator.authorizeRecoveryPolicy(argument, rawPolicy, {
      repositoryPath,
    });
    process.stdout.write(`${JSON.stringify({
      runId: result.orchestrator.snapshot().runId,
      policyHash: result.policyHash,
      manualNextStep: 'Run `pnpm agents:recover-handoffs <run-id>` or `pnpm agents:salvage-task <run-id> <task-id>` to use this authorized policy.',
    }, null, 2)}\n`);
    return 0;
  }
  if (argument === undefined || extra.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const repositoryPath = await new GitClient().repositoryRoot(process.cwd());
  if (command === 'plan') {
    const plan = await planOrchestrationPhase(resolve(repositoryPath, argument), { repositoryPath });
    process.stdout.write(renderPlan(plan));
    return 0;
  }
  if (command === 'run') {
    const cancellation = installCancellationSignal();
    try {
      const orchestrator = await AgentOrchestrator.start(
        resolve(repositoryPath, argument),
        { repositoryPath, signal: cancellation.signal },
      );
      process.stdout.write(`Run created: ${orchestrator.snapshot().runId}\n`);
      const state = await orchestrator.execute();
      process.stdout.write(renderStatus(state));
      return state.status === 'COMPLETED' ? 0 : 2;
    } finally {
      cancellation.dispose();
    }
  }
  if (command === 'resume') {
    const cancellation = installCancellationSignal();
    try {
      const orchestrator = await AgentOrchestrator.resume(argument, {
        repositoryPath,
        signal: cancellation.signal,
      });
      const state = await orchestrator.execute();
      process.stdout.write(renderStatus(state));
      return state.status === 'COMPLETED' ? 0 : 2;
    } finally {
      cancellation.dispose();
    }
  }
  if (command === 'recover-handoffs') {
    const { orchestrator, recovered, skipped } = await AgentOrchestrator.recoverHandoffFailures(
      argument,
      { repositoryPath },
    );
    process.stdout.write(`${JSON.stringify({
      runId: orchestrator.snapshot().runId,
      runStatus: orchestrator.snapshot().status,
      recovered,
      skipped,
      manualNextStep: recovered.length > 0
        ? 'Inspect the recovered task(s) below, then run `pnpm agents:resume <run-id>` to continue the run.'
        : 'No FAILED/HANDOFF_INVALID task was eligible for recovery; nothing changed.',
    }, null, 2)}\n`);
    return 0;
  }
  if (command === 'retry-integration') {
    const orchestrator = await AgentOrchestrator.retryIntegrationGate(argument, { repositoryPath });
    process.stdout.write(`${JSON.stringify({
      runId: orchestrator.snapshot().runId,
      runStatus: orchestrator.snapshot().status,
      archivedAttempts: orchestrator.snapshot().integrationAttempts?.length ?? 0,
      manualNextStep: 'Run `pnpm agents:resume <run-id>` to actually re-run the deterministic gate.',
    }, null, 2)}\n`);
    return 0;
  }
  if (command === 'status') {
    const { store } = await locateRun(repositoryPath, argument);
    process.stdout.write(renderStatus(await store.load()));
    return 0;
  }
  if (command === 'metrics') {
    const { store } = await locateRun(repositoryPath, argument);
    const state = await store.load();
    const config = state.strategy === 'adaptive'
      ? runtimePhaseConfig(await loadAdaptivePhaseConfig(join(store.runDirectory, 'phase.yaml')), state.adaptive!)
      : await loadAnyPhaseConfig(join(store.runDirectory, 'phase.yaml'));
    const metrics = await computeRunMetrics(store.runDirectory, state, config);
    process.stdout.write(`${JSON.stringify(metrics, null, 2)}\n`);
    return 0;
  }
  if (command === 'cleanup') {
    const { repositoryRoot, store } = await locateRun(repositoryPath, argument);
    const state = await store.load();
    if (state.status === 'RUNNING' || Object.values(state.tasks).some(
      (task) => task.status === 'RUNNING',
    )) {
      throw new Error('Refusing cleanup while the run or a task is RUNNING');
    }
    const manager = await WorktreeManager.create({ repositoryPath: repositoryRoot });
    const cleaned = await manager.cleanupRun(state.runId);
    process.stdout.write(
      `${JSON.stringify({ runId: state.runId, cleaned: cleaned.map(({ entry }) => entry.path) }, null, 2)}\n`,
    );
    return 0;
  }

  process.stderr.write(`Unknown command: ${command}\n${USAGE}\n`);
  return 1;
}

function installCancellationSignal(): {
  readonly signal: AbortSignal;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on('SIGINT', cancel);
  process.on('SIGTERM', cancel);
  return {
    signal: controller.signal,
    dispose: () => {
      process.off('SIGINT', cancel);
      process.off('SIGTERM', cancel);
    },
  };
}

async function locateRun(
  repositoryPath: string,
  runId: string,
): Promise<{ repositoryRoot: string; store: StateStore }> {
  const git = new GitClient();
  const repositoryRoot = await git.repositoryRoot(repositoryPath);
  return {
    repositoryRoot,
    store: new StateStore(
      join(repositoryRoot, 'tools/agent-orchestrator/runs'),
      runId,
    ),
  };
}

// §15/§14: verified against real --help output before being hard-coded, not
// guessed or left as an inference from an older, indirect note. Claude Code
// 2.1.220 documents both --model and --effort. codex-cli 0.149.0-alpha.4.1
// (`codex exec --help`, discovered via the VS Code extension fallback in
// executable-resolution.ts) documents `-m, --model <MODEL>` but no
// --effort/--reasoning flag of any kind.
const AGENT_CAPABILITY_NOTES: Readonly<Record<'codex' | 'claude', { model: string; effort: string }>> = {
  codex: { model: 'yes (-m/--model, exec subcommand)', effort: 'no (not present in codex exec --help)' },
  claude: { model: 'yes (--model)', effort: 'yes (--effort)' },
};

function describeSource(source: 'override' | 'path' | 'vscode-extension' | undefined): string {
  if (source === undefined) return '';
  if (source === 'override') return ' [via CODEX_EXECUTABLE/CLAUDE_EXECUTABLE override]';
  if (source === 'path') return ' [via PATH]';
  return ' [via VS Code extension discovery]';
}

export function renderPlan(plan: AnyPlanResult): string {
  if ('strategy' in plan && plan.strategy === 'adaptive') {
    const decisions = new Map(plan.preview.grantDecisions.map((decision) => [decision.requestId, decision]));
    const units = new Map(plan.preview.workUnits.map((unit) => [unit.requestId, unit]));
    return `${[
      `Phase: ${String(plan.config.phase)} — ${plan.config.name}`,
      'Strategy: adaptive',
      `Repository: ${plan.repositoryRoot}`,
      `Base: ${plan.config.baseBranch} @ ${plan.baseSha}`,
      `Goal: ${plan.config.goal}`,
      `Limits: ${JSON.stringify(plan.config.policy.limits)}`,
      ...(plan.preview.continuation === undefined ? [] : [
        `Continuation: ${plan.preview.continuation.sourceRunId} / ${plan.preview.continuation.sourceWorkUnitId}`,
        `  source artifact: ${plan.preview.continuation.sourceArtifactPath}`,
        `  source artifact SHA-256: ${plan.preview.continuation.sourceArtifactSha256}`,
        `  imported findings: ${plan.preview.continuation.findings.map((entry) => `${entry.finding.id} (${entry.finding.severity}/${entry.finding.category})`).join(', ')}`,
      ]),
      `Maximum possible concurrency: ${plan.maximumPossibleConcurrency}`,
      ...plan.preview.workRequests.flatMap((request) => {
        const decision = decisions.get(request.id);
        const unit = units.get(request.id);
        return [
          '',
          `${request.id}: ${request.role} / ${request.concern}`,
          `  objective: ${request.objective}`,
          `  reason: ${request.reason}`,
          `  evidence: ${JSON.stringify(request.evidence)}`,
          `  dependencies: ${JSON.stringify(request.dependencies)}`,
          `  capabilities: ${JSON.stringify(request.capabilities)}`,
          `  resourceClaims: ${JSON.stringify(request.resourceClaims)}`,
          `  risk/priority: ${request.risk}/${request.priority}`,
          `  arbiter: ${decision?.outcome ?? 'REQUESTED'} — ${decision?.reason ?? 'not evaluated'}${decision?.detail === undefined ? '' : ` — ${decision.detail}`}`,
          `  workUnit: ${unit?.id ?? 'none'} (${unit?.status ?? 'not materialized'})`,
        ];
      }),
      '',
      `Synthesis: ${plan.preview.workRequests.filter((request) => request.role === 'synthesis').map((request) => request.id).join(', ') || 'none'}`,
      'Plan only: no agents, branches, worktrees, run state, or model calls were created.',
    ].join('\n')}\n`;
  }
  const staticPlan = plan as PlanResult;
  const lines = [
    `Phase: ${String(staticPlan.config.phase)} — ${staticPlan.config.name}`,
    `Repository: ${staticPlan.repositoryRoot}`,
    `Base: ${staticPlan.config.baseBranch} @ ${staticPlan.baseSha}`,
    `Codex executable: ${staticPlan.agentExecutables.codex}${describeSource(staticPlan.agentExecutableSources.codex)}`,
    `  model override support: ${AGENT_CAPABILITY_NOTES.codex.model}`,
    `  effort override support: ${AGENT_CAPABILITY_NOTES.codex.effort}`,
    `Claude executable: ${staticPlan.agentExecutables.claude}${describeSource(staticPlan.agentExecutableSources.claude)}`,
    `  model override support: ${AGENT_CAPABILITY_NOTES.claude.model}`,
    `  effort override support: ${AGENT_CAPABILITY_NOTES.claude.effort}`,
    `Concurrency: ${staticPlan.config.concurrency}`,
    '',
  ];
  staticPlan.waves.forEach((wave, index) => {
    lines.push(`Wave ${index + 1}:`);
    wave.forEach((task) => lines.push(`  ${task.owner}: ${task.id} (${task.mode})`));
    lines.push('');
  });
  lines.push('Plan only: no agents, branches, or worktrees were created.');
  return `${lines.join('\n')}\n`;
}

export function renderStatus(state: RunState): string {
  return `${JSON.stringify({
    runId: state.runId,
    phase: state.phase,
    status: state.status,
    ...(state.strategy === undefined ? {} : { strategy: state.strategy }),
    baseBranch: state.baseBranch,
    baseSha: state.baseSha,
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, {
      status: task.status,
      attempts: task.agentAttempts.length,
      latestAttempt: task.agentAttempts.length === 0 ? null : (() => {
        const attempt = task.agentAttempts.at(-1)!;
        return {
          attempt: attempt.attempt,
          executor: attempt.agent,
          configuredTimeoutMs: attempt.timeoutMs ?? null,
          elapsedDurationMs: attempt.durationMs ?? (
            attempt.finishedAt === undefined
              ? Math.max(0, Date.parse(state.updatedAt) - Date.parse(attempt.startedAt))
              : Math.max(0, Date.parse(attempt.finishedAt) - Date.parse(attempt.startedAt))
          ),
          lastPersistedLifecycleEvent: task.status === 'SUCCEEDED'
            ? 'TASK_SUCCEEDED'
            : task.status === 'FAILED' || task.status === 'BLOCKED'
              ? 'TASK_FAILED'
              : attempt.outcome === undefined ? 'AGENT_STARTED' : 'AGENT_FINISHED',
          outcome: attempt.outcome ?? null,
        };
      })(),
      reviewRounds: task.reviewRounds,
      commitSha: task.commit?.sha ?? null,
      error: task.error ?? null,
    }])),
    integration: state.integration,
    ...(state.adaptive === undefined ? {} : {
      adaptive: {
        requests: state.adaptive.workRequests.length,
        decisions: state.adaptive.grantDecisions.length,
        workUnits: state.adaptive.workUnits.length,
        active: state.adaptive.workUnits.filter((unit) => unit.status === 'GRANTED' || unit.status === 'RUNNING').length,
        agentInvocations: state.adaptive.totalAgentInvocations,
        elapsedMs: Math.max(0, Date.parse(state.updatedAt) - Date.parse(state.adaptive.startedAt)),
        grantedEstimatedCostUnits: state.adaptive.grantedEstimatedCostUnits,
        limits: state.adaptive.policy.limits,
        topology: Object.fromEntries(state.adaptive.workRequests.map((request) => {
          const decision = [...state.adaptive!.grantDecisions].reverse().find((item) => item.requestId === request.id);
          const unit = state.adaptive!.workUnits.find((item) => item.requestId === request.id);
          return [request.id, {
            parentWorkUnitId: request.parentWorkUnitId ?? null,
            role: request.role,
            concern: request.concern,
            objective: request.objective,
            evidence: request.evidence,
            dependencies: request.dependencies,
            risk: request.risk,
            priority: request.priority,
            outcome: decision?.outcome ?? 'REQUESTED',
            reason: decision?.reason ?? null,
            decisionDetail: decision?.detail ?? null,
            status: unit === undefined
              ? (decision?.outcome === 'DENIED' ? 'DENIED' : decision?.outcome === 'WAITING' ? 'WAITING' : 'REQUESTED')
              : state.tasks[unit.id]?.status ?? unit.status,
            adaptiveStatus: unit?.status ?? null,
            capabilities: request.capabilities,
            resourceClaims: request.resourceClaims,
            route: unit?.route ?? null,
            workUnitId: unit?.id ?? null,
            workAttempts: unit?.attempts.length ?? 0,
            handoffPath: unit === undefined ? null : state.tasks[unit.id]?.handoffPath ?? null,
            reviewPaths: unit === undefined ? [] : state.tasks[unit.id]?.reviewPaths ?? [],
            commitSha: unit === undefined ? null : state.tasks[unit.id]?.commit?.sha ?? null,
          }];
        })),
        synthesis: state.adaptive.workRequests.filter((request) => request.role === 'synthesis').map((request) => request.id),
      },
    }),
    manualNextStep: state.status === 'COMPLETED'
      ? 'Inspect the integration worktree, handoffs, reviews, and logs; human approval is required before merge or push.'
      : 'Inspect run artifacts and resolve the reported failure/blocker; no merge or push occurred.',
  }, null, 2)}\n`;
}

if (require.main === module) {
  void main(process.argv.slice(2)).then(
    (exitCode) => {
      process.exitCode = exitCode;
    },
    (error: unknown) => {
      const candidate = error as { code?: unknown; message?: unknown; details?: unknown };
      process.stderr.write(`${JSON.stringify({
        code: typeof candidate.code === 'string' ? candidate.code : 'UNEXPECTED_ERROR',
        message: typeof candidate.message === 'string' ? candidate.message : String(error),
        ...(candidate.details !== undefined ? { details: candidate.details } : {}),
      }, null, 2)}\n`);
      process.exitCode = 2;
    },
  );
}
