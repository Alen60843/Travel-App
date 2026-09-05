import assert from 'node:assert/strict';
import test from 'node:test';

import { isOrchestratorError } from '../../src/errors';
import {
  canonicalizeRecoveryPolicy,
  hashRecoveryPolicy,
  parseRecoveryPolicyOverlay,
} from '../../src/recovery/policy';

test('an empty overlay parses to an object with no salvage/executors', () => {
  const overlay = parseRecoveryPolicyOverlay({});
  assert.deepEqual(overlay, {});
});

test('salvage.verify parses using the same shape/defaults as integration commands', () => {
  const overlay = parseRecoveryPolicyOverlay({
    salvage: { verify: [{ command: 'echo verify', required: true, timeoutMs: 1000 }] },
  });
  assert.deepEqual(overlay.salvage, { verify: [{ command: 'echo verify', required: true, timeoutMs: 1000 }] });
});

test('salvage.verify commands default required to true', () => {
  const overlay = parseRecoveryPolicyOverlay({ salvage: { verify: ['node --version'] } });
  assert.equal(overlay.salvage?.verify[0]?.required, true);
});

test('executors parse id/adapter/roles/capabilities/model/available', () => {
  const overlay = parseRecoveryPolicyOverlay({
    executors: [{
      id: 'metadata-repairer',
      adapter: 'claude',
      roles: ['handoff_repair'],
      capabilities: [{ capability: 'handoff_repair', minimumLevel: 1 }],
      model: 'sonnet',
      available: true,
    }],
  });
  assert.deepEqual(overlay.executors, [{
    id: 'metadata-repairer',
    adapter: 'claude',
    roles: ['handoff_repair'],
    capabilities: [{ capability: 'handoff_repair', minimumLevel: 1 }],
    model: 'sonnet',
    available: true,
  }]);
});

test('an executor capability without minimumLevel omits the field rather than defaulting it', () => {
  const overlay = parseRecoveryPolicyOverlay({
    executors: [{
      id: 'metadata-repairer', adapter: 'claude', roles: ['handoff_repair'],
      capabilities: [{ capability: 'handoff_repair' }], available: true,
    }],
  });
  assert.deepEqual(overlay.executors?.[0]?.capabilities, [{ capability: 'handoff_repair' }]);
});

test('an unknown top-level key is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ ownership: ['**'] }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an unknown executor key is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({
      executors: [{ id: 'x', adapter: 'claude', roles: ['handoff_repair'], available: true, dependsOn: [] }],
    }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an executor adapter outside codex/claude is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({
      executors: [{ id: 'x', adapter: 'gemini', roles: ['handoff_repair'], available: true }],
    }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an executor role outside the recovery role vocabulary is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({
      executors: [{ id: 'x', adapter: 'claude', roles: ['implementation'], available: true }],
    }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an executor missing available is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({
      executors: [{ id: 'x', adapter: 'claude', roles: ['handoff_repair'] }],
    }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('canonicalization is stable regardless of top-level or object key order', () => {
  const a = parseRecoveryPolicyOverlay({
    salvage: { verify: [{ command: 'true', required: true }] },
    executors: [{ id: 'x', adapter: 'claude', roles: ['handoff_repair'], capabilities: [], available: true }],
  });
  const b = parseRecoveryPolicyOverlay({
    executors: [{ available: true, roles: ['handoff_repair'], adapter: 'claude', id: 'x', capabilities: [] }],
    salvage: { verify: [{ required: true, command: 'true' }] },
  });
  assert.equal(canonicalizeRecoveryPolicy(a), canonicalizeRecoveryPolicy(b));
  assert.equal(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
});

test('canonicalization is NOT stable across a reordered verify command list — command order is semantically significant', () => {
  const a = parseRecoveryPolicyOverlay({ salvage: { verify: ['first', 'second'] } });
  const b = parseRecoveryPolicyOverlay({ salvage: { verify: ['second', 'first'] } });
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
});

test('hashRecoveryPolicy is deterministic and content-sensitive', () => {
  const a = parseRecoveryPolicyOverlay({ salvage: { verify: ['true'] } });
  const b = parseRecoveryPolicyOverlay({ salvage: { verify: ['true'] } });
  const c = parseRecoveryPolicyOverlay({ salvage: { verify: ['false'] } });
  assert.equal(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(c));
  assert.match(hashRecoveryPolicy(a), /^[0-9a-f]{64}$/);
});

// --- handoffRepair.additionalAttempts (audited repair-budget extension) ---

test('handoffRepair.additionalAttempts parses as a plain integer', () => {
  const overlay = parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 1 } });
  assert.deepEqual(overlay.handoffRepair, { additionalAttempts: 1 });
});

test('handoffRepair.additionalAttempts of 0 is valid (an explicit no-op extension)', () => {
  const overlay = parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 0 } });
  assert.deepEqual(overlay.handoffRepair, { additionalAttempts: 0 });
});

test('a negative additionalAttempts is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: -1 } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('a non-integer (floating point) additionalAttempts is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 1.5 } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('a NaN additionalAttempts is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: Number.NaN } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an unreasonably large additionalAttempts is rejected (bounded maximum)', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 1_000_000 } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an unknown handoffRepair key is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 1, unlimited: true } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('handoffRepair.additionalAttempts participates in the semantic policy hash', () => {
  const a = parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 1 } });
  const b = parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 2 } });
  const withoutOverlay = parseRecoveryPolicyOverlay({});
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(withoutOverlay));
});

test('handoffRepair.additionalAttempts hashes identically regardless of surrounding key order', () => {
  const a = parseRecoveryPolicyOverlay({
    salvage: { verify: [] },
    handoffRepair: { additionalAttempts: 1 },
    executors: [],
  });
  const b = parseRecoveryPolicyOverlay({
    executors: [],
    handoffRepair: { additionalAttempts: 1 },
    salvage: { verify: [] },
  });
  assert.equal(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
});
