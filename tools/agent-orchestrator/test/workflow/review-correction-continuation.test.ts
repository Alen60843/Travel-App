import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import { authorizationId, canonicalHash, validateCorrectionRequest } from '../../src/review/correction-continuation';
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
  private reviews = 0;
  constructor(readonly name: AgentName, private readonly roundTwo: 'approved' | 'changes_requested' = 'approved',
    public violateCorrection = false) {}

  async run(agentRequest: AgentRequest): Promise<AgentResult> {
    this.requests.push(agentRequest);
    let output: unknown;
    if (agentRequest.taskId === 'implementation') {
      const directory = join(agentRequest.worktreePath, 'apps/api/src/chat/presence');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'presence.service.ts'), 'export const stale = true;\n');
      await writeFile(join(directory, 'presence.spec.ts'), 'export {};\n');
      output = handoff(['apps/api/src/chat/presence/presence.service.ts', 'apps/api/src/chat/presence/presence.spec.ts']);
    } else if (agentRequest.role === 'correction') {
      await writeFile(join(agentRequest.worktreePath, 'apps/api/src/chat/presence/presence.service.ts'), 'export const stale = false;\n');
      if (this.violateCorrection) await writeFile(join(agentRequest.worktreePath, 'apps/api/src/chat/chat.service.ts'), 'export const widened = true;\n');
      const assigned = (agentRequest.taskSpecification as { requiredCanonicalFindings?: { findingId: string; canonicalFindingKey: string }[] }).requiredCanonicalFindings!;
      output = { ...handoff(['apps/api/src/chat/presence/presence.service.ts']), findingResponses: assigned.map((entry) => ({
        findingId: entry.findingId, canonicalFindingKey: entry.canonicalFindingKey, decision: 'confirmed', resolution: 'resolved',
        evidence: 'Guard removed.', fix: 'Removed stale guard.', verification: 'Host verification required.',
      })) };
    } else {
      this.reviews += 1;
      output = this.reviews === 1 || this.roundTwo === 'changes_requested'
        ? { status: 'changes_requested', findings: [finding], additionalWorkRequests: [request] }
        : { status: 'approved', findings: [] };
    }
    const timestamp = new Date().toISOString();
    return { agent: this.name, runId: agentRequest.runId, taskId: agentRequest.taskId,
      status: 'succeeded', failureCode: null, exitCode: 0, signal: null,
      stdoutPath: join(agentRequest.artifactsDirectory, 'stdout'), stderrPath: join(agentRequest.artifactsDirectory, 'stderr'),
      structuredHandoff: output, rawStdout: JSON.stringify(output), changedFiles: [], gitDiffSummary: null,
      testsReported: [], unresolvedQuestions: [], startedAt: timestamp, endedAt: timestamp, durationMs: 1,
      timedOut: false, aborted: false, errorMessage: null };
  }
}

function handoff(filesChanged: string[]) {
  return { status: 'complete', summary: 'complete', filesChanged, decisions: [], tests: [], openQuestions: [], reviewRequested: [] };
}

interface Fixture { repository: TemporaryRepository; runsRoot: string; orchestrator: AgentOrchestrator; agents: { codex: ContinuationAgent; claude: ContinuationAgent } }

async function fixture(roundTwo: 'approved' | 'changes_requested' = 'approved'): Promise<Fixture> {
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
    canonicalDesignDocument: 'design.md', maxReviewRounds: 2, concurrency: 1,
    tasks: [
      { id: 'implementation', title: 'implementation', owner: 'codex', mode: 'implementation', writer: true,
        files: ['apps/api/src/chat/presence/**'], dependsOn: [] },
      { id: 'final-review', title: 'final review', owner: 'claude', mode: 'final_review', writer: false,
        files: [], dependsOn: ['implementation'] },
    ], integration: { commands: ['node -e "process.exit(0)"'] },
  }));
  const agents = { codex: new ContinuationAgent('codex'), claude: new ContinuationAgent('claude', roundTwo) };
  const runsRoot = join(repository.container, 'runs');
  const orchestrator = await AgentOrchestrator.start(phase, { repositoryPath: repository.repository, runsRoot, agents });
  const blocked = await orchestrator.execute();
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.tasks['final-review']?.reviewRounds, 1);
  return { repository, runsRoot, orchestrator, agents };
}

const options = (value: Fixture) => ({ repositoryPath: value.repository.repository, runsRoot: value.runsRoot, agents: value.agents });

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
