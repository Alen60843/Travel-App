import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isOrchestratorError } from '../../src/errors';
import type { StructuredHandoff } from '../../src/handoff/schemas';
import {
  assertResumeBaseUnmoved,
  createRunState,
  reconcileInterruptedTasks,
  StateStore,
  type RunState,
} from '../../src/state';
import type { TaskSpec } from '../../src/tasks/task-schema';

const BASE_SHA = '1'.repeat(40);
const COMMIT_SHA = '2'.repeat(40);

function task(): TaskSpec {
  return {
    id: 'query',
    title: 'Query',
    owner: 'codex',
    effort: 'high',
    mode: 'implementation',
    files: ['apps/api/src/explorer/**'],
    dependsOn: [],
    writer: true,
  };
}

function state(root: string): RunState {
  return createRunState({
    runId: 'run-001',
    phase: 5,
    repositoryRoot: root,
    baseBranch: 'phase5/explorer',
    baseSha: BASE_SHA,
    tasks: [task()],
    clock: () => new Date('2026-08-21T10:00:00.000Z'),
  });
}

const COMPLETE_HANDOFF: StructuredHandoff = {
  status: 'complete',
  summary: 'complete',
  filesChanged: ['apps/api/src/explorer/query.ts'],
  decisions: [],
  tests: [],
  openQuestions: [],
  reviewRequested: [],
};

test('state writes are atomic, ordered, durable, and leave no temp files', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tripwith-state-'));
  try {
    const store = new StateStore(root, 'run-001');
    const initial = state(root);
    await store.initialize(initial);

    const running: RunState = { ...initial, status: 'RUNNING' };
    const blocked: RunState = { ...initial, status: 'BLOCKED' };
    await Promise.all([store.save(running), store.save(blocked)]);
    assert.equal((await store.load()).status, 'BLOCKED');
    assert.deepEqual(
      (await readdir(store.runDirectory)).filter((name) => name.includes('.tmp-')),
      [],
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('event JSONL preserves ordering and redacts secret-shaped fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tripwith-events-'));
  try {
    const store = new StateStore(root, 'run-001');
    await store.initialize(state(root));
    await Promise.all([
      store.appendEvent({
        name: 'RUN_CREATED',
        timestamp: '2026-08-21T10:00:00.000Z',
        runId: 'run-001',
        data: {
          apiToken: 'must-not-be-written',
          safe: 'visible',
          message: 'authorization=also-secret Bearer third-secret',
        },
      }),
      store.appendEvent({
        name: 'TASK_READY',
        timestamp: '2026-08-21T10:00:01.000Z',
        runId: 'run-001',
        taskId: 'query',
      }),
    ]);
    const lines = (await readFile(store.eventsPath, 'utf8')).trim().split('\n');
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[0] ?? '{}').data.apiToken, '[REDACTED]');
    assert.equal(JSON.parse(lines[0] ?? '{}').data.safe, 'visible');
    assert.equal(
      JSON.parse(lines[0] ?? '{}').data.message,
      'authorization=[REDACTED] Bearer [REDACTED]',
    );
    assert.equal(JSON.parse(lines[1] ?? '{}').taskId, 'query');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('corrupt state is rejected with STATE_CORRUPT', async () => {
  const root = await mkdtemp(join(tmpdir(), 'tripwith-corrupt-'));
  try {
    const store = new StateStore(root, 'run-001');
    await store.initialize(state(root));
    await writeFile(store.statePath, '{partial', 'utf8');
    await assert.rejects(
      store.load(),
      (error: unknown) => isOrchestratorError(error, 'STATE_CORRUPT'),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('resume accepts an owned committed task without rerunning it', () => {
  const initial = state('/repo');
  const running: RunState = {
    ...initial,
    status: 'RUNNING',
    tasks: {
      query: {
        ...initial.tasks.query!,
        status: 'RUNNING',
        agentAttempts: [
          {
            attempt: 1,
            agent: 'codex',
            startedAt: '2026-08-21T10:00:00.000Z',
            pid: 123,
          },
        ],
      },
    },
  };
  const result = reconcileInterruptedTasks(
    running,
    {
      query: {
        processAlive: false,
        ownershipValid: true,
        handoff: COMPLETE_HANDOFF,
        commit: {
          sha: COMMIT_SHA,
          parentSha: BASE_SHA,
          changedFiles: ['apps/api/src/explorer/query.ts'],
        },
      },
    },
    { agentRetries: 1, clock: () => new Date('2026-08-21T11:00:00.000Z') },
  );
  assert.equal(result.actions.query, 'RECOVERED_COMMIT');
  assert.equal(result.state.tasks.query?.status, 'SUCCEEDED');
  assert.equal(result.state.tasks.query?.commit?.sha, COMMIT_SHA);
});

test('resume retries process loss but blocks ambiguous committed work', () => {
  const initial = state('/repo');
  const running: RunState = {
    ...initial,
    status: 'RUNNING',
    tasks: {
      query: {
        ...initial.tasks.query!,
        status: 'RUNNING',
        agentAttempts: [
          {
            attempt: 1,
            agent: 'codex',
            startedAt: '2026-08-21T10:00:00.000Z',
          },
        ],
      },
    },
  };
  const retry = reconcileInterruptedTasks(
    running,
    { query: { processAlive: false } },
    { agentRetries: 1 },
  );
  assert.equal(retry.actions.query, 'RETRY_PROCESS_LOSS');
  assert.equal(retry.state.tasks.query?.status, 'READY');

  const ambiguous = reconcileInterruptedTasks(
    running,
    {
      query: {
        processAlive: false,
        handoff: COMPLETE_HANDOFF,
        commit: { sha: COMMIT_SHA, parentSha: BASE_SHA, changedFiles: [] },
      },
    },
    { agentRetries: 1 },
  );
  assert.equal(ambiguous.actions.query, 'BLOCKED_OWNERSHIP');
  assert.equal(ambiguous.state.status, 'BLOCKED');
});

test('resume refuses a moved base branch', () => {
  assert.doesNotThrow(() => assertResumeBaseUnmoved(BASE_SHA, BASE_SHA));
  assert.throws(
    () => assertResumeBaseUnmoved(BASE_SHA, COMMIT_SHA),
    (error: unknown) => isOrchestratorError(error, 'BASE_BRANCH_MOVED'),
  );
});
