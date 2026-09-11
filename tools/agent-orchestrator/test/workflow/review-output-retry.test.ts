import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { appendFile, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunEvent, RunState, TaskRunState } from '../../src/state';
import { createTemporaryRepository, type TemporaryRepository } from '../git/helpers';

const target = 'event-chat-review';
const prose = 'Review complete. Intended verdict: approved, no material findings.\n';
const approved = { status: 'approved', findings: [] };

class ReviewRetryAgent implements Agent {
  readonly requests: AgentRequest[] = [];
  constructor(readonly name: AgentName, private malformedReviews = 1) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.requests.push(request);
    await request.onStarted?.(process.pid);
    const attempt = request.attempt ?? 1;
    const prefix = `${request.runId}.${request.taskId}.${this.name}.attempt-${attempt}`;
    const stdoutPath = join(request.artifactsDirectory, `${prefix}.stdout.log`);
    const stderrPath = join(request.artifactsDirectory, `${prefix}.stderr.log`);
    await mkdir(request.artifactsDirectory, { recursive: true });

    let output: unknown;
    let rawStdout: string;
    if (request.taskId === 'event-chat-implementation') {
      await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented\n', 'utf8');
      output = completeHandoff();
      rawStdout = `${JSON.stringify(output)}\n`;
    } else if (request.taskId === target && this.malformedReviews > 0) {
      this.malformedReviews -= 1;
      output = null;
      rawStdout = prose;
    } else {
      output = approved;
      rawStdout = `${JSON.stringify(output)}\n`;
    }
    await writeFile(stdoutPath, rawStdout, 'utf8');
    await writeFile(stderrPath, '', 'utf8');
    const timestamp = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId,
      status: 'succeeded', failureCode: null, exitCode: 0, signal: null,
      stdoutPath, stderrPath, structuredHandoff: output, rawStdout,
      changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: timestamp, endedAt: timestamp, durationMs: 1,
      timedOut: false, aborted: false, errorMessage: null,
    };
  }
}

interface Fixture {
  readonly repository: TemporaryRepository;
  readonly runsRoot: string;
  readonly runId: string;
  readonly orchestrator: AgentOrchestrator;
  readonly codex: ReviewRetryAgent;
  readonly claude: ReviewRetryAgent;
}

async function fixture(options: { readonly mode?: string; readonly writer?: boolean; readonly unrelatedFailure?: boolean; readonly condition?: boolean } = {}): Promise<Fixture> {
  const repository = await createTemporaryRepository();
  await writeFile(join(repository.repository, 'design.md'), '# Design\n', 'utf8');
  await repository.git.run(repository.repository, ['add', '--', 'design.md']);
  await repository.git.run(repository.repository, ['commit', '-m', 'design']);
  const phaseFile = join(repository.container, 'phase.yaml');
  await writeFile(phaseFile, phaseYaml(repository.baseBranch, options), 'utf8');
  const runsRoot = join(repository.container, 'runs');
  const codex = new ReviewRetryAgent('codex', 0);
  const claude = new ReviewRetryAgent('claude');
  const orchestrator = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: repository.repository, runsRoot, agents: { codex, claude },
  });
  const failed = await orchestrator.execute();
  assert.equal(failed.status, 'FAILED');
  return { repository, runsRoot, runId: failed.runId, orchestrator, codex, claude };
}

const options = (value: Fixture) => ({
  repositoryPath: value.repository.repository,
  runsRoot: value.runsRoot,
  agents: { codex: value.codex, claude: value.claude },
});

async function events(value: Fixture): Promise<RunEvent[]> {
  return (await readFile(value.orchestrator.stateStore.eventsPath, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as RunEvent);
}

async function save(value: Fixture, transform: (state: RunState) => RunState): Promise<void> {
  await value.orchestrator.stateStore.save(transform(value.orchestrator.snapshot()));
}

async function refuses(value: Fixture, taskId = target): Promise<void> {
  const beforeState = await readFile(value.orchestrator.stateStore.statePath, 'utf8');
  const beforeEvents = await readFile(value.orchestrator.stateStore.eventsPath, 'utf8');
  const beforeInvocations = value.codex.requests.length + value.claude.requests.length;
  await assert.rejects(
    AgentOrchestrator.retryReviewOutput(value.runId, taskId, options(value)),
    (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
  );
  assert.equal(await readFile(value.orchestrator.stateStore.statePath, 'utf8'), beforeState);
  assert.equal(await readFile(value.orchestrator.stateStore.eventsPath, 'utf8'), beforeEvents);
  assert.equal(value.codex.requests.length + value.claude.requests.length, beforeInvocations);
}

test('structured-review authorization preserves failure evidence and resume uses the normal accepted-review path', async () => {
  const value = await fixture();
  try {
    const failed = value.orchestrator.snapshot();
    const originalTask = failed.tasks[target]!;
    const stdoutPath = originalTask.agentAttempts.length === 1
      ? join(value.orchestrator.stateStore.runDirectory, 'logs', `${value.runId}.${target}.claude.attempt-1.stdout.log`)
      : '';
    const originalStdout = await readFile(stdoutPath);
    const invocationsBefore = value.codex.requests.length + value.claude.requests.length;

    assert.equal(originalTask.status, 'FAILED');
    assert.equal(originalTask.error?.code, 'REVIEW_BLOCKED');
    assert.equal(originalTask.agentAttempts[0]?.outcome, 'succeeded');
    assert.equal(originalTask.handoffOutcome, 'invalid');
    assert.equal(originalTask.reviewRounds, 0);
    assert.deepEqual(originalTask.reviewPaths, []);

    const authorized = await AgentOrchestrator.retryReviewOutput(value.runId, target, options(value));
    const reopened = authorized.orchestrator.snapshot();
    assert.equal(value.codex.requests.length + value.claude.requests.length, invocationsBefore);
    assert.equal(reopened.status, 'RUNNING');
    assert.equal(reopened.tasks[target]?.status, 'READY');
    assert.equal(reopened.tasks['event-chat-final-review']?.status, 'PENDING');
    assert.deepEqual(authorized.reopenedTasks, ['event-chat-final-review']);
    assert.deepEqual(reopened.tasks[target]?.agentAttempts, originalTask.agentAttempts);
    assert.deepEqual(reopened.tasks[target]?.handoffRepairAttempts, originalTask.handoffRepairAttempts);
    assert.equal(reopened.tasks[target]?.reviewOutputRecoveries?.length, 1);
    assert.deepEqual(reopened.tasks[target]?.reviewOutputRecoveries?.[0]?.error, originalTask.error);
    assert.deepEqual(reopened.tasks[target]?.reviewOutputRecoveries?.[0]?.attempt, originalTask.agentAttempts[0]);
    assert.equal(
      reopened.tasks[target]?.reviewOutputRecoveries?.[0]?.stdoutSha256,
      createHash('sha256').update(originalStdout).digest('hex'),
    );
    assert.equal(await readFile(stdoutPath, 'utf8'), prose);
    assert.deepEqual(await readFile(stdoutPath), originalStdout);
    assert.ok((await events(value)).some((event) => event.name === 'REVIEW_OUTPUT_RETRY_AUTHORIZED'));

    const resumed = await AgentOrchestrator.resume(value.runId, options(value));
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.deepEqual(completed.tasks[target]?.agentAttempts.map((attempt) => attempt.outcome), ['succeeded', 'succeeded']);
    assert.equal(completed.tasks[target]?.reviewRounds, 1);
    assert.equal(completed.tasks[target]?.reviewPaths.length, 1);
    assert.equal(completed.tasks['event-chat-final-review']?.status, 'SUCCEEDED');
    assert.equal(completed.tasks['event-chat-final-review']?.reviewRounds, 1);
    assert.equal(value.claude.requests.filter((request) => request.taskId === target).length, 2);
    assert.equal(value.claude.requests.at(-2)?.access, 'read_only');
    assert.ok(JSON.stringify(value.claude.requests.at(-2)?.taskSpecification).includes('responseSchema'));
    assert.equal((await resumed.cleanup()).length, 4);
  } finally {
    await value.repository.dispose();
  }
});

test('structured-review retry is bounded and concurrent authorization cannot double-authorize', async () => {
  const value = await fixture();
  try {
    const outcomes = await Promise.allSettled([
      AgentOrchestrator.retryReviewOutput(value.runId, target, options(value)),
      AgentOrchestrator.retryReviewOutput(value.runId, target, options(value)),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    const state = await value.orchestrator.stateStore.load();
    assert.equal(state.tasks[target]?.reviewOutputRecoveries?.length, 1);
    assert.equal((await events(value)).filter((event) => event.name === 'REVIEW_OUTPUT_RETRY_AUTHORIZED').length, 1);
    await refuses(value);
  } finally {
    await value.repository.dispose();
  }
});

test('retry-review-output CLI authorizes without invoking a provider and reports the manual resume step', async () => {
  const value = await fixture();
  try {
    const invocationsBefore = value.codex.requests.length + value.claude.requests.length;
    const repositoryRuns = join(value.repository.repository, 'tools/agent-orchestrator/runs');
    await mkdir(repositoryRuns, { recursive: true });
    await rename(
      value.orchestrator.stateStore.runDirectory,
      join(repositoryRuns, value.runId),
    );
    const cli = resolve(__dirname, '../../src/cli.js');
    const result = spawnSync(process.execPath, [cli, 'retry-review-output', value.runId, target], {
      cwd: value.repository.repository,
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.runId, value.runId);
    assert.equal(output.runStatus, 'RUNNING');
    assert.equal(output.taskId, target);
    assert.equal(output.archivedRecovery, 1);
    assert.match(output.originalStdoutSha256, /^[0-9a-f]{64}$/);
    assert.match(output.manualNextStep, /agents:resume/);
    assert.equal(value.codex.requests.length + value.claude.requests.length, invocationsBefore);
  } finally {
    await value.repository.dispose();
  }
});

for (const scenario of ['wrong-error', 'failed-process', 'timed-out-process', 'accepted-review', 'accepted-handoff', 'non-quiescent', 'started-integration'] as const) {
  test(`structured-review retry refuses ${scenario}`, async () => {
    const value = await fixture();
    try {
      await save(value, (state) => {
        const task = state.tasks[target]!;
        const attempt = task.agentAttempts[0]!;
        const targetPatch: Partial<TaskRunState> = scenario === 'wrong-error'
          ? { error: { code: 'HANDOFF_INVALID', message: 'wrong class', at: state.updatedAt } }
          : scenario === 'failed-process' || scenario === 'timed-out-process'
            ? { agentAttempts: [{ ...attempt, outcome: scenario === 'failed-process' ? 'failed' : 'timed_out' }] }
            : scenario === 'accepted-review'
              ? { reviewPaths: [join(value.orchestrator.stateStore.runDirectory, 'reviews', 'accepted.json')], reviewRounds: 1 }
              : scenario === 'accepted-handoff'
                ? { handoffPath: join(value.orchestrator.stateStore.runDirectory, 'handoffs', 'accepted.json') }
                : {};
        if (scenario === 'non-quiescent') {
          const { error: _error, ...descendant } = state.tasks['event-chat-final-review']!;
          return { ...state, tasks: { ...state.tasks, 'event-chat-final-review': { ...descendant, status: 'READY' } } };
        }
        if (scenario === 'started-integration') {
          return { ...state, integration: { ...state.integration, status: 'RUNNING' } };
        }
        return { ...state, tasks: { ...state.tasks, [target]: { ...task, ...targetPatch } } };
      });
      await refuses(value);
    } finally {
      await value.repository.dispose();
    }
  });
}

test('structured-review retry refuses wrong mode and writer review configurations', async () => {
  for (const config of [{ mode: 'testing', writer: false }, { mode: 'review', writer: true }] as const) {
    const value = await fixture(config);
    try { await refuses(value); } finally { await value.repository.dispose(); }
  }
});

test('structured-review retry refuses dirty, moved, and foreign-commit worktrees', async () => {
  for (const scenario of ['dirty', 'moved', 'foreign'] as const) {
    const value = await fixture();
    try {
      const state = value.orchestrator.snapshot();
      const worktree = state.tasks[target]!.worktreePath!;
      if (scenario === 'dirty') await appendFile(join(worktree, 'feature.txt'), 'dirty\n', 'utf8');
      if (scenario === 'moved') await value.repository.git.run(worktree, ['checkout', state.baseSha]);
      if (scenario === 'foreign') {
        await writeFile(join(worktree, 'foreign.txt'), 'foreign\n', 'utf8');
        await value.repository.git.run(worktree, ['add', '--', 'foreign.txt']);
        await value.repository.git.run(worktree, ['commit', '-m', 'foreign']);
      }
      await refuses(value);
    } finally {
      await value.repository.dispose();
    }
  }
});

test('structured-review retry refuses drifted dependency evidence', async () => {
  const value = await fixture();
  try {
    await save(value, (state) => ({
      ...state,
      tasks: {
        ...state.tasks,
        'event-chat-implementation': {
          ...state.tasks['event-chat-implementation']!,
          commit: { ...state.tasks['event-chat-implementation']!.commit!, sha: state.baseSha },
        },
      },
    }));
    await refuses(value);
  } finally {
    await value.repository.dispose();
  }
});

test('structured-review retry refuses missing stdout and missing worktree registration', async () => {
  for (const scenario of ['stdout', 'registration'] as const) {
    const value = await fixture();
    try {
      if (scenario === 'stdout') {
        await unlink(join(
          value.orchestrator.stateStore.runDirectory,
          'logs',
          `${value.runId}.${target}.claude.attempt-1.stdout.log`,
        ));
      } else {
        const registryPath = join(value.repository.repository, '.agent-worktrees', 'registry.json');
        const registry = JSON.parse(await readFile(registryPath, 'utf8')) as {
          entries: { taskId: string | null }[];
        };
        registry.entries = registry.entries.filter((entry) => entry.taskId !== target);
        await writeFile(registryPath, `${JSON.stringify(registry, null, 2)}\n`, 'utf8');
      }
      await refuses(value);
    } finally {
      await value.repository.dispose();
    }
  }
});

test('structured-review retry re-evaluates the current task condition', async () => {
  const value = await fixture({ condition: true });
  try {
    const reviewPath = value.orchestrator.snapshot().tasks['gate-review']!.reviewPaths[0]!;
    await writeFile(reviewPath, JSON.stringify({
      status: 'blocked',
      findings: [{
        id: 'F001', severity: 'high', category: 'correctness', file: 'feature.txt', location: '1',
        problem: 'blocked', evidence: 'current evidence', impact: 'cannot continue',
        suggestedFix: 'fix it', verificationRequired: 'inspect the fix',
      }],
    }), 'utf8');
    await refuses(value);
  } finally {
    await value.repository.dispose();
  }
});

test('structured-review retry reopens only descendants attributable to the target', async () => {
  const value = await fixture({ unrelatedFailure: true });
  try {
    const result = await AgentOrchestrator.retryReviewOutput(value.runId, target, options(value));
    const state = result.orchestrator.snapshot();
    assert.deepEqual(result.reopenedTasks, ['event-chat-final-review']);
    assert.equal(state.tasks['event-chat-final-review']?.status, 'PENDING');
    assert.equal(state.tasks['independent-failure']?.status, 'FAILED');
    assert.equal(state.tasks['mixed-downstream']?.status, 'BLOCKED');
  } finally {
    await value.repository.dispose();
  }
});

function phaseYaml(baseBranch: string, options: { readonly mode?: string; readonly writer?: boolean; readonly unrelatedFailure?: boolean; readonly condition?: boolean }): string {
  return `
phase: review-output-retry
name: Structured review retry
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 2
agentRetries: 0
maxReviewRounds: 3
tasks:
  - id: event-chat-implementation
    title: Implement EVENT chat
    owner: codex
    mode: implementation
    effort: medium
    files: [feature.txt]
${options.condition === true ? `  - id: gate-review
    title: Gate review
    owner: claude
    mode: review
    effort: high
    dependsOn: [event-chat-implementation]
` : ''}  - id: ${target}
    title: Review EVENT chat
    owner: claude
    mode: ${options.mode ?? 'review'}
    effort: high
    dependsOn: [${options.condition === true ? 'gate-review' : 'event-chat-implementation'}]
${options.condition === true ? '    condition: { reviewOf: gate-review, skipIfStatus: [blocked] }\n' : ''}
${options.writer === undefined ? '' : `    writer: ${options.writer}\n${options.writer ? '    files: [review-note.txt]\n' : ''}`}  - id: event-chat-final-review
    title: Final review
    owner: claude
    mode: final_review
    effort: high
    dependsOn: [${target}]
${options.unrelatedFailure === true ? `  - id: independent-failure
    title: Independent failure
    owner: codex
    mode: implementation
    effort: medium
    files: [independent.txt]
  - id: mixed-downstream
    title: Mixed downstream
    owner: claude
    mode: final_review
    effort: high
    dependsOn: [${target}, independent-failure]
` : ''}integration:
  commands: ['node -e "process.exit(0)"']
`;
}

function completeHandoff(): unknown {
  return {
    status: 'complete', summary: 'implemented', filesChanged: ['feature.txt'], decisions: [],
    tests: [{ command: 'test', result: 'pass', details: 'passed' }], openQuestions: [], reviewRequested: [],
  };
}
