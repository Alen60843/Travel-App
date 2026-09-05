import assert from 'node:assert/strict';
import test from 'node:test';

import { hashRecoveryPolicy, type RecoveryPolicyOverlay } from '../../src/recovery/policy';
import { validateRunState } from '../../src/state/run-state';

function baseRunState(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: 1,
    runId: 'run-20260101000000-aaaaaaaa',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    phase: 1,
    repositoryRoot: '/tmp/recovery-policy-fixture',
    baseBranch: 'main',
    baseSha: '0'.repeat(40),
    status: 'FAILED',
    tasks: {
      'task-one': {
        id: 'task-one', status: 'FAILED', agentAttempts: [], reviewRounds: 0, reviewPaths: [],
      },
    },
    integration: { status: 'PENDING', integratedTaskCommits: [] },
    errors: [],
    ...overrides,
  };
}

test('recoveryPolicyHistory is absent by default (undefined, not an empty array)', () => {
  const state = validateRunState(baseRunState());
  assert.equal(state.recoveryPolicyHistory, undefined);
});

test('one persisted recovery policy snapshot round-trips exactly', () => {
  const policy: RecoveryPolicyOverlay = { salvage: { verify: [{ command: 'true', required: true }] } };
  const snapshot = { authorizedAt: '2026-01-01T00:00:00.000Z', policyHash: hashRecoveryPolicy(policy), policy };
  const state = validateRunState(baseRunState({ recoveryPolicyHistory: [snapshot] }));
  assert.deepEqual(state.recoveryPolicyHistory, [snapshot]);
});

test('multiple snapshots are preserved in append order', () => {
  const first: RecoveryPolicyOverlay = { salvage: { verify: [{ command: 'true', required: true }] } };
  const second: RecoveryPolicyOverlay = {
    salvage: { verify: [{ command: 'true', required: true }, { command: 'echo second', required: true }] },
  };
  const snapshots = [
    { authorizedAt: '2026-01-01T00:00:00.000Z', policyHash: hashRecoveryPolicy(first), policy: first },
    { authorizedAt: '2026-01-02T00:00:00.000Z', policyHash: hashRecoveryPolicy(second), policy: second },
  ];
  const state = validateRunState(baseRunState({ recoveryPolicyHistory: snapshots }));
  assert.deepEqual(state.recoveryPolicyHistory, snapshots);
});

test('a malformed snapshot (bad policy shape) fails closed with STATE_CORRUPT', () => {
  assert.throws(
    () => validateRunState(baseRunState({
      recoveryPolicyHistory: [{ authorizedAt: '2026-01-01T00:00:00.000Z', policyHash: 'abc', policy: { bogus: true } }],
    })),
    (error: unknown) => (error as { code?: string }).code === 'STATE_CORRUPT',
  );
});

test('a snapshot missing policyHash fails closed with STATE_CORRUPT', () => {
  assert.throws(
    () => validateRunState(baseRunState({
      recoveryPolicyHistory: [{ authorizedAt: '2026-01-01T00:00:00.000Z', policy: {} }],
    })),
    (error: unknown) => (error as { code?: string }).code === 'STATE_CORRUPT',
  );
});
