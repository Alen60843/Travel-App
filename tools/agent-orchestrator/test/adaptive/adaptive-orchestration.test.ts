import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  AdaptiveCoordinator,
  DeterministicCapabilityRouter,
  EvidenceDrivenPlanner,
  StaticCapabilityCatalog,
  parseAdaptivePhaseConfig,
  parseAdaptiveRunState,
  type AdaptivePolicy,
  type Clock,
  type WorkRequestDraft,
} from '../../src/adaptive';
import { loadPhaseConfig } from '../../src/config';
import { isOrchestratorError } from '../../src/errors';
import { createRunState, StateStore, type RunState } from '../../src/state';

class MutableClock implements Clock {
  constructor(private value: Date = new Date('2026-09-04T00:00:00.000Z')) {}
  now(): Date { return new Date(this.value); }
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

function policy(overrides: Partial<AdaptivePolicy['limits']> = {}): AdaptivePolicy {
  return {
    allowedConcerns: ['implementation', 'database', 'security', 'tests', 'synthesis'],
    allowedOwnership: ['tools/agent-orchestrator/**'],
    allowedResources: [],
    limits: {
      maxConcurrentAgents: 4,
      maxAgentInvocations: 20,
      maxTotalWorkUnits: 30,
      maxDecompositionDepth: 3,
      maxFanOutPerWorkUnit: 8,
      maxSynthesisInputs: 4,
      maxWallClockMs: 60_000,
      ...overrides,
    },
    requireEvidenceForExpansion: true,
    agingIntervalMs: 1_000,
    agingStep: 10,
    humanApprovalRisks: [],
  };
}

function correctionPolicy(): AdaptivePolicy {
  return {
    ...policy(),
    correctionPolicy: {
      allowedOwnership: ['tools/agent-orchestrator/**'],
      allowedRoles: ['correction', 'testing'],
      requireCanonicalFinding: true,
      maxRounds: 2,
    },
  };
}

function draft(options: Partial<WorkRequestDraft> = {}): WorkRequestDraft {
  return {
    role: 'implementation',
    concern: 'implementation',
    objective: 'Implement the bounded work item',
    reason: 'Repository evidence identifies a concrete change',
    dependencies: [],
    capabilities: [{ capability: 'typescript', minimumLevel: 1 }],
    resourceClaims: [],
    evidence: [{ kind: 'diff', reference: 'src/a.ts', summary: 'Relevant source changed' }],
    risk: 'medium',
    priority: 50,
    ...options,
  };
}

function coordinator(limits: Partial<AdaptivePolicy['limits']> = {}, clock = new MutableClock()): AdaptiveCoordinator {
  return AdaptiveCoordinator.create('Adaptive test goal', policy(limits), clock);
}

function grantOne(subject: AdaptiveCoordinator, requestDraft = draft()) {
  const request = subject.submit(requestDraft);
  const decision = subject.arbitrate().find((item) => item.requestId === request.id);
  assert.equal(decision?.outcome, 'GRANTED');
  const unit = subject.snapshot().workUnits.find((item) => item.requestId === request.id);
  assert.ok(unit);
  return { request, unit };
}

test('A/B: deterministic planner keeps small work whole and expands evidence-backed larger work', () => {
  const planner = new EvidenceDrivenPlanner();
  const candidates = [
    { role: 'implementation' as const, concern: 'implementation', objective: 'DTO update', reason: 'one local DTO diff', evidence: [{ kind: 'diff' as const, reference: 'dto.ts', summary: 'DTO changed' }] },
    { role: 'testing' as const, concern: 'tests', objective: 'Concurrency proof', reason: 'lock behavior changed', evidence: [{ kind: 'schema' as const, reference: 'migration.sql', summary: 'lock added' }] },
  ];
  assert.equal(planner.plan({ goal: 'small', candidates: candidates.slice(0, 1) }, policy()).length, 1);
  assert.equal(planner.plan({ goal: 'large', candidates }, policy()).length, 2);
});

test('C/D/Q: requests, grants and generated topology persist and replay exactly', async () => {
  const root = await mkdtemp(join(tmpdir(), 'adaptive-state-'));
  try {
    const subject = coordinator();
    grantOne(subject, draft({ estimatedCostUnits: 0.5 }));
    const staticState = createRunState({
      runId: 'adaptive-001', phase: 'adaptive-test', repositoryRoot: root,
      baseBranch: 'main', baseSha: '1'.repeat(40),
      tasks: [{ id: 'seed', title: 'Seed', owner: 'codex', effort: 'high', mode: 'implementation', files: ['tools/agent-orchestrator/**'], dependsOn: [], writer: true }],
    });
    const expected: RunState = { ...staticState, adaptive: subject.snapshot() };
    const store = new StateStore(root, 'adaptive-001');
    await store.initialize(expected);
    const loaded = await store.load();
    assert.deepEqual(loaded.adaptive, expected.adaptive);
    assert.deepEqual(new AdaptiveCoordinator(parseAdaptiveRunState(loaded.adaptive)).snapshot(), expected.adaptive);
    assert.match(await readFile(store.statePath, 'utf8'), /"grantDecisions"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('E/F: writer conflicts wait while read-only shards may share the same files', () => {
  const writers = coordinator();
  const sharedWrite = [{ kind: 'repository_path' as const, key: 'tools/agent-orchestrator/src/**', mode: 'write' as const }];
  writers.submit(draft({ objective: 'writer one', resourceClaims: sharedWrite }));
  writers.submit(draft({ objective: 'writer two', resourceClaims: sharedWrite }));
  const writerDecisions = writers.arbitrate();
  assert.deepEqual(writerDecisions.map((item) => item.outcome), ['GRANTED', 'WAITING']);
  assert.equal(writerDecisions[1]?.reason, 'OWNERSHIP_CONFLICT');
  const firstWriter = writers.snapshot().workUnits[0]!;
  writers.finish(firstWriter.id, 'SUCCEEDED');
  assert.equal(writers.arbitrate().find((decision) => decision.requestId === writers.snapshot().workRequests[1]!.id)?.outcome, 'GRANTED');
  assert.ok(writers.snapshot().events.some((event) => event.type === 'RESOURCE_RELEASED'));

  const readers = coordinator();
  const sharedRead = [{ kind: 'repository_path' as const, key: 'tools/agent-orchestrator/src/**', mode: 'read' as const }];
  readers.submit(draft({ role: 'review', objective: 'reader one', resourceClaims: sharedRead }));
  readers.submit(draft({ role: 'review', objective: 'reader two', resourceClaims: sharedRead }));
  assert.deepEqual(readers.arbitrate().map((item) => item.outcome), ['GRANTED', 'GRANTED']);
});

test('G: dependencies block premature grants and permit grant only after success', () => {
  const subject = coordinator();
  const first = subject.submit(draft({ objective: 'dependency' }));
  const second = subject.submit(draft({ objective: 'dependent', dependencies: [first.id] }));
  const initial = subject.arbitrate();
  assert.equal(initial.find((item) => item.requestId === second.id)?.reason, 'DEPENDENCY_NOT_READY');
  const firstUnit = subject.snapshot().workUnits.find((unit) => unit.requestId === first.id)!;
  subject.finish(firstUnit.id, 'SUCCEEDED');
  assert.equal(subject.arbitrate().find((item) => item.requestId === second.id)?.outcome, 'GRANTED');
});

test('H plus safety properties: every scheduler step respects concurrency and writer exclusion', () => {
  const subject = coordinator({ maxConcurrentAgents: 3 });
  for (let index = 0; index < 12; index += 1) {
    subject.submit(draft({
      objective: `work ${index}`,
      resourceClaims: [{ kind: 'repository_path', key: `tools/agent-orchestrator/src/shard-${index % 5}/**`, mode: index % 2 === 0 ? 'write' : 'read' }],
    }));
  }
  for (let step = 0; step < 12; step += 1) {
    subject.arbitrate();
    const active = subject.snapshot().workUnits.filter((unit) => unit.status === 'GRANTED' || unit.status === 'RUNNING');
    assert.ok(active.length <= 3);
    for (let left = 0; left < active.length; left += 1) {
      for (let right = left + 1; right < active.length; right += 1) {
        const a = active[left]!;
        const b = active[right]!;
        const bothWriteSame = a.resourceClaims.some((x) => x.mode === 'write' && b.resourceClaims.some((y) => y.mode === 'write' && x.key === y.key));
        assert.equal(bothWriteSame, false);
      }
    }
    const current = active[0];
    if (current !== undefined) subject.finish(current.id, 'SUCCEEDED');
  }
});

test('I: maxAgentInvocations is a hard grant budget', () => {
  const subject = coordinator({ maxConcurrentAgents: 2, maxAgentInvocations: 2 });
  for (let index = 0; index < 3; index += 1) subject.submit(draft({ objective: `budget ${index}` }));
  const decisions = subject.arbitrate();
  assert.equal(decisions.filter((item) => item.outcome === 'GRANTED').length, 2);
  assert.equal(decisions.find((item) => item.outcome === 'DENIED')?.reason, 'MAX_AGENT_INVOCATIONS');
  assert.equal(subject.snapshot().totalAgentInvocations, 2);
});

test('J plus depth property: children are parent depth + 1 and over-depth work is denied', () => {
  const subject = coordinator({ maxDecompositionDepth: 1 });
  const root = grantOne(subject);
  const childRequest = subject.submit(draft({ objective: 'child' }), { parentWorkUnitId: root.unit.id, source: 'agent' });
  subject.arbitrate();
  const child = subject.snapshot().workUnits.find((unit) => unit.requestId === childRequest.id)!;
  assert.equal(child.depth, root.unit.depth + 1);
  const grandchild = subject.submit(draft({ objective: 'grandchild' }), { parentWorkUnitId: child.id, source: 'agent' });
  assert.equal(subject.arbitrate().find((item) => item.requestId === grandchild.id)?.reason, 'MAX_DECOMPOSITION_DEPTH');
});

test('K/L: duplicates and unsupported expansion receive explicit evidence-backed denials', () => {
  const subject = coordinator();
  subject.submit(draft());
  const duplicate = subject.submit(draft());
  const unsupported = subject.submit(draft({ objective: 'unsupported', evidence: [] }));
  const decisions = subject.arbitrate();
  assert.equal(decisions.find((item) => item.requestId === duplicate.id)?.reason, 'DUPLICATE_REQUEST');
  assert.equal(decisions.find((item) => item.requestId === unsupported.id)?.reason, 'INSUFFICIENT_EVIDENCE');
});

test('M/N: a failed shard retries alone and successful sibling history is immutable', () => {
  const subject = coordinator();
  const first = grantOne(subject, draft({ objective: 'first sibling' }));
  const secondRequest = subject.submit(draft({ objective: 'second sibling' }));
  subject.arbitrate();
  const second = subject.snapshot().workUnits.find((unit) => unit.requestId === secondRequest.id)!;
  subject.finish(first.unit.id, 'SUCCEEDED', { resultEvidence: [{ kind: 'test', reference: 'one', summary: 'passed' }] });
  subject.finish(second.id, 'FAILED', { error: 'temporary provider failure' });
  const successfulBefore = structuredClone(subject.snapshot().workUnits.find((unit) => unit.id === first.unit.id));
  subject.authorizeRetry(second.id);
  subject.arbitrate();
  assert.deepEqual(subject.snapshot().workUnits.find((unit) => unit.id === first.unit.id), successfulBefore);
  assert.equal(subject.snapshot().workUnits.find((unit) => unit.id === second.id)?.attempts.length, 2);
});

test('O/P: bounded synthesis waits for inputs and synthesis retry never reruns shards', () => {
  const subject = coordinator();
  const inputs = [grantOne(subject, draft({ objective: 'review A', role: 'review' }))];
  const requestB = subject.submit(draft({ objective: 'review B', role: 'review' }));
  subject.arbitrate();
  const unitB = subject.snapshot().workUnits.find((unit) => unit.requestId === requestB.id)!;
  const synth = subject.createSynthesisTree([inputs[0]!.request.id, requestB.id]);
  assert.equal(synth.length, 1);
  assert.equal(subject.arbitrate().find((item) => item.requestId === synth[0]!.id)?.reason, 'DEPENDENCY_NOT_READY');
  subject.finish(inputs[0]!.unit.id, 'SUCCEEDED');
  subject.finish(unitB.id, 'SUCCEEDED');
  subject.arbitrate();
  const synthesisUnit = subject.snapshot().workUnits.find((unit) => unit.requestId === synth[0]!.id)!;
  const shardAttempts = subject.snapshot().workUnits.slice(0, 2).map((unit) => unit.attempts.length);
  subject.finish(synthesisUnit.id, 'FAILED');
  subject.authorizeRetry(synthesisUnit.id);
  subject.arbitrate();
  assert.deepEqual(subject.snapshot().workUnits.slice(0, 2).map((unit) => unit.attempts.length), shardAttempts);
});

test('bounded fan-in derives a hierarchy from configured context limit', () => {
  const subject = coordinator({ maxSynthesisInputs: 4, maxTotalWorkUnits: 40 });
  const ids = Array.from({ length: 12 }, (_, index) => subject.submit(draft({ objective: `review ${index}` })).id);
  const synth = subject.createSynthesisTree(ids);
  assert.equal(synth.length, 4);
  assert.ok(synth.every((request) => request.dependencies.length <= 4));
});

test('R: resume consumes persisted topology and never invokes the planner again', () => {
  let plannerCalls = 0;
  const planner = { plan: () => { plannerCalls += 1; return [draft()]; } };
  const subject = coordinator();
  subject.submitMany(planner.plan());
  subject.arbitrate();
  const resumed = new AdaptiveCoordinator(parseAdaptiveRunState(JSON.parse(JSON.stringify(subject.snapshot()))));
  resumed.arbitrate();
  assert.equal(plannerCalls, 1);
});

test('S: request, decision and event histories are append-only prefixes', () => {
  const subject = coordinator();
  grantOne(subject, draft({ objective: 'first history' }));
  const before = subject.snapshot();
  subject.submit(draft({ objective: 'second history' }));
  subject.arbitrate();
  const after = subject.snapshot();
  assert.deepEqual(after.workRequests.slice(0, before.workRequests.length), before.workRequests);
  assert.deepEqual(after.grantDecisions.slice(0, before.grantDecisions.length), before.grantDecisions);
  assert.deepEqual(after.events.slice(0, before.events.length), before.events);
});

test('T: bounded priority aging lets an old eligible request outrank newer work', () => {
  const clock = new MutableClock();
  const subject = coordinator({ maxConcurrentAgents: 1 }, clock);
  const blocker = grantOne(subject, draft({ objective: 'blocker', priority: 100 }));
  const old = subject.submit(draft({ objective: 'old low priority', priority: 1 }));
  subject.arbitrate();
  subject.finish(blocker.unit.id, 'SUCCEEDED');
  clock.advance(11_000);
  const fresh = subject.submit(draft({ objective: 'fresh high priority', priority: 100 }));
  const decisions = subject.arbitrate();
  assert.equal(decisions[0]?.requestId, old.id);
  assert.equal(decisions[0]?.outcome, 'GRANTED');
  assert.equal(decisions.find((item) => item.requestId === fresh.id)?.outcome, 'WAITING');
});

test('U: static phase YAML remains valid and adaptive policy config is separately opt-in', async () => {
  const packageRoot = process.cwd().endsWith('tools/agent-orchestrator')
    ? process.cwd()
    : join(process.cwd(), 'tools/agent-orchestrator');
  const staticConfig = await loadPhaseConfig(join(packageRoot, 'phases/phase5.real.yaml'));
  assert.ok(staticConfig.tasks.length > 0);
  const adaptive = parseAdaptivePhaseConfig({
    mode: 'adaptive', phase: 'future', name: 'Future adaptive phase', baseBranch: 'main',
    canonicalDesignDocument: 'docs/design.md', goal: 'Derive evidence-backed work', constraints: ['no push'], policy: policy(),
  });
  assert.equal(adaptive.mode, 'adaptive');
});

test('untrusted agents cannot grant, choose providers, expand policy, or bypass human gates', () => {
  const subject = coordinator();
  assert.throws(() => subject.submit(draft({ objective: 'orphan agent proposal' }), { source: 'agent' }), (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  const parent = grantOne(subject, draft({
    objective: 'parent',
    resourceClaims: [{ kind: 'repository_path', key: 'tools/agent-orchestrator/src/**', mode: 'write' }],
  }));
  const request = subject.submit(draft({
    objective: 'agent proposal',
    resourceClaims: [{ kind: 'repository_path', key: 'tools/agent-orchestrator/src/adaptive/**', mode: 'read' }],
  }), { source: 'agent', parentWorkUnitId: parent.unit.id });
  assert.equal(subject.snapshot().grantDecisions.length, 1);
  assert.equal(subject.snapshot().workUnits.length, 1);
  assert.throws(() => subject.submit({ ...draft(), provider: 'claude' }), (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'));
  subject.finish(parent.unit.id, 'SUCCEEDED');
  assert.equal(subject.arbitrate().find((decision) => decision.requestId === request.id)?.outcome, 'GRANTED');
  assert.ok(subject.snapshot().grantDecisions.every((decision) => !('provider' in decision)));
  assert.equal(subject.completionStatus(false), 'ACTIVE');
});

test('capability availability affects arbitration while provider-neutral routing happens after grant', () => {
  const clock = new MutableClock();
  const catalog = new StaticCapabilityCatalog([{ executorId: 'generic-b', capabilities: [{ capability: 'typescript', minimumLevel: 2 }], available: false }]);
  const subject = new AdaptiveCoordinator(AdaptiveCoordinator.create('goal', policy(), clock).snapshot(), catalog, clock);
  subject.submit(draft());
  assert.equal(subject.arbitrate()[0]?.reason, 'PROVIDER_TEMPORARILY_UNAVAILABLE');
  const router = new DeterministicCapabilityRouter();
  const request = subject.snapshot().workRequests[0]!;
  assert.equal(router.route(request, [
    { executorId: 'generic-z', capabilities: [{ capability: 'typescript', minimumLevel: 2 }], available: true },
    { executorId: 'generic-a', capabilities: [{ capability: 'typescript', minimumLevel: 2 }], available: true },
  ]).executorId, 'generic-a');
});

test('policy validation rejects unsafe limits and critical work can require human approval', () => {
  assert.throws(() => AdaptiveCoordinator.create('goal', { ...policy(), limits: { ...policy().limits, maxSynthesisInputs: 1 } }), (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'));
  assert.throws(() => AdaptiveCoordinator.create('goal', {
    ...policy(), correctionPolicy: { ...correctionPolicy().correctionPolicy!, requireCanonicalFinding: false },
  }), (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'));
  assert.throws(() => AdaptiveCoordinator.create('goal', {
    ...policy(), correctionPolicy: { ...correctionPolicy().correctionPolicy!, maxRounds: 6 },
  }), (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'));
  const humanPolicy = { ...policy(), humanApprovalRisks: ['critical'] as const };
  const subject = AdaptiveCoordinator.create('goal', humanPolicy);
  subject.submit(draft({ risk: 'critical' }));
  assert.equal(subject.arbitrate()[0]?.reason, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(subject.completionStatus(false), 'HUMAN_APPROVAL_REQUIRED');
});

test('remaining deterministic guardrails bound work count, fan-out, cost, scope and dependencies', () => {
  const countBound = coordinator({ maxConcurrentAgents: 2, maxTotalWorkUnits: 2 });
  for (let index = 0; index < 3; index += 1) countBound.submit(draft({ objective: `count ${index}` }));
  assert.equal(countBound.arbitrate().find((decision) => decision.reason === 'MAX_TOTAL_WORK_UNITS')?.outcome, 'DENIED');

  const costBound = AdaptiveCoordinator.create('goal', { ...policy(), limits: { ...policy().limits, maxEstimatedCostUnits: 1 } });
  costBound.submit(draft({ estimatedCostUnits: 2 }));
  assert.equal(costBound.arbitrate()[0]?.reason, 'BUDGET_EXCEEDED');

  const invalidDependency = coordinator();
  invalidDependency.submit(draft({ dependencies: ['request-999999'] }));
  assert.equal(invalidDependency.arbitrate()[0]?.reason, 'INVALID_DEPENDENCY');

  const scope = coordinator();
  scope.submit(draft({ resourceClaims: [{ kind: 'repository_path', key: 'apps/api/**', mode: 'read' }] }));
  assert.equal(scope.arbitrate()[0]?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');

  const fanOut = coordinator({ maxFanOutPerWorkUnit: 1 });
  const root = grantOne(fanOut, draft({ objective: 'fanout root' }));
  fanOut.submit(draft({ objective: 'child one' }), { parentWorkUnitId: root.unit.id, source: 'agent' });
  const excess = fanOut.submit(draft({ objective: 'child two' }), { parentWorkUnitId: root.unit.id, source: 'agent' });
  assert.equal(fanOut.arbitrate().find((decision) => decision.requestId === excess.id)?.reason, 'MAX_FAN_OUT');
});

test('TASK != AGENT: deterministic analysis may request zero invocations', () => {
  const planner = new EvidenceDrivenPlanner();
  const subject = coordinator();
  assert.deepEqual(planner.plan({ goal: 'documentation-only deterministic gate', candidates: [] }, policy()), []);
  assert.equal(subject.snapshot().totalAgentInvocations, 0);
});

test('review child cannot escalate write while canonical synthesis can create a separately authorized root correction', () => {
  const subject = AdaptiveCoordinator.create('correction authority', correctionPolicy());
  const review = grantOne(subject, draft({
    role: 'synthesis', concern: 'synthesis', objective: 'Canonicalize findings',
    capabilities: [{ capability: 'review' }],
    resourceClaims: [{ kind: 'repository_path', key: 'tools/agent-orchestrator/**', mode: 'read' }],
  }));
  subject.start(review.unit.id);
  subject.finish(review.unit.id, 'SUCCEEDED');

  const child = subject.submit(draft({
    role: 'correction', concern: 'synthesis', objective: 'Untrusted child fix',
    resourceClaims: [{ kind: 'repository_path', key: 'tools/agent-orchestrator/src/a.ts', mode: 'write' }],
    evidence: [{ kind: 'finding', reference: 'F001', summary: 'agent claim' }],
  }), { parentWorkUnitId: review.unit.id, source: 'agent' });
  const root = subject.submitCanonicalFindingWork(draft({
    role: 'correction', concern: 'synthesis', objective: 'Authorized root fix',
    dependencies: [review.request.id],
    resourceClaims: [{ kind: 'repository_path', key: 'tools/agent-orchestrator/src/a.ts', mode: 'write' }],
    evidence: [{ kind: 'finding', reference: 'F001', summary: 'persisted canonical finding' }],
  }), {
    kind: 'canonical_finding', purpose: 'correction', canonicalFindingKey: `${review.unit.id}:F001`,
    findingReference: 'F001', sourceWorkUnitId: review.unit.id, artifactPath: '/run/reviews/synthesis.json', round: 1,
  });
  const decisions = subject.arbitrate();
  assert.equal(decisions.find((item) => item.requestId === child.id)?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
  assert.equal(decisions.find((item) => item.requestId === root.id)?.outcome, 'GRANTED');
  assert.equal(root.parentWorkUnitId, undefined);
  assert.equal(root.source, 'orchestrator');
  assert.equal(root.authorization?.canonicalFindingKey, `${review.unit.id}:F001`);
});

test('correction policy is write-specific, rejects out-of-policy roots, and deduplicates one canonical finding per round', () => {
  const subject = AdaptiveCoordinator.create('correction policy', correctionPolicy());
  const review = grantOne(subject, draft({ role: 'synthesis', concern: 'synthesis', objective: 'Canonical review' }));
  subject.start(review.unit.id);
  subject.finish(review.unit.id, 'SUCCEEDED');
  const authorization = {
    kind: 'canonical_finding' as const, purpose: 'correction' as const,
    canonicalFindingKey: `${review.unit.id}:F001`, findingReference: 'F001',
    sourceWorkUnitId: review.unit.id, artifactPath: '/run/reviews/synthesis.json', round: 1,
  };
  const first = subject.submitCanonicalFindingWork(draft({
    role: 'correction', concern: 'synthesis', objective: 'first', dependencies: [review.request.id],
    resourceClaims: [{ kind: 'repository_path', key: 'tools/agent-orchestrator/src/a.ts', mode: 'write' }],
    evidence: [{ kind: 'finding', reference: 'F001', summary: 'canonical' }],
  }), authorization);
  const duplicate = subject.submitCanonicalFindingWork(draft({
    role: 'correction', concern: 'synthesis', objective: 'second proposal', dependencies: [review.request.id],
    resourceClaims: [{ kind: 'repository_path', key: 'tools/agent-orchestrator/src/a.ts', mode: 'write' }],
    evidence: [{ kind: 'finding', reference: 'F001', summary: 'canonical' }],
  }), authorization);
  assert.equal(duplicate.id, first.id);

  const denied = subject.submitCanonicalFindingWork(draft({
    role: 'correction', concern: 'synthesis', objective: 'outside', dependencies: [review.request.id],
    resourceClaims: [{ kind: 'repository_path', key: 'apps/api/src/events/a.ts', mode: 'write' }],
    evidence: [{ kind: 'finding', reference: 'F002', summary: 'canonical' }],
  }), { ...authorization, canonicalFindingKey: `${review.unit.id}:F002`, findingReference: 'F002' });
  assert.equal(subject.arbitrate().find((item) => item.requestId === denied.id)?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
});

test('arbitrary agent proposal cannot mint canonical root authority', () => {
  const subject = AdaptiveCoordinator.create('no forged roots', correctionPolicy());
  assert.throws(
    () => subject.submit(draft({ role: 'correction' }), { source: 'agent' }),
    (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
  );
});
