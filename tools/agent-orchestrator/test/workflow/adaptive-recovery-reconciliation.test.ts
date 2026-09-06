import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunState, TaskRunState } from '../../src/state';
import { createTemporaryRepository } from '../git/helpers';

/**
 * Adaptive recovery state reconciliation: after a recovery flow
 * (recoverHandoffFailures / salvageTask) sets TaskRunState to SUCCEEDED for
 * a task whose adaptive DynamicWorkUnit is still terminal FAILED/TIMED_OUT
 * (the real F001/F002 dogfood shape — run-20260904124350-dc56690c), the
 * adaptive layer must be mirrored through the same semantic completion
 * lifecycle a live success uses, so the targeted re-verification the
 * correction policy requires actually materializes.
 *
 * Setup strategy: F003's whole correction + reverification lifecycle runs
 * for real, live, through the orchestrator (proving the fix integrates with
 * the existing, unmodified reconcileAdaptiveCorrectionFlow dedup rather
 * than a hand-rolled substitute). F001/F002 are made to fail for real too
 * (a thrown agent error — a genuine live FAILED task and FAILED adaptive
 * unit, mirrored by the pre-existing, unmodified finishAdaptiveUnit path).
 * Only the LAST step — the recovery itself — is then either driven for real
 * (test C, via recoverHandoffFailures) or synthesized by hand-editing just
 * the TaskRunState (tests A/B/D and the acceptance test), exactly matching
 * how a real handoff-repair/salvage recovery leaves its evidence, without
 * needing to replay the full repair cascade Phase 3 already covers
 * end-to-end elsewhere.
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
      };
    } else if (request.role === 'handoff_repair') {
      const spec = request.taskSpecification as {
        malformedOutput: Record<string, unknown>;
        requiredCanonicalFindings: Array<{ findingId: string; canonicalFindingKey: string }>;
      };
      structuredHandoff = {
        ...spec.malformedOutput,
        tests: [],
        findingResponses: spec.requiredCanonicalFindings.map((required) => ({
          findingId: required.findingId, canonicalFindingKey: required.canonicalFindingKey,
          decision: 'confirmed', resolution: 'resolved', evidence: 'reproduced', fix: 'corrected', verification: 'checked',
        })),
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
        status: 'complete', summary: `corrected ${target}`, filesChanged: [target], decisions: [], tests: [],
        openQuestions: [], reviewRequested: [`targeted ${required.findingId}`],
        findingResponses: [{
          findingId: required.findingId, canonicalFindingKey: required.canonicalFindingKey,
          decision: 'confirmed', resolution: 'resolved', evidence: 'reproduced', fix: 'corrected', verification: 'checked',
        }],
      };
    } else {
      // Targeted re-verification review.
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
phase: adaptive-recovery-reconciliation
name: Adaptive recovery reconciliation
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
goal: Review and correct three canonical findings
constraints: [Use only canonical evidence]
policy:
  allowedConcerns: [review]
  allowedOwnership: ['**']
  allowedResources: []
  limits:
    maxConcurrentAgents: 4
    maxAgentInvocations: 16
    maxTotalWorkUnits: 16
    maxDecompositionDepth: 2
    maxFanOutPerWorkUnit: 3
    maxSynthesisInputs: 4
    maxWallClockMs: 600000
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

async function setUp(failFiles: readonly string[]) {
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
  const codex = new ReconciliationAgent('codex', failFiles);
  const claude = new ReconciliationAgent('claude', failFiles);
  const orchestrator = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository, runsRoot, agents: { codex, claude },
  });
  const runId = orchestrator.snapshot().runId;
  // Live: F003 (and only F003) actually succeeds, including its real
  // targeted re-verification. F001/F002 fail for real (a thrown agent
  // error), so their adaptive units become genuinely FAILED via the
  // existing, unmodified finishAdaptiveUnit mirror (they were GRANTED/
  // RUNNING at that moment, so that mirror is not the bug being fixed).
  const completed = await orchestrator.execute();
  return { fixture, runsRoot, runId, completed, codex, claude };
}

function findByFile(state: RunState, file: string): { taskId: string; unitId: string } {
  const unit = state.adaptive!.workUnits.find((candidate) => candidate.resourceClaims.some((claim) => claim.key === file))!;
  return { taskId: unit.id, unitId: unit.id };
}

function findReverificationUnit(state: RunState, canonicalFindingKey: string, round = 1) {
  const request = state.adaptive!.workRequests.find((candidate) =>
    candidate.authorization?.purpose === 'reverification'
    && candidate.authorization.canonicalFindingKey === canonicalFindingKey
    && candidate.authorization.round === round,
  );
  if (request === undefined) return undefined;
  return state.adaptive!.workUnits.find((unit) => unit.requestId === request.id);
}

test('setup sanity: F001/F002 fail live, F003 succeeds live with its own re-verification', async () => {
  const { fixture, completed } = await setUp(['f001.txt', 'f002.txt']);
  try {
    assert.equal(completed.status, 'FAILED');
    const f001 = findByFile(completed, 'f001.txt');
    const f002 = findByFile(completed, 'f002.txt');
    const f003 = findByFile(completed, 'f003.txt');
    assert.equal(completed.tasks[f001.taskId]?.status, 'FAILED');
    assert.equal(completed.adaptive!.workUnits.find((u) => u.id === f001.unitId)!.status, 'FAILED');
    assert.equal(completed.tasks[f002.taskId]?.status, 'FAILED');
    assert.equal(completed.adaptive!.workUnits.find((u) => u.id === f002.unitId)!.status, 'FAILED');
    assert.equal(completed.tasks[f003.taskId]?.status, 'SUCCEEDED');
    assert.equal(completed.adaptive!.workUnits.find((u) => u.id === f003.unitId)!.status, 'SUCCEEDED');
    const f003Request = completed.adaptive!.workRequests.find((r) => r.id === completed.adaptive!.workUnits.find((u) => u.id === f003.unitId)!.requestId)!;
    const f003Reverification = findReverificationUnit(completed, f003Request.authorization!.canonicalFindingKey);
    assert.ok(f003Reverification !== undefined);
    assert.equal(completed.tasks[f003Reverification!.id]?.status, 'SUCCEEDED');
  } finally {
    await fixture.dispose();
  }
});

/** Hand-edits just the TaskRunState (never the adaptive layer) to the exact evidence shape a real recovery leaves behind. */
async function markRecovered(
  orchestrator: AgentOrchestrator,
  taskId: string,
  kind: 'salvage' | 'handoff_repair',
): Promise<void> {
  // Reload from disk rather than trusting orchestrator.snapshot(): a prior
  // markRecovered call on the same instance already wrote to disk via
  // stateStore.save() without updating this orchestrator's in-memory
  // state, so snapshot() here would be stale and this call would silently
  // clobber that earlier edit.
  const before = await orchestrator.stateStore.load();
  const task = before.tasks[taskId]!;
  // A real recovery always writes a real handoff before succeeding the
  // task — reconcileAdaptiveCorrectionFlow's reverification authorization
  // is keyed off this exact path (task.handoffPath), and validateRunState
  // enforces that a reverification's artifactPath matches it exactly.
  const handoffPath = join(orchestrator.stateStore.runDirectory, 'handoffs', `${taskId}.json`);
  await mkdir(join(orchestrator.stateStore.runDirectory, 'handoffs'), { recursive: true });
  await writeFile(handoffPath, JSON.stringify({
    status: 'complete', summary: `recovered ${taskId}`, filesChanged: [taskId], decisions: [],
    tests: [], openQuestions: [], reviewRequested: [],
  }), 'utf8');
  const recovered: TaskRunState = kind === 'salvage'
    ? {
        ...task,
        status: 'SUCCEEDED',
        handoffPath,
        commit: { sha: '3'.repeat(40), parentSha: before.baseSha, changedFiles: [task.id] },
        salvage: {
          authorizedAt: before.createdAt,
          verification: { worktreeHeadSha: before.baseSha, trackedDiffFingerprint: 'fp', verifyConfigFingerprint: 'cfg', result: 'passed' },
        },
      }
    : {
        ...task,
        status: 'SUCCEEDED',
        handoffPath,
        commit: { sha: '4'.repeat(40), parentSha: before.baseSha, changedFiles: [task.id] },
        handoffRepairAttempts: [
          ...task.handoffRepairAttempts,
          { method: 'agent', succeeded: true, timestamp: before.createdAt, repairExecutorId: 'metadata-repairer', repairAdapter: 'claude' },
        ],
      };
  await orchestrator.stateStore.save({ ...before, tasks: { ...before.tasks, [taskId]: recovered } });
}

// A. Task SUCCEEDED + adaptive TIMED_OUT/FAILED + valid recovery provenance -> adaptive unit becomes SUCCEEDED, materializing a targeted re-verification.
test('reconciliation A: salvage-recovered task heals its adaptive unit and materializes a targeted re-verification', async () => {
  const { fixture, runsRoot, runId, completed } = await setUp(['f001.txt', 'f002.txt']);
  try {
    const f001 = findByFile(completed, 'f001.txt');
    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    await markRecovered(started, f001.taskId, 'salvage');

    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    const after = resumed.snapshot();
    const unit = after.adaptive!.workUnits.find((u) => u.id === f001.unitId)!;
    assert.equal(unit.status, 'SUCCEEDED');
    // Append-only history: the original FAILED attempt is untouched.
    assert.equal(unit.attempts.at(-1)?.status, 'FAILED');
    assert.ok(after.adaptive!.events.some((e) => e.type === 'WORK_UNIT_RECOVERED' && e.workUnitId === f001.unitId));
    const f001Request = after.adaptive!.workRequests.find((r) => r.id === unit.requestId)!;
    const reverification = findReverificationUnit(after, f001Request.authorization!.canonicalFindingKey);
    assert.ok(reverification !== undefined, 'a targeted re-verification request must be materialized for F001');
  } finally {
    await fixture.dispose();
  }
});

// B. The same, for a handoff-repair-recovered task (adaptive FAILED, not TIMED_OUT).
test('reconciliation B: handoff-repair-recovered task heals its adaptive unit and materializes a targeted re-verification', async () => {
  const { fixture, runsRoot, runId, completed } = await setUp(['f001.txt', 'f002.txt']);
  try {
    const f002 = findByFile(completed, 'f002.txt');
    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    await markRecovered(started, f002.taskId, 'handoff_repair');

    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    const after = resumed.snapshot();
    const unit = after.adaptive!.workUnits.find((u) => u.id === f002.unitId)!;
    assert.equal(unit.status, 'SUCCEEDED');
    assert.equal(unit.attempts.at(-1)?.status, 'FAILED');
    const f002Request = after.adaptive!.workRequests.find((r) => r.id === unit.requestId)!;
    const reverification = findReverificationUnit(after, f002Request.authorization!.canonicalFindingKey);
    assert.ok(reverification !== undefined, 'a targeted re-verification request must be materialized for F002');
  } finally {
    await fixture.dispose();
  }
});

// C. The explicit call-site path: recoverHandoffFailures itself performs the full repair AND the adaptive reconciliation in one call, without a separate resume().
test('reconciliation C: recoverHandoffFailures performs adaptive reconciliation inline, in the same call', async () => {
  const { fixture, runsRoot, runId, completed } = await setUp(['f002.txt']);
  try {
    const f002 = findByFile(completed, 'f002.txt');
    // Rewrite F002's failure into a real, repairable HANDOFF_INVALID shape:
    // a registered worktree with the (already-correct) diff, and a
    // preserved malformed stdout log the bounded agent repair tier can fix.
    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    const before = started.snapshot();
    // The original live failed attempt already registered and preserved
    // this task's worktree (failTask never clears it) — recovery reuses it
    // exactly as a real repair would, never recreating it.
    const worktreePath = before.tasks[f002.taskId]!.worktreePath!;
    await writeFile(join(worktreePath, 'f002.txt'), 'corrected f002.txt\n', 'utf8');
    const logsDir = join(started.stateStore.runDirectory, 'logs');
    await mkdir(logsDir, { recursive: true });
    const spec = (before.tasks[f002.taskId]!.agentAttempts.at(-1))!;
    await writeFile(
      join(logsDir, `${runId}.${f002.taskId}.${spec.agent}.attempt-${spec.attempt}.stdout.log`),
      JSON.stringify({
        status: 'complete', summary: 'corrected f002.txt', filesChanged: ['f002.txt'], decisions: [],
        tests: null, openQuestions: [], reviewRequested: [],
      }),
      'utf8',
    );
    // Recovery-eligible HANDOFF_INVALID requires the underlying agent
    // attempt to have actually succeeded (a malformed-but-produced handoff)
    // — a genuinely thrown/failed agent attempt (this task's real live
    // shape) is a different, ineligible case, so the attempt outcome is
    // corrected here to match the scenario under test.
    const f002Task: TaskRunState = {
      ...before.tasks[f002.taskId]!,
      status: 'FAILED',
      agentAttempts: before.tasks[f002.taskId]!.agentAttempts.map((attempt, index, arr) =>
        index === arr.length - 1 ? { ...attempt, outcome: 'succeeded' as const } : attempt),
      error: { code: 'HANDOFF_INVALID', message: 'handoff.tests must be an array', at: before.createdAt },
    };
    await started.stateStore.save({ ...before, tasks: { ...before.tasks, [f002.taskId]: f002Task } });

    // No recovery policy is authorized, so repair routes to the original
    // owner (codex, per F002's category:'testing' -> capability:'testing'
    // routing) — ReconciliationAgent's own handoff_repair branch handles it.
    const recovery = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    assert.deepEqual(recovery.recovered, [f002.taskId]);
    const after = recovery.orchestrator.snapshot();
    assert.equal(after.tasks[f002.taskId]?.status, 'SUCCEEDED');
    const unit = after.adaptive!.workUnits.find((u) => u.id === f002.unitId)!;
    assert.equal(unit.status, 'SUCCEEDED', 'adaptive reconciliation happened inline within recoverHandoffFailures itself');
    const f002Request = after.adaptive!.workRequests.find((r) => r.id === unit.requestId)!;
    assert.ok(findReverificationUnit(after, f002Request.authorization!.canonicalFindingKey) !== undefined);
  } finally {
    await fixture.dispose();
  }
});

// D. No recovery provenance: fail closed / remain unchanged — never silently heal arbitrary inconsistency.
test('reconciliation D: without recovery provenance, a SUCCEEDED-task/FAILED-adaptive-unit mismatch is left untouched', async () => {
  const { fixture, runsRoot, runId, completed } = await setUp(['f001.txt', 'f002.txt']);
  try {
    const f001 = findByFile(completed, 'f001.txt');
    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    const before = started.snapshot();
    // TaskRunState SUCCEEDED, but with NO recovery evidence at all (no
    // handoffRepairAttempts success, no salvage record) — this must never
    // be inferred as recovered merely from the mismatch.
    const bareTask: TaskRunState = { ...before.tasks[f001.taskId]!, status: 'SUCCEEDED', commit: { sha: '5'.repeat(40), parentSha: before.baseSha, changedFiles: ['f001.txt'] } };
    await started.stateStore.save({ ...before, tasks: { ...before.tasks, [f001.taskId]: bareTask } });

    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    const after = resumed.snapshot();
    const unit = after.adaptive!.workUnits.find((u) => u.id === f001.unitId)!;
    assert.equal(unit.status, 'FAILED', 'never healed without persisted recovery evidence');
    assert.ok(!after.adaptive!.events.some((e) => e.type === 'WORK_UNIT_RECOVERED'));
  } finally {
    await fixture.dispose();
  }
});

// E. Idempotency: reconciliation run twice never double-transitions, never duplicates the re-verification request, never re-invokes an agent.
test('reconciliation E: reconciliation is idempotent across repeated resume() calls', async () => {
  const { fixture, runsRoot, runId, completed } = await setUp(['f001.txt', 'f002.txt']);
  try {
    const f001 = findByFile(completed, 'f001.txt');
    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    await markRecovered(started, f001.taskId, 'salvage');

    const first = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    const firstSnapshot = first.snapshot();
    const secondCodex = new ReconciliationAgent('codex');
    const secondClaude = new ReconciliationAgent('claude');
    const second = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: secondCodex, claude: secondClaude },
    });
    const secondSnapshot = second.snapshot();
    assert.equal(
      secondSnapshot.adaptive!.events.filter((e) => e.type === 'WORK_UNIT_RECOVERED').length,
      firstSnapshot.adaptive!.events.filter((e) => e.type === 'WORK_UNIT_RECOVERED').length,
      'no second recovery transition',
    );
    assert.equal(
      secondSnapshot.adaptive!.workRequests.filter((r) => r.authorization?.purpose === 'reverification').length,
      firstSnapshot.adaptive!.workRequests.filter((r) => r.authorization?.purpose === 'reverification').length,
      'no duplicate targeted re-verification request',
    );
    assert.equal(secondCodex.invocations.length + secondClaude.invocations.length, 0, 'resume() alone never invokes an agent');
  } finally {
    await fixture.dispose();
  }
});

// Real-dogfood-shaped acceptance test (§22): F001/F002 recovered, F003/work4-analogue untouched, exactly one re-verification each, no duplicates.
test('real-dogfood-shaped acceptance: F001/F002 reconciliation leaves F003 and its existing re-verification provably unchanged', async () => {
  const { fixture, runsRoot, runId, completed } = await setUp(['f001.txt', 'f002.txt']);
  try {
    const f001 = findByFile(completed, 'f001.txt');
    const f002 = findByFile(completed, 'f002.txt');
    const f003 = findByFile(completed, 'f003.txt');
    const f003Request = completed.adaptive!.workRequests.find((r) => r.id === completed.adaptive!.workUnits.find((u) => u.id === f003.unitId)!.requestId)!;
    const f003Reverification = findReverificationUnit(completed, f003Request.authorization!.canonicalFindingKey)!;
    const f003TaskBefore = structuredClone(completed.tasks[f003.taskId]);
    const f003ReverificationTaskBefore = structuredClone(completed.tasks[f003Reverification.id]);
    const f003UnitBefore = structuredClone(completed.adaptive!.workUnits.find((u) => u.id === f003.unitId));
    const f003ReverificationUnitBefore = structuredClone(completed.adaptive!.workUnits.find((u) => u.id === f003Reverification.id));

    const started = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    await markRecovered(started, f001.taskId, 'salvage');
    await markRecovered(started, f002.taskId, 'handoff_repair');

    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new ReconciliationAgent('codex'), claude: new ReconciliationAgent('claude') },
    });
    const after = resumed.snapshot();

    assert.equal(after.adaptive!.workUnits.find((u) => u.id === f001.unitId)!.status, 'SUCCEEDED');
    assert.equal(after.adaptive!.workUnits.find((u) => u.id === f002.unitId)!.status, 'SUCCEEDED');
    assert.deepEqual(after.tasks[f003.taskId], f003TaskBefore, 'F003 correction task must be untouched');
    assert.deepEqual(after.tasks[f003Reverification.id], f003ReverificationTaskBefore, 'F003 re-verification task must be untouched');
    assert.deepEqual(after.adaptive!.workUnits.find((u) => u.id === f003.unitId), f003UnitBefore, 'F003 correction unit must be untouched');
    assert.deepEqual(after.adaptive!.workUnits.find((u) => u.id === f003Reverification.id), f003ReverificationUnitBefore, 'F003 re-verification unit must be untouched');

    const f001Request = after.adaptive!.workRequests.find((r) => r.id === after.adaptive!.workUnits.find((u) => u.id === f001.unitId)!.requestId)!;
    const f002Request = after.adaptive!.workRequests.find((r) => r.id === after.adaptive!.workUnits.find((u) => u.id === f002.unitId)!.requestId)!;
    assert.equal(after.adaptive!.workRequests.filter((r) =>
      r.authorization?.purpose === 'reverification' && r.authorization.canonicalFindingKey === f001Request.authorization!.canonicalFindingKey,
    ).length, 1, 'exactly one F001 re-verification');
    assert.equal(after.adaptive!.workRequests.filter((r) =>
      r.authorization?.purpose === 'reverification' && r.authorization.canonicalFindingKey === f002Request.authorization!.canonicalFindingKey,
    ).length, 1, 'exactly one F002 re-verification');
    assert.equal(after.adaptive!.workRequests.filter((r) =>
      r.authorization?.purpose === 'reverification' && r.authorization.canonicalFindingKey === f003Request.authorization!.canonicalFindingKey,
    ).length, 1, 'no duplicate F003 re-verification');
  } finally {
    await fixture.dispose();
  }
});
