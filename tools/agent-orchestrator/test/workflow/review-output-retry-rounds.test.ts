import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import {
  CLAUDE_STRUCTURED_REVIEW_OUTPUT_CONTRACT_ID,
  CLAUDE_TEXT_REVIEW_OUTPUT_CONTRACT_ID,
  type Agent,
  type AgentName,
  type AgentRequest,
  type AgentResult,
} from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import { canonicalHash } from '../../src/review/correction-continuation';
import type { RunEvent } from '../../src/state';
import { createTemporaryRepository, type TemporaryRepository } from '../git/helpers';

const reviewTaskId = 'final-review';
const finding = {
  id: 'F001', severity: 'medium', category: 'correctness',
  file: 'apps/api/src/chat/presence/presence.service.ts', location: 'line 1',
  problem: 'Presence is stale.', evidence: 'The stale value remains.', impact: 'Presence is unavailable.',
  suggestedFix: 'Update the value.', verificationRequired: 'Run presence tests.',
} as const;
const correctionRequest = {
  role: 'correction', concern: 'correctness', objective: 'Update Presence.', reason: 'F001 requires it.',
  dependencies: [], capabilities: [], risk: 'medium', priority: 80,
  resourceClaims: [{ kind: 'repository_path', key: 'apps/api/src/chat/presence/**', mode: 'write' }],
  evidence: [
    { kind: 'file', reference: 'apps/api/src/chat/presence/presence.spec.ts', summary: 'focused test' },
    { kind: 'finding', reference: 'F001', summary: 'accepted finding' },
  ],
} as const;
const prose = 'Review complete. No material defect remains against the stated invariants.\n';

class RoundAwareAgent implements Agent {
  readonly requests: AgentRequest[] = [];
  private reviewInvocation = 0;
  constructor(readonly name: AgentName,
    private readonly reviewSequence: readonly ('changes_requested' | 'prose' | 'approved')[] = []) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.requests.push(request);
    let output: unknown;
    let rawStdout: string;
    if (request.taskId === 'implementation') {
      const directory = join(request.worktreePath, 'apps/api/src/chat/presence');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'presence.service.ts'), 'export const presence = false;\n');
      await writeFile(join(directory, 'presence.spec.ts'), 'export {};\n');
      output = handoff(['apps/api/src/chat/presence/presence.service.ts', 'apps/api/src/chat/presence/presence.spec.ts']);
      rawStdout = JSON.stringify(output);
    } else if (request.role === 'correction') {
      await writeFile(join(request.worktreePath, 'apps/api/src/chat/presence/presence.service.ts'),
        'export const presence = true;\n');
      const required = (request.taskSpecification as {
        requiredCanonicalFindings?: readonly { findingId: string; canonicalFindingKey: string }[];
      }).requiredCanonicalFindings ?? [];
      output = { ...handoff(['apps/api/src/chat/presence/presence.service.ts']),
        findingResponses: required.map((entry) => ({
          findingId: entry.findingId, canonicalFindingKey: entry.canonicalFindingKey,
          decision: 'confirmed', resolution: 'resolved', evidence: 'Updated.', fix: 'Updated.', verification: 'Passed.',
        })) };
      rawStdout = JSON.stringify(output);
    } else {
      this.reviewInvocation += 1;
      const response = this.reviewSequence[this.reviewInvocation - 1] ?? 'approved';
      if (response === 'changes_requested') {
        output = { status: 'changes_requested', findings: [finding], additionalWorkRequests: [correctionRequest] };
        rawStdout = JSON.stringify(output);
      } else if (response === 'prose') {
        output = null;
        rawStdout = prose;
      } else {
        output = { status: 'approved', findings: [] };
        rawStdout = JSON.stringify(output);
      }
    }
    const stdoutPath = join(request.artifactsDirectory,
      `${request.runId}.${request.taskId}.${this.name}.attempt-${request.attempt}.stdout.log`);
    const stderrPath = join(request.artifactsDirectory,
      `${request.runId}.${request.taskId}.${this.name}.attempt-${request.attempt}.stderr.log`);
    await mkdir(request.artifactsDirectory, { recursive: true });
    await writeFile(stdoutPath, rawStdout);
    await writeFile(stderrPath, '');
    const timestamp = new Date().toISOString();
    return { agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded',
      failureCode: null, exitCode: 0, signal: null, stdoutPath, stderrPath, structuredHandoff: output,
      rawStdout, changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: timestamp, endedAt: timestamp, durationMs: 1, timedOut: false, aborted: false, errorMessage: null };
  }
}

function handoff(filesChanged: readonly string[]) {
  return { status: 'complete', summary: 'complete', filesChanged, decisions: [], tests: [], openQuestions: [], reviewRequested: [] };
}

interface Fixture {
  readonly repository: TemporaryRepository;
  readonly runsRoot: string;
  readonly runId: string;
  readonly orchestrator: AgentOrchestrator;
  readonly agents: { readonly codex: RoundAwareAgent; readonly claude: RoundAwareAgent };
  readonly correctionTaskId: string;
}

const databaseEnvironment = { ...process.env, TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: '5432',
  TEST_DB_USER: 'test', TEST_DB_PASSWORD: 'fixture-secret', TEST_DB_NAME: 'test' };

function options(value: Omit<Fixture, 'correctionTaskId'>) {
  return { repositoryPath: value.repository.repository, runsRoot: value.runsRoot, agents: value.agents,
    hostVerificationEnvironment: databaseEnvironment };
}

async function fixture(
  roundOneRecovery = false,
  doubleMalformedRoundTwo = false,
  useRepositoryRuns = false,
  postFixResult: 'approved' | 'prose' = 'approved',
): Promise<Fixture> {
  const repository = await createTemporaryRepository();
  await mkdir(join(repository.repository, 'apps/api/src/chat'), { recursive: true });
  await writeFile(join(repository.repository, 'apps/api/src/chat/chat.service.ts'), 'export {};\n');
  await writeFile(join(repository.repository, 'design.md'), '# Design\n');
  await writeFile(join(repository.repository, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(repository.repository, 'package.json'), '{"private":true,"packageManager":"pnpm@9.12.0"}\n');
  await writeFile(join(repository.repository, 'apps/api/package.json'), JSON.stringify({
    name: '@tripwith/api', private: true, scripts: { typecheck: 'true', test: 'true' },
  }));
  await repository.git.run(repository.repository, ['add', '-A']);
  await repository.git.run(repository.repository, ['commit', '-m', 'fixture']);
  const phase = join(repository.container, 'phase.yaml');
  await writeFile(phase, JSON.stringify({
    phase: 'round-aware-review-retry', name: 'round-aware review retry', baseBranch: repository.baseBranch,
    canonicalDesignDocument: 'design.md', maxReviewRounds: 2, concurrency: 1,
    tasks: [
      { id: 'implementation', title: 'implementation', owner: 'codex', mode: 'implementation', writer: true,
        files: ['apps/api/src/chat/presence/**'], dependsOn: [] },
      { id: reviewTaskId, title: 'final review', owner: 'claude', mode: 'final_review', writer: false,
        files: [], dependsOn: ['implementation'] },
    ], integration: { commands: ['node -e "process.exit(0)"'] },
  }));
  const agents = { codex: new RoundAwareAgent('codex'), claude: new RoundAwareAgent('claude', roundOneRecovery
    ? ['prose', 'changes_requested', 'prose', ...(doubleMalformedRoundTwo ? ['prose' as const] : []), postFixResult]
    : ['changes_requested', 'prose', ...(doubleMalformedRoundTwo ? ['prose' as const] : []), postFixResult]) };
  const runsRoot = useRepositoryRuns
    ? join(await realpath(repository.repository), 'tools/agent-orchestrator/runs')
    : join(repository.container, 'runs');
  const orchestrator = await AgentOrchestrator.start(phase, { repositoryPath: repository.repository, runsRoot, agents });
  let first = await orchestrator.execute();
  if (roundOneRecovery) {
    assert.equal(first.status, 'FAILED');
    await AgentOrchestrator.retryReviewOutput(first.runId, reviewTaskId,
      { repositoryPath: repository.repository, runsRoot, agents, hostVerificationEnvironment: databaseEnvironment });
    const retry = await AgentOrchestrator.resume(first.runId,
      { repositoryPath: repository.repository, runsRoot, agents, hostVerificationEnvironment: databaseEnvironment });
    first = await retry.execute();
  }
  assert.equal(first.status, 'BLOCKED');
  const authorized = await AgentOrchestrator.authorizeReviewCorrection(first.runId, reviewTaskId, 0,
    { repositoryPath: repository.repository, runsRoot, agents, hostVerificationEnvironment: databaseEnvironment });
  const correctionTaskId = authorized.continuation.authorization.correctionTask.id;
  const resumed = await AgentOrchestrator.resume(first.runId,
    { repositoryPath: repository.repository, runsRoot, agents, hostVerificationEnvironment: databaseEnvironment });
  const failed = await resumed.execute();
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.tasks[reviewTaskId]?.reviewRounds, 1);
  assert.equal(failed.tasks[reviewTaskId]?.agentAttempts.length, roundOneRecovery ? 3 : 2);
  return { repository, runsRoot, runId: first.runId, orchestrator: resumed, agents, correctionTaskId };
}

async function events(value: Fixture): Promise<RunEvent[]> {
  return (await readFile(value.orchestrator.stateStore.eventsPath, 'utf8')).trim().split('\n')
    .map((line) => JSON.parse(line) as RunEvent);
}

async function doubleMalformedRoundTwoFixture(
  useRepositoryRuns = false,
  postFixResult: 'approved' | 'prose' = 'approved',
): Promise<Fixture> {
  const value = await fixture(false, true, useRepositoryRuns, postFixResult);
  await AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value));
  const resumed = await AgentOrchestrator.resume(value.runId, options(value));
  const failed = await resumed.execute();
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.tasks[reviewTaskId]?.reviewRounds, 1);
  assert.equal(failed.tasks[reviewTaskId]?.agentAttempts.length, 3);
  assert.equal(failed.tasks[reviewTaskId]?.reviewOutputRecoveries?.length, 1);
  return { ...value, orchestrator: resumed };
}

test('accepted round 1 plus malformed round 2 authorizes only the current round without executing work', async () => {
  const value = await fixture();
  try {
    const before = value.orchestrator.snapshot();
    const task = before.tasks[reviewTaskId]!;
    const firstPath = task.reviewPaths[0]!;
    const firstBytes = await readFile(firstPath);
    const correction = before.tasks[value.correctionTaskId]!;
    const continuation = before.reviewCorrections![0]!;
    const invocations = value.agents.codex.requests.length + value.agents.claude.requests.length;

    const authorized = await AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value));
    const after = authorized.orchestrator.snapshot();
    const recovery = authorized.recovery;
    assert.equal(recovery.version, 2);
    if (recovery.version !== 2) assert.fail('expected v2 recovery');
    assert.equal(recovery.reviewRound, 2);
    assert.equal(recovery.taskReviewRound, 2);
    assert.equal(recovery.runId, value.runId);
    assert.equal(recovery.taskId, reviewTaskId);
    assert.equal(recovery.preparedHeadSha, task.preparedHeadSha);
    assert.deepEqual(recovery.acceptedReviewArtifacts, [{ round: 1, path: firstPath,
      sha256: createHash('sha256').update(firstBytes).digest('hex') }]);
    assert.equal(value.agents.codex.requests.length + value.agents.claude.requests.length, invocations);
    assert.equal(after.status, 'RUNNING');
    assert.equal(after.tasks[reviewTaskId]?.status, 'READY');
    assert.equal(after.tasks[reviewTaskId]?.reviewRounds, 1);
    assert.equal(after.tasks[reviewTaskId]?.agentAttempts.length, 2);
    assert.deepEqual(after.tasks[reviewTaskId]?.reviewPaths, [firstPath]);
    assert.deepEqual(after.tasks[value.correctionTaskId], correction);
    assert.deepEqual(after.reviewCorrections?.[0], continuation);
    assert.equal(after.integration.status, 'PENDING');
    assert.deepEqual(await readFile(firstPath), firstBytes);
  } finally { await value.repository.dispose(); }
});

test('round-2 retry resumes the same round, writes only the canonical round-2 artifact, and accepts once', async () => {
  const value = await fixture();
  try {
    const failed = value.orchestrator.snapshot();
    const firstPath = failed.tasks[reviewTaskId]!.reviewPaths[0]!;
    const firstBytes = await readFile(firstPath);
    await AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value));
    const resumed = await AgentOrchestrator.resume(value.runId, options(value));
    const completed = await resumed.execute();
    const task = completed.tasks[reviewTaskId]!;
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(task.reviewRounds, 2);
    assert.equal(task.agentAttempts.length, 3);
    assert.equal(task.reviewPaths.length, 2);
    assert.equal(task.reviewPaths[0], firstPath);
    assert.match(task.reviewPaths[1]!, /final-review\.round-2\.json$/);
    assert.deepEqual(await readFile(firstPath), firstBytes);
    assert.deepEqual(JSON.parse(await readFile(task.reviewPaths[1]!, 'utf8')), { status: 'approved', findings: [] });
    const starts = (await events(value)).filter((event) => event.name === 'REVIEW_STARTED' && event.taskId === reviewTaskId);
    assert.deepEqual(starts.map((event) => event.data?.round), [1, 2, 2]);
    const repeated = await AgentOrchestrator.resume(value.runId, options(value));
    assert.deepEqual(repeated.snapshot().tasks[reviewTaskId]?.reviewPaths, task.reviewPaths);
    assert.equal(repeated.snapshot().tasks[reviewTaskId]?.reviewRounds, 2);
  } finally { await value.repository.dispose(); }
});

test('round-2 retry authorization is concurrency-safe and bounded to one entry for that round', async () => {
  const value = await fixture();
  try {
    const outcomes = await Promise.allSettled([
      AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
      AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
    ]);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'fulfilled').length, 1);
    assert.equal(outcomes.filter((outcome) => outcome.status === 'rejected').length, 1);
    const task = (await value.orchestrator.stateStore.load()).tasks[reviewTaskId]!;
    assert.equal(task.reviewOutputRecoveries?.length, 1);
    assert.equal(task.reviewOutputRecoveries?.[0]?.version, 2);
    assert.equal(task.reviewOutputRecoveries?.[0]?.version === 2
      ? task.reviewOutputRecoveries[0].reviewRound : undefined, 2);
  } finally { await value.repository.dispose(); }
});

test('Claude contract continuation binds the consumed round-2 retry and both malformed attempts without invoking a provider', async () => {
  const value = await doubleMalformedRoundTwoFixture();
  try {
    const before = value.orchestrator.snapshot();
    const invocations = value.agents.codex.requests.length + value.agents.claude.requests.length;
    const consumed = before.tasks[reviewTaskId]!.reviewOutputRecoveries![0]!;
    const correction = before.tasks[value.correctionTaskId]!;
    await assert.rejects(
      AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /budget.*exhausted/.test(error.message),
    );

    const authorized = await AgentOrchestrator.continueClaudeReviewAfterOutputContractFix(
      value.runId,
      reviewTaskId,
      options(value),
    );

    assert.equal(authorized.created, true);
    assert.equal(authorized.recovery.version, 3);
    assert.equal(authorized.recovery.reviewRound, 2);
    assert.equal(authorized.recovery.taskReviewRound, 2);
    assert.equal(authorized.recovery.consumedRecovery, 1);
    assert.equal(authorized.recovery.consumedRecoverySha256, canonicalHash(consumed));
    assert.deepEqual(authorized.recovery.malformedAttempts, [2, 3]);
    assert.equal(authorized.recovery.oldContractId, CLAUDE_TEXT_REVIEW_OUTPUT_CONTRACT_ID);
    assert.equal(authorized.recovery.newContractId, CLAUDE_STRUCTURED_REVIEW_OUTPUT_CONTRACT_ID);
    assert.deepEqual(authorized.recovery.dependencyCommits, [{
      taskId: 'implementation',
      commitSha: before.tasks.implementation!.commit!.sha,
    }, {
      taskId: value.correctionTaskId,
      commitSha: correction.commit!.sha,
    }]);
    assert.ok(authorized.recovery.promptArtifacts.length > 0);
    assert.equal(value.agents.codex.requests.length + value.agents.claude.requests.length, invocations);
    const state = authorized.orchestrator.snapshot();
    assert.equal(state.status, 'RUNNING');
    assert.equal(state.tasks[reviewTaskId]?.status, 'READY');
    assert.equal(state.tasks[reviewTaskId]?.reviewRounds, 1);
    assert.equal(state.tasks[reviewTaskId]?.agentAttempts.length, 3);
    assert.deepEqual(state.tasks[value.correctionTaskId], correction);
    assert.equal(state.integration.status, 'PENDING');
  } finally { await value.repository.dispose(); }
});

test('Claude contract continuation is idempotent before resume and permits exactly one post-fix invocation', async () => {
  const value = await doubleMalformedRoundTwoFixture();
  try {
    const first = await AgentOrchestrator.continueClaudeReviewAfterOutputContractFix(
      value.runId, reviewTaskId, options(value),
    );
    const invocationCount = value.agents.claude.requests.length;
    const eventBytes = await readFile(value.orchestrator.stateStore.eventsPath);
    const repeated = await AgentOrchestrator.continueClaudeReviewAfterOutputContractFix(
      value.runId, reviewTaskId, options(value),
    );
    assert.equal(repeated.created, false);
    assert.deepEqual(repeated.recovery, first.recovery);
    assert.equal(value.agents.claude.requests.length, invocationCount);
    assert.deepEqual(await readFile(value.orchestrator.stateStore.eventsPath), eventBytes);

    const resumed = await AgentOrchestrator.resume(value.runId, options(value));
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks[reviewTaskId]?.agentAttempts.length, 4);
    assert.equal(completed.tasks[reviewTaskId]?.reviewRounds, 2);
    assert.equal(value.agents.claude.requests.length, invocationCount + 1);
    await (await AgentOrchestrator.resume(value.runId, options(value))).execute();
    assert.equal(value.agents.claude.requests.length, invocationCount + 1);
  } finally { await value.repository.dispose(); }
});

test('continue-claude-review-output CLI authorizes no provider and reports the manual resume boundary', async () => {
  const value = await doubleMalformedRoundTwoFixture(true);
  try {
    const invocations = value.agents.codex.requests.length + value.agents.claude.requests.length;
    const cli = resolve(__dirname, '../../src/cli.js');
    const result = spawnSync(
      process.execPath,
      [cli, 'continue-claude-review-output', value.runId, reviewTaskId],
      { cwd: value.repository.repository, encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(output.runId, value.runId);
    assert.equal(output.runStatus, 'RUNNING');
    assert.equal(output.taskId, reviewTaskId);
    assert.equal(output.created, true);
    assert.deepEqual(output.malformedAttempts, [2, 3]);
    assert.equal(output.oldContractId, CLAUDE_TEXT_REVIEW_OUTPUT_CONTRACT_ID);
    assert.equal(output.newContractId, CLAUDE_STRUCTURED_REVIEW_OUTPUT_CONTRACT_ID);
    assert.match(String(output.manualNextStep), /agents:resume/);
    assert.equal(value.agents.codex.requests.length + value.agents.claude.requests.length, invocations);
  } finally { await value.repository.dispose(); }
});

test('a failed post-contract-fix output cannot authorize or execute another provider attempt', async () => {
  const value = await doubleMalformedRoundTwoFixture(false, 'prose');
  try {
    await AgentOrchestrator.continueClaudeReviewAfterOutputContractFix(
      value.runId, reviewTaskId, options(value),
    );
    const resumed = await AgentOrchestrator.resume(value.runId, options(value));
    const failed = await resumed.execute();
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.tasks[reviewTaskId]?.agentAttempts.length, 4);
    const invocations = value.agents.claude.requests.length;

    const repeated = await AgentOrchestrator.continueClaudeReviewAfterOutputContractFix(
      value.runId, reviewTaskId, options(value),
    );
    assert.equal(repeated.created, false);
    assert.equal(repeated.orchestrator.snapshot().tasks[reviewTaskId]?.status, 'FAILED');
    await assert.rejects(
      AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
    );
    await (await AgentOrchestrator.resume(value.runId, options(value))).execute();
    assert.equal(value.agents.claude.requests.length, invocations);
  } finally { await value.repository.dispose(); }
});

for (const evidence of [
  'first-malformed-stdout',
  'second-malformed-stdout',
  'prompt-artifact',
  'prepared-head-binding',
  'dependency-binding',
] as const) {
  test(`Claude contract continuation fails closed when ${evidence} changes after authorization`, async () => {
    const value = await doubleMalformedRoundTwoFixture();
    try {
      const authorized = await AgentOrchestrator.continueClaudeReviewAfterOutputContractFix(
        value.runId, reviewTaskId, options(value),
      );
      if (evidence === 'prepared-head-binding' || evidence === 'dependency-binding') {
        const state = await value.orchestrator.stateStore.load();
        await value.orchestrator.stateStore.save({ ...state, tasks: { ...state.tasks,
          ...(evidence === 'prepared-head-binding'
            ? { [reviewTaskId]: { ...state.tasks[reviewTaskId]!, preparedHeadSha: state.baseSha } }
            : { implementation: { ...state.tasks.implementation!, commit: {
              ...state.tasks.implementation!.commit!, sha: state.baseSha,
            } } }),
        } });
      } else {
        const source = evidence === 'first-malformed-stdout'
          ? value.orchestrator.snapshot().tasks[reviewTaskId]!.reviewOutputRecoveries![0]!.stdoutPath
          : evidence === 'second-malformed-stdout'
            ? authorized.recovery.stdoutPath
            : authorized.recovery.promptArtifacts[0]!.path;
        await appendFile(source, 'tampered\n');
      }
      await assert.rejects(
        AgentOrchestrator.resume(value.runId, options(value)),
        (error) => isOrchestratorError(error, 'STATE_CORRUPT'),
      );
    } finally { await value.repository.dispose(); }
  });
}

test('an already materialized round-2 artifact refuses authorization without changing state', async () => {
  const value = await fixture();
  try {
    const state = value.orchestrator.snapshot();
    const path = join(value.orchestrator.stateStore.runDirectory, 'reviews', `${reviewTaskId}.round-2.json`);
    await writeFile(path, `${JSON.stringify({ status: 'approved', findings: [] }, null, 2)}\n`);
    const before = await readFile(value.orchestrator.stateStore.statePath);
    await assert.rejects(AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
    assert.deepEqual(await readFile(value.orchestrator.stateStore.statePath), before);
    assert.equal(state.tasks[reviewTaskId]?.reviewRounds, 1);
  } finally { await value.repository.dispose(); }
});

test('state that already counts and records round 2 cannot be retried as another round', async () => {
  const value = await fixture();
  try {
    const state = value.orchestrator.snapshot();
    const task = state.tasks[reviewTaskId]!;
    const path = join(value.orchestrator.stateStore.runDirectory, 'reviews', `${reviewTaskId}.round-2.json`);
    await writeFile(path, `${JSON.stringify({ status: 'approved', findings: [] }, null, 2)}\n`);
    await value.orchestrator.stateStore.save({ ...state, tasks: { ...state.tasks, [reviewTaskId]: {
      ...task, reviewRounds: 2, reviewPaths: [...task.reviewPaths, path],
    } } });
    await assert.rejects(AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  } finally { await value.repository.dispose(); }
});

test('round-1 and round-2 malformed outputs receive independent one-retry budgets', async () => {
  const value = await fixture(true);
  try {
    const before = value.orchestrator.snapshot().tasks[reviewTaskId]!;
    assert.equal(before.reviewOutputRecoveries?.length, 1);
    assert.equal(before.reviewOutputRecoveries?.[0]?.version === 2
      ? before.reviewOutputRecoveries[0].reviewRound : undefined, 1);
    const authorized = await AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value));
    const recoveries = authorized.orchestrator.snapshot().tasks[reviewTaskId]!.reviewOutputRecoveries!;
    assert.equal(authorized.recovery.recovery, 2);
    assert.deepEqual(recoveries.map((entry) => entry.version === 2 ? entry.reviewRound : undefined), [1, 2]);
  } finally { await value.repository.dispose(); }
});

test('legacy v1 recovery records still load and consume only their event-proven round budget', async () => {
  const value = await fixture();
  try {
    await AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value));
    const raw = JSON.parse(await readFile(value.orchestrator.stateStore.statePath, 'utf8')) as Record<string, any>;
    const task = raw.tasks[reviewTaskId];
    const recovery = task.reviewOutputRecoveries[0];
    delete recovery.version;
    await writeFile(value.orchestrator.stateStore.statePath, `${JSON.stringify(raw, null, 2)}\n`);
    await assert.rejects(value.orchestrator.stateStore.load(),
      (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
    for (const key of ['runId', 'taskId', 'reviewRound', 'taskReviewRound', 'preparedHeadSha', 'acceptedReviewArtifacts']) {
      delete recovery[key];
    }
    raw.status = 'FAILED';
    task.status = 'FAILED';
    task.error = recovery.error;
    task.handoffOutcome = 'invalid';
    task.finishedAt = new Date().toISOString();
    await writeFile(value.orchestrator.stateStore.statePath, `${JSON.stringify(raw, null, 2)}\n`);
    const loaded = await value.orchestrator.stateStore.load();
    assert.equal(loaded.tasks[reviewTaskId]?.reviewOutputRecoveries?.[0]?.version, undefined);
    await assert.rejects(AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
    assert.equal((await value.orchestrator.stateStore.load()).tasks[reviewTaskId]?.reviewOutputRecoveries?.length, 1);
  } finally { await value.repository.dispose(); }
});

for (const scenario of ['dirty-worktree', 'moved-head', 'changed-dependency', 'missing-stdout'] as const) {
  test(`round-2 retry refuses ${scenario}`, async () => {
    const value = await fixture();
    try {
      const state = value.orchestrator.snapshot();
      const task = state.tasks[reviewTaskId]!;
      if (scenario === 'dirty-worktree') await appendFile(join(task.worktreePath!, 'design.md'), 'dirty\n');
      if (scenario === 'moved-head') await value.repository.git.run(task.worktreePath!, ['checkout', state.baseSha]);
      if (scenario === 'changed-dependency') {
        await value.orchestrator.stateStore.save({ ...state, tasks: { ...state.tasks, implementation: {
          ...state.tasks.implementation!, commit: { ...state.tasks.implementation!.commit!, sha: state.baseSha },
        } } });
      }
      if (scenario === 'missing-stdout') {
        await unlink(join(value.orchestrator.stateStore.runDirectory, 'logs',
          `${value.runId}.${reviewTaskId}.claude.attempt-2.stdout.log`));
      }
      await assert.rejects(AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
        (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') || isOrchestratorError(error, 'STATE_CORRUPT'));
    } finally { await value.repository.dispose(); }
  });
}

test('a provider attempt announced for another round cannot be rebound to round 2', async () => {
  const value = await fixture();
  try {
    const path = value.orchestrator.stateStore.eventsPath;
    const rows = (await readFile(path, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as RunEvent);
    const index = rows.map((event) => event.name === 'REVIEW_STARTED' && event.taskId === reviewTaskId).lastIndexOf(true);
    rows[index] = { ...rows[index]!, data: { ...rows[index]!.data, round: 1 } };
    await writeFile(path, `${rows.map((event) => JSON.stringify(event)).join('\n')}\n`);
    await assert.rejects(AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  } finally { await value.repository.dispose(); }
});

test('current review-lineage round limits still refuse a round-2 retry', async () => {
  const value = await fixture();
  try {
    const phasePath = join(value.orchestrator.stateStore.runDirectory, 'phase.yaml');
    const phase = JSON.parse(await readFile(phasePath, 'utf8')) as Record<string, unknown>;
    phase.maxReviewRounds = 1;
    await writeFile(phasePath, JSON.stringify(phase));
    await assert.rejects(AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  } finally { await value.repository.dispose(); }
});

for (const evidence of ['accepted-artifact', 'failed-stdout'] as const) {
  test(`authorized round-2 retry fails closed if ${evidence} bytes change before resume`, async () => {
    const value = await fixture();
    try {
      const authorized = await AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value));
      const recovery = authorized.recovery;
      assert.equal(recovery.version, 2);
      if (recovery.version !== 2) assert.fail('expected v2 recovery');
      const path = evidence === 'accepted-artifact'
        ? recovery.acceptedReviewArtifacts[0]!.path
        : recovery.stdoutPath;
      await appendFile(path, 'tampered\n');
      await assert.rejects(AgentOrchestrator.resume(value.runId, options(value)),
        (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
    } finally { await value.repository.dispose(); }
  });
}

for (const artifactAlreadyPersisted of [false, true]) {
  test(`round-2 retry reconciles a crash after provider success${artifactAlreadyPersisted ? ' and artifact persistence' : ''}`, async () => {
    const value = await fixture();
    try {
      const authorized = await AgentOrchestrator.retryReviewOutput(value.runId, reviewTaskId, options(value));
      const state = authorized.orchestrator.snapshot();
      const task = state.tasks[reviewTaskId]!;
      const firstPath = task.reviewPaths[0]!;
      const firstBytes = await readFile(firstPath);
      const attempt = { ...task.agentAttempts.at(-1)!, attempt: 3,
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), outcome: 'succeeded' as const };
      const stdoutPath = join(value.orchestrator.stateStore.runDirectory, 'logs',
        `${value.runId}.${reviewTaskId}.claude.attempt-3.stdout.log`);
      await writeFile(stdoutPath, JSON.stringify({ status: 'approved', findings: [] }));
      const roundTwoPath = join(value.orchestrator.stateStore.runDirectory, 'reviews', `${reviewTaskId}.round-2.json`);
      if (artifactAlreadyPersisted) {
        await writeFile(roundTwoPath, `${JSON.stringify({ status: 'approved', findings: [] }, null, 2)}\n`);
      }
      await value.orchestrator.stateStore.save({ ...state, status: 'RUNNING', tasks: { ...state.tasks, [reviewTaskId]: {
        ...task, status: 'RUNNING', agentAttempts: [...task.agentAttempts, attempt],
      } } });
      const timestamp = new Date().toISOString();
      await value.orchestrator.stateStore.appendEvent({ name: 'REVIEW_STARTED', timestamp,
        runId: value.runId, taskId: reviewTaskId, data: { round: 2 } });
      await value.orchestrator.stateStore.appendEvent({ name: 'AGENT_STARTED', timestamp,
        runId: value.runId, taskId: reviewTaskId, data: { agent: 'claude', attempt: 3, timeoutMs: attempt.timeoutMs } });
      await value.orchestrator.stateStore.appendEvent({ name: 'AGENT_FINISHED', timestamp,
        runId: value.runId, taskId: reviewTaskId, data: { agent: 'claude', attempt: 3, status: 'succeeded', exitCode: 0 } });
      const resumed = await AgentOrchestrator.resume(value.runId, options(value));
      const recovered = resumed.snapshot().tasks[reviewTaskId]!;
      assert.equal(recovered.reviewRounds, 2);
      assert.deepEqual(recovered.reviewPaths, [firstPath, roundTwoPath]);
      assert.equal(recovered.reviewOutputRecoveries?.length, 1);
      assert.deepEqual(await readFile(firstPath), firstBytes);
      const repeated = await AgentOrchestrator.resume(value.runId, options(value));
      assert.deepEqual(repeated.snapshot().tasks[reviewTaskId]?.reviewPaths, recovered.reviewPaths);
      assert.equal(repeated.snapshot().tasks[reviewTaskId]?.reviewRounds, 2);
    } finally { await value.repository.dispose(); }
  });
}
