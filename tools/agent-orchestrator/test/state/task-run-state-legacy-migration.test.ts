import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRunState } from '../../src/state/run-state';

function baseRunState(taskOverrides: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    runId: 'run-20260101000000-aaaaaaaa',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    phase: 1,
    repositoryRoot: '/tmp/legacy-migration-fixture',
    baseBranch: 'main',
    baseSha: '0'.repeat(40),
    status: 'FAILED',
    tasks: {
      'task-one': {
        id: 'task-one',
        status: 'FAILED',
        agentAttempts: [],
        reviewRounds: 0,
        reviewPaths: [],
        ...taskOverrides,
      },
    },
    integration: { status: 'PENDING', integratedTaskCommits: [] },
    errors: [],
  };
}

test('legacy handoffRepairAttempted=true/handoffRepairSucceeded=false migrates to one legacy_unknown failed attempt', () => {
  const state = validateRunState(baseRunState({
    handoffRepairAttempted: true,
    handoffRepairSucceeded: false,
  }));
  assert.deepEqual(state.tasks['task-one']!.handoffRepairAttempts, [
    { method: 'legacy_unknown', succeeded: false, failureReason: 'legacy_unknown' },
  ]);
});

test('legacy handoffRepairAttempted=true/handoffRepairSucceeded=true migrates to one legacy_unknown succeeded attempt', () => {
  const state = validateRunState(baseRunState({
    handoffRepairAttempted: true,
    handoffRepairSucceeded: true,
  }));
  assert.deepEqual(state.tasks['task-one']!.handoffRepairAttempts, [
    { method: 'legacy_unknown', succeeded: true },
  ]);
});

test('absent legacy fields and absent handoffRepairAttempts both normalize to an empty array', () => {
  const state = validateRunState(baseRunState({}));
  assert.deepEqual(state.tasks['task-one']!.handoffRepairAttempts, []);
});

test('native handoffRepairAttempts array round-trips unchanged', () => {
  const native = [{
    method: 'agent',
    succeeded: false,
    failureReason: 'agent_invocation_failed',
    timestamp: '2026-01-01T00:00:00.000Z',
  }];
  const state = validateRunState(baseRunState({ handoffRepairAttempts: native }));
  assert.deepEqual(state.tasks['task-one']!.handoffRepairAttempts, native);
});

test('handoffRepairAttempted=false (never true) migrates to an empty array, not a record', () => {
  const state = validateRunState(baseRunState({
    handoffRepairAttempted: false,
  }));
  assert.deepEqual(state.tasks['task-one']!.handoffRepairAttempts, []);
});
