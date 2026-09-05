import assert from 'node:assert/strict';
import test from 'node:test';

import type { PhaseConfig } from '../../src/config';
import { isOrchestratorError } from '../../src/errors';
import {
  applyRecoveryPolicyOverlay,
  canonicalizeRecoveryPolicy,
  hashRecoveryPolicy,
  parseRecoveryPolicyOverlay,
} from '../../src/recovery/policy';

function baseConfig(overrides: Partial<PhaseConfig> = {}): PhaseConfig {
  return {
    phase: 'test', name: 'test', baseBranch: 'main', canonicalDesignDocument: 'design.md',
    concurrency: 1, maxReviewRounds: 3, agentRetries: 0, agentTimeoutMs: 60000,
    agentWorktree: { prepare: [] },
    tasks: [],
    integration: { prepare: [{ command: 'pnpm install --frozen-lockfile', required: true }], commands: [], diagnostics: [] },
    maxHandoffRepairAttempts: 2,
    salvage: { verify: [] },
    ...overrides,
  };
}

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

// --- recoveryBudget.maxWallClockMs (recovery execution budget epoch) ---

test('recoveryBudget.maxWallClockMs parses successfully', () => {
  const overlay = parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: 3_600_000 } });
  assert.deepEqual(overlay.recoveryBudget, { maxWallClockMs: 3_600_000 });
});

test('a zero recoveryBudget.maxWallClockMs is rejected (must be strictly positive)', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: 0 } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('a negative recoveryBudget.maxWallClockMs is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: -1 } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('a non-integer (floating point) recoveryBudget.maxWallClockMs is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: 1.5 } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('a NaN recoveryBudget.maxWallClockMs is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: Number.NaN } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an unreasonably large recoveryBudget.maxWallClockMs is rejected (bounded maximum)', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: 365 * 24 * 60 * 60 * 1000 } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an unknown recoveryBudget key is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: 3_600_000, resetOriginalBudget: true } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('recoveryBudget.maxWallClockMs participates in the semantic policy hash', () => {
  const a = parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: 3_600_000 } });
  const b = parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: 7_200_000 } });
  const withoutOverlay = parseRecoveryPolicyOverlay({});
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(withoutOverlay));
});

test('recoveryBudget.maxWallClockMs hashes identically regardless of surrounding key order/formatting', () => {
  const a = parseRecoveryPolicyOverlay({
    salvage: { verify: [] },
    recoveryBudget: { maxWallClockMs: 3_600_000 },
    handoffRepair: { additionalAttempts: 1 },
  });
  const b = parseRecoveryPolicyOverlay({
    handoffRepair: { additionalAttempts: 1 },
    recoveryBudget: { maxWallClockMs: 3_600_000 },
    salvage: { verify: [] },
  });
  assert.equal(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
});

test('no recoveryBudget field preserves current behavior (absent, not defaulted)', () => {
  const overlay = parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 1 } });
  assert.equal(overlay.recoveryBudget, undefined);
});

// --- integrationRecovery.prepare (integration recovery preparation overlay) ---

test('integrationRecovery.prepare parses using the same shape/defaults as other integration commands', () => {
  const overlay = parseRecoveryPolicyOverlay({
    integrationRecovery: {
      prepare: [
        { command: 'pnpm install --frozen-lockfile', required: true, timeoutMs: 900000 },
        { command: 'pnpm --filter @tripwith/shared build', required: true, timeoutMs: 300000 },
      ],
    },
  });
  assert.deepEqual(overlay.integrationRecovery, {
    prepare: [
      { command: 'pnpm install --frozen-lockfile', required: true, timeoutMs: 900000 },
      { command: 'pnpm --filter @tripwith/shared build', required: true, timeoutMs: 300000 },
    ],
  });
});

test('integrationRecovery.prepare commands default required to true', () => {
  const overlay = parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: ['pnpm install'] } });
  assert.equal(overlay.integrationRecovery?.prepare[0]?.required, true);
});

test('a malformed integrationRecovery.prepare command fails closed', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: [{ command: '' }] } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('integrationRecovery.prepare must be an array', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: 'pnpm install' } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an unknown integrationRecovery key is rejected', () => {
  assert.throws(
    () => parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: ['pnpm install'], commands: ['pnpm build'] } }),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('integrationRecovery.prepare participates in the semantic policy hash', () => {
  const a = parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: ['pnpm install', 'pnpm --filter @tripwith/shared build'] } });
  const b = parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: ['pnpm install', 'pnpm --filter @tripwith/shared test'] } });
  const withoutOverlay = parseRecoveryPolicyOverlay({});
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(withoutOverlay));
});

test('integrationRecovery.prepare order is semantically significant for the hash', () => {
  const a = parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: ['pnpm install', 'pnpm --filter @tripwith/shared build'] } });
  const b = parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: ['pnpm --filter @tripwith/shared build', 'pnpm install'] } });
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
});

test('integrationRecovery.prepare timeout changes the hash', () => {
  const a = parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: [{ command: 'pnpm install', required: true, timeoutMs: 900000 }] } });
  const b = parseRecoveryPolicyOverlay({ integrationRecovery: { prepare: [{ command: 'pnpm install', required: true, timeoutMs: 60000 }] } });
  assert.notEqual(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
});

test('integrationRecovery.prepare hashes identically regardless of surrounding key order/formatting', () => {
  const a = parseRecoveryPolicyOverlay({
    salvage: { verify: [] },
    integrationRecovery: { prepare: [{ command: 'pnpm install', required: true, timeoutMs: 900000 }] },
    handoffRepair: { additionalAttempts: 1 },
  });
  const b = parseRecoveryPolicyOverlay({
    handoffRepair: { additionalAttempts: 1 },
    integrationRecovery: { prepare: [{ timeoutMs: 900000, command: 'pnpm install', required: true }] },
    salvage: { verify: [] },
  });
  assert.equal(hashRecoveryPolicy(a), hashRecoveryPolicy(b));
});

test('no integrationRecovery field preserves current behavior (absent, not defaulted)', () => {
  const overlay = parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 1 } });
  assert.equal(overlay.integrationRecovery, undefined);
});

// --- applyRecoveryPolicyOverlay: the single effective-config implementation ---

test('A: an integrationRecovery.prepare with two commands is fully present in the effective config', () => {
  const overlay = parseRecoveryPolicyOverlay({
    integrationRecovery: { prepare: ['pnpm install --frozen-lockfile', 'pnpm --filter @tripwith/shared build'] },
  });
  const base = baseConfig();
  const effective = applyRecoveryPolicyOverlay(base, overlay);
  assert.deepEqual(effective.integration.prepare.map((c) => c.command), [
    'pnpm install --frozen-lockfile', 'pnpm --filter @tripwith/shared build',
  ]);
  // Only `prepare` is replaced — the historical deterministic commands/diagnostics are untouched.
  assert.equal(effective.integration.commands, base.integration.commands);
});

test('D: a salvage override survives being applied on top of an unrelated base config change', () => {
  const overlay = parseRecoveryPolicyOverlay({ salvage: { verify: ['pnpm test'] } });
  const effective = applyRecoveryPolicyOverlay(baseConfig({ concurrency: 4 }), overlay);
  assert.deepEqual(effective.salvage.verify.map((c) => c.command), ['pnpm test']);
  assert.equal(effective.concurrency, 4, 'unrelated base fields pass through unchanged');
});

test('applyRecoveryPolicyOverlay: no policy returns the base config unchanged (identity)', () => {
  const base = baseConfig();
  assert.equal(applyRecoveryPolicyOverlay(base, undefined), base);
});

test('applyRecoveryPolicyOverlay: handoffRepair.additionalAttempts is always computed from the given base, proving repeated application never stacks', () => {
  const overlay = parseRecoveryPolicyOverlay({ handoffRepair: { additionalAttempts: 1 } });
  const base = baseConfig({ maxHandoffRepairAttempts: 2 });
  const first = applyRecoveryPolicyOverlay(base, overlay);
  assert.equal(first.maxHandoffRepairAttempts, 3);
  // Applying the SAME overlay again to the SAME fresh base (exactly what a
  // correct caller does on every scheduling pass) yields the identical
  // effective value — never 4, 5, 6...
  const second = applyRecoveryPolicyOverlay(base, overlay);
  assert.equal(second.maxHandoffRepairAttempts, 3);
  // Misuse — applying the overlay to an ALREADY-overlaid config — is
  // exactly the bug this discipline exists to prevent; documented here so
  // the failure mode is explicit, not applied anywhere in production code.
  const misused = applyRecoveryPolicyOverlay(first, overlay);
  assert.equal(misused.maxHandoffRepairAttempts, 4, 'misuse stacks — this is why every real caller must pass a FRESH base');
});

test('applyRecoveryPolicyOverlay: recoveryBudget is never copied into PhaseConfig (it governs adaptive epoch state only)', () => {
  const overlay = parseRecoveryPolicyOverlay({ recoveryBudget: { maxWallClockMs: 3_600_000 } });
  const effective = applyRecoveryPolicyOverlay(baseConfig(), overlay);
  assert.deepEqual(effective, baseConfig(), 'recoveryBudget alone produces no PhaseConfig change whatsoever');
});

test('applyRecoveryPolicyOverlay: all three PhaseConfig-affecting fields apply together, independently', () => {
  const overlay = parseRecoveryPolicyOverlay({
    salvage: { verify: ['pnpm test'] },
    handoffRepair: { additionalAttempts: 2 },
    integrationRecovery: { prepare: ['pnpm install', 'pnpm --filter @tripwith/shared build'] },
    recoveryBudget: { maxWallClockMs: 3_600_000 },
  });
  const effective = applyRecoveryPolicyOverlay(baseConfig({ maxHandoffRepairAttempts: 2 }), overlay);
  assert.deepEqual(effective.salvage.verify.map((c) => c.command), ['pnpm test']);
  assert.equal(effective.maxHandoffRepairAttempts, 4);
  assert.deepEqual(effective.integration.prepare.map((c) => c.command), ['pnpm install', 'pnpm --filter @tripwith/shared build']);
});
