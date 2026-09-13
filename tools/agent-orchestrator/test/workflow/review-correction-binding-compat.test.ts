import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import {
  authorizationId,
  buildCorrectionTask,
  canonicalHash,
  correctionVerification,
  legacyCorrectionVerification,
} from '../../src/review/correction-continuation';
import type { RunState } from '../../src/state';
import { createTemporaryRepository, type TemporaryRepository } from '../git/helpers';

const finding = {
  id: 'F001', severity: 'medium', category: 'correctness', file: 'apps/api/src/base.ts', location: 'line 1',
  problem: 'A correction is required.', evidence: 'The persisted review proves it.', impact: 'Behavior is wrong.',
  suggestedFix: 'Apply the narrow correction.', verificationRequired: 'Run the focused test.',
} as const;

function requestFor(specPath: string, writePath: string) {
  return {
    role: 'correction' as const, concern: 'correctness', objective: 'Apply the narrow correction.',
    reason: 'F001 requires it.', dependencies: [], capabilities: [], risk: 'medium' as const, priority: 80,
    resourceClaims: [{ kind: 'repository_path' as const, key: writePath, mode: 'write' as const }],
    evidence: [
      { kind: 'file' as const, reference: specPath, summary: 'focused test' },
      { kind: 'finding' as const, reference: 'F001', summary: 'accepted finding' },
    ],
  };
}

const apiRequest = requestFor('apps/api/src/chat/presence/presence.spec.ts', 'apps/api/src/chat/presence/**');
const outsideRequest = requestFor('apps/web/src/page.spec.ts', 'apps/web/src/**');

class BindingAgent implements Agent {
  readonly requests: AgentRequest[] = [];
  constructor(readonly name: AgentName, private readonly correctionRequest: ReturnType<typeof requestFor>) {}
  async run(request: AgentRequest): Promise<AgentResult> {
    this.requests.push(request);
    let output: unknown;
    if (request.taskId === 'implementation') {
      await mkdir(join(request.worktreePath, 'apps/api/src'), { recursive: true });
      await writeFile(join(request.worktreePath, 'apps/api/src/base.ts'), 'export const base = true;\n');
      output = { status: 'complete', summary: 'implementation complete', filesChanged: ['apps/api/src/base.ts'],
        decisions: [], tests: [], openQuestions: [], reviewRequested: [] };
    } else {
      output = { status: 'changes_requested', findings: [finding], additionalWorkRequests: [this.correctionRequest] };
    }
    const stdoutPath = join(request.artifactsDirectory,
      `${request.runId}.${request.taskId}.${this.name}.attempt-${request.attempt}.stdout.log`);
    await writeFile(stdoutPath, JSON.stringify(output));
    const timestamp = new Date().toISOString();
    return { agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded',
      failureCode: null, exitCode: 0, signal: null, stdoutPath, stderrPath: join(request.artifactsDirectory, 'stderr'),
      structuredHandoff: output, rawStdout: JSON.stringify(output), changedFiles: [], gitDiffSummary: null,
      testsReported: [], unresolvedQuestions: [], startedAt: timestamp, endedAt: timestamp, durationMs: 1,
      timedOut: false, aborted: false, errorMessage: null };
  }
}

interface Fixture {
  readonly repository: TemporaryRepository;
  readonly runsRoot: string;
  readonly orchestrator: AgentOrchestrator;
  readonly agents: { readonly codex: BindingAgent; readonly claude: BindingAgent };
}

async function fixture(correctionRequest = outsideRequest): Promise<Fixture> {
  const repository = await createTemporaryRepository();
  await mkdir(join(repository.repository, 'apps/api'), { recursive: true });
  await mkdir(join(repository.repository, 'apps/web'), { recursive: true });
  await writeFile(join(repository.repository, 'package.json'), '{"private":true,"packageManager":"pnpm@9.12.0"}\n');
  await writeFile(join(repository.repository, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
  await writeFile(join(repository.repository, 'design.md'), '# design\n');
  await writeFile(join(repository.repository, 'apps/api/package.json'), '{"name":"@tripwith/api","private":true}\n');
  await writeFile(join(repository.repository, 'apps/web/package.json'), '{"name":"@tripwith/web","private":true}\n');
  await repository.git.run(repository.repository, ['add', '-A']);
  await repository.git.run(repository.repository, ['commit', '-m', 'fixture']);
  const phase = join(repository.container, 'phase.yaml');
  await writeFile(phase, JSON.stringify({ phase: 'binding-compat', name: 'binding compat',
    baseBranch: repository.baseBranch, canonicalDesignDocument: 'design.md', maxReviewRounds: 2, concurrency: 1,
    tasks: [
      { id: 'implementation', title: 'implementation', owner: 'codex', mode: 'implementation', writer: true,
        files: ['apps/api/src/**'], dependsOn: [] },
      { id: 'final-review', title: 'final review', owner: 'claude', mode: 'final_review', writer: false,
        files: [], dependsOn: ['implementation'] },
    ], integration: { commands: ['node -e "process.exit(0)"'] } }));
  const agents = { codex: new BindingAgent('codex', correctionRequest), claude: new BindingAgent('claude', correctionRequest) };
  const runsRoot = join(repository.container, 'runs');
  const orchestrator = await AgentOrchestrator.start(phase, { repositoryPath: repository.repository, runsRoot, agents });
  assert.equal((await orchestrator.execute()).status, 'BLOCKED');
  return { repository, runsRoot, orchestrator, agents };
}

const options = (value: Fixture) => ({ repositoryPath: value.repository.repository,
  runsRoot: value.runsRoot, agents: value.agents });

async function authorize(value: Fixture) {
  return AgentOrchestrator.authorizeReviewCorrection(value.orchestrator.snapshot().runId, 'final-review', 0, options(value));
}

test('persisted canonical apps/api correction still validates', async () => {
  const value = await fixture(apiRequest);
  try {
    const authorized = await authorize(value);
    const loaded = await AgentOrchestrator.resume(value.orchestrator.snapshot().runId, options(value));
    assert.deepEqual(loaded.snapshot().reviewCorrections, authorized.orchestrator.snapshot().reviewCorrections);
  } finally { await value.repository.dispose(); }
});

test('persisted legacy correction outside apps/api validates without canonical generation', async () => {
  const value = await fixture();
  try {
    const authorized = await authorize(value);
    const task = authorized.continuation.authorization.correctionTask;
    assert.deepEqual(task.verification, legacyCorrectionVerification(outsideRequest));
    assert.throws(() => correctionVerification(outsideRequest),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  } finally { await value.repository.dispose(); }
});

test('resume/load succeeds for a persisted legacy outside-package correction', async () => {
  const value = await fixture();
  try {
    await authorize(value);
    const loaded = await AgentOrchestrator.resume(value.orchestrator.snapshot().runId, options(value));
    assert.equal(loaded.snapshot().status, 'RUNNING');
  } finally { await value.repository.dispose(); }
});

test('continuation reconciliation materializes the legacy correction task', async () => {
  const value = await fixture();
  try {
    const authorized = await authorize(value);
    const taskId = authorized.continuation.authorization.correctionTask.id;
    assert.equal(authorized.orchestrator.snapshot().tasks[taskId]?.status, 'READY');
  } finally { await value.repository.dispose(); }
});

test('authorization outside apps/api does not brick the run or invoke a correction provider', async () => {
  const value = await fixture();
  try {
    const providerCalls = value.agents.codex.requests.length;
    const authorized = await authorize(value);
    assert.equal(value.agents.codex.requests.length, providerCalls);
    assert.equal(authorized.orchestrator.snapshot().status, 'RUNNING');
  } finally { await value.repository.dispose(); }
});

test('persisted task matching neither canonical nor legacy shape fails STATE_CORRUPT', async () => {
  const value = await fixture();
  try {
    const authorized = await authorize(value);
    const state = authorized.orchestrator.snapshot();
    const continuation = state.reviewCorrections![0]!;
    const { id: _id, authorizedBy: _by, authorizedAt: _at, ...identity } = continuation.authorization;
    const forgedIdentity = { ...identity, correctionTask: { ...identity.correctionTask,
      verification: [{ command: 'node forged.js', required: true, timeoutMs: 1_000 }] } };
    await authorized.orchestrator.stateStore.save({ ...state, reviewCorrections: [{ ...continuation,
      authorization: { id: authorizationId(forgedIdentity), ...forgedIdentity,
        authorizedBy: 'human' as const, authorizedAt: continuation.authorization.authorizedAt } }] } as RunState);
    await assert.rejects(AgentOrchestrator.resume(state.runId, options(value)),
      (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  } finally { await value.repository.dispose(); }
});

test('canonical API verification directly rejects outside, absolute, and traversal paths', () => {
  for (const path of ['apps/web/src/page.spec.ts', '/apps/api/src/page.spec.ts', 'apps/api/../web/page.spec.ts']) {
    assert.throws(() => correctionVerification(requestFor(path, 'apps/web/src/**')));
  }
});

test('Phase-7-shaped apps/api correction authorization keeps package-relative binding', async () => {
  const value = await fixture(apiRequest);
  try {
    const authorized = await authorize(value);
    const task = authorized.continuation.authorization.correctionTask;
    assert.match(task.verification![1]!.command, /--runTestsByPath src\/chat\/presence\/presence\.spec\.ts$/);
    assert.equal(canonicalHash(task.verification), canonicalHash(correctionVerification(apiRequest)));
    await AgentOrchestrator.resume(value.orchestrator.snapshot().runId, options(value));
  } finally { await value.repository.dispose(); }
});

test('new safe outside-package correction creation preserves the pre-69255 legacy shape', async () => {
  const value = await fixture();
  try {
    const state = value.orchestrator.snapshot();
    const review = value.orchestrator.config.tasks.find((task) => task.id === 'final-review')!;
    const task = buildCorrectionTask(value.orchestrator.config, review, outsideRequest, state.runId);
    assert.deepEqual(task.verification, legacyCorrectionVerification(outsideRequest));
  } finally { await value.repository.dispose(); }
});
