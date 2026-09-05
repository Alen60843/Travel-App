import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import type { GitClient } from '../../src/git';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunState, TaskRunState } from '../../src/state';
import { createTemporaryRepository } from '../git/helpers';

/**
 * The Recovery Execution Budget Epoch, end to end: the real
 * run-20260904124350-dc56690c shape — F001/F002 corrections recovered via
 * the adaptive-recovery reconciliation fix, but their targeted
 * re-verification requests (analogues of request-000007/000008) born
 * DENIED/WALL_CLOCK_BUDGET_EXCEEDED because the ORIGINAL run's own
 * maxWallClockMs was already exhausted by the time reconciliation
 * materialized them. An authorized recoveryBudget overlay must safely
 * re-arbitrate exactly those two requests (append-only — the original
 * denial is never rewritten) while leaving unrelated
 * OUTSIDE_ALLOWED_OWNERSHIP-denied proposals (the "PostgreSQL testing
 * proposals" analogue) and F003's already-successful correction/
 * re-verification completely untouched.
 *
 * A controllable fake clock (not a real wall-clock wait) drives both the
 * original-budget exhaustion and the recovery epoch's own elapsed-time
 * checks deterministically.
 */

class ReconciliationAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(readonly name: AgentName, private readonly failFiles: readonly string[] = []) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    await request.onStarted?.(process.pid);
    let structuredHandoff: unknown;
    if (request.role === 'final_review') {
      structuredHandoff = {
        status: 'changes_requested',
        findings: [
          {
            id: 'F001', severity: 'medium', category: 'correctness', file: 'f001.txt', location: 'line 1',
            problem: 'F001 problem', evidence: 'F001 evidence', impact: 'F001 impact',
            suggestedFix: 'fix F001', verificationRequired: 'check f001.txt',
          },
          {
            id: 'F002', severity: 'medium', category: 'testing', file: 'f002.txt', location: 'line 1',
            problem: 'F002 problem', evidence: 'F002 evidence', impact: 'F002 impact',
            suggestedFix: 'fix F002', verificationRequired: 'check f002.txt',
          },
          {
            id: 'F003', severity: 'low', category: 'testing', file: 'f003.txt', location: 'line 1',
            problem: 'F003 problem', evidence: 'F003 evidence', impact: 'F003 impact',
            suggestedFix: 'fix F003', verificationRequired: 'check f003.txt',
          },
        ],
        // The "two unrelated PostgreSQL testing proposals" analogue: outside
        // the phase's allowedResources, so they are denied for ownership —
        // never touched by recovery-budget authorization. Evidence
        // deliberately does NOT reference F001/F002/F003: reconcileAdaptiveCorrectionFlow
        // adopts an agent proposal as a finding's OWN canonical correction
        // template whenever it is role correction/testing, has a write
        // claim, AND its evidence references that finding's id — these
        // proposals must stay genuinely unrelated, not accidentally hijack
        // F001/F002's real canonical correction requests.
        additionalWorkRequests: [
          {
            role: 'testing', concern: 'testing', objective: 'PostgreSQL concurrency proposal 1',
            reason: 'untrusted agent proposal', dependencies: [], capabilities: [{ capability: 'testing' }],
            resourceClaims: [{ kind: 'database', key: 'tripwith-postgres', mode: 'write' }],
            evidence: [{ kind: 'finding', reference: 'PG-CONCURRENCY-1', summary: 'agent-proposed database test' }],
            risk: 'medium', priority: 40,
          },
          {
            role: 'testing', concern: 'testing', objective: 'PostgreSQL concurrency proposal 2',
            reason: 'untrusted agent proposal', dependencies: [], capabilities: [{ capability: 'testing' }],
            resourceClaims: [{ kind: 'database', key: 'tripwith-postgres', mode: 'write' }],
            evidence: [{ kind: 'finding', reference: 'PG-CONCURRENCY-2', summary: 'agent-proposed database test' }],
            risk: 'medium', priority: 40,
          },
        ],
      };
    } else if (request.role === 'correction' || request.role === 'testing') {
      const target = request.allowedFileOwnership[0]!;
      if (this.failFiles.includes(target)) {
        throw new Error(`simulated agent failure for ${target}`);
      }
      await writeFile(join(request.worktreePath, target), `corrected ${target}\n`, 'utf8');
      const spec = request.taskSpecification as {
        requiredCanonicalFindings: Array<{ findingId: string; canonicalFindingKey: string }>;
      };
      const required = spec.requiredCanonicalFindings[0]!;
      structuredHandoff = {
        status: 'complete', summary: `corrected ${target}`, filesChanged: [target], decisions: [],
        tests: [], openQuestions: [], reviewRequested: [`targeted ${required.findingId}`],
        findingResponses: [{
          findingId: required.findingId, canonicalFindingKey: required.canonicalFindingKey,
          decision: 'confirmed', resolution: 'resolved', evidence: 'reproduced', fix: 'corrected', verification: 'checked',
        }],
      };
    } else {
      structuredHandoff = { status: 'approved', findings: [] };
    }
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded', failureCode: null,
      exitCode: 0, signal: null,
      stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout`),
      stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr`),
      structuredHandoff, changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: now, endedAt: now, durationMs: 1, timedOut: false, aborted: false, errorMessage: null,
    };
  }
}

function phaseYaml(baseBranch: string): string {
  return `mode: adaptive
phase: recovery-execution-budget-epoch
name: Recovery execution budget epoch
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
goal: Review and correct three canonical findings
constraints: [Use only canonical evidence]
policy:
  allowedConcerns: [review, testing]
  allowedOwnership: ['**']
  allowedResources: []
  limits:
    maxConcurrentAgents: 4
    maxAgentInvocations: 20
    maxTotalWorkUnits: 20
    maxDecompositionDepth: 2
    maxFanOutPerWorkUnit: 3
    maxSynthesisInputs: 4
    maxWallClockMs: 1000
  requireEvidenceForExpansion: true
  agingIntervalMs: 1000
  agingStep: 1
  humanApprovalRisks: []
  correctionPolicy:
    allowedOwnership: ['**']
    allowedRoles: [correction, testing]
    requireCanonicalFinding: true
    maxRounds: 2
initialCandidates:
  - role: final_review
    concern: review
    objective: Canonical review
    reason: Independent verdict is required
    evidence: [{ kind: file, reference: design.md, summary: implementation }]
    resourceClaims: [{ kind: repository_path, key: design.md, mode: read }]
    capabilities: [{ capability: review }]
    risk: medium
    priority: 90
executors:
  - id: writer
    adapter: codex
    capabilities: [{ capability: typescript_backend_editing }, { capability: testing }]
    roles: [correction, testing]
    effort: high
  - id: reviewer
    adapter: claude
    capabilities: [{ capability: review }]
    roles: [review, final_review]
    effort: high
agentRetries: 0
agentTimeoutMs: 60000
integration:
  commands:
    - command: "true"
      required: true
  diagnostics: []
`;
}

class FakeClock {
  constructor(private value: Date = new Date('2026-01-01T00:00:00.000Z')) {}
  now = (): Date => this.value;
  advance(ms: number): void { this.value = new Date(this.value.getTime() + ms); }
}

async function setUp() {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
  await writeFile(join(fixture.repository, 'f001.txt'), 'base\n', 'utf8');
  await writeFile(join(fixture.repository, 'f002.txt'), 'base\n', 'utf8');
  await writeFile(join(fixture.repository, 'f003.txt'), 'base\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'f001.txt', 'f002.txt', 'f003.txt']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'baseline']);
  const runsRoot = join(fixture.container, 'runs');
  const phaseFile = join(fixture.container, 'phase.yaml');
  await writeFile(phaseFile, phaseYaml(fixture.baseBranch), 'utf8');
  const clock = new FakeClock();
  const codex = new ReconciliationAgent('codex', ['f001.txt', 'f002.txt']);
  const claude = new ReconciliationAgent('claude', ['f001.txt', 'f002.txt']);
  const orchestrator = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository, runsRoot, agents: { codex, claude }, clock: clock.now,
  });
  const runId = orchestrator.snapshot().runId;
  // Live: F003 succeeds fully (including its own targeted re-verification);
  // F001/F002 fail for real (a thrown agent error), well within the
  // original 1-second wall-clock budget.
  const completed = await orchestrator.execute();
  return { fixture, runsRoot, runId, completed, clock };
}

function findByFile(state: RunState, file: string): { taskId: string; unitId: string } {
  const unit = state.adaptive!.workUnits.find((candidate) => candidate.resourceClaims.some((claim) => claim.key === file))!;
  return { taskId: unit.id, unitId: unit.id };
}

function reverificationRequest(state: RunState, canonicalFindingKey: string) {
  return state.adaptive!.workRequests.find((request) =>
    request.authorization?.purpose === 'reverification' && request.authorization.canonicalFindingKey === canonicalFindingKey);
}

function latestDecisionFor(state: RunState, requestId: string) {
  return [...state.adaptive!.grantDecisions].reverse().find((d) => d.requestId === requestId);
}

function activeEpochOf(state: RunState) {
  return state.adaptive!.recoveryEpochs?.find((epoch) => epoch.number === state.adaptive!.activeRecoveryEpochNumber);
}

async function markRecovered(
  orchestrator: AgentOrchestrator,
  git: GitClient,
  taskId: string,
  file: string,
  kind: 'salvage' | 'handoff_repair',
): Promise<void> {
  const before = await orchestrator.stateStore.load();
  const task = before.tasks[taskId]!;
  const handoffPath = join(orchestrator.stateStore.runDirectory, 'handoffs', `${taskId}.json`);
  const { mkdir } = await import('node:fs/promises');
  await mkdir(join(orchestrator.stateStore.runDirectory, 'handoffs'), { recursive: true });
  await writeFile(handoffPath, JSON.stringify({
    status: 'complete', summary: `recovered ${taskId}`, filesChanged: [file], decisions: [],
    tests: [], openQuestions: [], reviewRequested: [],
  }), 'utf8');
  // A real commit — later steps (a targeted review's actual diff/worktree
  // prep) need a real, resolvable SHA, not a synthetic placeholder.
  await writeFile(join(task.worktreePath!, file), `corrected ${file}\n`, 'utf8');
  await git.run(task.worktreePath!, ['add', '--', file]);
  await git.run(task.worktreePath!, ['commit', '-m', `recovered ${taskId}`]);
  const commitSha = (await git.run(task.worktreePath!, ['rev-parse', 'HEAD'])).stdout.trim();
  const recovered: TaskRunState = kind === 'salvage'
    ? {
        ...task, status: 'SUCCEEDED', handoffPath,
        commit: { sha: commitSha, parentSha: before.baseSha, changedFiles: [file] },
        salvage: {
          authorizedAt: before.createdAt,
          verification: { worktreeHeadSha: before.baseSha, trackedDiffFingerprint: 'fp', verifyConfigFingerprint: 'cfg', result: 'passed' },
        },
      }
    : {
        ...task, status: 'SUCCEEDED', handoffPath,
        commit: { sha: commitSha, parentSha: before.baseSha, changedFiles: [file] },
        handoffRepairAttempts: [
          ...task.handoffRepairAttempts,
          { method: 'agent', succeeded: true, timestamp: before.createdAt, repairExecutorId: 'metadata-repairer', repairAdapter: 'claude' },
        ],
      };
  await orchestrator.stateStore.save({ ...before, tasks: { ...before.tasks, [taskId]: recovered } });
}

test('real-dogfood-shaped acceptance: F001/F002 re-verification requests born WALL_CLOCK-denied become eligible after an authorized recovery epoch, PostgreSQL proposals and F003 stay untouched', async () => {
  const { fixture, runsRoot, runId, completed, clock } = await setUp();
  try {
    assert.equal(completed.status, 'FAILED');
    const f001 = findByFile(completed, 'f001.txt');
    const f002 = findByFile(completed, 'f002.txt');
    const f003 = findByFile(completed, 'f003.txt');
    assert.equal(completed.tasks[f001.taskId]?.status, 'FAILED');
    assert.equal(completed.tasks[f002.taskId]?.status, 'FAILED');
    assert.equal(completed.tasks[f003.taskId]?.status, 'SUCCEEDED');

    const pgRequests = completed.adaptive!.workRequests.filter((r) => r.objective.startsWith('PostgreSQL concurrency proposal'));
    assert.equal(pgRequests.length, 2);
    for (const pg of pgRequests) {
      assert.equal(latestDecisionFor(completed, pg.id)?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
    }

    const f003Request = completed.adaptive!.workRequests.find((r) => r.id === completed.adaptive!.workUnits.find((u) => u.id === f003.unitId)!.requestId)!;
    const f003Reverification = reverificationRequest(completed, f003Request.authorization!.canonicalFindingKey)!;
    const f003ReverificationUnit = completed.adaptive!.workUnits.find((u) => u.requestId === f003Reverification.id)!;
    const f003TaskBefore = structuredClone(completed.tasks[f003.taskId]);
    const f003ReverificationTaskBefore = structuredClone(completed.tasks[f003ReverificationUnit.id]);

    // Mark F001 (salvage) and F002 (handoff-repair) recovered, well past
    // the original 1-second wall-clock budget.
    clock.advance(20_000);
    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    await markRecovered(started, fixture.git, f001.taskId, 'f001.txt', 'salvage');
    await markRecovered(started, fixture.git, f002.taskId, 'f002.txt', 'handoff_repair');

    // A plain resume() reconciles the adaptive units (prior task's fix) and
    // materializes F001/F002 re-verification requests — but the original
    // budget is already exhausted, so they are born WALL_CLOCK-denied.
    const stale = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    const staleState = stale.snapshot();
    const f001Request = staleState.adaptive!.workRequests.find((r) => r.id === staleState.adaptive!.workUnits.find((u) => u.id === f001.unitId)!.requestId)!;
    const f002Request = staleState.adaptive!.workRequests.find((r) => r.id === staleState.adaptive!.workUnits.find((u) => u.id === f002.unitId)!.requestId)!;
    const f001Reverification = reverificationRequest(staleState, f001Request.authorization!.canonicalFindingKey)!;
    const f002Reverification = reverificationRequest(staleState, f002Request.authorization!.canonicalFindingKey)!;
    assert.equal(latestDecisionFor(staleState, f001Reverification.id)?.reason, 'WALL_CLOCK_BUDGET_EXCEEDED');
    assert.equal(latestDecisionFor(staleState, f002Reverification.id)?.reason, 'WALL_CLOCK_BUDGET_EXCEEDED');
    const f001OriginalDenial = latestDecisionFor(staleState, f001Reverification.id)!;

    // Authorize the recovery execution budget epoch.
    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now });

    const after = authorization.orchestrator.snapshot();
    // Append-only: the original DENIED decision is untouched.
    assert.deepEqual(latestDecisionFor(after, f001Reverification.id) === undefined ? undefined : after.adaptive!.grantDecisions.find((d) => d.id === f001OriginalDenial.id), f001OriginalDenial);
    assert.equal(after.adaptive!.grantDecisions.filter((d) => d.requestId === f001Reverification.id).length, 2, 'decision 1 remains, decision 2 appended');

    // F001/F002 re-verification requests are now eligible (GRANTED, or
    // WAITING and then GRANTED once normal scheduling frees concurrency).
    let finalState = after;
    for (let i = 0; i < 3 && (
      latestDecisionFor(finalState, f001Reverification.id)?.outcome !== 'GRANTED'
      || latestDecisionFor(finalState, f002Reverification.id)?.outcome !== 'GRANTED'
    ); i += 1) {
      const resumed = await AgentOrchestrator.resume(runId, {
        repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
      });
      finalState = resumed.snapshot();
    }
    assert.equal(latestDecisionFor(finalState, f001Reverification.id)?.outcome, 'GRANTED');
    assert.equal(latestDecisionFor(finalState, f002Reverification.id)?.outcome, 'GRANTED');

    // PostgreSQL proposals remain unchanged DENIED.
    for (const pg of pgRequests) {
      assert.equal(finalState.adaptive!.grantDecisions.filter((d) => d.requestId === pg.id).length, 1, 'no re-arbitration for the unrelated proposal');
      assert.equal(latestDecisionFor(finalState, pg.id)?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
    }

    // F003 correction + re-verification remain provably unchanged.
    assert.deepEqual(finalState.tasks[f003.taskId], f003TaskBefore);
    assert.deepEqual(finalState.tasks[f003ReverificationUnit.id], f003ReverificationTaskBefore);

    // Exactly one F001 request, exactly one F002 request — no duplicates.
    assert.equal(finalState.adaptive!.workRequests.filter((r) =>
      r.authorization?.purpose === 'reverification' && r.authorization.canonicalFindingKey === f001Request.authorization!.canonicalFindingKey,
    ).length, 1);
    assert.equal(finalState.adaptive!.workRequests.filter((r) =>
      r.authorization?.purpose === 'reverification' && r.authorization.canonicalFindingKey === f002Request.authorization!.canonicalFindingKey,
    ).length, 1);
  } finally {
    await fixture.dispose();
  }
});

test('crash/resume: the recovery epoch survives reconstruction with the exact same identity and startedAt, no re-authorization, no replanning', async () => {
  const { fixture, runsRoot, runId, completed, clock } = await setUp();
  try {
    const f001 = findByFile(completed, 'f001.txt');
    const f002 = findByFile(completed, 'f002.txt');
    clock.advance(20_000);
    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    await markRecovered(started, fixture.git, f001.taskId, 'f001.txt', 'salvage');
    await markRecovered(started, fixture.git, f002.taskId, 'f002.txt', 'handoff_repair');
    await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });

    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now });
    const epochBefore = activeEpochOf(authorization.orchestrator.snapshot())!;
    assert.equal(epochBefore.number, 1);

    // Simulate a crash: advance the fake clock (real time keeps passing
    // even if the process is down) and reconstruct via a brand-new resume().
    clock.advance(15 * 60 * 1000);
    const reconstructed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    const epochAfter = activeEpochOf(reconstructed.snapshot())!;
    assert.equal(epochAfter.number, epochBefore.number, 'exact same epoch ID');
    assert.equal(epochAfter.startedAt, epochBefore.startedAt, 'exact same startedAt — elapsed time is computed from persisted state, not process uptime');
    assert.equal(
      reconstructed.snapshot().adaptive!.events.filter((e) => e.type === 'RECOVERY_EPOCH_AUTHORIZED').length,
      authorization.orchestrator.snapshot().adaptive!.events.filter((e) => e.type === 'RECOVERY_EPOCH_AUTHORIZED').length,
      'no second authorization event from merely resuming',
    );
  } finally {
    await fixture.dispose();
  }
});

// --- §10: multi-epoch real shape regression ---

test('multi-epoch: a genuinely new policy (integrationRecovery added) creates Epoch 2 without invalidating Epoch 1\'s completed F001/F002 review decisions', async () => {
  const { fixture, runsRoot, runId, completed, clock } = await setUp();
  try {
    const f001 = findByFile(completed, 'f001.txt');
    const f002 = findByFile(completed, 'f002.txt');
    clock.advance(20_000);
    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    await markRecovered(started, fixture.git, f001.taskId, 'f001.txt', 'salvage');
    await markRecovered(started, fixture.git, f002.taskId, 'f002.txt', 'handoff_repair');
    await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });

    // Epoch 1: recoveryBudget only — grants F001/F002's targeted reviews.
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now });

    // Run the two granted targeted reviews all the way to SUCCEEDED.
    let runningOrchestrator = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    await runningOrchestrator.stateStore.save({ ...(await runningOrchestrator.stateStore.load()), status: 'RUNNING' });
    runningOrchestrator = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    const finished = await runningOrchestrator.execute();
    assert.equal(finished.status, 'COMPLETED', JSON.stringify(finished.errors));

    const epoch1Before = activeEpochOf(finished)!;
    assert.equal(epoch1Before.number, 1);
    const f001Request = finished.adaptive!.workRequests.find((r) => r.id === finished.adaptive!.workUnits.find((u) => u.id === f001.unitId)!.requestId)!;
    const f002Request = finished.adaptive!.workRequests.find((r) => r.id === finished.adaptive!.workUnits.find((u) => u.id === f002.unitId)!.requestId)!;
    const f001Reverification = reverificationRequest(finished, f001Request.authorization!.canonicalFindingKey)!;
    const f002Reverification = reverificationRequest(finished, f002Request.authorization!.canonicalFindingKey)!;
    const f001DecisionsBefore = finished.adaptive!.grantDecisions.filter((d) => d.requestId === f001Reverification.id);
    const f002DecisionsBefore = finished.adaptive!.grantDecisions.filter((d) => d.requestId === f002Reverification.id);
    assert.equal(f001DecisionsBefore.length, 2);
    assert.equal(f001DecisionsBefore[1]?.recoveryEpochNumber, 1);
    const f001UnitBefore = structuredClone(finished.adaptive!.workUnits.find((u) => u.requestId === f001Reverification.id));
    const f002UnitBefore = structuredClone(finished.adaptive!.workUnits.find((u) => u.requestId === f002Reverification.id));
    const workUnitCountBefore = finished.adaptive!.workUnits.length;
    const workRequestCountBefore = finished.adaptive!.workRequests.length;

    // Epoch 2: a genuinely different policy (integrationRecovery added) —
    // the semantic hash changes even though recoveryBudget itself did not.
    const secondAuthorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
      integrationRecovery: { prepare: ['pnpm install --frozen-lockfile', 'pnpm --filter @tripwith/shared build'] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now });

    const after = secondAuthorization.orchestrator.snapshot();
    const epoch1After = after.adaptive!.recoveryEpochs!.find((e) => e.number === 1)!;
    const epoch2After = after.adaptive!.recoveryEpochs!.find((e) => e.number === 2)!;
    assert.deepEqual(epoch1After, epoch1Before, 'Epoch 1 remains persisted unchanged');
    assert.ok(epoch2After !== undefined, 'Epoch 2 is appended');
    assert.equal(after.adaptive!.activeRecoveryEpochNumber, 2, 'active epoch becomes 2');
    assert.equal(after.adaptive!.recoveryEpochs!.length, 2);

    // No STATE_CORRUPT on reload — Epoch 1's GrantDecisions remain valid.
    const reloaded = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    const reloadedState = reloaded.snapshot();
    assert.deepEqual(reloadedState.adaptive!.grantDecisions.filter((d) => d.requestId === f001Reverification.id), f001DecisionsBefore, 'F001 decisions unchanged, no duplicate');
    assert.deepEqual(reloadedState.adaptive!.grantDecisions.filter((d) => d.requestId === f002Reverification.id), f002DecisionsBefore, 'F002 decisions unchanged, no duplicate');
    assert.deepEqual(reloadedState.adaptive!.workUnits.find((u) => u.requestId === f001Reverification.id), f001UnitBefore, 'no duplicate/re-executed F001 review unit');
    assert.deepEqual(reloadedState.adaptive!.workUnits.find((u) => u.requestId === f002Reverification.id), f002UnitBefore, 'no duplicate/re-executed F002 review unit');
    assert.equal(reloadedState.adaptive!.workUnits.length, workUnitCountBefore, 'no new work units created merely by authorizing Epoch 2');
    assert.equal(reloadedState.adaptive!.workRequests.length, workRequestCountBefore, 'no new work requests created merely by authorizing Epoch 2');
    // Epoch 2 has no adaptive scope of its own — integrationRecovery never
    // touches adaptive WorkRequests/GrantDecisions at all.
    assert.deepEqual(epoch2After.requestIds, []);
  } finally {
    await fixture.dispose();
  }
});

test('crash/resume with two epochs: both survive exactly, active epoch remains 2, no duplicate re-arbitration', async () => {
  const { fixture, runsRoot, runId, completed, clock } = await setUp();
  try {
    const f001 = findByFile(completed, 'f001.txt');
    const f002 = findByFile(completed, 'f002.txt');
    clock.advance(20_000);
    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    await markRecovered(started, fixture.git, f001.taskId, 'f001.txt', 'salvage');
    await markRecovered(started, fixture.git, f002.taskId, 'f002.txt', 'handoff_repair');
    await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now });
    const secondAuthorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
      integrationRecovery: { prepare: ['pnpm install --frozen-lockfile', 'pnpm --filter @tripwith/shared build'] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now });
    const before = secondAuthorization.orchestrator.snapshot();
    assert.equal(before.adaptive!.recoveryEpochs!.length, 2);
    assert.equal(before.adaptive!.activeRecoveryEpochNumber, 2);

    clock.advance(60_000);
    const reconstructed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') }, clock: clock.now,
    });
    const after = reconstructed.snapshot();
    assert.deepEqual(after.adaptive!.recoveryEpochs, before.adaptive!.recoveryEpochs, 'both epochs survive exactly');
    assert.equal(after.adaptive!.activeRecoveryEpochNumber, 2, 'active epoch remains 2');
    assert.equal(
      after.adaptive!.events.filter((e) => e.type === 'RECOVERY_EPOCH_AUTHORIZED').length,
      before.adaptive!.events.filter((e) => e.type === 'RECOVERY_EPOCH_AUTHORIZED').length,
      'no epoch recreated, no policy reauthorization',
    );
    assert.equal(after.adaptive!.grantDecisions.length, before.adaptive!.grantDecisions.length, 'no duplicate re-arbitration');
  } finally {
    await fixture.dispose();
  }
});
