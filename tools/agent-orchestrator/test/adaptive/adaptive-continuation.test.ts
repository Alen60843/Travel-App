import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentRequest, AgentResult } from '../../src/agents';
import {
  AdaptiveCoordinator,
  parseAdaptivePhaseConfigYaml,
  type AdaptivePolicy,
} from '../../src/adaptive';
import { renderPlan } from '../../src/cli';
import { AgentOrchestrator, planOrchestrationPhase } from '../../src/orchestrator';
import { createRunState, StateStore, type RunState } from '../../src/state';
import type { TaskSpec } from '../../src/tasks';
import { createTemporaryRepository } from '../git/helpers';

const SOURCE_RUN_ID = 'run-source-canonical';

const POLICY: AdaptivePolicy = {
  allowedConcerns: ['review', 'synthesis'],
  allowedOwnership: ['**'],
  allowedResources: [],
  limits: {
    maxConcurrentAgents: 3,
    maxAgentInvocations: 6,
    maxTotalWorkUnits: 6,
    maxDecompositionDepth: 2,
    maxFanOutPerWorkUnit: 3,
    maxSynthesisInputs: 4,
    maxWallClockMs: 600_000,
  },
  requireEvidenceForExpansion: true,
  agingIntervalMs: 1_000,
  agingStep: 1,
  humanApprovalRisks: [],
};

function canonicalReview(files = ['feature.txt', 'tests.txt', 'concurrency.txt']): unknown {
  const findings = files.map((file, index) => ({
    id: `F${String(index + 1).padStart(3, '0')}`,
    severity: index === 2 ? 'low' : 'medium',
    category: index === 0 ? 'correctness' : 'testing',
    file,
    location: `line ${index + 1}`,
    problem: `canonical problem ${index + 1}`,
    evidence: `canonical evidence ${index + 1}`,
    impact: `canonical impact ${index + 1}`,
    suggestedFix: `canonical fix ${index + 1}`,
    verificationRequired: `canonical verification ${index + 1}`,
  }));
  return {
    status: 'changes_requested',
    findings,
    additionalWorkRequests: findings.slice(0, 2).map((finding, index) => ({
      role: index === 0 ? 'correction' : 'testing',
      concern: index === 0 ? 'api_validation' : 'testing',
      objective: `Address ${finding.id}`,
      reason: finding.suggestedFix,
      dependencies: [],
      capabilities: [{ capability: index === 0 ? 'typescript_backend_editing' : 'testing' }],
      resourceClaims: [{ kind: 'repository_path', key: finding.file, mode: 'write' }],
      evidence: [{ kind: 'finding', reference: finding.id, summary: finding.evidence }],
      risk: 'low',
      priority: 70 - index,
    })),
  };
}

function taskSpecsForSource(coordinator: AdaptiveCoordinator): TaskSpec[] {
  const state = coordinator.snapshot();
  const requestToUnit = new Map(state.workUnits.map((unit) => [unit.requestId, unit.id]));
  return state.workUnits.map((unit) => ({
    id: unit.id,
    title: unit.objective,
    owner: 'claude',
    effort: 'high',
    mode: unit.role === 'synthesis' ? 'synthesis' : 'review',
    files: [],
    dependsOn: unit.dependencyRequestIds.map((requestId) => requestToUnit.get(requestId)!),
    writer: false,
    instructions: unit.reason,
  }));
}

async function seedCanonicalSource(options: {
  repository: string;
  runsRoot: string;
  baseBranch: string;
  baseSha: string;
  review?: unknown;
}): Promise<{ store: StateStore; artifactPath: string; state: RunState }> {
  const coordinator = AdaptiveCoordinator.create('Canonical source review', POLICY);
  const requests = coordinator.submitMany([
    {
      role: 'review', concern: 'review', objective: 'Review shard A', reason: 'independent evidence',
      evidence: [{ kind: 'file', reference: 'feature.txt', summary: 'source' }],
      resourceClaims: [{ kind: 'repository_path', key: 'feature.txt', mode: 'read' }],
      capabilities: [{ capability: 'review' }], risk: 'low', priority: 80,
    },
    {
      role: 'review', concern: 'review', objective: 'Review shard B', reason: 'independent evidence',
      evidence: [{ kind: 'file', reference: 'tests.txt', summary: 'source' }],
      resourceClaims: [{ kind: 'repository_path', key: 'tests.txt', mode: 'read' }],
      capabilities: [{ capability: 'review' }], risk: 'low', priority: 79,
    },
  ], { source: 'planner' });
  coordinator.createSynthesisTree(requests.map((request) => request.id));
  coordinator.arbitrate();
  for (const unit of coordinator.snapshot().workUnits.filter((unit) => unit.role === 'review')) {
    coordinator.start(unit.id);
    coordinator.finish(unit.id, 'SUCCEEDED');
  }
  coordinator.arbitrate();
  const synthesis = coordinator.snapshot().workUnits.find((unit) => unit.role === 'synthesis')!;
  coordinator.start(synthesis.id);
  coordinator.finish(synthesis.id, 'SUCCEEDED');

  const store = new StateStore(options.runsRoot, SOURCE_RUN_ID);
  const artifactPath = join(store.runDirectory, 'reviews', `${synthesis.id}.json`);
  const created = createRunState({
    runId: SOURCE_RUN_ID,
    phase: 'source-review',
    repositoryRoot: options.repository,
    baseBranch: options.baseBranch,
    baseSha: options.baseSha,
    tasks: taskSpecsForSource(coordinator),
    strategy: 'adaptive',
    adaptive: coordinator.snapshot(),
  });
  const timestamp = new Date().toISOString();
  const state: RunState = {
    ...created,
    status: 'BLOCKED',
    tasks: Object.fromEntries(Object.entries(created.tasks).map(([id, task]) => [id, {
      ...task,
      status: 'SUCCEEDED' as const,
      preparedHeadSha: options.baseSha,
      reviewRounds: 1,
      reviewPaths: id === synthesis.id ? [artifactPath] : [],
      startedAt: timestamp,
      finishedAt: timestamp,
    }])),
  };
  await store.initialize(state);
  await writeFile(artifactPath, `${JSON.stringify(options.review ?? canonicalReview(), null, 2)}\n`, 'utf8');
  return { store, artifactPath, state };
}

function continuationPhase(
  baseBranch: string,
  baseSha: string,
  options: { sourceRunId?: string; sourceWorkUnitId?: string; correctionOwnership?: string[]; agentRetries?: number } = {},
): string {
  const ownership = options.correctionOwnership ?? ['feature.txt', 'tests.txt', 'concurrency.txt'];
  return `mode: adaptive
phase: continuation-test
name: Canonical finding continuation
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
goal: Correct imported canonical findings and re-verify them
constraints: [Do not rerun review shards]
continuation:
  sourceRunId: ${options.sourceRunId ?? SOURCE_RUN_ID}
  sourceWorkUnitId: ${options.sourceWorkUnitId ?? 'work-000003'}
  sourceArtifactType: review
  expectedBaseSha: ${baseSha}
  mode: canonical_findings
policy:
  allowedConcerns: [api_validation, testing]
  allowedOwnership: ['**']
  allowedResources: []
  limits:
    maxConcurrentAgents: 3
    maxAgentInvocations: 12
    maxTotalWorkUnits: 12
    maxDecompositionDepth: 2
    maxFanOutPerWorkUnit: 3
    maxSynthesisInputs: 4
    maxWallClockMs: 600000
  requireEvidenceForExpansion: true
  agingIntervalMs: 1000
  agingStep: 1
  humanApprovalRisks: []
  correctionPolicy:
    allowedOwnership: [${ownership.join(', ')}]
    allowedRoles: [correction, testing]
    requireCanonicalFinding: true
    maxRounds: 2
executors:
  - id: writer
    adapter: codex
    capabilities: [{ capability: typescript_backend_editing }, { capability: testing }]
    roles: [correction, testing]
    effort: high
  - id: reviewer
    adapter: claude
    capabilities: [{ capability: review }]
    roles: [review]
    effort: high
agentRetries: ${options.agentRetries ?? 0}
agentTimeoutMs: 60000
integration:
  commands:
    - command: grep corrected feature.txt
      required: true
  diagnostics: []
`;
}

class ContinuationAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  reviewTimeoutsRemaining = 0;

  constructor(
    readonly name: 'codex' | 'claude',
    private readonly runsRoot: string,
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    await request.onStarted?.(process.pid);
    const persisted = JSON.parse(await readFile(join(this.runsRoot, request.runId, 'run.json'), 'utf8')) as {
      adaptive?: { continuation?: { findings?: unknown[] }; workRequests?: unknown[]; grantDecisions?: unknown[] };
    };
    assert.ok((persisted.adaptive?.continuation?.findings?.length ?? 0) > 0, 'findings must be durable before launch');
    assert.ok((persisted.adaptive?.workRequests?.length ?? 0) > 0, 'correction requests must be durable before launch');
    assert.ok((persisted.adaptive?.grantDecisions?.length ?? 0) > 0, 'arbiter decisions must be durable before launch');
    const task = (request.taskSpecification as { task: TaskSpec; actualDependencyDiff: string }).task;
    const canonicalFindingKey = (request.taskSpecification as {
      requiredCanonicalFindings?: Array<{ canonicalFindingKey: string }>;
    }).requiredCanonicalFindings?.[0]?.canonicalFindingKey;
    const instructions = task.instructions ?? '';
    const findingId = task.title.match(/F\d{3,}/)?.[0] ?? instructions.match(/"id":"(F\d{3,})"/)?.[1] ?? 'F001';
    let structuredHandoff: unknown;
    let status: AgentResult['status'] = 'succeeded';
    if (request.role === 'correction' || request.role === 'testing') {
      const target = request.allowedFileOwnership[0]!;
      await writeFile(join(request.worktreePath, target), `corrected ${findingId}\n`, 'utf8');
      structuredHandoff = {
        status: 'complete', summary: `corrected ${findingId}`, filesChanged: [target], decisions: [], tests: [],
        openQuestions: [], reviewRequested: [`targeted ${findingId}`],
        findingResponses: [{ findingId, canonicalFindingKey, decision: 'confirmed', resolution: 'resolved', evidence: 'reproduced', fix: 'corrected', verification: 'focused check' }],
      };
    } else if (this.reviewTimeoutsRemaining > 0) {
      this.reviewTimeoutsRemaining -= 1;
      status = 'timed_out';
      structuredHandoff = null;
    } else {
      assert.match(instructions, /Original canonical finding/);
      assert.match(instructions, /sourceArtifactSha256/);
      assert.match((request.taskSpecification as { actualDependencyDiff: string }).actualDependencyDiff, /corrected/);
      assert.ok(request.dependencyHandoffs.length > 0, 'targeted re-review receives correction tests/handoff');
      structuredHandoff = { status: 'approved', findings: [] };
    }
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId, status,
      exitCode: status === 'succeeded' ? 0 : null, signal: status === 'timed_out' ? 'SIGTERM' : null,
      stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout`),
      stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr`),
      structuredHandoff, changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: now, endedAt: now, durationMs: 0, timedOut: status === 'timed_out', aborted: false,
      failureCode: status === 'timed_out' ? 'AGENT_TIMEOUT' : null,
      errorMessage: status === 'timed_out' ? 'interrupted targeted review' : null,
    };
  }
}

type RepairBehavior =
  | 'succeed' | 'throw' | 'contradict'
  | 'prose-fence' | 'whitespace-fence' | 'ambiguous' | 'invalid-json' | 'schema-invalid';

class SemanticRepairAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(
    readonly name: 'codex' | 'claude',
    private readonly supported = true,
    private readonly repairBehavior: RepairBehavior = 'succeed',
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    await request.onStarted?.(process.pid);
    let structuredHandoff: unknown;
    let rawStdout: string | undefined;
    if (request.role === 'correction' || request.role === 'testing') {
      await writeFile(join(request.worktreePath, request.allowedFileOwnership[0]!), 'corrected F001\n', 'utf8');
      structuredHandoff = {
        status: 'complete', summary: 'corrected F001', filesChanged: [request.allowedFileOwnership[0]],
        decisions: [], tests: this.supported ? [{ command: 'focused-test', result: 'pass', details: '1/1' }] : [],
        openQuestions: [], reviewRequested: ['F001'],
      };
    } else if (request.role === 'handoff_repair') {
      assert.equal(request.access, 'read_only');
      assert.deepEqual(request.allowedFileOwnership, []);
      const spec = request.taskSpecification as {
        malformedOutput: Record<string, unknown>;
        requiredCanonicalFindings: Array<{ findingId: string; finding: unknown; canonicalFindingKey: string }>;
        deterministicTaskEvidence: { taskDiff: string; tests: unknown[]; filesChanged: string[] };
      };
      assert.deepEqual(Object.keys(spec.deterministicTaskEvidence).sort(), ['filesChanged', 'taskDiff', 'tests']);
      assert.match(spec.deterministicTaskEvidence.taskDiff, /corrected F001/);
      assert.equal(spec.requiredCanonicalFindings[0]?.findingId, 'F001');
      assert.ok(spec.requiredCanonicalFindings[0]?.finding);
      if (this.repairBehavior === 'throw') {
        throw new Error('simulated agent-invocation-layer failure (e.g. empty/crashed process output)');
      }
      const validRepaired = {
        ...spec.malformedOutput,
        findingResponses: [{
          findingId: 'F001', canonicalFindingKey: spec.requiredCanonicalFindings[0]!.canonicalFindingKey,
          decision: 'confirmed', resolution: 'resolved', evidence: 'task diff contains correction',
          fix: 'updated feature', verification: 'focused-test passed 1/1',
        }],
      };
      if (this.repairBehavior === 'succeed') {
        structuredHandoff = validRepaired;
      } else if (this.repairBehavior === 'contradict') {
        // Rewrites a field OTHER than findingResponses, which the real
        // repair path must detect and reject as a silent semantic rewrite.
        structuredHandoff = { ...validRepaired, summary: 'a different, unrequested summary' };
      } else if (this.repairBehavior === 'prose-fence') {
        // The real F002 dogfood failure shape: Claude prefaces its final
        // JSON with explanatory prose and wraps it in a markdown fence.
        structuredHandoff = null;
        rawStdout = `I'll proceed directly to producing the repaired JSON.\n\n\`\`\`json\n${JSON.stringify(validRepaired)}\n\`\`\`\n`;
      } else if (this.repairBehavior === 'whitespace-fence') {
        structuredHandoff = null;
        rawStdout = `   \n\n\`\`\`json\n${JSON.stringify(validRepaired)}\n\`\`\`\n   `;
      } else if (this.repairBehavior === 'ambiguous') {
        structuredHandoff = null;
        const variantB = {
          ...validRepaired,
          findingResponses: [{ ...validRepaired.findingResponses[0], verification: 'a different but still valid verification note' }],
        };
        rawStdout = `${JSON.stringify(validRepaired)}\n\nAlternatively:\n${JSON.stringify(variantB)}`;
      } else if (this.repairBehavior === 'invalid-json') {
        structuredHandoff = null;
        rawStdout = 'this is not JSON at all, just prose with no braces whatsoever';
      } else if (this.repairBehavior === 'schema-invalid') {
        structuredHandoff = null;
        const missingRequiredField: Record<string, unknown> = { ...(validRepaired as Record<string, unknown>) };
        delete missingRequiredField.filesChanged;
        rawStdout = JSON.stringify(missingRequiredField);
      }
    } else {
      structuredHandoff = { status: 'approved', findings: [] };
    }
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded', failureCode: null,
      exitCode: 0, signal: null, stdoutPath: join(request.artifactsDirectory, 'fake.stdout'),
      stderrPath: join(request.artifactsDirectory, 'fake.stderr'), structuredHandoff,
      ...(rawStdout === undefined ? {} : { rawStdout }),
      changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: now, endedAt: now, durationMs: 1, timedOut: false, aborted: false, errorMessage: null,
    };
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function setup(files = ['feature.txt', 'tests.txt', 'concurrency.txt']) {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, 'design.md'), '# design\n', 'utf8');
  for (const file of files) await writeFile(join(fixture.repository, file), 'original\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', 'design.md', ...files]);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'reviewed implementation']);
  const baseSha = (await fixture.git.run(fixture.repository, ['rev-parse', 'HEAD'])).stdout.trim();
  const runsRoot = join(fixture.container, 'runs');
  const source = await seedCanonicalSource({
    repository: fixture.repository, runsRoot, baseBranch: fixture.baseBranch, baseSha,
    review: canonicalReview(files),
  });
  return { fixture, baseSha, runsRoot, source };
}

test('valid canonical synthesis seeds a dry continuation plan without rerunning review shards or mutating state', async () => {
  const context = await setup();
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const beforeRun = await hashFile(context.source.store.statePath);
    const beforeArtifact = await hashFile(context.source.artifactPath);
    const plan = await planOrchestrationPhase(phaseFile, {
      repositoryPath: context.fixture.repository,
      runsRoot: context.runsRoot,
      agents: { codex: new ContinuationAgent('codex', context.runsRoot), claude: new ContinuationAgent('claude', context.runsRoot) },
    });
    assert.ok('strategy' in plan && plan.strategy === 'adaptive');
    assert.deepEqual(plan.preview.continuation?.findings.map((entry) => entry.finding.id), ['F001', 'F002', 'F003']);
    assert.deepEqual(plan.preview.workRequests.map((request) => request.role), ['correction', 'testing', 'testing']);
    assert.equal(plan.preview.workRequests.filter((request) => request.role === 'review' || request.role === 'synthesis').length, 0);
    assert.equal(plan.preview.workRequests.filter((request) => request.authorization?.findingReference === 'F001').length, 1);
    assert.match(renderPlan(plan), /Continuation: run-source-canonical \/ work-000003/);
    assert.match(renderPlan(plan), /F001 \(medium\/correctness\), F002 \(medium\/testing\), F003 \(low\/testing\)/);
    assert.deepEqual((await readdir(context.runsRoot)).sort(), [SOURCE_RUN_ID]);
    assert.equal(await hashFile(context.source.store.statePath), beforeRun);
    assert.equal(await hashFile(context.source.artifactPath), beforeArtifact);
  } finally {
    await context.fixture.dispose();
  }
});

test('continuation persists provenance before launch, applies policy-authorized corrections, and performs targeted read-only re-verification', async () => {
  const context = await setup();
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const sourceRunHash = await hashFile(context.source.store.statePath);
    const sourceArtifactHash = await hashFile(context.source.artifactPath);
    const codex = new ContinuationAgent('codex', context.runsRoot);
    const claude = new ContinuationAgent('claude', context.runsRoot);
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    assert.equal(codex.invocations.length + claude.invocations.length, 0);
    const initial = orchestrator.snapshot();
    assert.equal(initial.adaptive?.continuation?.sourceArtifactSha256, sourceArtifactHash);
    assert.equal(initial.adaptive?.workRequests.length, 3);
    assert.equal(initial.adaptive?.grantDecisions.length, 3);
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    assert.equal(codex.invocations.length, 3);
    assert.equal(claude.invocations.length, 3);
    assert.ok(claude.invocations.every((request) => request.role === 'review' && request.access === 'read_only'));
    assert.equal(completed.adaptive?.workRequests.filter((request) => request.authorization?.purpose === 'correction').length, 3);
    assert.equal(completed.adaptive?.workRequests.filter((request) => request.authorization?.findingReference === 'F001' && request.authorization?.purpose === 'correction').length, 1);
    assert.equal(completed.adaptive?.workRequests.filter((request) => request.authorization?.purpose === 'reverification').length, 3);
    assert.equal(await hashFile(context.source.store.statePath), sourceRunHash);
    assert.equal(await hashFile(context.source.artifactPath), sourceArtifactHash);
    const events = (await readFile(orchestrator.stateStore.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { name: string });
    const importIndex = events.findIndex((event) => event.name === 'ADAPTIVE_CANONICAL_FINDINGS_IMPORTED');
    const agentIndex = events.findIndex((event) => event.name === 'AGENT_STARTED');
    assert.ok(importIndex >= 0 && agentIndex > importIndex);
    await orchestrator.cleanup();
  } finally {
    await context.fixture.dispose();
  }
});

test('imported correction authority remains bounded by correctionPolicy', async () => {
  const context = await setup(['outside.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation-denied.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha, { correctionOwnership: ['feature.txt'] }), 'utf8');
    const plan = await planOrchestrationPhase(phaseFile, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot });
    assert.ok('strategy' in plan && plan.strategy === 'adaptive');
    assert.equal(plan.preview.workRequests.length, 1);
    assert.equal(plan.preview.grantDecisions[0]?.outcome, 'DENIED');
    assert.equal(plan.preview.grantDecisions[0]?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
  } finally {
    await context.fixture.dispose();
  }
});

test('continuation source validation fails closed for wrong base, missing run, wrong shard, failed unit, and malformed artifact', async (t) => {
  await t.test('wrong expected base', async () => {
    const context = await setup();
    try {
      const phaseFile = join(context.fixture.container, 'wrong-base.yaml');
      await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, 'a'.repeat(40)), 'utf8');
      await assert.rejects(planOrchestrationPhase(phaseFile, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot }), /base/i);
    } finally { await context.fixture.dispose(); }
  });
  await t.test('missing source run', async () => {
    const context = await setup();
    try {
      const phaseFile = join(context.fixture.container, 'missing.yaml');
      await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha, { sourceRunId: 'run-missing' }), 'utf8');
      await assert.rejects(planOrchestrationPhase(phaseFile, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot }), /Source run/);
    } finally { await context.fixture.dispose(); }
  });
  await t.test('non-canonical review shard', async () => {
    const context = await setup();
    try {
      const phaseFile = join(context.fixture.container, 'shard.yaml');
      await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha, { sourceWorkUnitId: 'work-000001' }), 'utf8');
      await assert.rejects(planOrchestrationPhase(phaseFile, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot }), /canonical review\/synthesis/);
    } finally { await context.fixture.dispose(); }
  });
  await t.test('artifact path owned by another work unit', async () => {
    const context = await setup();
    try {
      const loaded = await context.source.store.load();
      const wrongPath = join(context.source.store.runDirectory, 'reviews', 'work-000001.json');
      await writeFile(wrongPath, `${JSON.stringify(canonicalReview(), null, 2)}\n`, 'utf8');
      await context.source.store.save({
        ...loaded,
        tasks: {
          ...loaded.tasks,
          'work-000003': { ...loaded.tasks['work-000003']!, reviewPaths: [wrongPath] },
        },
      });
      const phaseFile = join(context.fixture.container, 'wrong-artifact.yaml');
      await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
      await assert.rejects(planOrchestrationPhase(phaseFile, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot }), /does not belong/);
    } finally { await context.fixture.dispose(); }
  });
  await t.test('failed source unit', async () => {
    const context = await setup();
    try {
      const loaded = await context.source.store.load();
      const state: RunState = {
        ...loaded,
        tasks: { ...loaded.tasks, 'work-000003': { ...loaded.tasks['work-000003']!, status: 'FAILED' } },
        adaptive: {
          ...loaded.adaptive!,
          workUnits: loaded.adaptive!.workUnits.map((unit) => unit.id === 'work-000003' ? { ...unit, status: 'FAILED' as const } : unit),
        },
      };
      await context.source.store.save(state);
      const phaseFile = join(context.fixture.container, 'failed.yaml');
      await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
      await assert.rejects(planOrchestrationPhase(phaseFile, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot }), /did not succeed/);
    } finally { await context.fixture.dispose(); }
  });
  await t.test('malformed artifact', async () => {
    const context = await setup();
    try {
      await writeFile(context.source.artifactPath, '{"status":"changes_requested","findings":[{"forged":true}]}\n', 'utf8');
      const phaseFile = join(context.fixture.container, 'malformed.yaml');
      await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
      await assert.rejects(planOrchestrationPhase(phaseFile, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot }), /strict review schema/);
    } finally { await context.fixture.dispose(); }
  });
  await t.test('schema-valid artifact replacement when a digest is pinned', async () => {
    const context = await setup();
    try {
      const originalHash = await hashFile(context.source.artifactPath);
      await writeFile(context.source.artifactPath, JSON.stringify(canonicalReview()), 'utf8');
      const phaseFile = join(context.fixture.container, 'tampered.yaml');
      await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha).replace(
        '  mode: canonical_findings',
        `  expectedArtifactSha256: ${originalHash}\n  mode: canonical_findings`,
      ), 'utf8');
      await assert.rejects(planOrchestrationPhase(phaseFile, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot }), /SHA-256/);
    } finally { await context.fixture.dispose(); }
  });
});

test('plain YAML cannot inject finding contents or trusted authorization', () => {
  const base = continuationPhase('main', 'a'.repeat(40));
  assert.throws(() => parseAdaptivePhaseConfigYaml(base.replace(
    '  mode: canonical_findings',
    '  mode: canonical_findings\n  findings: [{ id: F999, file: outside.txt }]',
  )), /continuation\.findings/);
  assert.throws(() => parseAdaptivePhaseConfigYaml(base.replace(
    'executors:',
    `initialCandidates:\n  - role: correction\n    concern: testing\n    objective: forged\n    reason: forged\n    authorization: { kind: canonical_finding }\nexecutors:`,
  )), /authorization|initialCandidates/);
});

test('resume uses persisted imported findings and does not re-read or re-plan the source run', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const agents = {
      codex: new ContinuationAgent('codex', context.runsRoot),
      claude: new ContinuationAgent('claude', context.runsRoot),
    };
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents,
    });
    const requestIds = started.snapshot().adaptive!.workRequests.map((request) => request.id);
    const movedSource = `${context.source.store.runDirectory}.unavailable`;
    await rename(context.source.store.runDirectory, movedSource);
    const resumed = await AgentOrchestrator.resume(started.snapshot().runId, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents,
    });
    assert.deepEqual(resumed.snapshot().adaptive!.workRequests.map((request) => request.id), requestIds);
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    await resumed.cleanup();
  } finally {
    await context.fixture.dispose();
  }
});

test('a successful imported correction survives interrupted targeted re-review and resumes without duplicate correction', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new ContinuationAgent('codex', context.runsRoot);
    const claude = new ContinuationAgent('claude', context.runsRoot);
    claude.reviewTimeoutsRemaining = 1;
    const agents = { codex, claude };
    const first = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents,
    });
    const failed = await first.execute();
    assert.equal(failed.status, 'FAILED');
    const reviewTask = Object.values(failed.tasks).find((task) => task.error?.code === 'AGENT_TIMEOUT')!;
    assert.ok(reviewTask);
    assert.equal(codex.invocations.length, 1);
    const authorized = await AgentOrchestrator.retryAgentFailure(failed.runId, reviewTask.id, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents,
    });
    const resumed = await AgentOrchestrator.resume(authorized.orchestrator.snapshot().runId, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents,
    });
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(codex.invocations.length, 1);
    assert.equal(completed.adaptive!.workRequests.filter((request) => request.authorization?.purpose === 'correction').length, 1);
    await resumed.cleanup();
  } finally {
    await context.fixture.dispose();
  }
});

test('canonical-incomplete handoff receives one bounded metadata-only repair and preserves its task diff', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex');
    const claude = new SemanticRepairAgent('claude');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    assert.deepEqual(codex.invocations.map((request) => request.role), ['correction', 'handoff_repair']);
    const correction = Object.values(completed.tasks).find((task) => task.commit !== undefined)!;
    assert.deepEqual(correction.commit?.changedFiles, ['feature.txt']);
    assert.equal(correction.handoffRepairAttempts.length, 1);
    assert.equal(correction.handoffRepairAttempts.at(-1)?.succeeded, true);
    assert.equal(correction.handoffRepairAttempts.at(-1)?.method, 'agent');
    assert.equal(correction.handoffRepairAttempts.at(-1)?.failureReason, undefined);
    assert.equal(typeof correction.handoffRepairAttempts.at(-1)?.timestamp, 'string');
    const handoff = JSON.parse(await readFile(correction.handoffPath!, 'utf8')) as { findingResponses: unknown[] };
    assert.equal(handoff.findingResponses.length, 1);
    await orchestrator.cleanup();
  } finally { await context.fixture.dispose(); }
});

test('semantic repair cannot fabricate resolved success without both diff and passing task evidence', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex', false);
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot,
      agents: { codex, claude: new SemanticRepairAgent('claude') },
    });
    const failed = await orchestrator.execute();
    assert.equal(failed.status, 'FAILED');
    assert.equal(codex.invocations.filter((request) => request.role === 'handoff_repair').length, 1);
    assert.equal(Object.values(failed.tasks)[0]?.error?.code, 'HANDOFF_INVALID');
    assert.equal(Object.values(failed.tasks)[0]?.commit, undefined);
    assert.match(await readFile(join(Object.values(failed.tasks)[0]!.worktreePath!, 'feature.txt'), 'utf8'), /corrected F001/);
    const failedRecord = Object.values(failed.tasks)[0]!.handoffRepairAttempts;
    assert.equal(failedRecord.length, 1);
    assert.equal(failedRecord[0]?.succeeded, false);
    assert.equal(failedRecord[0]?.failureReason, 'evidence_insufficient');
    // The failed task intentionally preserves its dirty worktree for operator inspection.
  } finally { await context.fixture.dispose(); }
});

test('a repair agent that cannot even be invoked classifies as agent_invocation_failed', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex', true, 'throw');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot,
      agents: { codex, claude: new SemanticRepairAgent('claude') },
    });
    const failed = await orchestrator.execute();
    assert.equal(failed.status, 'FAILED');
    assert.equal(codex.invocations.filter((request) => request.role === 'handoff_repair').length, 1);
    assert.equal(Object.values(failed.tasks)[0]?.error?.code, 'HANDOFF_INVALID');
    assert.equal(Object.values(failed.tasks)[0]?.commit, undefined);
    const record = Object.values(failed.tasks)[0]!.handoffRepairAttempts;
    assert.equal(record.length, 1);
    assert.equal(record[0]?.succeeded, false);
    assert.equal(record[0]?.failureReason, 'agent_invocation_failed');
    assert.equal(record[0]?.method, 'none');
  } finally { await context.fixture.dispose(); }
});

test('a repair agent that silently rewrites original handoff content classifies as contradiction_detected', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex', true, 'contradict');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot,
      agents: { codex, claude: new SemanticRepairAgent('claude') },
    });
    const failed = await orchestrator.execute();
    assert.equal(failed.status, 'FAILED');
    assert.equal(codex.invocations.filter((request) => request.role === 'handoff_repair').length, 1);
    assert.equal(Object.values(failed.tasks)[0]?.error?.code, 'HANDOFF_INVALID');
    assert.equal(Object.values(failed.tasks)[0]?.commit, undefined);
    const record = Object.values(failed.tasks)[0]!.handoffRepairAttempts;
    assert.equal(record.length, 1);
    assert.equal(record[0]?.succeeded, false);
    assert.equal(record[0]?.failureReason, 'contradiction_detected');
  } finally { await context.fixture.dispose(); }
});


// --- Provider-neutral handoff repair routing (recovery policy executors) ---

test('handoff repair routes to a configured recovery executor instead of the original task owner, which stays unchanged', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex');
    const claude = new SemanticRepairAgent('claude');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    const runId = started.snapshot().runId;

    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      executors: [{
        id: 'metadata-repairer', adapter: 'claude', roles: ['handoff_repair'],
        capabilities: [{ capability: 'handoff_repair' }], available: true,
      }],
    }, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude } });

    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));

    // Codex is still the task's writer (correction), but handoff_repair must
    // have gone to claude, the configured recovery executor — never codex.
    assert.deepEqual(codex.invocations.map((request) => request.role), ['correction']);
    assert.equal(claude.invocations.filter((request) => request.role === 'handoff_repair').length, 1);

    const correction = Object.values(completed.tasks).find((task) => task.commit !== undefined)!;
    assert.equal(correction.agentAttempts[0]?.agent, 'codex', 'the original task owner fact is unchanged');
    const record = correction.handoffRepairAttempts.at(-1);
    assert.equal(record?.succeeded, true);
    assert.equal(record?.repairExecutorId, 'metadata-repairer');
    assert.equal(record?.repairAdapter, 'claude');
  } finally { await context.fixture.dispose(); }
});

test('with no recovery policy authorized, handoff repair falls back to task.owner and still records repair executor identity', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex');
    const claude = new SemanticRepairAgent('claude');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    assert.equal(codex.invocations.filter((request) => request.role === 'handoff_repair').length, 1);
    const correction = Object.values(completed.tasks).find((task) => task.commit !== undefined)!;
    const record = correction.handoffRepairAttempts.at(-1);
    assert.equal(record?.repairExecutorId, 'codex');
    assert.equal(record?.repairAdapter, 'codex');
  } finally { await context.fixture.dispose(); }
});

test('explicitly configured recovery executors with none eligible fail closed WITHOUT consuming an agent call', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex');
    const claude = new SemanticRepairAgent('claude');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    const runId = started.snapshot().runId;

    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      executors: [{
        id: 'unavailable-repairer', adapter: 'claude', roles: ['handoff_repair'],
        capabilities: [{ capability: 'handoff_repair' }], available: false,
      }],
    }, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude } });

    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    const failed = await resumed.execute();
    assert.equal(failed.status, 'FAILED');
    assert.equal(codex.invocations.filter((request) => request.role === 'handoff_repair').length, 0, 'the original owner must never be silently used once executors are explicitly configured');
    assert.equal(claude.invocations.filter((request) => request.role === 'handoff_repair').length, 0, 'no configured executor was eligible, so no agent call is consumed at all');
    const correction = Object.values(failed.tasks).find((task) => task.error?.code === 'HANDOFF_INVALID')!;
    assert.equal(correction.handoffRepairAttempts.at(-1)?.failureReason, 'no_eligible_recovery_executor');
    assert.equal(correction.handoffRepairAttempts.at(-1)?.repairExecutorId, undefined);
  } finally { await context.fixture.dispose(); }
});

test('a configured executor whose declared capabilities omit handoff_repair is a capability mismatch and fails closed', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex');
    const claude = new SemanticRepairAgent('claude');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    const runId = started.snapshot().runId;

    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      executors: [{
        id: 'wrong-capability-repairer', adapter: 'claude', roles: ['handoff_repair'],
        capabilities: [{ capability: 'some_other_capability' }], available: true,
      }],
    }, { repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude } });

    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    const failed = await resumed.execute();
    assert.equal(failed.status, 'FAILED');
    assert.equal(claude.invocations.filter((request) => request.role === 'handoff_repair').length, 0);
    assert.equal(codex.invocations.filter((request) => request.role === 'handoff_repair').length, 0);
    const correction = Object.values(failed.tasks).find((task) => task.error?.code === 'HANDOFF_INVALID')!;
    assert.equal(correction.handoffRepairAttempts.at(-1)?.failureReason, 'no_eligible_recovery_executor');
  } finally { await context.fixture.dispose(); }
});


// --- Repair-output framing: deterministic extraction of the repair
// agent's OWN response, reusing the exact same structured-output helper
// the live handoff-repair cascade already applies to the ORIGINAL agent's
// output ---

test('repair output framing: prose followed by a single fenced JSON object is extracted deterministically and succeeds', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex', true, 'prose-fence');
    const claude = new SemanticRepairAgent('claude');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot, agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    assert.equal(codex.invocations.filter((request) => request.role === 'handoff_repair').length, 1, 'no second repair attempt — one bounded call only');
    const correction = Object.values(completed.tasks).find((task) => task.commit !== undefined)!;
    const record = correction.handoffRepairAttempts.at(-1);
    assert.equal(record?.succeeded, true);
    assert.equal(record?.method, 'agent');
    // Framing extraction never touches the worktree — the diff codex wrote
    // during the (unrelated) correction step is exactly what it was.
    assert.equal(await readFile(join(correction.worktreePath!, 'feature.txt'), 'utf8'), 'corrected F001\n');
  } finally { await context.fixture.dispose(); }
});

test('repair output framing: surrounding whitespace plus a fenced JSON object still succeeds', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex', true, 'whitespace-fence');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot,
      agents: { codex, claude: new SemanticRepairAgent('claude') },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    const correction = Object.values(completed.tasks).find((task) => task.commit !== undefined)!;
    assert.equal(correction.handoffRepairAttempts.at(-1)?.succeeded, true);
  } finally { await context.fixture.dispose(); }
});

test('repair output framing: two plausible JSON candidates is genuine ambiguity and fails closed as repair_output_invalid', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex', true, 'ambiguous');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot,
      agents: { codex, claude: new SemanticRepairAgent('claude') },
    });
    const failed = await orchestrator.execute();
    assert.equal(failed.status, 'FAILED');
    assert.equal(codex.invocations.filter((request) => request.role === 'handoff_repair').length, 1);
    const correction = Object.values(failed.tasks).find((task) => task.error?.code === 'HANDOFF_INVALID')!;
    assert.equal(correction.commit, undefined);
    assert.equal(correction.handoffRepairAttempts.at(-1)?.failureReason, 'repair_output_invalid');
  } finally { await context.fixture.dispose(); }
});

test('repair output framing: non-JSON prose with no braces fails closed as repair_output_invalid', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex', true, 'invalid-json');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot,
      agents: { codex, claude: new SemanticRepairAgent('claude') },
    });
    const failed = await orchestrator.execute();
    assert.equal(failed.status, 'FAILED');
    const correction = Object.values(failed.tasks).find((task) => task.error?.code === 'HANDOFF_INVALID')!;
    assert.equal(correction.commit, undefined);
    assert.equal(correction.handoffRepairAttempts.at(-1)?.failureReason, 'repair_output_invalid');
  } finally { await context.fixture.dispose(); }
});

test('repair output framing: structurally valid JSON missing a required field fails closed as repair_output_invalid, not evidence_insufficient', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex', true, 'schema-invalid');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot,
      agents: { codex, claude: new SemanticRepairAgent('claude') },
    });
    const failed = await orchestrator.execute();
    assert.equal(failed.status, 'FAILED');
    const correction = Object.values(failed.tasks).find((task) => task.error?.code === 'HANDOFF_INVALID')!;
    assert.equal(correction.handoffRepairAttempts.at(-1)?.failureReason, 'repair_output_invalid');
  } finally { await context.fixture.dispose(); }
});

test('repair output framing: routing/executor identity is still recorded on a failed agent-tier attempt', async () => {
  const context = await setup(['feature.txt']);
  try {
    const phaseFile = join(context.fixture.container, 'continuation.yaml');
    await writeFile(phaseFile, continuationPhase(context.fixture.baseBranch, context.baseSha), 'utf8');
    const codex = new SemanticRepairAgent('codex', true, 'invalid-json');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: context.fixture.repository, runsRoot: context.runsRoot,
      agents: { codex, claude: new SemanticRepairAgent('claude') },
    });
    const failed = await orchestrator.execute();
    const correction = Object.values(failed.tasks).find((task) => task.error?.code === 'HANDOFF_INVALID')!;
    const record = correction.handoffRepairAttempts.at(-1);
    // No recovery policy was authorized, so routing fell back to the
    // original owner (codex) — but the identity is still recorded, even
    // though the attempt failed, because routing genuinely resolved an
    // executor before the output turned out to be unusable.
    assert.equal(record?.repairExecutorId, 'codex');
    assert.equal(record?.repairAdapter, 'codex');
  } finally { await context.fixture.dispose(); }
});
