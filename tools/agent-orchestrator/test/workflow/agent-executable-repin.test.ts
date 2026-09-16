import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { effectiveAgentExecutables, executableRepinId } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunState, TaskRunState } from '../../src/state';
import { createTemporaryRepository, type TemporaryRepository } from '../git/helpers';

interface RepinFixture {
  readonly repository: TemporaryRepository;
  readonly runsRoot: string;
  readonly runId: string;
  readonly orchestrator: AgentOrchestrator;
  readonly oldPath: string;
  readonly replacementPath: string;
  readonly markerPath: string;
}

async function executable(path: string, agent: 'codex' | 'claude' = 'codex', marker?: string): Promise<void> {
  await writeFile(path, [
    '#!/bin/sh',
    `if [ "$1" = "--version" ]; then echo "${agent === 'codex' ? 'codex-cli 1.2.3' : 'claude 1.2.3'}"; exit 0; fi`,
    'cat > /dev/null',
    ...(marker === undefined ? [] : [`printf invoked > '${marker}'`]),
    `printf '%s\n' '${JSON.stringify({ status: 'approved', findings: [] })}'`,
    '',
  ].join('\n'));
  await chmod(path, 0o700);
}

async function fixture(): Promise<RepinFixture> {
  const repository = await createTemporaryRepository();
  await writeFile(join(repository.repository, 'design.md'), '# Design\n');
  await repository.git.run(repository.repository, ['add', '-A']);
  await repository.git.run(repository.repository, ['commit', '-m', 'design']);
  const binaries = join(repository.container, 'bin');
  await mkdir(binaries);
  const oldPath = join(binaries, 'old-codex');
  const replacementPath = join(binaries, 'new-codex');
  const markerPath = join(repository.container, 'replacement-invoked');
  await executable(oldPath);
  await executable(replacementPath, 'codex', markerPath);
  const phase = join(repository.container, 'phase.yaml');
  await writeFile(phase, JSON.stringify({
    phase: 'executable-repin', name: 'executable repin', baseBranch: repository.baseBranch,
    canonicalDesignDocument: 'design.md', concurrency: 1,
    tasks: [{ id: 'failed-review', title: 'failed review', owner: 'codex', mode: 'review', writer: false,
      files: [], dependsOn: [] }], integration: { commands: ['node -e "process.exit(0)"'] },
  }));
  const previous = process.env.CODEX_EXECUTABLE;
  process.env.CODEX_EXECUTABLE = oldPath;
  const runsRoot = join(repository.container, 'runs');
  let orchestrator: AgentOrchestrator;
  try {
    orchestrator = await AgentOrchestrator.start(phase, { repositoryPath: repository.repository, runsRoot });
  } finally {
    if (previous === undefined) delete process.env.CODEX_EXECUTABLE;
    else process.env.CODEX_EXECUTABLE = previous;
  }
  await rm(oldPath);
  const failed = await orchestrator.execute();
  assert.equal(failed.status, 'FAILED');
  assert.equal(failed.tasks['failed-review']?.error?.code, 'AGENT_FAILED');
  assert.match(failed.tasks['failed-review']!.error!.message, new RegExp(`spawn ${oldPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} ENOENT`));
  return { repository, runsRoot, runId: failed.runId, orchestrator, oldPath, replacementPath, markerPath };
}

const options = (value: RepinFixture) => ({ repositoryPath: value.repository.repository, runsRoot: value.runsRoot });

async function dispose(value: RepinFixture): Promise<void> { await value.repository.dispose(); }

async function editTask(value: RepinFixture, update: (task: TaskRunState) => TaskRunState): Promise<void> {
  const state = await value.orchestrator.stateStore.load();
  await value.orchestrator.stateStore.save({ ...state, tasks: { ...state.tasks,
    'failed-review': update(state.tasks['failed-review']!),
  } });
}

test('missing pin authorizes a SHA-bound replacement with zero provider calls and preserves attempt history', async () => {
  const value = await fixture();
  try {
    const before = value.orchestrator.snapshot();
    const attempts = before.tasks['failed-review']!.agentAttempts;
    const result = await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value));
    assert.equal(result.created, true);
    assert.equal(result.repin.oldExecutablePath, value.oldPath);
    assert.equal(result.repin.oldExecutableState, 'missing');
    assert.equal(result.repin.replacement.path, value.replacementPath);
    assert.match(result.repin.replacement.sha256, /^[a-f0-9]{64}$/);
    assert.match(result.repin.replacement.version, /codex-cli/);
    assert.deepEqual(result.orchestrator.snapshot().tasks['failed-review']!.agentAttempts, attempts);
    await assert.rejects(access(value.markerPath));
  } finally { await dispose(value); }
});

test('repeating the same repin is idempotent and appends no event or attempt', async () => {
  const value = await fixture();
  try {
    const first = await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value));
    const eventsBefore = await readFile(first.orchestrator.stateStore.eventsPath, 'utf8');
    const attempts = first.orchestrator.snapshot().tasks['failed-review']!.agentAttempts;
    const second = await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value));
    assert.equal(second.created, false);
    assert.equal(second.repin.id, first.repin.id);
    assert.equal(second.orchestrator.snapshot().agentExecutableRepins?.length, 1);
    assert.deepEqual(second.orchestrator.snapshot().tasks['failed-review']!.agentAttempts, attempts);
    assert.equal(await readFile(second.orchestrator.stateStore.eventsPath, 'utf8'), eventsBefore);
  } finally { await dispose(value); }
});

test('repin refuses when the old effective executable is still usable', async () => {
  const value = await fixture();
  try {
    await executable(value.oldPath);
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /still usable/.test(error.message));
  } finally { await dispose(value); }
});

test('repin refuses a missing replacement', async () => {
  const value = await fixture();
  try {
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', join(value.repository.container, 'missing'), options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  } finally { await dispose(value); }
});

test('repin refuses a non-executable replacement', async () => {
  const value = await fixture();
  try {
    await chmod(value.replacementPath, 0o600);
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /not executable/.test(error.message));
  } finally { await dispose(value); }
});

test('authorized replacement SHA drift fails closed before retry', async () => {
  const value = await fixture();
  try {
    await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value));
    await executable(value.replacementPath, 'codex');
    await assert.rejects(AgentOrchestrator.retryAgentFailure(value.runId, 'failed-review', options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /SHA-256 changed/.test(error.message));
  } finally { await dispose(value); }
});

test('repin refuses arbitrary AGENT_FAILED not bound to spawn ENOENT', async () => {
  const value = await fixture();
  try {
    await editTask(value, (task) => ({ ...task, error: { ...task.error!, message: 'provider exited non-zero' } }));
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /no failed task/.test(error.message));
  } finally { await dispose(value); }
});

test('repin refuses timeout failures', async () => {
  const value = await fixture();
  try {
    await editTask(value, (task) => ({ ...task, error: { ...task.error!, code: 'AGENT_TIMEOUT' },
      agentAttempts: task.agentAttempts.map((attempt) => ({ ...attempt, outcome: 'timed_out' as const })) }));
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  } finally { await dispose(value); }
});

test('repin refuses a dirty failed worktree', async () => {
  const value = await fixture();
  try {
    const task = value.orchestrator.snapshot().tasks['failed-review']!;
    await writeFile(join(task.worktreePath!, 'dirty.txt'), 'provider work\n');
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /provider-produced/.test(error.message));
  } finally { await dispose(value); }
});

test('repin refuses a failed task with a recorded commit', async () => {
  const value = await fixture();
  try {
    await editTask(value, (task) => ({ ...task, commit: { sha: '2'.repeat(40), parentSha: task.preparedHeadSha!, changedFiles: [] } }));
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /has a commit/.test(error.message));
  } finally { await dispose(value); }
});

test('repin refuses a failed task with accepted structured output', async () => {
  const value = await fixture();
  try {
    await editTask(value, (task) => ({ ...task, handoffOutcome: 'valid' }));
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /structured output/.test(error.message));
  } finally { await dispose(value); }
});

test('repin refuses after integration has started', async () => {
  const value = await fixture();
  try {
    const state = await value.orchestrator.stateStore.load();
    await value.orchestrator.stateStore.save({ ...state, integration: { ...state.integration, status: 'RUNNING' } });
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /integration has started/.test(error.message));
  } finally { await dispose(value); }
});

test('repin refuses while a recorded provider PID is alive', async () => {
  const value = await fixture();
  try {
    await editTask(value, (task) => ({ ...task, agentAttempts: task.agentAttempts.map((attempt) => ({ ...attempt, pid: process.pid })) }));
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /still alive/.test(error.message));
  } finally { await dispose(value); }
});

test('repin conservatively refuses a cross-agent executable', async () => {
  const value = await fixture();
  try {
    await executable(value.replacementPath, 'claude');
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /does not identify as codex/.test(error.message));
  } finally { await dispose(value); }
});

test('a second migration is chained from the current effective executable', async () => {
  const value = await fixture();
  try {
    const first = await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value));
    await rm(value.replacementPath);
    const secondPath = join(value.repository.container, 'bin', 'newer-codex');
    await executable(secondPath);
    const state = await first.orchestrator.stateStore.load();
    const task = state.tasks['failed-review']!;
    const nextAttempt = { ...task.agentAttempts.at(-1)!, attempt: 2, startedAt: state.updatedAt,
      finishedAt: state.updatedAt, outcome: 'failed' as const };
    await first.orchestrator.stateStore.save({ ...state, tasks: { ...state.tasks, 'failed-review': { ...task,
      agentAttempts: [...task.agentAttempts, nextAttempt], error: { code: 'AGENT_FAILED',
        message: `spawn ${value.replacementPath} ENOENT`, at: state.updatedAt },
    } } });
    const second = await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', secondPath, options(value));
    assert.equal(second.repin.oldExecutablePath, value.replacementPath);
    assert.equal(second.repin.sourceFailure.attempt, 2);
    assert.equal(second.orchestrator.snapshot().agentExecutableRepins?.length, 2);
    assert.equal(effectiveAgentExecutables(second.orchestrator.snapshot()).codex, secondPath);
  } finally { await dispose(value); }
});

test('retry then resume uses the persisted replacement without PATH discovery', async () => {
  const value = await fixture();
  const previousOverride = process.env.CODEX_EXECUTABLE;
  try {
    await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value));
    const attemptsBeforeRetry = value.orchestrator.snapshot().tasks['failed-review']!.agentAttempts.length;
    const retry = await AgentOrchestrator.retryAgentFailure(value.runId, 'failed-review', options(value));
    assert.equal(retry.orchestrator.snapshot().tasks['failed-review']?.agentAttempts.length, attemptsBeforeRetry);
    process.env.CODEX_EXECUTABLE = join(value.repository.container, 'must-not-be-resolved');
    const resumed = await AgentOrchestrator.resume(value.runId, options(value));
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(await readFile(value.markerPath, 'utf8'), 'invoked');
    assert.deepEqual(completed.tasks['failed-review']?.agentAttempts.map((attempt) => attempt.outcome),
      [...Array(attemptsBeforeRetry).fill('failed'), 'succeeded']);
  } finally {
    if (previousOverride === undefined) delete process.env.CODEX_EXECUTABLE;
    else process.env.CODEX_EXECUTABLE = previousOverride;
    await dispose(value);
  }
});

test('authorized replacement disappearance fails closed on reload', async () => {
  const value = await fixture();
  try {
    await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value));
    await rm(value.replacementPath);
    await assert.rejects(AgentOrchestrator.resume(value.runId, options(value)),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /unavailable or unsafe/.test(error.message));
  } finally { await dispose(value); }
});

test('crash reload preserves the same deterministic effective executable', async () => {
  const value = await fixture();
  try {
    const authorized = await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value));
    const reloaded = await authorized.orchestrator.stateStore.load();
    assert.equal(effectiveAgentExecutables(reloaded).codex, value.replacementPath);
    assert.equal(reloaded.agentExecutables?.codex, value.oldPath);
    assert.equal(reloaded.agentExecutableRepins?.[0]?.id, authorized.repin.id);
  } finally { await dispose(value); }
});

test('repin refuses relative paths, directories, and symlinks', async () => {
  const value = await fixture();
  try {
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', 'relative-codex', options(value)));
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', join(value.repository.container, 'bin'), options(value)));
    const symlink = join(value.repository.container, 'bin', 'linked-codex');
    await value.repository.git.run(value.repository.repository, ['config', 'core.filemode', 'true']);
    const { symlink: makeSymlink } = await import('node:fs/promises');
    await makeSymlink(value.replacementPath, symlink);
    await assert.rejects(AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', symlink, options(value)));
  } finally { await dispose(value); }
});

test('repin history parser rejects a non-contiguous forged migration chain', async () => {
  const value = await fixture();
  try {
    const authorized = await AgentOrchestrator.repinAgentExecutable(value.runId, 'codex', value.replacementPath, options(value));
    const state = authorized.orchestrator.snapshot();
    const { id: _id, authorizedBy, authorizedAt, ...identity } = authorized.repin;
    const forgedIdentity = { ...identity, oldExecutablePath: '/wrong/source' };
    const forged = { id: executableRepinId(forgedIdentity), ...forgedIdentity, authorizedBy, authorizedAt };
    await writeFile(authorized.orchestrator.stateStore.statePath, JSON.stringify({ ...state, agentExecutableRepins: [forged] }));
    await assert.rejects(authorized.orchestrator.stateStore.load(),
      (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  } finally { await dispose(value); }
});
