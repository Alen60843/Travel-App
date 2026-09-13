import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { taskCommitMessage } from '../../src/git';
import { AgentOrchestrator, type OrchestratorOptions } from '../../src/orchestrator';
import {
  authorizationId,
  correctionVerification,
  legacyCorrectionVerification,
  repositoryPathToPackageRelative,
} from '../../src/review/correction-continuation';
import type { ReviewCorrectionVerificationRecovery } from '../../src/review/correction-verification-recovery';
import type { RunState } from '../../src/state';
import { createTemporaryRepository, type TemporaryRepository } from '../git/helpers';

const finding = {
  id: 'F001', severity: 'high', category: 'correctness',
  file: 'apps/api/src/chat/presence/presence.service.ts', location: 'line 1',
  problem: 'EVENT is rejected.', evidence: 'The guard is unconditional.', impact: 'Presence fails.',
  suggestedFix: 'Remove the guard.', verificationRequired: 'Run presence tests.',
} as const;

const request = {
  role: 'correction', concern: 'authorization', objective: 'Allow EVENT presence.', reason: 'F001 proves the gap.',
  dependencies: [], capabilities: [], risk: 'medium', priority: 80,
  resourceClaims: [{ kind: 'repository_path', key: 'apps/api/src/chat/presence/**', mode: 'write' }],
  evidence: [
    { kind: 'file', reference: 'apps/api/src/chat/presence/presence.spec.ts', summary: 'unit coverage' },
    { kind: 'finding', reference: 'F001', summary: 'accepted finding' },
  ],
} as const;

function handoff(filesChanged: readonly string[]) {
  return { status: 'complete', summary: 'correction complete', filesChanged, decisions: [], tests: [],
    openQuestions: [], reviewRequested: [] };
}

class RecoveryAgent implements Agent {
  readonly requests: AgentRequest[] = [];
  constructor(readonly name: AgentName) {}
  async run(agentRequest: AgentRequest): Promise<AgentResult> {
    this.requests.push(agentRequest);
    let output: unknown;
    if (agentRequest.taskId === 'implementation') {
      const directory = join(agentRequest.worktreePath, 'apps/api/src/chat/presence');
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, 'presence.service.ts'), 'export const value = "old";\n');
      await writeFile(join(directory, 'presence.spec.ts'), 'export const unit = "old";\n');
      output = handoff(['apps/api/src/chat/presence/presence.service.ts', 'apps/api/src/chat/presence/presence.spec.ts']);
    } else if (agentRequest.role === 'correction') {
      const directory = join(agentRequest.worktreePath, 'apps/api/src/chat/presence');
      await writeFile(join(directory, 'presence.service.ts'), 'export const value = "fixed";\n');
      await writeFile(join(directory, 'presence.spec.ts'), 'export const unit = "fixed";\n');
      await writeFile(join(directory, 'presence.service.int-spec.ts'), 'export const integration = "fixed";\n');
      const required = (agentRequest.taskSpecification as { requiredCanonicalFindings?: readonly {
        findingId: string; canonicalFindingKey: string;
      }[] }).requiredCanonicalFindings ?? [];
      output = { ...handoff([
        'apps/api/src/chat/presence/presence.service.ts',
        'apps/api/src/chat/presence/presence.spec.ts',
        'apps/api/src/chat/presence/presence.service.int-spec.ts',
      ]), findingResponses: required.map((entry) => ({ findingId: entry.findingId,
        canonicalFindingKey: entry.canonicalFindingKey, decision: 'confirmed', resolution: 'resolved',
        evidence: 'Guard removed.', fix: 'Removed guard.', verification: 'Host verification.',
      })) };
    } else {
      output = { status: 'changes_requested', findings: [finding], additionalWorkRequests: [request] };
    }
    const stdoutPath = join(agentRequest.artifactsDirectory,
      `${agentRequest.runId}.${agentRequest.taskId}.${this.name}.attempt-${agentRequest.attempt}.stdout.log`);
    await writeFile(stdoutPath, JSON.stringify(output));
    const timestamp = new Date().toISOString();
    return { agent: this.name, runId: agentRequest.runId, taskId: agentRequest.taskId,
      status: 'succeeded', failureCode: null, exitCode: 0, signal: null, stdoutPath,
      stderrPath: join(agentRequest.artifactsDirectory, 'stderr'), structuredHandoff: output,
      rawStdout: JSON.stringify(output), changedFiles: [], gitDiffSummary: null, testsReported: [],
      unresolvedQuestions: [], startedAt: timestamp, endedAt: timestamp, durationMs: 1,
      timedOut: false, aborted: false, errorMessage: null };
  }
}

interface Fixture {
  readonly repository: TemporaryRepository;
  readonly runsRoot: string;
  readonly orchestrator: AgentOrchestrator;
  readonly runId: string;
  readonly correctionTaskId: string;
  readonly markerPath: string;
  readonly agents: { readonly codex: RecoveryAgent; readonly claude: RecoveryAgent };
  readonly environment: NodeJS.ProcessEnv;
}

function options(value: Fixture, overrides: NodeJS.ProcessEnv = {}): OrchestratorOptions {
  return { repositoryPath: value.repository.repository, runsRoot: value.runsRoot, agents: value.agents,
    hostVerificationEnvironment: { ...value.environment, ...overrides } };
}

async function fixture(): Promise<Fixture> {
  const repository = await createTemporaryRepository();
  const markerPath = join(repository.container, 'verification-calls.log');
  await mkdir(join(repository.repository, 'apps/api'), { recursive: true });
  await writeFile(join(repository.repository, 'package.json'), '{"private":true,"packageManager":"pnpm@9.12.0"}\n');
  await writeFile(join(repository.repository, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(repository.repository, 'design.md'), '# design\n');
  await writeFile(join(repository.repository, 'apps/api/package.json'), JSON.stringify({
    name: '@tripwith/api', private: true,
    scripts: { typecheck: 'node ../../verify.cjs typecheck', test: 'node ../../verify.cjs test' },
  }));
  await writeFile(join(repository.repository, 'verify.cjs'), [
    "const fs = require('node:fs');",
    "fs.appendFileSync(process.env.VERIFICATION_MARKER, process.argv.slice(2).join(' ') + '\\n');",
    "const args = process.argv.slice(2).join(' ');",
    "if (args.includes('apps/api/')) process.exit(31);",
    "if (process.env.FAIL_CORRECTION_VERIFY === '1' && process.argv[2] === 'test') process.exit(32);",
  ].join('\n'));
  await repository.git.run(repository.repository, ['add', '-A']);
  await repository.git.run(repository.repository, ['commit', '-m', 'fixture']);
  const phase = join(repository.container, 'phase.yaml');
  await writeFile(phase, JSON.stringify({
    phase: 'correction-recovery', name: 'correction recovery', baseBranch: repository.baseBranch,
    canonicalDesignDocument: 'design.md', maxReviewRounds: 2, concurrency: 1,
    tasks: [
      { id: 'implementation', title: 'implementation', owner: 'codex', mode: 'implementation', writer: true,
        files: ['apps/api/src/chat/presence/**'], dependsOn: [] },
      { id: 'final-review', title: 'final review', owner: 'claude', mode: 'final_review', writer: false,
        files: [], dependsOn: ['implementation'] },
    ], integration: { commands: ['node -e "process.exit(0)"'] },
  }));
  const agents = { codex: new RecoveryAgent('codex'), claude: new RecoveryAgent('claude') };
  const runsRoot = join(repository.container, 'runs');
  const initial = await AgentOrchestrator.start(phase, { repositoryPath: repository.repository, runsRoot, agents });
  const blocked = await initial.execute();
  assert.equal(blocked.status, 'BLOCKED');
  const environment = { ...process.env, VERIFICATION_MARKER: markerPath,
    TEST_DB_HOST: '127.0.0.1', TEST_DB_PORT: '5432', TEST_DB_USER: 'tripwith',
    TEST_DB_PASSWORD: 'fixture-db-secret', TEST_DB_NAME: 'tripwith' };
  const value = { repository, runsRoot, orchestrator: initial, runId: blocked.runId,
    correctionTaskId: '', markerPath, agents, environment };
  const authorized = await AgentOrchestrator.authorizeReviewCorrection(blocked.runId, 'final-review', 0, options(value));
  const authorizedState = authorized.orchestrator.snapshot();
  const continuation = authorizedState.reviewCorrections![0]!;
  const { id: _id, authorizedBy: _by, authorizedAt: _at, ...identity } = continuation.authorization;
  const legacyIdentity = { ...identity, correctionTask: { ...identity.correctionTask,
    verification: legacyCorrectionVerification(request) } };
  const legacyContinuation = { ...continuation, authorization: {
    id: authorizationId(legacyIdentity), ...legacyIdentity, authorizedBy: 'human' as const,
    authorizedAt: continuation.authorization.authorizedAt,
  } };
  await authorized.orchestrator.stateStore.save({ ...authorizedState, reviewCorrections: [legacyContinuation] } as RunState);
  const correctionTaskId = legacyIdentity.correctionTask.id;
  const resumed = await AgentOrchestrator.resume(blocked.runId, options(value));
  const failed = await resumed.execute();
  assert.equal(failed.tasks[correctionTaskId]?.status, 'BLOCKED');
  assert.equal(failed.tasks[correctionTaskId]?.error?.message, 'Review correction host verification failed');
  return { ...value, orchestrator: resumed, correctionTaskId };
}

async function recover(value: Fixture, overrides: NodeJS.ProcessEnv = {}) {
  return AgentOrchestrator.retryReviewCorrectionVerification(value.runId, value.correctionTaskId, options(value, overrides));
}

async function seedPassingCheckpoint(value: Fixture): Promise<ReviewCorrectionVerificationRecovery> {
  const failed = await recover(value, { FAIL_CORRECTION_VERIFY: '1' });
  const state = failed.orchestrator.snapshot();
  const recovery = state.reviewCorrectionVerificationRecoveries![0]!;
  const now = new Date().toISOString();
  const passed = { ...recovery, attempts: [{
    attempt: 1, startedAt: now, finishedAt: now, result: 'passed' as const,
    handoffSha256: recovery.handoffSha256, worktreeHeadSha: recovery.worktreeHeadSha,
    worktreeDiffFingerprint: recovery.worktreeDiffFingerprint,
    commands: recovery.normalizedVerificationCommands.map((command, index) => ({
      command: command.command, required: true, timeoutMs: command.timeoutMs!, termination: null,
      timedOut: false, exitCode: 0, signal: null, durationMs: 1,
      stdoutPath: join(value.runsRoot, `pass-${index}.stdout.log`),
      stderrPath: join(value.runsRoot, `pass-${index}.stderr.log`),
    })),
  }] };
  await failed.orchestrator.stateStore.save({ ...state, reviewCorrectionVerificationRecoveries: [passed] });
  return passed;
}

test('apps/api repository paths normalize to filtered-package-relative paths', () => {
  assert.equal(repositoryPathToPackageRelative('apps/api/src/chat/presence/presence.spec.ts', 'apps/api'),
    'src/chat/presence/presence.spec.ts');
  assert.match(correctionVerification(request)[1]!.command, /--runTestsByPath src\/chat\/presence\/presence\.spec\.ts$/);
});

test('package path normalization refuses paths outside apps/api', () => {
  assert.throws(() => repositoryPathToPackageRelative('apps/web/src/page.spec.ts', 'apps/api'),
    (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
});

test('generated Presence integration selector is package-relative', () => {
  assert.equal(correctionVerification(request)[2]!.command,
    'pnpm --filter @tripwith/api test -- --runInBand --testPathPatterns=src/chat/presence/.*\\.int-spec\\.ts$');
});

test('provider success plus legacy host-path failure recovers without another provider call', async () => {
  const value = await fixture();
  try {
    const before = value.agents.codex.requests.length + value.agents.claude.requests.length;
    const result = await recover(value);
    assert.ok(result.recovery.correctionCommitSha);
    assert.equal(value.agents.codex.requests.length + value.agents.claude.requests.length, before);
  } finally { await value.repository.dispose(); }
});

test('recovery invokes zero providers', async () => {
  const value = await fixture();
  try {
    const before = value.agents.codex.requests.length;
    await recover(value);
    assert.equal(value.agents.codex.requests.length, before);
  } finally { await value.repository.dispose(); }
});

test('dirty paths outside correction ownership refuse recovery', async () => {
  const value = await fixture();
  try {
    const task = value.orchestrator.snapshot().tasks[value.correctionTaskId]!;
    await writeFile(join(task.worktreePath!, 'apps/api/src/outside.ts'), 'outside\n');
    await assert.rejects(recover(value), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  } finally { await value.repository.dispose(); }
});

test('handoff changed after recovery authorization refuses', async () => {
  const value = await fixture();
  try {
    await recover(value, { FAIL_CORRECTION_VERIFY: '1' });
    const path = value.orchestrator.snapshot().tasks[value.correctionTaskId]!.handoffPath!;
    const parsed = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    await writeFile(path, JSON.stringify({ ...parsed, summary: 'changed after authorization' }));
    await assert.rejects(recover(value), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  } finally { await value.repository.dispose(); }
});

test('worktree changed after recovery authorization refuses', async () => {
  const value = await fixture();
  try {
    await recover(value, { FAIL_CORRECTION_VERIFY: '1' });
    const task = value.orchestrator.snapshot().tasks[value.correctionTaskId]!;
    await writeFile(join(task.worktreePath!, 'apps/api/src/chat/presence/presence.service.ts'), 'changed again\n');
    await assert.rejects(recover(value), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  } finally { await value.repository.dispose(); }
});

test('missing database environment fails closed before Jest', async () => {
  const value = await fixture();
  try {
    const before = await readFile(value.markerPath, 'utf8');
    await assert.rejects(AgentOrchestrator.retryReviewCorrectionVerification(value.runId, value.correctionTaskId, {
      repositoryPath: value.repository.repository, runsRoot: value.runsRoot, agents: value.agents,
      hostVerificationEnvironment: { ...value.environment, TEST_DB_PASSWORD: '' },
    }), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /TEST_DB_PASSWORD/.test(error.message));
    assert.equal(await readFile(value.markerPath, 'utf8'), before);
  } finally { await value.repository.dispose(); }
});

test('database secrets are not persisted in state or events', async () => {
  const value = await fixture();
  try {
    const result = await recover(value);
    const persisted = `${await readFile(result.orchestrator.stateStore.statePath, 'utf8')}\n${await readFile(result.orchestrator.stateStore.eventsPath, 'utf8')}`;
    assert.doesNotMatch(persisted, /fixture-db-secret/);
  } finally { await value.repository.dispose(); }
});

test('successful recovery creates exactly one canonical correction commit', async () => {
  const value = await fixture();
  try {
    const result = await recover(value);
    const task = result.orchestrator.snapshot().tasks[value.correctionTaskId]!;
    const commits = await value.repository.git.run(task.worktreePath!, ['rev-list', `${task.preparedHeadSha}..HEAD`]);
    assert.equal(commits.stdout.trim().split(/\r?\n/).filter(Boolean).length, 1);
    assert.equal(task.commit?.sha, result.recovery.correctionCommitSha);
  } finally { await value.repository.dispose(); }
});

test('successful recovery reopens the same final review for round two', async () => {
  const value = await fixture();
  try {
    const result = await recover(value);
    const state = result.orchestrator.snapshot();
    assert.equal(state.reviewCorrections![0]?.phase, 'REVIEW_REOPENED');
    assert.equal(state.reviewCorrections![0]?.authorization.reviewTaskId, 'final-review');
    assert.equal(state.tasks['final-review']?.status, 'READY');
    assert.equal(state.tasks['final-review']?.reviewRounds, 1);
  } finally { await value.repository.dispose(); }
});

test('retrying a successful recovery is idempotent', async () => {
  const value = await fixture();
  try {
    const first = await recover(value);
    const second = await recover(value);
    assert.equal(second.createdCommit, false);
    assert.equal(second.verificationExecuted, false);
    assert.equal(second.recovery.correctionCommitSha, first.recovery.correctionCommitSha);
    assert.equal(second.orchestrator.snapshot().reviewCorrectionVerificationRecoveries?.length, 1);
  } finally { await value.repository.dispose(); }
});

test('failed corrected verification remains BLOCKED with command evidence', async () => {
  const value = await fixture();
  try {
    const result = await recover(value, { FAIL_CORRECTION_VERIFY: '1' });
    assert.equal(result.recovery.correctionCommitSha, undefined);
    assert.equal(result.recovery.attempts.at(-1)?.result, 'failed');
    assert.equal(result.orchestrator.snapshot().tasks[value.correctionTaskId]?.status, 'BLOCKED');
  } finally { await value.repository.dispose(); }
});

test('integration remains untouched until final review approval', async () => {
  const value = await fixture();
  try {
    const result = await recover(value);
    assert.deepEqual(result.orchestrator.snapshot().integration, { status: 'PENDING', integratedTaskCommits: [] });
  } finally { await value.repository.dispose(); }
});

test('new correction tasks persist corrected canonical verification commands', async () => {
  const value = await fixture();
  try {
    // The fixture rewrites its grant to legacy only after authorization; the pure
    // generator is the canonical source used by every newly-created grant.
    assert.deepEqual(correctionVerification(request).map(({ command }) => command), [
      'pnpm --filter @tripwith/api typecheck',
      'pnpm --filter @tripwith/api test -- --runInBand --runTestsByPath src/chat/presence/presence.spec.ts',
      'pnpm --filter @tripwith/api test -- --runInBand --testPathPatterns=src/chat/presence/.*\\.int-spec\\.ts$',
      'pnpm --filter @tripwith/api test -- --runInBand',
    ]);
  } finally { await value.repository.dispose(); }
});

test('a passing verification checkpoint survives a crash before commit', async () => {
  const value = await fixture();
  try {
    await seedPassingCheckpoint(value);
    const result = await recover(value);
    assert.equal(result.verificationExecuted, false);
    assert.equal(result.createdCommit, true);
  } finally { await value.repository.dispose(); }
});

test('a canonical commit survives a crash before continuation persistence', async () => {
  const value = await fixture();
  try {
    const recovery = await seedPassingCheckpoint(value);
    const state = await value.orchestrator.stateStore.load();
    const task = state.tasks[value.correctionTaskId]!;
    const handoffValue = JSON.parse(await readFile(task.handoffPath!, 'utf8')) as { summary: string };
    await value.repository.git.run(task.worktreePath!, ['add', '-A']);
    await value.repository.git.run(task.worktreePath!, ['commit', '-m',
      taskCommitMessage('codex', value.correctionTaskId, handoffValue.summary)]);
    const result = await recover(value);
    assert.equal(result.verificationExecuted, false);
    assert.equal(result.createdCommit, false);
    assert.ok(result.recovery.correctionCommitSha);
    assert.equal(result.recovery.id, recovery.id);
  } finally { await value.repository.dispose(); }
});
