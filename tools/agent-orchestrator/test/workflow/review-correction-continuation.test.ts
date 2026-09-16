import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import {
  authorizationId,
  canonicalHash,
  canonicalCorrectionRequest,
  correctionRequestHash,
  validateCorrectionRequest,
} from '../../src/review/correction-continuation';
import type { RunEvent, RunState } from '../../src/state';
import { createTemporaryRepository, type TemporaryRepository } from '../git/helpers';

const finding = {
  id: 'F001', severity: 'medium', category: 'correctness',
  file: 'apps/api/src/chat/presence/presence.service.ts', location: 'line 1',
  problem: 'EVENT is rejected.', evidence: 'The unconditional guard remains.', impact: 'Presence is unavailable.',
  suggestedFix: 'Remove the guard.', verificationRequired: 'Run presence tests.',
} as const;

const request = {
  role: 'correction', concern: 'authorization', objective: 'Allow authorized EVENT presence.', reason: 'F001 proves stale policy.',
  dependencies: [], capabilities: [], risk: 'medium', priority: 80,
  resourceClaims: [
    { kind: 'repository_path', key: 'apps/api/src/chat/presence/**', mode: 'write' },
    { kind: 'repository_path', key: 'apps/api/src/chat/chat.service.ts', mode: 'read' },
  ],
  evidence: [
    { kind: 'file', reference: 'apps/api/src/chat/presence/presence.service.ts:1', summary: 'stale guard' },
    { kind: 'file', reference: 'apps/api/src/chat/presence/presence.spec.ts', summary: 'unit coverage' },
    { kind: 'finding', reference: 'F001', summary: 'accepted finding' },
  ],
} as const;

class ContinuationAgent implements Agent {
  readonly requests: AgentRequest[] = [];
  private readonly reviews = new Map<string, number>();
  constructor(readonly name: AgentName, private readonly roundTwo: 'approved' | 'changes_requested' = 'approved',
    public violateCorrection = false, public crashAfterRoundTwoOutput = false) {}

  async run(agentRequest: AgentRequest): Promise<AgentResult> {
    this.requests.push(agentRequest);
    let output: unknown;
    if (agentRequest.taskId === 'implementation') {
      const directory = join(agentRequest.worktreePath, 'apps/api/src/chat/presence');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'presence.service.ts'), 'export const stale = true;\n');
      await writeFile(join(directory, 'presence.spec.ts'), 'export {};\n');
      output = handoff(['apps/api/src/chat/presence/presence.service.ts', 'apps/api/src/chat/presence/presence.spec.ts']);
    } else if (agentRequest.taskId === 'parallel-writer') {
      const directory = join(agentRequest.worktreePath, 'apps/api/src/chat/presence');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'parallel.ts'), 'export const parallel = true;\n');
      output = handoff(['apps/api/src/chat/presence/parallel.ts']);
    } else if (agentRequest.role === 'correction') {
      await writeFile(join(agentRequest.worktreePath, 'apps/api/src/chat/presence/presence.service.ts'), 'export const stale = false;\n');
      if (this.violateCorrection) await writeFile(join(agentRequest.worktreePath, 'apps/api/src/chat/chat.service.ts'), 'export const widened = true;\n');
      const assigned = (agentRequest.taskSpecification as { requiredCanonicalFindings?: { findingId: string; canonicalFindingKey: string }[] }).requiredCanonicalFindings!;
      output = { ...handoff(['apps/api/src/chat/presence/presence.service.ts']), findingResponses: assigned.map((entry) => ({
        findingId: entry.findingId, canonicalFindingKey: entry.canonicalFindingKey, decision: 'confirmed', resolution: 'resolved',
        evidence: 'Guard removed.', fix: 'Removed stale guard.', verification: 'Host verification required.',
      })) };
    } else {
      const reviewRound = (this.reviews.get(agentRequest.taskId) ?? 0) + 1;
      this.reviews.set(agentRequest.taskId, reviewRound);
      const emittedRequest = agentRequest.taskId === 'final-review-b' ? { ...request, resourceClaims: [
        { kind: 'repository_path' as const, key: 'apps/api/src/other/**', mode: 'write' as const },
      ] } : request;
      output = reviewRound === 1 || this.roundTwo === 'changes_requested'
        ? { status: 'changes_requested', findings: [finding], additionalWorkRequests: [emittedRequest] }
        : { status: 'approved', findings: [] };
    }
    const stdoutPath = join(agentRequest.artifactsDirectory,
      `${agentRequest.runId}.${agentRequest.taskId}.${this.name}.attempt-${agentRequest.attempt}.stdout.log`);
    await writeFile(stdoutPath, JSON.stringify(output));
    if (agentRequest.role === 'final_review' && this.reviews.get(agentRequest.taskId) === 2 && this.crashAfterRoundTwoOutput) {
      throw new Error('simulated crash after round-2 provider output');
    }
    const timestamp = new Date().toISOString();
    return { agent: this.name, runId: agentRequest.runId, taskId: agentRequest.taskId,
      status: 'succeeded', failureCode: null, exitCode: 0, signal: null,
      stdoutPath, stderrPath: join(agentRequest.artifactsDirectory, 'stderr'),
      structuredHandoff: output, rawStdout: JSON.stringify(output), changedFiles: [], gitDiffSummary: null,
      testsReported: [], unresolvedQuestions: [], startedAt: timestamp, endedAt: timestamp, durationMs: 1,
      timedOut: false, aborted: false, errorMessage: null };
  }
}

function handoff(filesChanged: string[]) {
  return { status: 'complete', summary: 'complete', filesChanged, decisions: [], tests: [], openQuestions: [], reviewRequested: [] };
}

interface Fixture { repository: TemporaryRepository; runsRoot: string; orchestrator: AgentOrchestrator; agents: { codex: ContinuationAgent; claude: ContinuationAgent } }

async function fixture(roundTwo: 'approved' | 'changes_requested' = 'approved', parallelWriter = false,
  sequentialReviews = false): Promise<Fixture> {
  const repository = await createTemporaryRepository();
  await mkdir(join(repository.repository, 'apps/api/src/chat'), { recursive: true });
  await writeFile(join(repository.repository, 'apps/api/src/chat/chat.service.ts'), 'export {};\n');
  await writeFile(join(repository.repository, 'design.md'), '# design\n');
  await writeFile(join(repository.repository, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(repository.repository, 'package.json'), '{"private":true,"packageManager":"pnpm@9.12.0"}\n');
  await writeFile(join(repository.repository, 'apps/api/package.json'), JSON.stringify({
    name: '@tripwith/api', private: true, scripts: { typecheck: 'true', test: 'true' },
  }));
  await repository.git.run(repository.repository, ['add', '-A']);
  await repository.git.run(repository.repository, ['commit', '-m', 'fixture']);
  const phase = join(repository.container, 'phase.yaml');
  await writeFile(phase, JSON.stringify({
    phase: 'review-correction', name: 'review correction', baseBranch: repository.baseBranch,
    canonicalDesignDocument: 'design.md', maxReviewRounds: 2, concurrency: sequentialReviews ? 2 : 1,
    tasks: [
      { id: 'implementation', title: 'implementation', owner: 'codex', mode: 'implementation', writer: true,
        files: ['apps/api/src/chat/presence/**'], dependsOn: [] },
      ...(parallelWriter ? [{ id: 'parallel-writer', title: 'parallel writer', owner: 'codex', mode: 'implementation', writer: true,
        files: ['apps/api/src/chat/presence/**'], dependsOn: ['implementation'] }] : []),
      { id: sequentialReviews ? 'final-review-a' : 'final-review', title: 'final review', owner: 'claude', mode: 'final_review', writer: false,
        files: [], dependsOn: ['implementation'] },
      ...(sequentialReviews ? [{ id: 'final-review-b', title: 'second final review', owner: 'claude', mode: 'final_review', writer: false,
        files: [], dependsOn: ['implementation'] }] : []),
    ], integration: { commands: ['node -e "process.exit(0)"'] },
  }));
  const agents = { codex: new ContinuationAgent('codex'), claude: new ContinuationAgent('claude', roundTwo) };
  const runsRoot = join(repository.container, 'runs');
  const orchestrator = await AgentOrchestrator.start(phase, { repositoryPath: repository.repository, runsRoot, agents });
  const blocked = await orchestrator.execute();
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.tasks[sequentialReviews ? 'final-review-a' : 'final-review']?.reviewRounds, 1);
  return { repository, runsRoot, orchestrator, agents };
}

const testDatabaseEnvironment = {
  ...process.env,
  TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: '5432', TEST_DB_USER: 'tripwith',
  TEST_DB_PASSWORD: 'fixture-only-secret', TEST_DB_NAME: 'tripwith',
};
const options = (value: Fixture) => ({ repositoryPath: value.repository.repository, runsRoot: value.runsRoot,
  agents: value.agents, hostVerificationEnvironment: testDatabaseEnvironment });

async function events(value: Fixture): Promise<RunEvent[]> {
  return (await readFile(value.orchestrator.stateStore.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as RunEvent);
}

test('authorized review correction executes as a narrow writer and reruns the same review as round 2', async () => {
  const value = await fixture();
  try {
    const firstPath = value.orchestrator.snapshot().tasks['final-review']!.reviewPaths[0]!;
    const firstBytes = await readFile(firstPath);
    const invocationCount = value.agents.codex.requests.length + value.agents.claude.requests.length;
    const authorized = await AgentOrchestrator.authorizeReviewCorrection(value.orchestrator.snapshot().runId, 'final-review', 0, options(value));
    assert.equal(authorized.created, true);
    assert.equal(value.agents.codex.requests.length + value.agents.claude.requests.length, invocationCount, 'authorization invokes zero providers');
    const correction = authorized.continuation.authorization.correctionTask;
    assert.equal(correction.mode, 'correction');
    assert.equal(correction.owner, 'codex');
    assert.deepEqual(correction.files, ['apps/api/src/chat/presence/**']);
    assert.match(correction.instructions!, /Authorized read scope: apps\/api\/src\/chat\/chat\.service\.ts/);
    assert.equal(authorized.orchestrator.snapshot().integration.status, 'PENDING');

    const duplicate = await AgentOrchestrator.authorizeReviewCorrection(value.orchestrator.snapshot().runId, 'final-review', 0, options(value));
    assert.equal(duplicate.created, false);
    assert.equal(duplicate.continuation.authorization.id, authorized.continuation.authorization.id);

    const resumed = await AgentOrchestrator.resume(value.orchestrator.snapshot().runId, options(value));
    const completed = await resumed.execute();
    const verificationError = completed.tasks[correction.id]?.verification?.commands.at(-1)?.stderrPath;
    assert.equal(completed.status, 'COMPLETED', verificationError === undefined ? JSON.stringify(completed, null, 2) : await readFile(verificationError, 'utf8'));
    assert.equal(completed.tasks[correction.id]?.status, 'SUCCEEDED');
    assert.deepEqual(completed.tasks[correction.id]?.commit?.changedFiles, ['apps/api/src/chat/presence/presence.service.ts']);
    assert.equal(completed.tasks[correction.id]?.verification?.status, 'SUCCEEDED');
    assert.equal(completed.tasks['final-review']?.reviewRounds, 2);
    assert.equal(completed.tasks['final-review']?.reviewPaths.length, 2);
    assert.match(completed.tasks['final-review']!.reviewPaths[1]!, /\.round-2\.json$/);
    assert.deepEqual(await readFile(firstPath), firstBytes, 'round 1 artifact remains immutable');
    const reviewStarts = (await events(value)).filter((event) => event.name === 'REVIEW_STARTED' && event.taskId === 'final-review');
    assert.deepEqual(reviewStarts.map((event) => event.data?.round), [1, 2]);
    assert.equal(completed.integration.status, 'SUCCEEDED');
  } finally { await value.repository.dispose(); }
});

test('round-2 stdout crash recovery preserves round 1 and records one distinct artifact exactly once', async () => {
  const value = await fixture();
  try {
    const runId = value.orchestrator.snapshot().runId;
    const roundOnePath = value.orchestrator.snapshot().tasks['final-review']!.reviewPaths[0]!;
    const roundOneBytes = await readFile(roundOnePath);
    const roundOneSha = createHash('sha256').update(roundOneBytes).digest('hex');
    const authorized = await AgentOrchestrator.authorizeReviewCorrection(runId, 'final-review', 0, options(value));
    assert.equal(authorized.continuation.authorization.reviewArtifactSha256, roundOneSha);
    value.agents.claude.crashAfterRoundTwoOutput = true;
    const crashing = await AgentOrchestrator.resume(runId, options(value));
    const interrupted = await crashing.execute();
    const interruptedReview = interrupted.tasks['final-review']!;
    assert.equal(interruptedReview.status, 'FAILED');
    // execute() deliberately converts thrown agent-layer errors into a
    // terminal task. Recreate the exact durable crash window after stdout
    // exists and the provider attempt completed, but before parsed-review
    // state/artifact persistence.
    const { error: _error, finishedAt: _finishedAt, ...runningReview } = interruptedReview;
    await crashing.stateStore.save({ ...interrupted, status: 'RUNNING', tasks: { ...interrupted.tasks,
      'final-review': { ...runningReview, status: 'RUNNING', agentAttempts: runningReview.agentAttempts.map((attempt, index, attempts) =>
        index === attempts.length - 1 ? { ...attempt, finishedAt: new Date().toISOString(), outcome: 'succeeded' as const } : attempt) },
    } });

    value.agents.claude.crashAfterRoundTwoOutput = false;
    const recovered = await AgentOrchestrator.resume(runId, options(value));
    const recoveredTask = recovered.snapshot().tasks['final-review']!;
    assert.equal(recoveredTask.reviewRounds, 2);
    assert.equal(recoveredTask.reviewPaths.length, 2);
    assert.equal(recoveredTask.reviewPaths[0], roundOnePath);
    assert.match(recoveredTask.reviewPaths[1]!, /\.round-2\.json$/);
    assert.notEqual(recoveredTask.reviewPaths[1], roundOnePath);
    assert.deepEqual(await readFile(roundOnePath), roundOneBytes);
    assert.equal(createHash('sha256').update(await readFile(roundOnePath)).digest('hex'), roundOneSha);
    const roundTwoBytes = await readFile(recoveredTask.reviewPaths[1]!);
    assert.deepEqual(roundTwoBytes, Buffer.from(`${JSON.stringify({ status: 'approved', findings: [] }, null, 2)}\n`));
    assert.equal(createHash('sha256').update(roundTwoBytes).digest('hex'),
      createHash('sha256').update(Buffer.from(`${JSON.stringify({ status: 'approved', findings: [] }, null, 2)}\n`)).digest('hex'));

    const repeated = await AgentOrchestrator.resume(runId, options(value));
    assert.deepEqual(repeated.snapshot().tasks['final-review']!.reviewPaths, recoveredTask.reviewPaths);
    assert.equal(repeated.snapshot().reviewCorrections?.length, 1, 'continuation binding still loads');
  } finally { await value.repository.dispose(); }
});

test('correction request identity always hashes normalized optional defaults', async () => {
  const expanded = { ...request, dependencies: [], capabilities: [], risk: 'medium' as const, priority: 50 };
  const optionalKeys = ['dependencies', 'capabilities', 'risk', 'priority', 'estimatedCostUnits'] as const;
  const omissionCases: readonly (readonly (typeof optionalKeys)[number][])[] = [
    ...optionalKeys.map((key) => [key] as const), optionalKeys,
  ];
  for (const omittedKeys of omissionCases) {
    const raw: Record<string, unknown> = { ...expanded, estimatedCostUnits: undefined };
    for (const key of omittedKeys) delete raw[key];
    assert.equal(correctionRequestHash(raw), correctionRequestHash(expanded), `omitting ${omittedKeys.join(', ')}`);
    const value = await fixture();
    try {
      const state = value.orchestrator.snapshot();
      const artifactPath = state.tasks['final-review']!.reviewPaths[0]!;
      await writeFile(artifactPath, JSON.stringify({ status: 'changes_requested', findings: [finding], additionalWorkRequests: [raw] }));
      const authorized = await AgentOrchestrator.authorizeReviewCorrection(state.runId, 'final-review', 0, options(value));
      assert.equal(authorized.continuation.authorization.correctionRequestHash, correctionRequestHash(expanded));
      const replayed = await AgentOrchestrator.resume(state.runId, options(value));
      assert.equal(replayed.snapshot().reviewCorrections?.[0]?.authorization.correctionRequestHash,
        correctionRequestHash(expanded));
    } finally { await value.repository.dispose(); }
  }
  const combined = { ...expanded } as Record<string, unknown>;
  for (const key of optionalKeys) delete combined[key];
  assert.equal(correctionRequestHash(combined), correctionRequestHash(expanded));
  assert.deepEqual(canonicalCorrectionRequest(combined), canonicalCorrectionRequest(expanded));
  assert.notEqual(correctionRequestHash({ ...expanded, objective: 'Semantically different correction.' }),
    correctionRequestHash(expanded));
});

test('overlapping prospective correction graph refuses before any durable mutation', async () => {
  const value = await fixture('approved', true);
  try {
    const state = value.orchestrator.snapshot();
    const runBytes = await readFile(value.orchestrator.stateStore.statePath);
    const eventBytes = await readFile(value.orchestrator.stateStore.eventsPath);
    const worktrees = (await value.repository.git.run(value.repository.repository, ['worktree', 'list', '--porcelain'])).stdout;
    const invocations = value.agents.codex.requests.length + value.agents.claude.requests.length;
    await assert.rejects(AgentOrchestrator.authorizeReviewCorrection(state.runId, 'final-review', 0, options(value)),
      (error) => isOrchestratorError(error, 'OWNERSHIP_OVERLAP'));
    assert.deepEqual(await readFile(value.orchestrator.stateStore.statePath), runBytes);
    assert.deepEqual(await readFile(value.orchestrator.stateStore.eventsPath), eventBytes);
    assert.equal((await value.repository.git.run(value.repository.repository, ['worktree', 'list', '--porcelain'])).stdout, worktrees);
    assert.equal(value.agents.codex.requests.length + value.agents.claude.requests.length, invocations);
    const unchanged = JSON.parse(runBytes.toString('utf8')) as RunState;
    assert.equal(unchanged.reviewCorrections, undefined);
    assert.equal(Object.keys(unchanged.tasks).some((id) => id.startsWith('review-correction-')), false);
  } finally { await value.repository.dispose(); }
});

test('completed continuation for one review does not block a later unrelated review', async () => {
  const value = await fixture('approved', false, true);
  try {
    const runId = value.orchestrator.snapshot().runId;
    const first = await AgentOrchestrator.authorizeReviewCorrection(runId, 'final-review-a', 0, options(value));
    const firstCorrectionId = first.continuation.authorization.correctionTask.id;
    const resumed = await AgentOrchestrator.resume(runId, options(value));
    const secondBlocked = await resumed.execute();
    assert.equal(secondBlocked.tasks['final-review-a']?.status, 'SUCCEEDED');
    assert.equal(secondBlocked.tasks['final-review-b']?.status, 'BLOCKED', JSON.stringify(secondBlocked, null, 2));
    assert.equal(secondBlocked.tasks['final-review-b']?.error?.code, 'BLOCKED_FOR_HUMAN_REVIEW', JSON.stringify(secondBlocked.tasks['final-review-b'], null, 2));
    assert.equal(secondBlocked.tasks['final-review-b']?.agentAttempts.at(-1)?.outcome, 'succeeded');
    assert.equal(secondBlocked.tasks['final-review-b']?.handoffOutcome, 'valid');
    const second = await AgentOrchestrator.authorizeReviewCorrection(runId, 'final-review-b', 0, options(value));
    assert.equal(second.created, true);
    assert.equal(second.orchestrator.snapshot().reviewCorrections?.length, 2);
    assert.notEqual(second.continuation.authorization.correctionTask.id, firstCorrectionId);
  } finally { await value.repository.dispose(); }
});

test('round 2 changes_requested consumes the remaining budget and cannot create a fresh continuation root', async () => {
  const value = await fixture('changes_requested');
  try {
    const runId = value.orchestrator.snapshot().runId;
    await AgentOrchestrator.authorizeReviewCorrection(runId, 'final-review', 0, options(value));
    const resumed = await AgentOrchestrator.resume(runId, options(value));
    const blocked = await resumed.execute();
    assert.equal(blocked.status, 'BLOCKED');
    assert.equal(blocked.tasks['final-review']?.reviewRounds, 2, JSON.stringify(blocked, null, 2));
    assert.equal(blocked.integration.status, 'PENDING');
    await assert.rejects(AgentOrchestrator.authorizeReviewCorrection(runId, 'final-review', 0, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /consumed this review lineage/.test(error.message));
  } finally { await value.repository.dispose(); }
});

for (const scenario of ['approved', 'malformed', 'no-request', 'multiple-requests', 'non-correction', 'empty-write', 'finding-mismatch', 'integration-started', 'provider-running'] as const) {
  test(`review correction refuses ${scenario}`, async () => {
    const value = await fixture();
    try {
      const state = value.orchestrator.snapshot();
      const path = state.tasks['final-review']!.reviewPaths[0]!;
      let review: unknown = { status: 'changes_requested', findings: [finding], additionalWorkRequests: [request] };
      if (scenario === 'approved') review = { status: 'approved', findings: [] };
      if (scenario === 'malformed') review = { status: 'changes_requested', findings: [] };
      if (scenario === 'no-request') review = { status: 'changes_requested', findings: [finding] };
      if (scenario === 'multiple-requests') review = { status: 'changes_requested', findings: [finding], additionalWorkRequests: [request, request] };
      if (scenario === 'non-correction') review = { status: 'changes_requested', findings: [finding], additionalWorkRequests: [{ ...request, role: 'testing' }] };
      if (scenario === 'empty-write') review = { status: 'changes_requested', findings: [finding], additionalWorkRequests: [{ ...request,
        resourceClaims: [{ kind: 'repository_path', key: 'apps/api/src/chat/chat.service.ts', mode: 'read' }] }] };
      if (scenario === 'finding-mismatch') review = { status: 'changes_requested', findings: [finding], additionalWorkRequests: [{ ...request,
        evidence: [{ kind: 'finding', reference: 'F999', summary: 'forged' }] }] };
      await writeFile(path, JSON.stringify(review));
      if (scenario === 'integration-started') await value.orchestrator.stateStore.save({ ...state, integration: { ...state.integration, status: 'RUNNING' } });
      if (scenario === 'provider-running') {
        const task = state.tasks['final-review']!;
        await value.orchestrator.stateStore.save({ ...state, tasks: { ...state.tasks, 'final-review': { ...task,
          agentAttempts: task.agentAttempts.map((attempt) => ({ ...attempt, pid: process.pid })) } } });
      }
      await assert.rejects(AgentOrchestrator.authorizeReviewCorrection(state.runId, 'final-review', 0, options(value)),
        (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') || isOrchestratorError(error, 'REVIEW_BLOCKED'));
    } finally { await value.repository.dispose(); }
  });
}

test('request validation canonicalizes line evidence and rejects unsafe or mismatched authority', () => {
  assert.equal(validateCorrectionRequest(request, ['F001']).role, 'correction');
  assert.throws(() => validateCorrectionRequest({ ...request, evidence: [{ kind: 'file', reference: '../escape.ts:3', summary: 'bad' }] }, ['F001']));
  assert.throws(() => validateCorrectionRequest({ ...request, evidence: [{ kind: 'finding', reference: 'F002', summary: 'bad' }] }, ['F001']));
  assert.notEqual(canonicalHash(request), canonicalHash({ ...request, objective: 'widened' }));
});

test('persisted authorization tamper and ownership widening fail closed on load', async () => {
  const value = await fixture();
  try {
    const runId = value.orchestrator.snapshot().runId;
    const result = await AgentOrchestrator.authorizeReviewCorrection(runId, 'final-review', 0, options(value));
    const state = result.orchestrator.snapshot();
    const continuation = state.reviewCorrections![0]!;
    const { id: _id, authorizedBy: _by, authorizedAt: _at, ...identity } = continuation.authorization;
    const widenedIdentity = { ...identity, correctionTask: { ...identity.correctionTask, files: ['apps/api/src/chat/**'] } };
    const widened = { ...continuation, authorization: { id: authorizationId(widenedIdentity), ...widenedIdentity,
      authorizedBy: 'human' as const, authorizedAt: continuation.authorization.authorizedAt } };
    await value.orchestrator.stateStore.save({ ...state, reviewCorrections: [widened] } as RunState);
    await assert.rejects(AgentOrchestrator.resume(runId, options(value)),
      (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  } finally { await value.repository.dispose(); }
});

test('authorization checkpoint heals task-creation crash without duplicating the correction', async () => {
  const value = await fixture();
  try {
    const runId = value.orchestrator.snapshot().runId;
    const authorized = await AgentOrchestrator.authorizeReviewCorrection(runId, 'final-review', 0, options(value));
    const state = authorized.orchestrator.snapshot();
    const correctionId = authorized.continuation.authorization.correctionTask.id;
    const { [correctionId]: _crashedTask, ...tasks } = state.tasks;
    await value.orchestrator.stateStore.save({ ...state, tasks, reviewCorrections: [{ ...authorized.continuation, phase: 'AUTHORIZED' }] });
    const healed = await AgentOrchestrator.resume(runId, options(value));
    assert.equal(healed.snapshot().tasks[correctionId]?.status, 'READY');
    assert.equal(Object.keys(healed.snapshot().tasks).filter((id) => id === correctionId).length, 1);
  } finally { await value.repository.dispose(); }
});

test('artifact tamper after authorization fails closed before correction execution', async () => {
  const value = await fixture();
  try {
    const runId = value.orchestrator.snapshot().runId;
    const authorized = await AgentOrchestrator.authorizeReviewCorrection(runId, 'final-review', 0, options(value));
    await writeFile(authorized.continuation.authorization.reviewArtifactPath,
      JSON.stringify({ status: 'changes_requested', findings: [finding], additionalWorkRequests: [{ ...request, objective: 'tampered' }] }));
    await assert.rejects(AgentOrchestrator.resume(runId, options(value)),
      (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
    assert.equal(value.agents.codex.requests.filter((entry) => entry.role === 'correction').length, 0);
  } finally { await value.repository.dispose(); }
});

test('correction ownership violation fails and never reopens the source review', async () => {
  const value = await fixture();
  try {
    value.agents.codex.violateCorrection = true;
    const runId = value.orchestrator.snapshot().runId;
    const authorized = await AgentOrchestrator.authorizeReviewCorrection(runId, 'final-review', 0, options(value));
    const resumed = await AgentOrchestrator.resume(runId, options(value));
    const failed = await resumed.execute();
    const correctionId = authorized.continuation.authorization.correctionTask.id;
    assert.equal(failed.tasks[correctionId]?.error?.code, 'OWNERSHIP_VIOLATION');
    assert.equal(failed.tasks['final-review']?.status, 'BLOCKED');
    assert.equal(failed.tasks['final-review']?.reviewPaths.length, 1);
    assert.equal(failed.integration.status, 'PENDING');
  } finally { await value.repository.dispose(); }
});

test('changes_requested with only low findings is not materially eligible', async () => {
  const value = await fixture();
  try {
    const state = value.orchestrator.snapshot();
    const path = state.tasks['final-review']!.reviewPaths[0]!;
    const low = { ...finding, severity: 'low' as const };
    await writeFile(path, JSON.stringify({ status: 'changes_requested', findings: [low], additionalWorkRequests: [request] }));
    await assert.rejects(AgentOrchestrator.authorizeReviewCorrection(state.runId, 'final-review', 0, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /no material finding/.test(error.message));
  } finally { await value.repository.dispose(); }
});

test('an unrelated material finding cannot authorize a request that references only a low finding', async () => {
  const value = await fixture();
  try {
    const state = value.orchestrator.snapshot();
    const path = state.tasks['final-review']!.reviewPaths[0]!;
    const low = { ...finding, id: 'F002', severity: 'low' as const };
    const lowRequest = { ...request, evidence: request.evidence.map((entry) =>
      entry.kind === 'finding' ? { ...entry, reference: 'F002' } : entry) };
    await writeFile(path, JSON.stringify({ status: 'changes_requested', findings: [
      { ...finding, severity: 'high' as const }, low,
    ], additionalWorkRequests: [lowRequest] }));
    await assert.rejects(AgentOrchestrator.authorizeReviewCorrection(state.runId, 'final-review', 0, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /references no material finding/.test(error.message));
  } finally { await value.repository.dispose(); }
});
