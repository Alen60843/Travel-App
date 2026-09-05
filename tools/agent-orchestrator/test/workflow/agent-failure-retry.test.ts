import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunState } from '../../src/state';
import { createTemporaryRepository, type TemporaryRepository } from '../git/helpers';

class RetryScenarioAgent implements Agent {
  readonly invocations: string[] = [];

  constructor(
    readonly name: AgentName,
    private reviewFailuresRemaining = 1,
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request.taskId);
    await request.onStarted?.(process.pid);
    if (request.taskId === 'events-core-api') {
      await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented\n', 'utf8');
      return successfulResult(this.name, request, completeHandoff());
    }
    if (request.taskId === 'independent-failure') {
      return failedResult(this.name, request);
    }
    if (request.taskId === 'events-core-review' && this.reviewFailuresRemaining > 0) {
      this.reviewFailuresRemaining -= 1;
      return failedResult(this.name, request);
    }
    return successfulResult(this.name, request, { status: 'approved', findings: [] });
  }
}

interface FailedScenario {
  readonly fixture: TemporaryRepository;
  readonly runsRoot: string;
  readonly runId: string;
  readonly orchestrator: AgentOrchestrator;
  readonly codex: RetryScenarioAgent;
  readonly claude: RetryScenarioAgent;
}

test('Phase 6 shape: explicit retry preserves the successful implementation and resume reruns only the failed review', async () => {
  const scenario = await createFailedScenario();
  try {
    const failed = scenario.orchestrator.snapshot();
    const implementationBefore = failed.tasks['events-core-api']!;
    const commitBefore = implementationBefore.commit!;
    assert.equal(failed.status, 'FAILED');
    assert.equal(implementationBefore.status, 'SUCCEEDED');
    assert.equal(implementationBefore.agentAttempts.length, 1);
    assert.equal(failed.tasks['events-core-review']?.error?.code, 'AGENT_FAILED');
    assert.equal(failed.tasks['events-core-final-review']?.error?.code, 'TASK_DEPENDENCY_FAILED');

    const invocationsBeforeRecovery = [
      ...scenario.codex.invocations,
      ...scenario.claude.invocations,
    ];
    const recovered = await AgentOrchestrator.retryAgentFailure(
      scenario.runId,
      'events-core-review',
      recoveryOptions(scenario),
    );
    const authorized = recovered.orchestrator.snapshot();

    assert.deepEqual(
      [...scenario.codex.invocations, ...scenario.claude.invocations],
      invocationsBeforeRecovery,
      'the recovery command must not invoke an agent',
    );
    assert.equal(authorized.status, 'RUNNING');
    assert.equal(authorized.tasks['events-core-review']?.status, 'READY');
    assert.equal(authorized.tasks['events-core-final-review']?.status, 'PENDING');
    assert.deepEqual(recovered.reopenedTasks, ['events-core-final-review']);
    assert.deepEqual(authorized.tasks['events-core-api'], implementationBefore);
    assert.equal(authorized.tasks['events-core-api']?.commit?.sha, commitBefore.sha);
    assert.equal(authorized.tasks['events-core-api']?.agentAttempts.length, 1);
    assert.equal(authorized.tasks['events-core-review']?.agentAttempts.length, 1);
    assert.equal(authorized.tasks['events-core-review']?.agentAttempts[0]?.outcome, 'failed');
    assert.equal(authorized.tasks['events-core-review']?.agentFailureRecoveries?.length, 1);
    assert.equal(
      authorized.tasks['events-core-review']?.agentFailureRecoveries?.[0]?.error.code,
      'AGENT_FAILED',
    );

    const events = (await readFile(recovered.orchestrator.stateStore.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { name: string; taskId?: string });
    assert.ok(events.some((event) =>
      event.name === 'AGENT_RETRY_AUTHORIZED' && event.taskId === 'events-core-review'));
    assert.ok(events.some((event) =>
      event.name === 'TASK_DEPENDENCY_REOPENED'
      && event.taskId === 'events-core-final-review'));

    const resumed = await AgentOrchestrator.resume(scenario.runId, recoveryOptions(scenario));
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.deepEqual(completed.tasks['events-core-api'], implementationBefore);
    assert.equal(completed.tasks['events-core-api']?.commit?.sha, commitBefore.sha);
    assert.equal(completed.tasks['events-core-api']?.agentAttempts.length, 1);
    assert.deepEqual(
      completed.tasks['events-core-review']?.agentAttempts.map((attempt) => attempt.outcome),
      ['failed', 'succeeded'],
    );
    assert.equal(completed.tasks['events-core-final-review']?.agentAttempts.length, 1);
    assert.deepEqual(scenario.codex.invocations, ['events-core-api']);
    assert.deepEqual(
      scenario.claude.invocations,
      ['events-core-review', 'events-core-review', 'events-core-final-review'],
    );
    assert.equal((await resumed.cleanup()).length, 4);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('retry-agent refuses a SUCCEEDED task without changing persisted state', async () => {
  const scenario = await createFailedScenario();
  try {
    const before = scenario.orchestrator.snapshot();
    await assert.rejects(
      AgentOrchestrator.retryAgentFailure(
        scenario.runId,
        'events-core-api',
        recoveryOptions(scenario),
      ),
      (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
    );
    assert.deepEqual(await scenario.orchestrator.stateStore.load(), before);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('retry-agent refuses a non-terminal run even when the task has a process failure', async () => {
  const scenario = await createFailedScenario();
  try {
    const before = scenario.orchestrator.snapshot();
    await scenario.orchestrator.stateStore.save({ ...before, status: 'RUNNING' });
    await assert.rejects(
      AgentOrchestrator.retryAgentFailure(
        scenario.runId,
        'events-core-review',
        recoveryOptions(scenario),
      ),
      (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('retry-agent accepts the provider-neutral AGENT_TIMEOUT process shape', async () => {
  const scenario = await createFailedScenario();
  try {
    const before = scenario.orchestrator.snapshot();
    const review = before.tasks['events-core-review']!;
    const attempts = review.agentAttempts.map((attempt, index) =>
      index === review.agentAttempts.length - 1 ? { ...attempt, outcome: 'timed_out' as const } : attempt);
    await scenario.orchestrator.stateStore.save({
      ...before,
      tasks: {
        ...before.tasks,
        'events-core-review': {
          ...review,
          agentAttempts: attempts,
          error: {
            code: 'AGENT_TIMEOUT',
            message: 'bounded execution timeout',
            at: before.updatedAt,
          },
        },
      },
    });
    const recovered = await AgentOrchestrator.retryAgentFailure(
      scenario.runId,
      'events-core-review',
      recoveryOptions(scenario),
    );
    assert.equal(recovered.orchestrator.snapshot().tasks['events-core-review']?.status, 'READY');
    assert.equal(recovered.recovery.error.code, 'AGENT_TIMEOUT');
  } finally {
    await scenario.fixture.dispose();
  }
});

test('retry-agent refuses a failed task with a recorded successful commit', async () => {
  const scenario = await createFailedScenario();
  try {
    const before = scenario.orchestrator.snapshot();
    await scenario.orchestrator.stateStore.save({
      ...before,
      tasks: {
        ...before.tasks,
        'events-core-review': {
          ...before.tasks['events-core-review']!,
          commit: before.tasks['events-core-api']!.commit!,
        },
      },
    });
    await assert.rejects(
      AgentOrchestrator.retryAgentFailure(
        scenario.runId,
        'events-core-review',
        recoveryOptions(scenario),
      ),
      (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('retry-agent refuses a failed task with an accepted structured artifact', async () => {
  const scenario = await createFailedScenario();
  try {
    const before = scenario.orchestrator.snapshot();
    await scenario.orchestrator.stateStore.save({
      ...before,
      tasks: {
        ...before.tasks,
        'events-core-review': {
          ...before.tasks['events-core-review']!,
          reviewPaths: [join(scenario.orchestrator.stateStore.runDirectory, 'reviews', 'accepted.json')],
        },
      },
    });
    await assert.rejects(
      AgentOrchestrator.retryAgentFailure(
        scenario.runId,
        'events-core-review',
        recoveryOptions(scenario),
      ),
      (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('retry-agent refuses when a required dependency is no longer SUCCEEDED or SKIPPED', async () => {
  const scenario = await createFailedScenario();
  try {
    const before = scenario.orchestrator.snapshot();
    await scenario.orchestrator.stateStore.save({
      ...before,
      tasks: {
        ...before.tasks,
        'events-core-api': {
          ...before.tasks['events-core-api']!,
          status: 'FAILED',
          error: {
            code: 'AGENT_FAILED',
            message: 'dependency no longer succeeded',
            at: before.updatedAt,
          },
        },
      },
    });
    await assert.rejects(
      AgentOrchestrator.retryAgentFailure(
        scenario.runId,
        'events-core-review',
        recoveryOptions(scenario),
      ),
      (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

for (const semanticCode of ['HANDOFF_INVALID', 'REVIEW_BLOCKED'] as const) {
  test(`retry-agent refuses ${semanticCode} structured-output recovery`, async () => {
    const scenario = await createFailedScenario();
    try {
      const before = scenario.orchestrator.snapshot();
      await scenario.orchestrator.stateStore.save(withReviewError(before, semanticCode));
      await assert.rejects(
        AgentOrchestrator.retryAgentFailure(
          scenario.runId,
          'events-core-review',
          recoveryOptions(scenario),
        ),
        (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
      );
      assert.equal(
        (await scenario.orchestrator.stateStore.load()).tasks['events-core-review']?.error?.code,
        semanticCode,
      );
    } finally {
      await scenario.fixture.dispose();
    }
  });
}

test('retry-agent refuses a run with integration failure state', async () => {
  const scenario = await createFailedScenario();
  try {
    const before = scenario.orchestrator.snapshot();
    await scenario.orchestrator.stateStore.save({
      ...before,
      status: 'BLOCKED',
      integration: {
        ...before.integration,
        status: 'BLOCKED',
        error: {
          code: 'INTEGRATION_TEST_FAILED',
          message: 'gate failed',
          at: before.updatedAt,
        },
      },
    });
    await assert.rejects(
      AgentOrchestrator.retryAgentFailure(
        scenario.runId,
        'events-core-review',
        recoveryOptions(scenario),
      ),
      (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('retry-agent refuses ambiguous dirty work in the failed task worktree', async () => {
  const scenario = await createFailedScenario();
  try {
    const before = scenario.orchestrator.snapshot();
    const reviewWorktree = before.tasks['events-core-review']!.worktreePath!;
    await appendFile(join(reviewWorktree, 'feature.txt'), 'ambiguous change\n', 'utf8');
    await assert.rejects(
      AgentOrchestrator.retryAgentFailure(
        scenario.runId,
        'events-core-review',
        recoveryOptions(scenario),
      ),
      (error: unknown) =>
        isOrchestratorError(error, 'TASK_STATE_INVALID')
        && error.message.includes('uncommitted or untracked changes'),
    );
    assert.equal((await scenario.orchestrator.stateStore.load()).status, 'FAILED');
  } finally {
    await scenario.fixture.dispose();
  }
});

test('retry-agent reopens only dependency failures attributable solely to the target', async () => {
  const scenario = await createFailedScenario({ includeIndependentFailure: true });
  try {
    const recovered = await AgentOrchestrator.retryAgentFailure(
      scenario.runId,
      'events-core-review',
      recoveryOptions(scenario),
    );
    const state = recovered.orchestrator.snapshot();
    assert.deepEqual(recovered.reopenedTasks, ['events-core-final-review']);
    assert.equal(state.tasks['events-core-final-review']?.status, 'PENDING');
    assert.equal(state.tasks['mixed-downstream']?.status, 'BLOCKED');
    assert.equal(state.tasks['mixed-downstream']?.error?.code, 'TASK_DEPENDENCY_FAILED');
    assert.equal(state.tasks['independent-failure']?.status, 'FAILED');
  } finally {
    await scenario.fixture.dispose();
  }
});

test('agent failure recovery history and agent attempts remain append-only across repeated failures', async () => {
  const scenario = await createFailedScenario({ reviewFailures: 2, includeDownstream: false });
  try {
    const first = await AgentOrchestrator.retryAgentFailure(
      scenario.runId,
      'events-core-review',
      recoveryOptions(scenario),
    );
    const firstArchive = first.recovery;
    const resumed = await AgentOrchestrator.resume(scenario.runId, recoveryOptions(scenario));
    const failedAgain = await resumed.execute();
    assert.equal(failedAgain.status, 'FAILED');
    assert.deepEqual(
      failedAgain.tasks['events-core-review']?.agentAttempts.map((attempt) => attempt.outcome),
      ['failed', 'failed'],
    );

    const second = await AgentOrchestrator.retryAgentFailure(
      scenario.runId,
      'events-core-review',
      recoveryOptions(scenario),
    );
    const history = second.orchestrator.snapshot().tasks['events-core-review']!
      .agentFailureRecoveries!;
    assert.equal(history.length, 2);
    assert.deepEqual(history[0], firstArchive);
    assert.equal(history[1]?.recovery, 2);
    assert.equal(history[1]?.attempt.attempt, 2);
    assert.deepEqual(
      second.orchestrator.snapshot().tasks['events-core-review']?.agentAttempts.map(
        (attempt) => attempt.attempt,
      ),
      [1, 2],
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

async function createFailedScenario(options: {
  readonly reviewFailures?: number;
  readonly includeDownstream?: boolean;
  readonly includeIndependentFailure?: boolean;
} = {}): Promise<FailedScenario> {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);
  const phaseFile = join(fixture.container, 'phase.yaml');
  await writeFile(
    phaseFile,
    phaseYaml(fixture.baseBranch, {
      includeDownstream: options.includeDownstream ?? true,
      includeIndependentFailure: options.includeIndependentFailure ?? false,
    }),
    'utf8',
  );
  const runsRoot = join(fixture.container, 'runs');
  await mkdir(runsRoot, { recursive: true });
  const codex = new RetryScenarioAgent('codex', 0);
  const claude = new RetryScenarioAgent('claude', options.reviewFailures ?? 1);
  const orchestrator = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository,
    runsRoot,
    agents: { codex, claude },
  });
  const failed = await orchestrator.execute();
  assert.equal(failed.status, 'FAILED');
  return { fixture, runsRoot, runId: failed.runId, orchestrator, codex, claude };
}

function recoveryOptions(scenario: FailedScenario) {
  return {
    repositoryPath: scenario.fixture.repository,
    runsRoot: scenario.runsRoot,
    agents: { codex: scenario.codex, claude: scenario.claude },
  };
}

function withReviewError(
  state: RunState,
  code: 'HANDOFF_INVALID' | 'REVIEW_BLOCKED',
): RunState {
  return {
    ...state,
    tasks: {
      ...state.tasks,
      'events-core-review': {
        ...state.tasks['events-core-review']!,
        error: { code, message: 'structured output failed', at: state.updatedAt },
      },
    },
  };
}

function phaseYaml(
  baseBranch: string,
  options: { readonly includeDownstream: boolean; readonly includeIndependentFailure: boolean },
): string {
  return `
phase: retry-test
name: Agent failure retry
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 2
agentRetries: 0
maxReviewRounds: 3
tasks:
  - id: events-core-api
    title: Implement events
    owner: codex
    mode: implementation
    effort: medium
    files: [feature.txt]
  - id: events-core-review
    title: Review events
    owner: claude
    mode: review
    effort: high
    dependsOn: [events-core-api]
${options.includeDownstream ? `  - id: events-core-final-review
    title: Final review
    owner: claude
    mode: final_review
    effort: high
    dependsOn: [events-core-review]
` : ''}${options.includeIndependentFailure ? `  - id: independent-failure
    title: Independent failed implementation
    owner: codex
    mode: implementation
    effort: medium
    files: [independent.txt]
  - id: mixed-downstream
    title: Mixed downstream
    owner: claude
    mode: final_review
    effort: high
    dependsOn: [events-core-review, independent-failure]
` : ''}integration:
  commands:
    - node -e "process.exit(0)"
`;
}

function completeHandoff(): unknown {
  return {
    status: 'complete',
    summary: 'Implemented the test feature.',
    filesChanged: ['feature.txt'],
    decisions: [],
    tests: [{ command: 'fake-test', result: 'pass', details: 'fake evidence' }],
    openQuestions: [],
    reviewRequested: [],
  };
}

function successfulResult(
  agent: AgentName,
  request: AgentRequest,
  structuredHandoff: unknown,
): AgentResult {
  const timestamp = new Date().toISOString();
  return {
    agent,
    runId: request.runId,
    taskId: request.taskId,
    status: 'succeeded',
    failureCode: null,
    exitCode: 0,
    signal: null,
    stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout.log`),
    stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr.log`),
    structuredHandoff,
    changedFiles: [],
    gitDiffSummary: null,
    testsReported: [],
    unresolvedQuestions: [],
    startedAt: timestamp,
    endedAt: timestamp,
    durationMs: 0,
    timedOut: false,
    aborted: false,
    errorMessage: null,
  };
}

function failedResult(agent: AgentName, request: AgentRequest): AgentResult {
  const timestamp = new Date().toISOString();
  return {
    ...successfulResult(agent, request, null),
    status: 'failed',
    failureCode: 'AGENT_FAILED',
    exitCode: 1,
    structuredHandoff: null,
    endedAt: timestamp,
    errorMessage: 'provider/process failed before semantic output',
  };
}
