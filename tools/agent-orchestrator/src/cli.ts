#!/usr/bin/env node

import { join, resolve } from 'node:path';

import { GitClient, WorktreeManager } from './git';
import { computeRunMetrics } from './metrics/compute-metrics';
import { AgentOrchestrator, planPhase } from './orchestrator';
import { StateStore, type RunState } from './state';
import { loadAnyPhaseConfig } from './workflow/solver-verifier';

const USAGE = `TripWith local agent orchestrator

Usage:
  pnpm agents:plan <phase-file>
  pnpm agents:run <phase-file>
  pnpm agents:resume <run-id>
  pnpm agents:status <run-id>
  pnpm agents:cleanup <run-id>
  pnpm agents:metrics <run-id>
  pnpm agents:recover-handoffs <run-id>
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
  if (argument === undefined || extra.length > 0) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }

  const repositoryPath = await new GitClient().repositoryRoot(process.cwd());
  if (command === 'plan') {
    const plan = await planPhase(resolve(repositoryPath, argument), { repositoryPath });
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
    const config = await loadAnyPhaseConfig(join(store.runDirectory, 'phase.yaml'));
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

function renderPlan(plan: Awaited<ReturnType<typeof planPhase>>): string {
  const lines = [
    `Phase: ${String(plan.config.phase)} — ${plan.config.name}`,
    `Repository: ${plan.repositoryRoot}`,
    `Base: ${plan.config.baseBranch} @ ${plan.baseSha}`,
    `Codex executable: ${plan.agentExecutables.codex}${describeSource(plan.agentExecutableSources.codex)}`,
    `  model override support: ${AGENT_CAPABILITY_NOTES.codex.model}`,
    `  effort override support: ${AGENT_CAPABILITY_NOTES.codex.effort}`,
    `Claude executable: ${plan.agentExecutables.claude}${describeSource(plan.agentExecutableSources.claude)}`,
    `  model override support: ${AGENT_CAPABILITY_NOTES.claude.model}`,
    `  effort override support: ${AGENT_CAPABILITY_NOTES.claude.effort}`,
    `Concurrency: ${plan.config.concurrency}`,
    '',
  ];
  plan.waves.forEach((wave, index) => {
    lines.push(`Wave ${index + 1}:`);
    wave.forEach((task) => lines.push(`  ${task.owner}: ${task.id} (${task.mode})`));
    lines.push('');
  });
  lines.push('Plan only: no agents, branches, or worktrees were created.');
  return `${lines.join('\n')}\n`;
}

function renderStatus(state: RunState): string {
  return `${JSON.stringify({
    runId: state.runId,
    phase: state.phase,
    status: state.status,
    baseBranch: state.baseBranch,
    baseSha: state.baseSha,
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, {
      status: task.status,
      attempts: task.agentAttempts.length,
      reviewRounds: task.reviewRounds,
      commitSha: task.commit?.sha ?? null,
      error: task.error ?? null,
    }])),
    integration: state.integration,
    manualNextStep: state.status === 'COMPLETED'
      ? 'Inspect the integration worktree, handoffs, reviews, and logs; human approval is required before merge or push.'
      : 'Inspect run artifacts and resolve the reported failure/blocker; no merge or push occurred.',
  }, null, 2)}\n`;
}

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
