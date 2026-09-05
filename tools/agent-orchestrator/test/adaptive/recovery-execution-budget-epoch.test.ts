import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AdaptiveCoordinator,
  StaticCapabilityCatalog,
  parseAdaptiveRunState,
  type AdaptivePolicy,
  type Clock,
  type WorkRequestDraft,
} from '../../src/adaptive';
import { isOrchestratorError } from '../../src/errors';

/**
 * The Recovery Execution Budget Epoch: an operator-authorized, explicitly
 * bounded wall-clock budget for work causally associated with an
 * explicitly recovered task/canonical finding — never a blanket reset of
 * the original run's own wall-clock budget or any other limit. These tests
 * exercise AdaptiveCoordinator.authorizeRecoveryEpoch directly (a bare
 * coordinator, no orchestrator, no TaskRunState) so the wall-clock/decision
 * mechanics are proven precisely and fast; the orchestrator-level
 * provenance wiring (recoveryScopedReverificationRequestIds) and the real
 * dogfood-shaped topology are covered separately in
 * test/workflow/recovery-execution-budget-epoch-acceptance.test.ts.
 */

class MutableClock implements Clock {
  constructor(private value: Date = new Date('2026-09-04T00:00:00.000Z')) {}
  now(): Date { return new Date(this.value); }
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

function policy(overrides: Partial<AdaptivePolicy['limits']> = {}): AdaptivePolicy {
  return {
    allowedConcerns: ['review', 'implementation'],
    allowedOwnership: ['src/**'],
    allowedResources: [],
    limits: {
      maxConcurrentAgents: 4,
      maxAgentInvocations: 20,
      maxTotalWorkUnits: 30,
      maxDecompositionDepth: 3,
      maxFanOutPerWorkUnit: 8,
      maxSynthesisInputs: 4,
      maxWallClockMs: 3_600_000,
      ...overrides,
    },
    requireEvidenceForExpansion: true,
    agingIntervalMs: 1_000,
    agingStep: 10,
    humanApprovalRisks: [],
  };
}

function draft(options: Partial<WorkRequestDraft> = {}): WorkRequestDraft {
  return {
    role: 'review',
    concern: 'review',
    objective: 'Re-verify a canonical finding',
    reason: 'targeted re-verification',
    dependencies: [],
    capabilities: [{ capability: 'review' }],
    resourceClaims: [{ kind: 'repository_path', key: 'src/feature.ts', mode: 'read' }],
    evidence: [{ kind: 'finding', reference: 'F001', summary: 'canonical finding' }],
    risk: 'low',
    priority: 50,
    ...options,
  };
}

function coordinator(limits: Partial<AdaptivePolicy['limits']> = {}, clock: Clock = new MutableClock()): AdaptiveCoordinator {
  return AdaptiveCoordinator.create('Recovery execution budget epoch test', policy(limits), clock);
}

/** grantDecisions is append-only and ordered oldest-first — a plain .find() would return the FIRST (possibly stale) decision for a re-arbitrated request. */
function latestDecisionFor(subject: AdaptiveCoordinator, requestId: string) {
  return [...subject.snapshot().grantDecisions].reverse().find((d) => d.requestId === requestId);
}

/** The currently active recovery epoch's own record. */
function activeEpoch(subject: AdaptiveCoordinator) {
  const state = subject.snapshot();
  return state.recoveryEpochs?.find((epoch) => epoch.number === state.activeRecoveryEpochNumber);
}

const EPOCH_POLICY_HASH_A = 'a'.repeat(64);
const EPOCH_POLICY_HASH_B = 'b'.repeat(64);

// --- §21: original vs recovery budget ---

test('original vs recovery budget: a recovery-generated request denied by the exhausted original budget becomes eligible after an authorized recovery epoch', () => {
  const clock = new MutableClock();
  const subject = coordinator({ maxWallClockMs: 3_600_000 }, clock);
  const request = subject.submit(draft());

  // Original run age: 20 hours — well past the original 1-hour budget.
  clock.advance(20 * 60 * 60 * 1000);
  const firstDecisions = subject.arbitrate();
  assert.equal(firstDecisions.find((d) => d.requestId === request.id)?.outcome, 'DENIED');
  assert.equal(firstDecisions.find((d) => d.requestId === request.id)?.reason, 'WALL_CLOCK_BUDGET_EXCEEDED');
  assert.equal(subject.snapshot().workUnits.find((u) => u.requestId === request.id), undefined);

  // Authorize a 1-hour recovery epoch right now (age within the epoch: 0).
  const epochDecisions = subject.authorizeRecoveryEpoch({
    policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [request.id],
  });
  assert.equal(epochDecisions.length, 1);
  assert.equal(epochDecisions[0]?.outcome, 'GRANTED');
  assert.equal(subject.snapshot().workUnits.find((u) => u.requestId === request.id)?.status, 'GRANTED');

  // 5 minutes into the recovery epoch, the request remains eligible/stable.
  clock.advance(5 * 60 * 1000);
  const normalArbitrate = subject.arbitrate();
  assert.deepEqual(normalArbitrate, [], 'an already-GRANTED unit is not re-evaluated by ordinary arbitration');
});

// --- §22: append-only re-arbitration ---

test('append-only re-arbitration: the original DENIED decision is never rewritten, a new decision is appended, no duplicate request/unit', () => {
  const clock = new MutableClock();
  const subject = coordinator({ maxWallClockMs: 1_000 }, clock);
  const request = subject.submit(draft());
  clock.advance(2_000);
  subject.arbitrate();
  const decision1 = subject.snapshot().grantDecisions.find((d) => d.requestId === request.id)!;
  assert.equal(decision1.outcome, 'DENIED');
  assert.equal(decision1.reason, 'WALL_CLOCK_BUDGET_EXCEEDED');

  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [request.id] });

  const after = subject.snapshot();
  const decisionsForRequest = after.grantDecisions.filter((d) => d.requestId === request.id);
  assert.equal(decisionsForRequest.length, 2, 'decision 1 remains, decision 2 is appended');
  assert.deepEqual(decisionsForRequest[0], decision1, 'the original DENIED decision is byte-for-byte unchanged');
  assert.equal(decisionsForRequest[1]?.outcome, 'GRANTED');
  assert.equal(decisionsForRequest[1]?.recoveryEpochNumber, 1);
  assert.equal(after.workRequests.filter((r) => r.id === request.id).length, 1, 'request identity is not duplicated');
  assert.equal(after.workRequests.length, 1, 'no duplicate WorkRequest was created');
  assert.equal(after.workUnits.filter((u) => u.requestId === request.id).length, 1, 'exactly one work unit');
});

// --- §23: other denials stay denied ---

test('other denials stay denied: ownership/dependency/capability/policy denials are never reopened by recovery-budget authorization', () => {
  const clock = new MutableClock();
  // A catalog that only ever satisfies the 'review' capability, so a
  // request asking for an unprovisioned capability genuinely fails
  // eligibility (the default AVAILABLE_CATALOG used elsewhere in this file
  // treats every capability as available, which would never exercise
  // NO_CAPABLE_PROVIDER).
  const catalog = new StaticCapabilityCatalog([
    { executorId: 'reviewer', roles: ['review'], capabilities: [{ capability: 'review' }], available: true },
  ]);
  const subject = new AdaptiveCoordinator(AdaptiveCoordinator.create('Recovery execution budget epoch test', policy({ maxWallClockMs: 1_000 }), clock).snapshot(), catalog, clock);

  const ownershipDenied = subject.submit(draft({
    resourceClaims: [{ kind: 'repository_path', key: 'outside/scope.ts', mode: 'write' }],
  }));
  const missingDependency = subject.submit(draft({ dependencies: ['request-999999'] }));
  const capabilityDenied = subject.submit(draft({ capabilities: [{ capability: 'nonexistent_capability' }] }));
  const wallClockDenied = subject.submit(draft());

  clock.advance(2_000);
  subject.arbitrate();
  const before = subject.snapshot();
  assert.equal(before.grantDecisions.find((d) => d.requestId === ownershipDenied.id)?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
  assert.equal(before.grantDecisions.find((d) => d.requestId === missingDependency.id)?.reason, 'INVALID_DEPENDENCY');
  assert.equal(before.grantDecisions.find((d) => d.requestId === capabilityDenied.id)?.reason, 'NO_CAPABLE_PROVIDER');
  assert.equal(before.grantDecisions.find((d) => d.requestId === wallClockDenied.id)?.reason, 'WALL_CLOCK_BUDGET_EXCEEDED');

  // Authorize a recovery epoch scoped ONLY to the wall-clock-denied request
  // — the narrow-scope contract itself.
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [wallClockDenied.id] });
  const afterNarrow = subject.snapshot();
  assert.equal(afterNarrow.grantDecisions.filter((d) => d.requestId === ownershipDenied.id).length, 1, 'ownership denial untouched');
  assert.equal(afterNarrow.grantDecisions.filter((d) => d.requestId === missingDependency.id).length, 1, 'dependency denial untouched');
  assert.equal(afterNarrow.grantDecisions.filter((d) => d.requestId === capabilityDenied.id).length, 1, 'capability denial untouched');

  // Defense in depth: even if a caller mistakenly included a non-wall-clock
  // DENIED request in requestIds, the coordinator itself refuses to
  // reconsider it (only WALL_CLOCK_BUDGET_EXCEEDED denials qualify).
  subject.authorizeRecoveryEpoch({
    policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000,
    requestIds: [wallClockDenied.id, ownershipDenied.id, missingDependency.id, capabilityDenied.id],
  });
  const afterDefensive = subject.snapshot();
  assert.equal(afterDefensive.grantDecisions.filter((d) => d.requestId === ownershipDenied.id).length, 1, 'still untouched');
  assert.equal(afterDefensive.grantDecisions.filter((d) => d.requestId === missingDependency.id).length, 1, 'still untouched');
  assert.equal(afterDefensive.grantDecisions.filter((d) => d.requestId === capabilityDenied.id).length, 1, 'still untouched');
});

// --- §24: other limits still apply ---

test('other limits still apply: a fresh recovery wall-clock budget does not bypass maxTotalWorkUnits/maxAgentInvocations', () => {
  const clock = new MutableClock();
  const subject = coordinator({ maxWallClockMs: 1_000, maxConcurrentAgents: 2, maxAgentInvocations: 2, maxTotalWorkUnits: 2 }, clock);

  // Three requests, all originally denied for wall-clock ONLY — at this
  // single arbitration pass none of them ever gets granted, so
  // maxTotalWorkUnits/maxAgentInvocations stay at 0 throughout it.
  const first = subject.submit(draft({ objective: 'Recovery-scoped work A', resourceClaims: [{ kind: 'repository_path', key: 'src/a.ts', mode: 'write' }] }));
  const second = subject.submit(draft({ objective: 'Recovery-scoped work B', resourceClaims: [{ kind: 'repository_path', key: 'src/b.ts', mode: 'write' }] }));
  const third = subject.submit(draft({ objective: 'Recovery-scoped work C', resourceClaims: [{ kind: 'repository_path', key: 'src/c.ts', mode: 'write' }] }));
  clock.advance(2_000);
  subject.arbitrate();
  for (const request of [first, second, third]) {
    assert.equal(subject.snapshot().grantDecisions.find((d) => d.requestId === request.id)?.reason, 'WALL_CLOCK_BUDGET_EXCEEDED');
  }

  // Authorize the epoch for the first two — they consume the entire
  // maxTotalWorkUnits(2)/maxAgentInvocations(2) budget, which is a GLOBAL,
  // cumulative counter shared with every other request, recovery-scoped or not.
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first.id, second.id] });
  assert.equal(subject.snapshot().workUnits.filter((u) => u.status === 'GRANTED').length, 2);
  assert.equal(latestDecisionFor(subject, first.id)?.outcome, 'GRANTED');
  assert.equal(latestDecisionFor(subject, second.id)?.outcome, 'GRANTED');

  // Scoping the third request under the SAME (already-active) epoch reuses
  // it (no clock reset) but a fresh recovery wall-clock budget still does
  // not manufacture free work-unit/agent-invocation budget — it is denied
  // for a different, independently-enforced, never-bypassed reason.
  const epochDecisions = subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [third.id] });
  assert.equal(epochDecisions.length, 1);
  assert.equal(epochDecisions[0]?.outcome, 'DENIED');
  assert.equal(epochDecisions[0]?.reason, 'MAX_TOTAL_WORK_UNITS');
  assert.equal(subject.snapshot().workUnits.find((u) => u.requestId === third.id), undefined);
});

test('other limits still apply: concurrency exhaustion still yields WAITING under an active recovery epoch, not an automatic grant', () => {
  const clock = new MutableClock();
  const subject = coordinator({ maxWallClockMs: 1_000, maxConcurrentAgents: 1 }, clock);
  const active = subject.submit(draft({ objective: 'Active concurrent work', resourceClaims: [{ kind: 'repository_path', key: 'src/other.ts', mode: 'write' }] }));
  subject.arbitrate();
  const activeUnit = subject.snapshot().workUnits.find((u) => u.requestId === active.id)!;
  assert.equal(activeUnit.status, 'GRANTED');

  const recoveryScoped = subject.submit(draft());
  clock.advance(2_000);
  subject.arbitrate();
  assert.equal(subject.snapshot().grantDecisions.find((d) => d.requestId === recoveryScoped.id)?.reason, 'WALL_CLOCK_BUDGET_EXCEEDED');

  const epochDecisions = subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [recoveryScoped.id] });
  assert.equal(epochDecisions[0]?.outcome, 'WAITING', 'concurrency is still full, so the epoch admits WAITING, never a forced GRANT');
  assert.equal(epochDecisions[0]?.reason, 'GLOBAL_CONCURRENCY_LIMIT');

  // Normal scheduling later frees the slot and the WAITING request is then granted.
  subject.finish(activeUnit.id, 'SUCCEEDED');
  const laterDecisions = subject.arbitrate();
  assert.equal(laterDecisions.find((d) => d.requestId === recoveryScoped.id)?.outcome, 'GRANTED');
});

// --- §25: idempotency ---

test('idempotency: reauthorizing the same semantic policy does not reset the clock, grant extra budget, or duplicate anything', () => {
  const clock = new MutableClock();
  const subject = coordinator({ maxWallClockMs: 1_000 }, clock);
  const request = subject.submit(draft());
  clock.advance(2_000);
  subject.arbitrate();

  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [request.id] });
  const epoch1 = activeEpoch(subject)!;
  assert.equal(epoch1.number, 1);
  const decisionsAfterFirst = subject.snapshot().grantDecisions.filter((d) => d.requestId === request.id);
  assert.equal(decisionsAfterFirst.length, 2);
  const unitsAfterFirst = subject.snapshot().workUnits.length;

  // Advance time and reauthorize the exact same semantic policy.
  clock.advance(10 * 60 * 1000);
  const secondDecisions = subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [request.id] });
  const epoch2 = activeEpoch(subject)!;
  assert.equal(epoch2.number, epoch1.number, 'no new epoch number');
  assert.equal(epoch2.startedAt, epoch1.startedAt, 'no fresh clock reset');
  assert.equal(epoch2.maxWallClockMs, epoch1.maxWallClockMs, 'no extra budget');
  assert.deepEqual(secondDecisions, [], 'no duplicate re-arbitration decision — the request is already resolved');
  assert.equal(subject.snapshot().grantDecisions.filter((d) => d.requestId === request.id).length, 2, 'still exactly 2 decisions');
  assert.equal(subject.snapshot().workUnits.length, unitsAfterFirst, 'no duplicate work unit');
});

test('idempotency: a genuinely different policy hash creates the next epoch with a fresh clock', () => {
  const clock = new MutableClock();
  const subject = coordinator({ maxWallClockMs: 1_000 }, clock);
  const request = subject.submit(draft());
  clock.advance(2_000);
  subject.arbitrate();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [request.id] });
  const epoch1 = activeEpoch(subject)!;

  clock.advance(10 * 60 * 1000);
  const second = subject.submit(draft({ objective: 'A second, later recovery-scoped request' }));
  clock.advance(2_000);
  subject.arbitrate();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_B, maxWallClockMs: 7_200_000, requestIds: [second.id] });
  const epoch2 = activeEpoch(subject)!;
  assert.equal(epoch2.number, epoch1.number + 1, 'a distinct semantic policy authorizes the next epoch');
  assert.notEqual(epoch2.startedAt, epoch1.startedAt, 'the new epoch gets its own fresh start');
  assert.equal(epoch2.maxWallClockMs, 7_200_000);
});

// --- Multi-epoch history: two epochs, historical GrantDecision validation ---

function twoRequestCoordinator(): { subject: AdaptiveCoordinator; clock: MutableClock; first: string; second: string } {
  const clock = new MutableClock();
  const subject = coordinator({ maxWallClockMs: 1_000 }, clock);
  const first = subject.submit(draft({ objective: 'First recovery-scoped request' }));
  const second = subject.submit(draft({ objective: 'Second recovery-scoped request', resourceClaims: [{ kind: 'repository_path', key: 'src/other.ts', mode: 'read' }] }));
  clock.advance(2_000);
  subject.arbitrate();
  return { subject, clock, first: first.id, second: second.id };
}

test('multi-epoch: Epoch 1 remains valid and untouched after Epoch 2 is authorized for a different request', () => {
  const { subject, clock, first, second } = twoRequestCoordinator();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first] });
  const epoch1Before = activeEpoch(subject)!;
  const decisionsBefore = subject.snapshot().grantDecisions.filter((d) => d.requestId === first);

  clock.advance(60_000);
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_B, maxWallClockMs: 7_200_000, requestIds: [second] });

  const after = subject.snapshot();
  const epoch1After = after.recoveryEpochs!.find((e) => e.number === 1)!;
  assert.deepEqual(epoch1After, epoch1Before, 'Epoch 1 is byte-for-byte unchanged');
  assert.deepEqual(after.grantDecisions.filter((d) => d.requestId === first), decisionsBefore, 'Epoch 1 decisions are unchanged, no duplicates');
  assert.equal(after.recoveryEpochs!.length, 2);
  assert.equal(after.activeRecoveryEpochNumber, 2);
  // A request already claimed by Epoch 1 is never migrated into Epoch 2's
  // scope, even though it would still be recomputed as eligible.
  assert.ok(!after.recoveryEpochs!.find((e) => e.number === 2)!.requestIds.includes(first));

  // Round-tripping through parseAdaptiveRunState (exactly what a real
  // resume() does) must never raise STATE_CORRUPT.
  assert.doesNotThrow(() => parseAdaptiveRunState(JSON.parse(JSON.stringify(after))));
});

// --- §11: validation failures ---

test('validation A: a GrantDecision referencing a nonexistent epoch fails closed', () => {
  const { subject, first } = twoRequestCoordinator();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first] });
  const corrupted = JSON.parse(JSON.stringify(subject.snapshot()));
  const decision = corrupted.grantDecisions.find((d: { requestId: string }) => d.requestId === first);
  decision.recoveryEpochNumber = 99;
  assert.throws(
    () => parseAdaptiveRunState(corrupted),
    (error: unknown) => isOrchestratorError(error, 'STATE_CORRUPT'),
  );
});

test('validation B: a GrantDecision referencing an epoch where the requestId was never in scope fails closed', () => {
  const { subject, clock, first, second } = twoRequestCoordinator();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first] });
  clock.advance(60_000);
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_B, maxWallClockMs: 7_200_000, requestIds: [second] });
  const corrupted = JSON.parse(JSON.stringify(subject.snapshot()));
  // Forge a decision claiming `second` belongs to Epoch 1 — it never did.
  const secondDecision = [...corrupted.grantDecisions].reverse().find((d: { requestId: string }) => d.requestId === second);
  secondDecision.recoveryEpochNumber = 1;
  assert.throws(
    () => parseAdaptiveRunState(corrupted),
    (error: unknown) => isOrchestratorError(error, 'STATE_CORRUPT'),
  );
});

test('validation C: duplicate epoch numbers fail closed', () => {
  const { subject, first } = twoRequestCoordinator();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first] });
  const corrupted = JSON.parse(JSON.stringify(subject.snapshot()));
  corrupted.recoveryEpochs.push({ ...corrupted.recoveryEpochs[0], requestIds: [] });
  assert.throws(
    () => parseAdaptiveRunState(corrupted),
    (error: unknown) => isOrchestratorError(error, 'STATE_CORRUPT'),
  );
});

test('validation D: activeRecoveryEpochNumber referencing a nonexistent epoch fails closed', () => {
  const { subject, first } = twoRequestCoordinator();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first] });
  const corrupted = JSON.parse(JSON.stringify(subject.snapshot()));
  corrupted.activeRecoveryEpochNumber = 7;
  assert.throws(
    () => parseAdaptiveRunState(corrupted),
    (error: unknown) => isOrchestratorError(error, 'STATE_CORRUPT'),
  );
});

test('validation E: a malformed legacy single-epoch state still fails closed on other invariants (e.g. missing policyHash)', () => {
  const { subject, first } = twoRequestCoordinator();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first] });
  const corrupted = JSON.parse(JSON.stringify(subject.snapshot()));
  const legacyEpoch = corrupted.recoveryEpochs[0];
  delete corrupted.recoveryEpochs;
  delete corrupted.activeRecoveryEpochNumber;
  delete legacyEpoch.policyHash;
  corrupted.recoveryEpoch = legacyEpoch;
  assert.throws(
    () => parseAdaptiveRunState(corrupted),
    (error: unknown) => isOrchestratorError(error, 'STATE_CORRUPT'),
  );
});

test('validation E: a well-formed legacy single-epoch state parses successfully (backward compatibility)', () => {
  const { subject, first } = twoRequestCoordinator();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first] });
  const snapshot = JSON.parse(JSON.stringify(subject.snapshot()));
  const legacyEpoch = snapshot.recoveryEpochs[0];
  delete snapshot.recoveryEpochs;
  delete snapshot.activeRecoveryEpochNumber;
  snapshot.recoveryEpoch = legacyEpoch;
  const parsed = parseAdaptiveRunState(snapshot);
  assert.deepEqual(parsed.recoveryEpochs, [legacyEpoch]);
  assert.equal(parsed.activeRecoveryEpochNumber, legacyEpoch.number);
});

test('legacy and current recoveryEpoch shapes must never coexist', () => {
  const { subject, first } = twoRequestCoordinator();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first] });
  const corrupted = JSON.parse(JSON.stringify(subject.snapshot()));
  corrupted.recoveryEpoch = corrupted.recoveryEpochs[0];
  assert.throws(
    () => parseAdaptiveRunState(corrupted),
    (error: unknown) => isOrchestratorError(error, 'STATE_CORRUPT'),
  );
});

test('validation F: non-monotonic/non-contiguous epoch numbering fails closed', () => {
  const { subject, clock, first, second } = twoRequestCoordinator();
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_A, maxWallClockMs: 3_600_000, requestIds: [first] });
  clock.advance(60_000);
  subject.authorizeRecoveryEpoch({ policyHash: EPOCH_POLICY_HASH_B, maxWallClockMs: 7_200_000, requestIds: [second] });
  const corrupted = JSON.parse(JSON.stringify(subject.snapshot()));
  // Swap the numbers so the array is [2, 1] instead of [1, 2].
  corrupted.recoveryEpochs = [corrupted.recoveryEpochs[1], corrupted.recoveryEpochs[0]];
  assert.throws(
    () => parseAdaptiveRunState(corrupted),
    (error: unknown) => isOrchestratorError(error, 'STATE_CORRUPT'),
  );
});
