#!/usr/bin/env node

import { join, resolve } from 'node:path';

import { GitClient, WorktreeManager } from './git';
import { AgentOrchestrator, planPhase } from './orchestrator';
import { StateStore, type RunState } from './state';

const USAGE = `TripWith local agent orchestrator

Usage:
  pnpm agents:plan <phase-file>
  pnpm agents:run <phase-file>
  pnpm agents:resume <run-id>
  pnpm agents:status <run-id>
  pnpm agents:cleanup <run-id>

Planning is read-only. Running or resuming may invoke locally authenticated paid agents.
No command merges into the phase branch or pushes to a remote.`;

async function main(argv: readonly string[]): Promise<number> {
  const [command, argument, ...extra] = argv;
  if (command === undefined || command === '--help' || command === '-h') {
    process.stdout.write(`${USAGE}\n`);
    return command === undefined ? 1 : 0;
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
  if (command === 'status') {
    const { store } = await locateRun(repositoryPath, argument);
    process.stdout.write(renderStatus(await store.load()));
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

function renderPlan(plan: Awaited<ReturnType<typeof planPhase>>): string {
  const lines = [
    `Phase: ${String(plan.config.phase)} — ${plan.config.name}`,
    `Repository: ${plan.repositoryRoot}`,
    `Base: ${plan.config.baseBranch} @ ${plan.baseSha}`,
    `Codex: ${plan.agentExecutables.codex}`,
    `Claude: ${plan.agentExecutables.claude}`,
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
