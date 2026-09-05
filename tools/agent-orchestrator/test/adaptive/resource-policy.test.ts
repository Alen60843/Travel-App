import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AdaptiveCoordinator,
  StaticCapabilityCatalog,
  parseAdaptivePolicy,
  type AdaptivePolicy,
  type WorkRequestDraft,
} from '../../src/adaptive';

const policy = (mode: 'read' | 'write' = 'write'): AdaptivePolicy => ({
  allowedConcerns: ['testing'], allowedOwnership: ['src/**'],
  allowedResources: [{ kind: 'database', key: 'tripwith-test-postgres', mode }],
  limits: {
    maxConcurrentAgents: 2, maxAgentInvocations: 4, maxTotalWorkUnits: 4,
    maxDecompositionDepth: 2, maxFanOutPerWorkUnit: 2, maxSynthesisInputs: 2,
    maxWallClockMs: 60_000,
  },
  requireEvidenceForExpansion: true, agingIntervalMs: 1000, agingStep: 1,
  humanApprovalRisks: [],
});

const request = (key = 'tripwith-test-postgres', mode: 'read' | 'write' = 'write'): WorkRequestDraft => ({
  role: 'testing', concern: 'testing', objective: 'Run database integration proof',
  reason: 'A real transaction invariant needs verification', dependencies: [],
  capabilities: [{ capability: 'postgresql_integration_testing', minimumLevel: 1 }],
  resourceClaims: [
    { kind: 'repository_path', key: 'src/test.ts', mode: 'read' },
    { kind: 'database', key, mode },
  ],
  evidence: [{ kind: 'test', reference: 'src/test.ts', summary: 'requires PostgreSQL' }],
  risk: 'low', priority: 50,
});

const catalog = (capable: boolean) => new StaticCapabilityCatalog(capable ? [{
  executorId: 'db-runner', available: true, roles: ['testing'],
  capabilities: [{ capability: 'postgresql_integration_testing', minimumLevel: 1 }],
}] : [{
  executorId: 'plain-runner', available: true, roles: ['testing'], capabilities: [{ capability: 'testing' }],
}]);

function decide(policyValue: AdaptivePolicy, draft: WorkRequestDraft, capable = true) {
  const coordinator = new AdaptiveCoordinator(
    AdaptiveCoordinator.create('resource test', policyValue).snapshot(),
    catalog(capable),
  );
  const submitted = coordinator.submit(draft);
  return coordinator.arbitrate().find((item) => item.requestId === submitted.id)!;
}

test('declared exact database resource and capable executor can be granted', () => {
  assert.equal(decide(policy(), request()).outcome, 'GRANTED');
});

test('undeclared resource and write escalation over read authority are denied', () => {
  assert.equal(decide(policy(), request('invented-db')).reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
  assert.equal(decide(policy('read'), request()).reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
  assert.equal(decide(policy('write'), request('tripwith-test-postgres', 'read')).outcome, 'GRANTED');
});

test('capability and concrete resource authority are independent requirements', () => {
  assert.equal(decide({ ...policy(), allowedResources: [] }, request(), true).reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
  assert.equal(decide(policy(), request(), false).reason, 'NO_CAPABLE_PROVIDER');
});

test('an agent child cannot dynamically enlarge allowed resources', () => {
  const coordinator = new AdaptiveCoordinator(AdaptiveCoordinator.create('resource test', policy()).snapshot(), catalog(true));
  const parent = coordinator.submit(request('tripwith-test-postgres', 'read'));
  coordinator.arbitrate();
  const unit = coordinator.snapshot().workUnits.find((item) => item.requestId === parent.id)!;
  const child = coordinator.submit(request('invented-db'), { parentWorkUnitId: unit.id, source: 'agent' });
  assert.equal(coordinator.arbitrate().find((item) => item.requestId === child.id)?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
});

test('file ownership remains independently enforced', () => {
  const outside = request();
  const altered = { ...outside, resourceClaims: [{ kind: 'repository_path' as const, key: 'other/file.ts', mode: 'write' as const }] };
  assert.equal(decide(policy(), altered).reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
});

test('resource boundary mode validates strictly and legacy omission defaults conservatively to read', () => {
  const base = policy();
  const legacy = parseAdaptivePolicy({
    ...base, allowedResources: [{ kind: 'database', key: 'legacy-db' }],
  });
  assert.deepEqual(legacy.allowedResources, [{ kind: 'database', key: 'legacy-db', mode: 'read' }]);
  assert.throws(() => parseAdaptivePolicy({
    ...base, allowedResources: [{ kind: 'database', key: 'db', mode: 'admin' }],
  }), /mode is invalid/);
});
