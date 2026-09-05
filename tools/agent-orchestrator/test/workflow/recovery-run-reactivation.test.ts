import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import type { GitClient } from '../../src/git';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunEvent, RunState, TaskRunState } from '../../src/state';
import { createTemporaryRepository } from '../git/helpers';

async function readEvents(orchestrator: AgentOrchestrator): Promise<readonly RunEvent[]> {
  const raw = await readFile(orchestrator.stateStore.eventsPath, 'utf8').catch(() => '');
  return raw.split('\n').filter((line) => line.trim() !== '').map((line) => JSON.parse(line) as RunEvent);
}

/**
 * Run-level recovery reactivation: a BLOCKED adaptive run whose only
 * blocker was F001/F002's targeted re-verification requests being denied
 * for the ORIGINAL wall-clock budget goes stale once an authorized
 * recovery epoch supersedes those denials — execute()'s own while-loop
 * guard (RUNNING/CREATED only) never runs again to notice on its own.
 * reactivateBlockedRunAfterRecoveryEpoch reuses the exact same
 * completionStatus()/adaptiveReviewGate() checks execute() itself used to
 * decide BLOCKED, so it only ever flips BLOCKED -> RUNNING when those
 * checks, evaluated fresh, no longer say so.
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
          { id: 'F001', severity: 'medium', category: 'correctness', file: 'f001.txt', location: 'line 1', problem: 'p', evidence: 'e', impact: 'i', suggestedFix: 'f', verificationRequired: 'v' },
          { id: 'F002', severity: 'medium', category: 'testing', file: 'f002.txt', location: 'line 1', problem: 'p', evidence: 'e', impact: 'i', suggestedFix: 'f', verificationRequired: 'v' },
          { id: 'F003', severity: 'low', category: 'testing', file: 'f003.txt', location: 'line 1', problem: 'p', evidence: 'e', impact: 'i', suggestedFix: 'f', verificationRequired: 'v' },
        ],
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
      if (this.failFiles.includes(target)) throw new Error(`simulated agent failure for ${target}`);
      await writeFile(join(request.worktreePath, target), `corrected ${target}\n`, 'utf8');
      const spec = request.taskSpecification as { requiredCanonicalFindings: Array<{ findingId: string; canonicalFindingKey: string }> };
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
phase: recovery-run-reactivation
name: Recovery run reactivation
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

function freshAgents(failFiles: readonly string[] = []) {
  return { codex: new ReconciliationAgent('codex', failFiles), claude: new ReconciliationAgent('claude', failFiles) };
}

function findByFile(state: RunState, file: string): { taskId: string; unitId: string } {
  const unit = state.adaptive!.workUnits.find((candidate) => candidate.resourceClaims.some((claim) => claim.key === file))!;
  return { taskId: unit.id, unitId: unit.id };
}

function latestDecisionFor(state: RunState, requestId: string) {
  return [...state.adaptive!.grantDecisions].reverse().find((d) => d.requestId === requestId);
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
  await mkdir(join(orchestrator.stateStore.runDirectory, 'handoffs'), { recursive: true });
  await writeFile(handoffPath, JSON.stringify({
    status: 'complete', summary: `recovered ${taskId}`, filesChanged: [file], decisions: [],
    tests: [], openQuestions: [], reviewRequested: [],
  }), 'utf8');
  // A real commit — later steps (the reviewer's actual diff/worktree prep)
  // need a real, resolvable SHA, not a synthetic placeholder.
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

/**
 * Drives the shared scenario all the way to the real precondition: a
 * BLOCKED run with F001/F002 corrections recovered, their targeted
 * re-verification requests DENIED for the original wall-clock budget, and
 * everything else (F003, the two PostgreSQL proposals) exactly as a live
 * run would leave it.
 */
async function setUpBlockedRun() {
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
  const orchestrator = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository, runsRoot, agents: freshAgents(['f001.txt', 'f002.txt']), clock: clock.now,
  });
  const runId = orchestrator.snapshot().runId;
  const liveResult = await orchestrator.execute();
  assert.equal(liveResult.status, 'FAILED', 'sanity: F001/F002 fail live, F003 succeeds');
  const f001 = findByFile(liveResult, 'f001.txt');
  const f002 = findByFile(liveResult, 'f002.txt');
  const f003 = findByFile(liveResult, 'f003.txt');

  clock.advance(20_000);
  const started = await AgentOrchestrator.resume(runId, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
  await markRecovered(started, fixture.git, f001.taskId, 'f001.txt', 'salvage');
  await markRecovered(started, fixture.git, f002.taskId, 'f002.txt', 'handoff_repair');

  // Simulate what a real handoff-repair/salvage recovery flow already does
  // (reset status FAILED -> RUNNING) so the subsequent execute() call can
  // reach the adaptive completion gate and set the real BLOCKED shape —
  // reused here rather than replaying the full repair cascade Phase 3/the
  // prior task already cover end to end.
  const beforeReactivationRun = await started.stateStore.load();
  await started.stateStore.save({ ...beforeReactivationRun, status: 'RUNNING' });
  const runningOrchestrator = await AgentOrchestrator.resume(runId, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
  const blocked = await runningOrchestrator.execute();
  assert.equal(blocked.status, 'BLOCKED', 'sanity: the run reaches the real BLOCKED shape via the adaptive completion gate');
  assert.equal(blocked.errors.at(-1)?.code, 'BLOCKED_FOR_HUMAN_REVIEW');

  return { fixture, runsRoot, runId, blocked, clock, f001, f002, f003 };
}

test('real run shape: authorizing the recovery budget epoch reactivates a BLOCKED run superseded solely by wall-clock denials', async () => {
  const { fixture, runsRoot, runId, blocked, clock, f001, f002, f003 } = await setUpBlockedRun();
  try {
    const f001Request = blocked.adaptive!.workRequests.find((r) => r.id === blocked.adaptive!.workUnits.find((u) => u.id === f001.unitId)!.requestId)!;
    const f002Request = blocked.adaptive!.workRequests.find((r) => r.id === blocked.adaptive!.workUnits.find((u) => u.id === f002.unitId)!.requestId)!;
    const f001Reverification = blocked.adaptive!.workRequests.find((r) => r.authorization?.purpose === 'reverification' && r.authorization.canonicalFindingKey === f001Request.authorization!.canonicalFindingKey)!;
    const f002Reverification = blocked.adaptive!.workRequests.find((r) => r.authorization?.purpose === 'reverification' && r.authorization.canonicalFindingKey === f002Request.authorization!.canonicalFindingKey)!;
    assert.equal(latestDecisionFor(blocked, f001Reverification.id)?.reason, 'WALL_CLOCK_BUDGET_EXCEEDED');
    assert.equal(latestDecisionFor(blocked, f002Reverification.id)?.reason, 'WALL_CLOCK_BUDGET_EXCEEDED');
    const pgRequests = blocked.adaptive!.workRequests.filter((r) => r.objective.startsWith('PostgreSQL concurrency proposal'));
    assert.equal(pgRequests.length, 2);
    for (const pg of pgRequests) assert.equal(latestDecisionFor(blocked, pg.id)?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
    const f003TaskBefore = structuredClone(blocked.tasks[f003.taskId]);
    const f001CorrectionTaskBefore = structuredClone(blocked.tasks[f001.taskId]);
    const f002CorrectionTaskBefore = structuredClone(blocked.tasks[f002.taskId]);

    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });

    const after = authorization.orchestrator.snapshot();
    assert.equal(after.status, 'RUNNING', 'the run is reactivated');

    const events = await readEvents(authorization.orchestrator);
    const reactivation = events.find((e) => e.name === 'RUN_RECOVERY_REACTIVATED');
    assert.ok(reactivation !== undefined, 'a RUN_RECOVERY_REACTIVATED event was emitted');
    assert.equal(reactivation!.data?.recoveryEpochNumber, 1);
    assert.deepEqual(
      [...(reactivation!.data?.supersededRequestIds as string[])].sort(),
      [f001Reverification.id, f002Reverification.id].sort(),
    );

    // Append-only: the original denial is untouched, a new decision is appended.
    assert.equal(after.adaptive!.grantDecisions.filter((d) => d.requestId === f001Reverification.id).length, 2);
    assert.equal(after.adaptive!.grantDecisions.filter((d) => d.requestId === f002Reverification.id).length, 2);
    assert.equal(after.adaptive!.grantDecisions.find((d) => d.requestId === f001Reverification.id && d.reason === 'WALL_CLOCK_BUDGET_EXCEEDED')?.outcome, 'DENIED');
    assert.equal(latestDecisionFor(after, f001Reverification.id)?.outcome, 'GRANTED');
    assert.equal(latestDecisionFor(after, f002Reverification.id)?.outcome, 'GRANTED');
    const f001ReverificationUnit = after.adaptive!.workUnits.find((u) => u.requestId === f001Reverification.id)!;
    const f002ReverificationUnit = after.adaptive!.workUnits.find((u) => u.requestId === f002Reverification.id)!;
    assert.equal(after.tasks[f001ReverificationUnit.id]?.status, 'READY');
    assert.equal(after.tasks[f002ReverificationUnit.id]?.status, 'READY');

    // F001/F002 CORRECTION tasks/requests and F003 are unchanged.
    assert.deepEqual(after.tasks[f001.taskId], f001CorrectionTaskBefore);
    assert.deepEqual(after.tasks[f002.taskId], f002CorrectionTaskBefore);
    assert.deepEqual(after.tasks[f003.taskId], f003TaskBefore);

    // PostgreSQL denials unchanged.
    for (const pg of pgRequests) {
      assert.equal(after.adaptive!.grantDecisions.filter((d) => d.requestId === pg.id).length, 1);
      assert.equal(latestDecisionFor(after, pg.id)?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
    }

    // No duplicate requests were created.
    assert.equal(after.adaptive!.workRequests.filter((r) => r.authorization?.purpose === 'reverification' && r.authorization.canonicalFindingKey === f001Request.authorization!.canonicalFindingKey).length, 1);
    assert.equal(after.adaptive!.workRequests.filter((r) => r.authorization?.purpose === 'reverification' && r.authorization.canonicalFindingKey === f002Request.authorization!.canonicalFindingKey).length, 1);

    // normal execute() now actually runs the two READY reviewers.
    const completed = await authorization.orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
  } finally {
    await fixture.dispose();
  }
});

test('idempotency: reactivation never fires twice and RUNNING is a no-op', async () => {
  const { fixture, runsRoot, runId, clock } = await setUpBlockedRun();
  try {
    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    const firstSnapshot = authorization.orchestrator.snapshot();
    assert.equal(firstSnapshot.status, 'RUNNING');
    const reactivations1 = (await readEvents(authorization.orchestrator)).filter((e) => e.name === 'RUN_RECOVERY_REACTIVATED').length;
    assert.equal(reactivations1, 1);

    // A later resume() call (RUNNING already) must be a pure no-op for this mechanism.
    const resumed = await AgentOrchestrator.resume(runId, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    const secondSnapshot = resumed.snapshot();
    assert.equal(secondSnapshot.status, 'RUNNING');
    const reactivations2 = (await readEvents(resumed)).filter((e) => e.name === 'RUN_RECOVERY_REACTIVATED').length;
    assert.equal(reactivations2, reactivations1, 'no duplicate reactivation event');
    assert.equal(secondSnapshot.adaptive!.grantDecisions.length, firstSnapshot.adaptive!.grantDecisions.length, 'no duplicate grant decisions');
    assert.equal(secondSnapshot.adaptive!.workUnits.length, firstSnapshot.adaptive!.workUnits.length, 'no duplicate work units');
  } finally {
    await fixture.dispose();
  }
});

// --- Negative cases (§10) ---

test('negative A: BLOCKED with no recovery epoch is never reactivated', async () => {
  const { fixture, runsRoot, runId, blocked, clock } = await setUpBlockedRun();
  try {
    assert.equal(blocked.adaptive!.recoveryEpoch, undefined);
    const resumed = await AgentOrchestrator.resume(runId, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    assert.equal(resumed.snapshot().status, 'BLOCKED');
  } finally {
    await fixture.dispose();
  }
});

test('negative D: an unrelated task-level BLOCKED is never reactivated by authorizing a recovery epoch', async () => {
  const { fixture, runsRoot, runId, blocked, clock, f003 } = await setUpBlockedRun();
  try {
    const orchestrator = await AgentOrchestrator.resume(runId, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    const before = await orchestrator.stateStore.load();
    // Simulate an unrelated task-level human-review block (e.g. an
    // escalation JUDGE unresolved) that must never be swept aside.
    const humanBlockedTask: TaskRunState = {
      ...before.tasks[f003.taskId]!,
      status: 'BLOCKED',
      error: { code: 'BLOCKED_FOR_HUMAN_REVIEW', message: 'unresolved human decision', at: before.createdAt },
    };
    await orchestrator.stateStore.save({ ...before, tasks: { ...before.tasks, [f003.taskId]: humanBlockedTask } });

    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    assert.equal(authorization.orchestrator.snapshot().status, 'BLOCKED', 'a genuine task-level block is never reactivated');
  } finally {
    await fixture.dispose();
  }
});

test('negative E: an integration-blocked run is never reactivated by authorizing a recovery epoch', async () => {
  const { fixture, runsRoot, runId, clock } = await setUpBlockedRun();
  try {
    const orchestrator = await AgentOrchestrator.resume(runId, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    const before = await orchestrator.stateStore.load();
    await orchestrator.stateStore.save({
      ...before,
      integration: { ...before.integration, status: 'BLOCKED', error: { code: 'INTEGRATION_TEST_FAILED', message: 'a required integration command failed', at: before.createdAt } },
    });
    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    assert.equal(authorization.orchestrator.snapshot().status, 'BLOCKED', 'an integration blocker is never reactivated by this mechanism');
  } finally {
    await fixture.dispose();
  }
});

test('negative F: an unrelated required OUTSIDE_ALLOWED_OWNERSHIP denial (non-agent-sourced) is never reactivated', async () => {
  const { fixture, runsRoot, runId, blocked, clock } = await setUpBlockedRun();
  try {
    const orchestrator = await AgentOrchestrator.resume(runId, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    const before = await orchestrator.stateStore.load();
    // A non-agent-sourced (orchestrator-authorized) request denied for
    // ownership — unlike the agent-proposed PostgreSQL proposals, THIS
    // kind of denial is exactly what completionStatus()'s own BLOCKED
    // check keys on, so it must keep the run BLOCKED regardless of the
    // recovery epoch.
    const rootDeniedRequest = {
      id: 'request-999001', sequence: before.adaptive!.workRequests.length + 1, createdAt: before.createdAt, source: 'orchestrator' as const,
      role: 'review' as const, concern: 'review', objective: 'Unrelated required root review', reason: 'r', depth: 0,
      dependencies: [], capabilities: [{ capability: 'review' }],
      resourceClaims: [{ kind: 'repository_path' as const, key: 'outside/scope.ts', mode: 'write' as const }],
      evidence: [{ kind: 'finding' as const, reference: 'UNRELATED', summary: 's' }], risk: 'low' as const, priority: 10,
    };
    const deniedDecision = {
      id: `decision-${String(before.adaptive!.grantDecisions.length + 1).padStart(6, '0')}`,
      requestId: rootDeniedRequest.id, outcome: 'DENIED' as const, reason: 'OUTSIDE_ALLOWED_OWNERSHIP' as const,
      detail: 'outside phase ownership', effectivePriority: 10, decidedAt: before.createdAt,
      sequence: before.adaptive!.grantDecisions.length + 1,
    };
    await orchestrator.stateStore.save({
      ...before,
      adaptive: {
        ...before.adaptive!,
        workRequests: [...before.adaptive!.workRequests, rootDeniedRequest],
        grantDecisions: [...before.adaptive!.grantDecisions, deniedDecision],
      },
    });
    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    assert.equal(authorization.orchestrator.snapshot().status, 'BLOCKED', 'an unrelated required denial keeps completionStatus() BLOCKED');
  } finally {
    await fixture.dispose();
  }
});

test('negative G: no runnable/relevant recovery work exists (recovery epoch authorized but nothing was actually superseded)', async () => {
  const { fixture, runsRoot, runId, clock } = await setUpBlockedRun();
  try {
    // Authorize a recovery budget with NO recovery-scoped work at all (a
    // run that never had a wall-clock-denied recovery-scoped request to
    // begin with) — simulated by wiping recoveryEvidenceKind's provenance
    // for both tasks first, so recoveryScopedReverificationRequestIds()
    // returns empty and no request is ever superseded.
    const orchestrator = await AgentOrchestrator.resume(runId, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    const before = await orchestrator.stateStore.load();
    const strippedTasks = Object.fromEntries(Object.entries(before.tasks).map(([id, task]) => [
      id,
      task.salvage === undefined && task.handoffRepairAttempts.every((a) => !a.succeeded)
        ? task
        : { ...task, salvage: undefined, handoffRepairAttempts: task.handoffRepairAttempts.map((a) => ({ ...a, succeeded: false })) },
    ]));
    await orchestrator.stateStore.save({ ...before, tasks: strippedTasks as typeof before.tasks });

    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      recoveryBudget: { maxWallClockMs: 3_600_000 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: freshAgents(), clock: clock.now });
    assert.equal(authorization.orchestrator.snapshot().status, 'BLOCKED', 'nothing was actually superseded, so the run stays BLOCKED');
  } finally {
    await fixture.dispose();
  }
});
