import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentRequest, AgentResult } from '../../src/agents';
import { renderPlan, renderStatus } from '../../src/cli';
import { AgentOrchestrator, planOrchestrationPhase } from '../../src/orchestrator';
import { StateStore } from '../../src/state';
import { createTemporaryRepository } from '../git/helpers';

class AdaptiveAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(
    readonly name: 'codex' | 'claude',
    private readonly reviewStatus: 'approved' | 'changes_requested' = 'approved',
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    await request.onStarted?.(process.pid);
    let output: unknown;
    if (request.role === 'implementation') {
      await writeFile(join(request.worktreePath, 'feature.txt'), 'adaptive\n', 'utf8');
      output = {
        status: 'complete', summary: 'implemented', filesChanged: ['feature.txt'],
        decisions: [], tests: [], openQuestions: [], reviewRequested: [],
        additionalWorkRequests: ['correctness', 'security'].map((concern) => ({
          role: 'review', concern: 'review', objective: `Inspect ${concern} in the concrete implementation diff`,
          reason: `The completed implementation supplies ${concern} evidence`,
          dependencies: [], capabilities: [{ capability: 'review' }],
          resourceClaims: [{ kind: 'repository_path', key: 'feature.txt', mode: 'read' }],
          evidence: [{ kind: 'diff', reference: 'feature.txt', summary: `${concern} review target` }],
          risk: 'low', priority: 60,
        })),
      };
    } else {
      output = this.reviewStatus === 'approved' ? { status: 'approved', findings: [] } : {
        status: 'changes_requested',
        findings: [{
          id: 'F001', severity: 'high', category: 'correctness', file: 'feature.txt',
          location: 'line 1', problem: 'Concrete defect', evidence: 'Observed output',
          impact: 'Incorrect behavior', suggestedFix: 'Correct it', verificationRequired: 'Focused test',
        }],
      };
    }
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId,
      status: 'succeeded', exitCode: 0, signal: null,
      stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout`),
      stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr`),
      structuredHandoff: output, changedFiles: [], gitDiffSummary: null,
      testsReported: [], unresolvedQuestions: [], startedAt: now, endedAt: now,
      durationMs: 0, timedOut: false, aborted: false,
      failureCode: null, errorMessage: null,
    };
  }
}

class TimeoutAgent implements Agent {
  readonly name = 'codex' as const;
  calls = 0;
  async run(request: AgentRequest): Promise<AgentResult> {
    this.calls += 1;
    await request.onStarted?.(process.pid);
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId,
      status: 'timed_out', failureCode: 'AGENT_TIMEOUT', errorMessage: 'bounded timeout',
      exitCode: null, signal: 'SIGTERM', stdoutPath: join(request.artifactsDirectory, 'timeout.stdout'),
      stderrPath: join(request.artifactsDirectory, 'timeout.stderr'), structuredHandoff: null,
      changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: now, endedAt: now, durationMs: 1, timedOut: true, aborted: false,
    };
  }
}

function adaptivePhase(baseBranch: string): string {
  return `mode: adaptive
phase: adaptive-test
name: Adaptive production wiring
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
goal: Implement and independently verify one bounded change
constraints:
  - Do not touch unrelated files
policy:
  allowedConcerns: [implementation, review, synthesis]
  allowedOwnership: [feature.txt]
  allowedResources: []
  limits:
    maxConcurrentAgents: 2
    maxAgentInvocations: 6
    maxTotalWorkUnits: 6
    maxDecompositionDepth: 2
    maxFanOutPerWorkUnit: 3
    maxSynthesisInputs: 2
    maxWallClockMs: 600000
  requireEvidenceForExpansion: true
  agingIntervalMs: 1000
  agingStep: 1
  humanApprovalRisks: [critical]
initialCandidates:
  - role: implementation
    concern: implementation
    objective: Implement feature
    reason: The configured phase requires the feature
    evidence:
      - kind: file
        reference: design.md
        summary: Canonical contract
    resourceClaims:
      - kind: repository_path
        key: feature.txt
        mode: write
    capabilities:
      - capability: typescript
    risk: medium
    priority: 80
  - role: final_review
    concern: review
    objective: Verify feature
    reason: Independent evidence gate
    dependencies: [request-000001]
    evidence:
      - kind: file
        reference: design.md
        summary: Review invariant
    resourceClaims:
      - kind: repository_path
        key: feature.txt
        mode: read
    capabilities:
      - capability: review
    risk: medium
    priority: 70
executors:
  - id: codex-writer
    adapter: codex
    capabilities: [{ capability: typescript }]
    roles: [implementation]
    effort: high
  - id: claude-reviewer
    adapter: claude
    capabilities: [{ capability: review }, { capability: synthesis }]
    roles: [review, synthesis, final_review]
    effort: high
agentRetries: 1
agentTimeoutMs: 60000
integration:
  commands:
    - command: test -f feature.txt
      required: true
  diagnostics: []
`;
}

test('adaptive plan is a true dry run with explicit deterministic decisions', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'design']);
    const phaseFile = join(fixture.container, 'adaptive.yaml');
    const runsRoot = join(fixture.container, 'runs');
    await writeFile(phaseFile, adaptivePhase(fixture.baseBranch), 'utf8');
    const plan = await planOrchestrationPhase(phaseFile, { repositoryPath: fixture.repository, runsRoot });
    assert.ok('strategy' in plan && plan.strategy === 'adaptive');
    assert.equal(plan.preview.workRequests.length, 2);
    assert.equal(plan.preview.grantDecisions[0]?.outcome, 'GRANTED');
    assert.equal(plan.preview.grantDecisions[1]?.reason, 'DEPENDENCY_NOT_READY');
    const rendered = renderPlan(plan);
    assert.match(rendered, /Strategy: adaptive/);
    assert.match(rendered, /Canonical contract/);
    assert.match(rendered, /DEPENDENCY_NOT_READY/);
    assert.match(rendered, /Maximum possible concurrency: 1/);
    await assert.rejects(readFile(runsRoot, 'utf8'));
    assert.equal((await fixture.git.run(fixture.repository, ['worktree', 'list', '--porcelain'])).stdout.match(/^worktree /gm)?.length, 1);
  } finally {
    await fixture.dispose();
  }
});

test('adaptive run persists before launch, grants before routing, executes through existing engine, and gates integration', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'design']);
    const phaseFile = join(fixture.container, 'adaptive.yaml');
    const runsRoot = join(fixture.container, 'runs');
    await writeFile(phaseFile, adaptivePhase(fixture.baseBranch), 'utf8');
    const codex = new AdaptiveAgent('codex');
    const claude = new AdaptiveAgent('claude');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex, claude },
    });
    const before = orchestrator.snapshot();
    assert.equal(before.strategy, 'adaptive');
    assert.ok(before.adaptive);
    assert.equal(before.adaptive.workUnits[0]?.status, 'GRANTED');
    assert.equal(before.adaptive.workUnits[0]?.route?.executorId, 'codex-writer');
    assert.equal(codex.invocations.length + claude.invocations.length, 0);
    const persistedBefore = await new StateStore(runsRoot, before.runId).load();
    assert.deepEqual(persistedBefore.adaptive, before.adaptive);
    assert.match(renderStatus(before), /"strategy": "adaptive"/);
    assert.match(renderStatus(before), /"route"/);

    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.integration.status, 'SUCCEEDED');
    assert.deepEqual(completed.adaptive?.workUnits.map((unit) => unit.status), ['SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED', 'SUCCEEDED']);
    assert.equal(codex.invocations.length, 1);
    assert.equal(claude.invocations.length, 4);
    assert.equal(claude.invocations[0]?.access, 'read_only');
    assert.match(String((claude.invocations[0]?.taskSpecification as { actualDependencyDiff?: string }).actualDependencyDiff), /feature.txt/);
    assert.equal(claude.invocations.find((request) => request.role === 'synthesis')?.access, 'read_only');
    assert.equal(completed.adaptive?.workRequests.filter((request) => request.role === 'synthesis').length, 1);
    assert.equal(await readFile(join(completed.integration.worktreePath!, 'feature.txt'), 'utf8'), 'adaptive\n');
    assert.equal(completed.integration.integratedTaskCommits.length, 1);
    await orchestrator.cleanup();
  } finally {
    await fixture.dispose();
  }
});

test('adaptive resume reconstructs persisted topology without re-planning or duplicating request ids', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'design']);
    const phaseFile = join(fixture.container, 'adaptive.yaml');
    const runsRoot = join(fixture.container, 'runs');
    await writeFile(phaseFile, adaptivePhase(fixture.baseBranch), 'utf8');
    const first = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new AdaptiveAgent('codex'), claude: new AdaptiveAgent('claude') },
    });
    const requestIds = first.snapshot().adaptive!.workRequests.map((request) => request.id);
    const resumed = await AgentOrchestrator.resume(first.snapshot().runId, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new AdaptiveAgent('codex'), claude: new AdaptiveAgent('claude') },
    });
    assert.deepEqual(resumed.snapshot().adaptive!.workRequests.map((request) => request.id), requestIds);
    assert.equal(resumed.snapshot().baseSha, first.snapshot().baseSha);
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.deepEqual(completed.adaptive!.workRequests.slice(0, 2).map((request) => request.id), requestIds);
    await resumed.cleanup();
  } finally {
    await fixture.dispose();
  }
});

test('adaptive phase schema rejects provider self-selection and unsupported fields', async () => {
  const fixture = await createTemporaryRepository();
  try {
    const phaseFile = join(fixture.container, 'bad-adaptive.yaml');
    await mkdir(fixture.container, { recursive: true });
    await writeFile(phaseFile, `${adaptivePhase(fixture.baseBranch)}provider: claude\n`, 'utf8');
    await assert.rejects(
      planOrchestrationPhase(phaseFile, { repositoryPath: fixture.repository }),
      (error: unknown) => (error as { code?: string }).code === 'CONFIG_INVALID',
    );
  } finally {
    await fixture.dispose();
  }
});

test('denied and human-approval requests never route or invoke an agent', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'design']);
    const runsRoot = join(fixture.container, 'runs');
    const agent = new AdaptiveAgent('codex');
    for (const [name, source, expectedReason] of [
      ['denied', adaptivePhase(fixture.baseBranch).replace(/evidence:\n      - kind: file\n        reference: design.md\n        summary: Canonical contract/, 'evidence: []'), 'INSUFFICIENT_EVIDENCE'],
      ['human', adaptivePhase(fixture.baseBranch).replace('risk: medium\n    priority: 80', 'risk: critical\n    priority: 80'), 'HUMAN_APPROVAL_REQUIRED'],
    ] as const) {
      const phaseFile = join(fixture.container, `${name}.yaml`);
      await writeFile(phaseFile, source, 'utf8');
      const orchestrator = await AgentOrchestrator.start(phaseFile, {
        repositoryPath: fixture.repository, runsRoot, agents: { codex: agent, claude: new AdaptiveAgent('claude') },
      });
      const decision = orchestrator.snapshot().adaptive!.grantDecisions.find((item) => item.requestId === 'request-000001');
      assert.equal(decision?.reason, expectedReason);
      assert.equal(orchestrator.snapshot().adaptive!.workUnits.some((unit) => unit.requestId === 'request-000001'), false);
      const stopped = await orchestrator.execute();
      assert.equal(stopped.status, 'BLOCKED');
    }
    assert.equal(agent.invocations.length, 0);
  } finally {
    await fixture.dispose();
  }
});

test('adaptive timeout retry reopens only the stable failed unit and preserves request history', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'design']);
    const phaseFile = join(fixture.container, 'adaptive-retry.yaml');
    const runsRoot = join(fixture.container, 'runs');
    await writeFile(phaseFile, adaptivePhase(fixture.baseBranch).replace('agentRetries: 1', 'agentRetries: 0'), 'utf8');
    const timeout = new TimeoutAgent();
    const first = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: timeout, claude: new AdaptiveAgent('claude') },
    });
    const failed = await first.execute();
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.adaptive!.workUnits[0]?.status, 'TIMED_OUT');
    const requestsBefore = structuredClone(failed.adaptive!.workRequests);
    const retry = await AgentOrchestrator.retryAgentFailure(failed.runId, 'work-000001', {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new AdaptiveAgent('codex'), claude: new AdaptiveAgent('claude') },
    });
    assert.equal(retry.orchestrator.snapshot().adaptive!.workUnits[0]?.status, 'GRANTED');
    assert.deepEqual(retry.orchestrator.snapshot().adaptive!.workRequests, requestsBefore);
    const resumed = await AgentOrchestrator.resume(failed.runId, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new AdaptiveAgent('codex'), claude: new AdaptiveAgent('claude') },
    });
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.adaptive!.workUnits[0]?.attempts.length, 2);
    assert.equal(timeout.calls, 1);
    await resumed.cleanup();
  } finally {
    await fixture.dispose();
  }
});

test('adaptive resume fails closed when the immutable base branch moved', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'design']);
    const phaseFile = join(fixture.container, 'adaptive-base.yaml');
    const runsRoot = join(fixture.container, 'runs');
    await writeFile(phaseFile, adaptivePhase(fixture.baseBranch), 'utf8');
    const first = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new AdaptiveAgent('codex'), claude: new AdaptiveAgent('claude') },
    });
    await writeFile(join(fixture.repository, 'moved.txt'), 'move\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'moved.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'move base']);
    await assert.rejects(
      AgentOrchestrator.resume(first.snapshot().runId, {
        repositoryPath: fixture.repository, runsRoot,
        agents: { codex: new AdaptiveAgent('codex'), claude: new AdaptiveAgent('claude') },
      }),
      (error: unknown) => (error as { code?: string }).code === 'BASE_BRANCH_MOVED',
    );
  } finally {
    await fixture.dispose();
  }
});

test('adaptive review cannot silently pass the deterministic gate with unresolved findings', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'design']);
    const phaseFile = join(fixture.container, 'adaptive-findings.yaml');
    await writeFile(phaseFile, adaptivePhase(fixture.baseBranch), 'utf8');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot: join(fixture.container, 'runs'),
      agents: { codex: new AdaptiveAgent('codex'), claude: new AdaptiveAgent('claude', 'changes_requested') },
    });
    const stopped = await orchestrator.execute();
    assert.equal(stopped.status, 'BLOCKED');
    assert.equal(stopped.integration.status, 'PENDING');
    assert.equal(stopped.errors.some((error) => error.code === 'BLOCKED_FOR_HUMAN_REVIEW'), true);
  } finally {
    await fixture.dispose();
  }
});
