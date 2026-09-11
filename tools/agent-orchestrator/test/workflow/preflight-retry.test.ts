import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, unlink, mkdtemp, readdir, rename, rmdir, rm, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { OrchestratorError, isOrchestratorError } from '../../src/errors';
import { WorktreeManager } from '../../src/git';
import { AgentOrchestrator } from '../../src/orchestrator';
import { StateStore, type RunEvent, type RunState, type TaskRunState } from '../../src/state';
import type { TaskSpec } from '../../src/tasks';
import { createTemporaryRepository } from '../git/helpers';

const target = 'realtime-review';
const approved = { status: 'approved', findings: [] };
const changes = { status: 'changes_requested', findings: [{
  id: 'F001', severity: 'low', category: 'testing', file: 'shared.txt', location: '',
  problem: 'Missing example.', evidence: 'No example exists.', impact: 'Harder to test.',
  suggestedFix: 'Add example.', verificationRequired: 'Inspect example.',
}] };

class FakeAgent implements Agent {
  readonly invocations: string[] = [];
  constructor(readonly name: AgentName) {}
  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request.taskId);
    await request.onStarted?.(process.pid);
    const writer = request.access === 'writer';
    if (writer) await writeFile(join(request.worktreePath, 'shared.txt'), request.taskId);
    const output = writer ? {
      status: 'complete', summary: request.taskId, filesChanged: ['shared.txt'], decisions: [], tests: [],
      openQuestions: [], reviewRequested: [],
    } : request.taskId.endsWith('final-review') ? approved : changes;
    const timestamp = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded', failureCode: null,
      exitCode: 0, signal: null, stdoutPath: join(request.artifactsDirectory, 'unused.stdout.log'),
      stderrPath: join(request.artifactsDirectory, 'unused.stderr.log'), structuredHandoff: output,
      changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: timestamp, endedAt: timestamp, durationMs: 0, timedOut: false, aborted: false, errorMessage: null,
    };
  }
}

async function fixture(prepared = true) {
  const repository = await createTemporaryRepository();
  try {
    await writeFile(join(repository.repository, 'design.md'), '# Design');
    await repository.git.run(repository.repository, ['add', '--', 'design.md']);
    await repository.git.run(repository.repository, ['commit', '-m', 'design']);
    const tasks = [
      ['core-impl', 'implementation'], ['core-review', 'review'], ['core-fix', 'correction'],
      ['core-final-review', 'final_review'], ['realtime-impl', 'implementation'],
      [target, 'review'], ['realtime-fix', 'correction'], ['realtime-final-review', 'final_review'],
    ].map(([id, mode], index, entries) => ({
      id, title: id, mode, owner: mode === 'implementation' || mode === 'correction' ? 'codex' : 'claude',
      files: mode === 'implementation' || mode === 'correction' ? ['shared.txt'] : [],
      dependsOn: index === 0 ? [] : [entries[index - 1]![0]],
      ...(mode === 'correction' || mode === 'final_review' ? {
        condition: { reviewOf: index < 4 ? 'core-review' : target, skipIfStatus: ['approved'] },
      } : {}),
    }));
    // Counts actual preparation executions outside source/worktree contents.
    const preparationLog = join(repository.container, 'preparations.log');
    const phaseFile = join(repository.container, 'phase.yaml');
    await writeFile(phaseFile, JSON.stringify({
      phase: 'preflight', name: 'Preflight regression', baseBranch: repository.baseBranch,
      canonicalDesignDocument: 'design.md', maxReviewRounds: 2, concurrency: 1,
      agentWorktree: { prepare: [{ command: `node -e "require('node:fs').appendFileSync('${preparationLog}', process.cwd() + String.fromCharCode(10))"` }] },
      tasks, integration: { commands: ['node -e "process.exit(0)"'] },
    }));
    const agents = { codex: new FakeAgent('codex'), claude: new FakeAgent('claude') };
    const options = { repositoryPath: repository.repository, runsRoot: join(repository.container, 'runs'), agents };
    const orchestrator = await AgentOrchestrator.start(phaseFile, options);
    // Emulate precisely the old guard placement, without ever invoking the
    // target's fake reviewer. All upstream tasks execute through production.
    const prototype = AgentOrchestrator.prototype as unknown as {
      executeTask(task: TaskSpec): Promise<void>; prepareTask(task: TaskSpec): Promise<unknown>;
    };
    const executeTask = prototype.executeTask;
    prototype.executeTask = async function (task) {
      if (task.id !== target) return executeTask.call(this, task);
      if (prepared) await this.prepareTask(task);
      throw new OrchestratorError('BLOCKED_FOR_HUMAN_REVIEW', 'Historical wording is not an eligibility signal',
        { details: { completedRounds: 2, maxReviewRounds: 2 } });
    };
    let failed: RunState;
    try { failed = await orchestrator.execute(); } finally { prototype.executeTask = executeTask; }
    assert.equal(failed.tasks[target]?.agentAttempts.length, 0);
    assert.equal(failed.tasks[target]?.error?.code, 'BLOCKED_FOR_HUMAN_REVIEW');
    assert.ok(!agents.claude.invocations.includes(target));
    return { repository, options, orchestrator, failed, store: orchestrator.stateStore, preparationLog };
  } catch (error) {
    await repository.dispose();
    throw error;
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
const retry = (f: Fixture) => AgentOrchestrator.retryPreflight(f.failed.runId, target, f.options);
const invocations = (f: Fixture) => [...f.options.agents.codex.invocations, ...f.options.agents.claude.invocations];
const replaceTarget = (f: Fixture, patch: Partial<TaskRunState>): RunState => ({
  ...f.failed, tasks: { ...f.failed.tasks, [target]: { ...f.failed.tasks[target]!, ...patch } },
});
async function events(f: Fixture): Promise<RunEvent[]> {
  return (await readFile(f.store.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as RunEvent);
}
async function refused(f: Fixture): Promise<void> {
  const state = await readFile(f.store.statePath, 'utf8');
  const history = await readFile(f.store.eventsPath, 'utf8');
  const calls = invocations(f);
  await assert.rejects(retry(f));
  assert.equal(await readFile(f.store.statePath, 'utf8'), state);
  assert.equal(await readFile(f.store.eventsPath, 'utf8'), history);
  assert.deepEqual(invocations(f), calls);
}

for (const prepared of [true, false]) {
  test(`real bug shape: preflight retry and full resume ${prepared ? 'reuse the prepared worktree' : 'create the absent worktree'}`, async () => {
    const f = await fixture(prepared);
    try {
      if (!prepared) {
        f.failed = { ...replaceTarget(f, { status: 'BLOCKED' }), status: 'BLOCKED' };
        await f.store.save(f.failed);
      }
      const calls = invocations(f);
      const history = await readFile(f.store.eventsPath, 'utf8');
      const result = await retry(f);
      const ready = result.orchestrator.snapshot();
      assert.equal(result.completedRounds, 0);
      assert.equal(result.maxReviewRounds, 2);
      assert.equal(ready.status, 'RUNNING');
      assert.equal(ready.tasks[target]?.status, 'READY');
      assert.equal(ready.tasks[target]?.agentAttempts.length, 0);
      assert.equal(ready.tasks[target]?.reviewRounds, 0);
      assert.deepEqual(result.reopenedTasks, ['realtime-fix', 'realtime-final-review']);
      for (const id of result.reopenedTasks) assert.equal(ready.tasks[id]?.status, 'PENDING');
      assert.deepEqual(invocations(f), calls, 'recovery invokes zero providers');
      assert.deepEqual(ready.errors, f.failed.errors);
      assert.deepEqual(ready.tasks[target]?.preparation, f.failed.tasks[target]?.preparation);
      assert.equal(ready.tasks[target]?.worktreePath, f.failed.tasks[target]?.worktreePath);
      assert.ok((await readFile(f.store.eventsPath, 'utf8')).startsWith(history));
      const authorization = (await events(f)).find((event) => event.name === 'PREFLIGHT_RETRY_AUTHORIZED');
      assert.deepEqual(authorization?.data?.previousTask, f.failed.tasks[target]);
      assert.equal(authorization?.data?.completedRounds, 0);
      assert.deepEqual(authorization?.data?.reopenedTasks, result.reopenedTasks);
      const resumed = await AgentOrchestrator.resume(f.failed.runId, f.options);
      const completed = await resumed.execute();
      assert.equal(completed.status, 'COMPLETED');
      assert.equal(f.options.agents.claude.invocations.filter((id) => id === target).length, 1);
      assert.deepEqual(completed.tasks['realtime-impl'], f.failed.tasks['realtime-impl']);
      const round = (await events(f)).find((event) => event.name === 'REVIEW_STARTED' && event.taskId === target);
      assert.equal(round?.data?.round, 1);
      const manager = await WorktreeManager.create({ repositoryPath: f.repository.repository });
      const owned = (await manager.listOwned()).filter((entry) => entry.runId === f.failed.runId && entry.taskId === target);
      assert.equal(owned.length, 1);
      const preparations = (await readFile(f.preparationLog, 'utf8')).trim().split('\n');
      assert.equal(preparations.filter((path) => path.endsWith(`/${f.failed.runId}-task-${target}`)).length, 1, 'preparation is not duplicated');
      assert.equal((await events(f)).filter((event) => event.name === 'AGENT_WORKTREE_PREPARATION_STARTED' && event.taskId === target).length, 1);
      await assert.rejects(retry(f), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
    } finally { await f.repository.dispose(); }
  });
}

test('preflight retry refuses unsupported state and evidence without mutation or providers', async (t) => {
  const f = await fixture();
  try {
    const ts = f.failed.createdAt;
    const targetCases: Record<string, Partial<TaskRunState>> = {
      'agent attempt': { agentAttempts: [{ attempt: 1, agent: 'claude', startedAt: ts }] },
      'review path': { reviewPaths: ['/tmp/review.json'] },
      'handoff path': { handoffPath: '/tmp/handoff.json' },
      'accepted output': { handoffOutcome: 'valid' },
      'invalid output': { handoffOutcome: 'invalid' },
      'task commit': { commit: f.failed.tasks['realtime-impl']!.commit! },
      'review round': { reviewRounds: 1 },
      'repair evidence': { handoffRepairAttempts: [{ method: 'none', succeeded: false, timestamp: ts }] },
      'salvage evidence': { salvage: { authorizedAt: ts } },
      'wrong branch': { branch: 'wrong' },
      'wrong worktree': { worktreePath: f.failed.tasks['core-review']!.worktreePath! },
      'failed preparation': { preparation: { ...f.failed.tasks[target]!.preparation!, status: 'FAILED' } },
      'cancelled task': { status: 'CANCELLED' },
    };
    for (const code of ['AGENT_FAILED', 'AGENT_TIMEOUT', 'REVIEW_BLOCKED', 'HANDOFF_INVALID', 'OWNERSHIP_VIOLATION',
      'INTEGRATION_TEST_FAILED', 'CONFIG_INVALID'] as const) {
      targetCases[`wrong error ${code}`] = { error: { code, message: 'Maximum review rounds reached (2)', at: ts } };
    }
    for (const [name, patch] of Object.entries(targetCases)) {
      await t.test(name, async () => { await f.store.save(replaceTarget(f, patch)); await refused(f); });
    }
    const runCases: Record<string, RunState> = {
      'non-terminal run': { ...f.failed, status: 'RUNNING' },
      'cancelled run': { ...f.failed, status: 'CANCELLED' },
      'integration commit': { ...f.failed, integration: { ...f.failed.integration, integratedTaskCommits: [f.failed.baseSha] } },
      'integration fix': { ...f.failed, integration: { ...f.failed.integration, integrationFixCommits: [f.failed.baseSha] } },
      'integration worktree': { ...f.failed, integration: { ...f.failed.integration, worktreePath: '/tmp/integration' } },
      'integration head': { ...f.failed, integration: { ...f.failed.integration, headSha: f.failed.baseSha } },
      'integration command': { ...f.failed, integration: { ...f.failed.integration, currentCommand: 0 } },
      'integration error': { ...f.failed, integration: { ...f.failed.integration, error: f.failed.tasks[target]!.error! } },
      'integration preparation': { ...f.failed, integration: { ...f.failed.integration, preparation: f.failed.tasks[target]!.preparation! } },
      'integration recovery history': { ...f.failed, integrationAttempts: [{ status: 'BLOCKED', integratedTaskCommits: [] }] },
    };
    const { preparedHeadSha: _checkpoint, ...partial } = f.failed.tasks[target]!;
    runCases['partial worktree'] = { ...f.failed, tasks: { ...f.failed.tasks, [target]: partial } };
    for (const status of ['PENDING', 'READY', 'RUNNING'] as const) {
      runCases[`live sibling ${status}`] = { ...f.failed, tasks: { ...f.failed.tasks,
        'core-review': { ...f.failed.tasks['core-review']!, status },
      } };
    }
    runCases['unsatisfied dependency'] = { ...f.failed, tasks: { ...f.failed.tasks,
      'realtime-impl': { ...f.failed.tasks['realtime-impl']!, status: 'FAILED' },
    } };
    runCases['illegitimate skipped dependency'] = { ...f.failed, tasks: { ...f.failed.tasks,
      'realtime-impl': { ...f.failed.tasks['realtime-impl']!, status: 'SKIPPED', skipReason: 'not a conditional task' },
    } };
    runCases['descendant attempt'] = { ...f.failed, tasks: { ...f.failed.tasks,
      'realtime-fix': { ...f.failed.tasks['realtime-fix']!, agentAttempts: [{ attempt: 1, agent: 'codex', startedAt: ts }] },
    } };
    runCases['descendant preparation'] = { ...f.failed, tasks: { ...f.failed.tasks,
      'realtime-fix': { ...f.failed.tasks['realtime-fix']!, preparation: f.failed.tasks[target]!.preparation! },
    } };
    for (const [name, state] of Object.entries(runCases)) {
      await t.test(name, async () => { await f.store.save(state); await refused(f); });
    }
    await t.test('missing task', async () => {
      await f.store.save(f.failed);
      await assert.rejects(AgentOrchestrator.retryPreflight(f.failed.runId, 'missing', f.options),
        (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
    });
  } finally { await f.repository.dispose(); }
});

test('dirty, untracked, moved, foreign, and mismatched prepared worktrees are preserved on refusal', async (t) => {
  const f = await fixture();
  try {
    const path = f.failed.tasks[target]!.worktreePath!;
    const original = await readFile(join(path, 'shared.txt'), 'utf8');
    await t.test('dirty tracked file', async () => {
      await writeFile(join(path, 'shared.txt'), 'dirty');
      await refused(f);
      assert.equal(await readFile(join(path, 'shared.txt'), 'utf8'), 'dirty');
      await writeFile(join(path, 'shared.txt'), original);
    });
    await t.test('untracked file', async () => {
      await writeFile(join(path, 'untracked.txt'), 'retain me');
      await refused(f);
      assert.equal(await readFile(join(path, 'untracked.txt'), 'utf8'), 'retain me');
      await unlink(join(path, 'untracked.txt'));
    });
    await t.test('registry base mismatch', async () => {
      const registryPath = join(f.repository.repository, '.agent-worktrees/registry.json');
      const source = await readFile(registryPath, 'utf8');
      const registry = JSON.parse(source);
      registry.entries.find((entry: { taskId: string }) => entry.taskId === target).baseSha = f.failed.tasks['core-impl']!.commit!.sha;
      await writeFile(registryPath, JSON.stringify(registry));
      await refused(f);
      await writeFile(registryPath, source);
    });
    await t.test('canonical dependency changed', async () => {
      await f.store.save({ ...f.failed, tasks: { ...f.failed.tasks, 'realtime-impl': {
        ...f.failed.tasks['realtime-impl']!, commit: f.failed.tasks['core-impl']!.commit!,
      } } });
      await refused(f);
      await f.store.save(f.failed);
    });
    await t.test('unfinished Git operation', async () => {
      const gitDir = (await f.repository.git.run(path, ['rev-parse', '--absolute-git-dir'])).stdout.trim();
      const { rmdir } = await import('node:fs/promises');
      await mkdir(join(gitDir, 'rebase-merge'));
      await refused(f);
      await rmdir(join(gitDir, 'rebase-merge'));
    });
    await t.test('HEAD moved by foreign commit', async () => {
      await f.repository.git.run(path, ['commit', '--allow-empty', '-m', 'foreign']);
      const head = await f.repository.git.resolveCommit(path, 'HEAD');
      await refused(f);
      assert.equal(await f.repository.git.resolveCommit(path, 'HEAD'), head);
    });
    await t.test('foreign commit cannot be disguised as a new prepared checkpoint', async () => {
      const head = await f.repository.git.resolveCommit(path, 'HEAD');
      await f.store.save(replaceTarget(f, { preparedHeadSha: head,
        preparation: { ...f.failed.tasks[target]!.preparation!, headSha: head } }));
      await refused(f);
    });
  } finally { await f.repository.dispose(); }
});

test('current conditions and current lineage are authoritative, regardless of historical prose', async (t) => {
  const f = await fixture(false);
  try {
    const phasePath = join(f.store.runDirectory, 'phase.yaml');
    const source = await readFile(phasePath, 'utf8');
    const config = JSON.parse(source);
    const spec = config.tasks.find((entry: { id: string }) => entry.id === target);
    await t.test('current condition skips', async () => {
      spec.condition = { reviewOf: 'core-final-review', skipIfStatus: ['approved'] };
      await writeFile(phasePath, JSON.stringify(config));
      await refused(f);
    });
    await t.test('same-lineage third review still fails strict guard', async () => {
      spec.condition = { reviewOf: 'core-review', skipIfStatus: ['approved'] };
      await writeFile(phasePath, JSON.stringify(config));
      await assert.rejects(retry(f), (error) => isOrchestratorError(error, 'BLOCKED_FOR_HUMAN_REVIEW')
        && error.details?.completedRounds === 2);
      await refused(f);
    });
    await t.test('wrong mode', async () => {
      delete spec.condition;
      spec.mode = 'debate';
      await writeFile(phasePath, JSON.stringify(config));
      await refused(f);
    });
    await writeFile(phasePath, source);
    await t.test('artifact on disk without a state pointer', async () => {
      const path = join(f.store.runDirectory, 'reviews', `${target}.json`);
      await writeFile(path, JSON.stringify(approved));
      await refused(f);
      await unlink(path);
    });
    await t.test('orphan worktree cannot masquerade as unprepared', async () => {
      const manager = await WorktreeManager.create({ repositoryPath: f.repository.repository });
      await manager.createTaskWorktree({ runId: f.failed.runId, taskId: target, baseBranch: f.failed.baseBranch, baseSha: f.failed.baseSha });
      await refused(f);
    });
  } finally { await f.repository.dispose(); }
});

test('crash before atomic state save preserves the worktree and failure, and retry is safe', async () => {
  const f = await fixture();
  const save = StateStore.prototype.save;
  try {
    StateStore.prototype.save = async function (state) {
      if (state.runId === f.failed.runId && state.tasks[target]?.status === 'READY') throw new Error('simulated crash before save');
      return save.call(this, state);
    };
    await assert.rejects(retry(f), /simulated crash/);
    StateStore.prototype.save = save;
    assert.deepEqual(await f.store.load(), f.failed);
    assert.ok((await events(f)).some((event) => event.name === 'PREFLIGHT_RETRY_AUTHORIZED'));
    const retried = await retry(f);
    assert.equal(retried.orchestrator.snapshot().tasks[target]?.worktreePath, f.failed.tasks[target]?.worktreePath);
    const resumed = await AgentOrchestrator.resume(f.failed.runId, f.options);
    assert.equal((await resumed.execute()).status, 'COMPLETED');
  } finally { StateStore.prototype.save = save; await f.repository.dispose(); }
});

test('crash after atomic state save leaves durable provenance and a resumable prepared task', async () => {
  const f = await fixture();
  const append = StateStore.prototype.appendEvent;
  try {
    StateStore.prototype.appendEvent = async function (event) {
      if (event.runId === f.failed.runId && event.name === 'RUN_RESUMED') throw new Error('simulated crash after save');
      return append.call(this, event);
    };
    await assert.rejects(retry(f), /simulated crash/);
    StateStore.prototype.appendEvent = append;
    assert.equal((await f.store.load()).tasks[target]?.status, 'READY');
    assert.deepEqual((await events(f)).find((event) => event.name === 'PREFLIGHT_RETRY_AUTHORIZED')?.data?.previousTask, f.failed.tasks[target]);
    const resumed = await AgentOrchestrator.resume(f.failed.runId, f.options);
    assert.equal((await resumed.execute()).status, 'COMPLETED');
    assert.equal(f.options.agents.claude.invocations.filter((id) => id === target).length, 1);
  } finally { StateStore.prototype.appendEvent = append; await f.repository.dispose(); }
});

test('concurrent preflight retries authorize once and a dead-owner lock is recoverable', async () => {
  const f = await fixture(false);
  try {
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    assert.equal(exited.status, 0);
    await mkdir(join(f.store.runDirectory, 'retry-preflight.lock'));
    await writeFile(join(f.store.runDirectory, 'retry-preflight.lock', exited.stdout), '');
    const calls = invocations(f);
    const results = await Promise.allSettled([retry(f), retry(f)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    for (const result of results) {
      if (result.status === 'rejected') assert.ok(isOrchestratorError(result.reason, 'TASK_STATE_INVALID'));
    }
    assert.equal((await events(f)).filter((event) => event.name === 'PREFLIGHT_RETRY_AUTHORIZED').length, 1);
    assert.deepEqual(invocations(f), calls);
  } finally { await f.repository.dispose(); }
});

// Runs in an independent process. Synchronize at the actual filesystem call,
// without adding hooks or mutable globals to the production StateStore.
function lockContender(): void {
  const fs = require('node:fs/promises') as typeof import('node:fs/promises');
  const { join } = require('node:path') as typeof import('node:path');
  const { StateStore } = require(process.argv[1]!) as typeof import('../../src/state');
  const { OrchestratorError } = require(process.argv[2]!) as typeof import('../../src/errors');
  const store = new StateStore(process.argv[3]!, 'run-race');
  const mode = process.argv[4]!;
  const lockPath = join(store.runDirectory, 'retry-preflight.lock');
  const staleOwner = process.argv[5]!;
  const wait = (phase: string) => new Promise<void>((resolve) => {
    process.once('message', () => resolve());
    process.send!({ phase });
  });
  const unlink = fs.unlink;
  const rmdir = fs.rmdir;
  const readdir = fs.readdir;
  if (mode === 'unlink' || mode === 'permission') {
    fs.unlink = async (path) => {
      if (path === join(lockPath, staleOwner)) {
        await wait('retiring');
        if (mode === 'permission') throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
      }
      return unlink(path);
    };
  } else if (mode === 'rmdir') {
    fs.rmdir = async (path, options) => {
      if (path === lockPath) await wait('retiring');
      return rmdir(path, options);
    };
  } else if (mode === 'inspect') {
    fs.readdir = (async (path: string) => {
      const owners = await readdir(path);
      if (path === lockPath) await wait('retiring');
      return owners;
    }) as typeof fs.readdir;
  }
  void store.withPreflightRetryLock(async () => {
    await wait('acquired');
  }).then(
    () => { process.send!({ phase: 'done', success: true }); process.disconnect!(); },
    (error: NodeJS.ErrnoException) => {
      process.send!({ phase: 'done', success: false, code: error.code, typed: error instanceof OrchestratorError });
      process.disconnect!();
    },
  );
}

interface ContenderResult { success: boolean; code?: string; typed?: boolean }
function startContender(runsRoot: string, mode: string, staleOwner: string) {
  const child = spawn(process.execPath, ['-e', `(${lockContender.toString()})()`,
    resolve(__dirname, '../../src/state/state-store.js'), resolve(__dirname, '../../src/errors.js'),
    runsRoot, mode, staleOwner,
  ], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  const phase = <T>(name: string) => new Promise<T>((resolve) => {
    child.on('message', (message) => {
      const value = message as { phase: string } & T;
      if (value.phase === name) resolve(value);
    });
  });
  return { child, retiring: phase<void>('retiring'), acquired: phase<void>('acquired'), done: phase<ContenderResult>('done') };
}

test('20 synchronized stale-owner races produce one acquisition, typed contention, and a reusable lock', { timeout: 30_000 }, async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), 'tripwith-lock-race-'));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const store = new StateStore(runsRoot, 'run-race');
  await mkdir(store.runDirectory);
  const lockPath = join(store.runDirectory, 'retry-preflight.lock');
  const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
  assert.equal(exited.status, 0);
  for (let iteration = 0; iteration < 20; iteration += 1) {
    await mkdir(lockPath);
    await writeFile(join(lockPath, exited.stdout), '');
    const first = startContender(runsRoot, 'unlink', exited.stdout);
    const second = startContender(runsRoot, 'unlink', exited.stdout);
    t.after(() => { first.child.kill(); second.child.kill(); });
    // Both processes have inspected the SAME dead owner and reached unlink.
    await Promise.all([first.retiring, second.retiring]);
    first.child.send('retire');
    await first.acquired;
    assert.deepEqual(await readdir(lockPath), [String(first.child.pid)]);
    // The loser resumes cleanup only AFTER the winner has installed its PID.
    second.child.send('retire');
    assert.deepEqual(await second.done, { phase: 'done', success: false, code: 'TASK_STATE_INVALID', typed: true });
    assert.deepEqual(await readdir(lockPath), [String(first.child.pid)], 'replacement owner must remain untouched');
    first.child.send('complete');
    assert.deepEqual(await first.done, { phase: 'done', success: true });
    assert.deepEqual(await readdir(store.runDirectory), []);
    let thirdAcquisitions = 0;
    await store.withPreflightRetryLock(async () => { thirdAcquisitions += 1; });
    assert.equal(thirdAcquisitions, 1);
    assert.deepEqual(await readdir(store.runDirectory), []);
  }
});

for (const scenario of ['missing-directory', 'replacement-before-rmdir', 'replacement-before-unlink', 'permission'] as const) {
  test(`stale-lock cleanup handles ${scenario} without deleting replacement contents`, { timeout: 10_000 }, async (t) => {
    const runsRoot = await mkdtemp(join(tmpdir(), 'tripwith-lock-check-'));
    t.after(() => rm(runsRoot, { recursive: true, force: true }));
    const store = new StateStore(runsRoot, 'run-race');
    await mkdir(store.runDirectory);
    const lockPath = join(store.runDirectory, 'retry-preflight.lock');
    await mkdir(lockPath);
    const exited = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' });
    assert.equal(exited.status, 0);
    if (scenario === 'replacement-before-unlink' || scenario === 'permission') {
      await writeFile(join(lockPath, exited.stdout), '');
    } else {
      const old = new Date(Date.now() - 60_000);
      await utimes(lockPath, old, old);
    }
    const contender = startContender(runsRoot,
      scenario === 'replacement-before-unlink' ? 'inspect' : scenario === 'permission' ? 'permission' : 'rmdir', exited.stdout);
    t.after(() => contender.child.kill());
    await contender.retiring;
    if (scenario === 'replacement-before-unlink') {
      await rename(lockPath, join(store.runDirectory, 'retired'));
      await mkdir(lockPath);
      // Even the same PID filename in a different directory must be retained.
      await writeFile(join(lockPath, exited.stdout), 'replacement');
    } else if (scenario !== 'permission') {
      await rmdir(lockPath);
      if (scenario === 'replacement-before-rmdir') {
        await mkdir(lockPath);
        await writeFile(join(lockPath, String(process.pid)), 'replacement');
      }
    }
    contender.child.send('continue');
    const result = await contender.done;
    assert.equal(result.success, false);
    assert.equal(result.code, scenario === 'permission' ? 'EACCES' : 'TASK_STATE_INVALID');
    assert.equal(result.typed, scenario !== 'permission');
    if (scenario === 'replacement-before-unlink') {
      assert.equal(await readFile(join(lockPath, exited.stdout), 'utf8'), 'replacement');
      await unlink(join(lockPath, exited.stdout));
      await rmdir(lockPath);
    } else if (scenario === 'replacement-before-rmdir') {
      assert.equal(await readFile(join(lockPath, String(process.pid)), 'utf8'), 'replacement');
      await unlink(join(lockPath, String(process.pid)));
      await rmdir(lockPath);
    } else if (scenario === 'permission') {
      assert.deepEqual(await readdir(lockPath), [exited.stdout]);
    }
    await store.withPreflightRetryLock(async () => {});
  });
}

test('unexpected lock contents fail closed with typed error and are preserved', async (t) => {
  const runsRoot = await mkdtemp(join(tmpdir(), 'tripwith-lock-shape-'));
  t.after(() => rm(runsRoot, { recursive: true, force: true }));
  const store = new StateStore(runsRoot, 'run-race');
  const lockPath = join(store.runDirectory, 'retry-preflight.lock');
  await mkdir(lockPath, { recursive: true });
  await writeFile(join(lockPath, 'unknown'), 'keep');
  await assert.rejects(store.withPreflightRetryLock(async () => assert.fail('must not acquire')),
    (error) => isOrchestratorError(error, 'TASK_STATE_INVALID') && /unexpected contents/.test(error.message));
  assert.equal(await readFile(join(lockPath, 'unknown'), 'utf8'), 'keep');
});

test('retry-preflight CLI returns scheduler eligibility and a manual resume step without providers', async () => {
  const f = await fixture(false);
  try {
    // CLI uses the repository's conventional runs directory.
    const { rename, mkdir } = await import('node:fs/promises');
    const runsRoot = join(f.repository.repository, 'tools/agent-orchestrator/runs');
    await mkdir(runsRoot, { recursive: true });
    await rename(f.store.runDirectory, join(runsRoot, f.failed.runId));
    const cli = resolve(__dirname, '../../src/cli.js');
    const result = spawnSync(process.execPath, [cli, 'retry-preflight', f.failed.runId, target], {
      cwd: f.repository.repository, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.runId, f.failed.runId);
    assert.equal(output.runStatus, 'RUNNING');
    assert.equal(output.taskId, target);
    assert.equal(output.completedRounds, 0);
    assert.deepEqual(output.reopenedTasks, ['realtime-fix', 'realtime-final-review']);
    assert.match(output.manualNextStep, new RegExp(`pnpm agents:resume ${f.failed.runId}`));
  } finally { await f.repository.dispose(); }
});

test('descendants with an unrelated failed dependency remain blocked', async () => {
  const f = await fixture(false);
  try {
    const phasePath = join(f.store.runDirectory, 'phase.yaml');
    const phase = JSON.parse(await readFile(phasePath, 'utf8'));
    phase.tasks.push({ id: 'unrelated', title: 'Unrelated', mode: 'review', owner: 'claude', files: [], dependsOn: [] });
    phase.tasks.find((entry: { id: string }) => entry.id === 'realtime-fix').dependsOn.push('unrelated');
    await writeFile(phasePath, JSON.stringify(phase));
    await f.store.save({ ...f.failed, tasks: { ...f.failed.tasks, unrelated: {
      id: 'unrelated', status: 'FAILED', agentAttempts: [], reviewRounds: 0, reviewPaths: [], handoffRepairAttempts: [],
      error: { code: 'AGENT_FAILED', message: 'Unrelated failure', at: f.failed.createdAt },
    } } });
    const result = await retry(f);
    assert.deepEqual(result.reopenedTasks, []);
    for (const id of ['realtime-fix', 'realtime-final-review']) {
      assert.deepEqual(result.orchestrator.snapshot().tasks[id], f.failed.tasks[id]);
    }
    assert.equal(result.orchestrator.snapshot().tasks.unrelated?.status, 'FAILED');
  } finally { await f.repository.dispose(); }
});

test('moving the immutable base branch refuses preflight recovery', async () => {
  const f = await fixture(false);
  try {
    await f.repository.git.run(f.repository.repository, ['commit', '--allow-empty', '-m', 'base moved']);
    await refused(f);
    await assert.rejects(retry(f), (error) => isOrchestratorError(error, 'BASE_BRANCH_MOVED'));
  } finally { await f.repository.dispose(); }
});

test('a legitimate conditional skipped dependency remains satisfied', async () => {
  const f = await fixture(false);
  try {
    const phasePath = join(f.store.runDirectory, 'phase.yaml');
    const phase = JSON.parse(await readFile(phasePath, 'utf8'));
    phase.tasks.push(
      { id: 'gate-review', title: 'Approved review', mode: 'review', owner: 'claude', files: [], dependsOn: ['realtime-impl'] },
      { id: 'optional', title: 'Optional final review', mode: 'final_review', owner: 'claude', files: [],
        dependsOn: ['gate-review'], condition: { reviewOf: 'gate-review', skipIfStatus: ['approved'] } },
    );
    phase.tasks.find((entry: { id: string }) => entry.id === target).dependsOn = ['optional'];
    await writeFile(phasePath, JSON.stringify(phase));
    const reviewPath = join(f.store.runDirectory, 'reviews/gate-review.json');
    await writeFile(reviewPath, JSON.stringify(approved));
    await f.store.save({ ...f.failed, tasks: { ...f.failed.tasks,
      'gate-review': { id: 'gate-review', status: 'SUCCEEDED', agentAttempts: [], reviewRounds: 1,
        reviewPaths: [reviewPath], handoffRepairAttempts: [] },
      optional: { id: 'optional', status: 'SKIPPED', skipReason: 'gate-review approved',
        agentAttempts: [], reviewRounds: 0, reviewPaths: [], handoffRepairAttempts: [] },
    } });
    const result = await retry(f);
    assert.equal(result.completedRounds, 1);
    assert.equal(result.orchestrator.snapshot().tasks[target]?.status, 'READY');
    assert.equal(result.orchestrator.snapshot().tasks.optional?.status, 'SKIPPED');
  } finally { await f.repository.dispose(); }
});
