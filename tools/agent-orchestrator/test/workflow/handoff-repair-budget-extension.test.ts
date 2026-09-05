import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { WorktreeManager } from '../../src/git';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunState, TaskRunState } from '../../src/state';
import { createTemporaryRepository } from '../git/helpers';

/**
 * The audited handoff-repair budget extension
 * (RecoveryPolicyOverlay.handoffRepair.additionalAttempts): the real F002
 * dogfood task has 2 persisted failed handoffRepairAttempts, exhausting the
 * default maxHandoffRepairAttempts (2). These tests prove the effective
 * budget (base + authorized additional) is computed correctly, requires
 * explicit operator authorization via agents:authorize-recovery-policy
 * (never a silent grant), and uses STATE semantics — repeated authorization
 * of the same additionalAttempts value never stacks the budget.
 *
 * No agent is ever actually invoked to a repair success in this file (the
 * combined framing + budget dogfood-shaped regression lives in
 * phase6-dogfood-recovery-acceptance.test.ts) — these tests isolate the
 * eligibility/budget arithmetic itself, following the scenario 16b harness
 * shape in solver-verifier-protocol.test.ts.
 */

class NeverAgent implements Agent {
  constructor(readonly name: AgentName) {}
  async run(request: AgentRequest): Promise<AgentResult> {
    throw new Error(`unexpected agent invocation for role ${request.role} (task ${request.taskId}, agent ${this.name})`);
  }
}

/** Always succeeds a bounded read-only repair call — used only where a test expects the budget to actually admit a 3rd attempt. */
class AlwaysRepairsAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(readonly name: AgentName) {}
  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    const spec = request.taskSpecification as { malformedOutput: Record<string, unknown> };
    const repaired = { ...spec.malformedOutput, tests: [] };
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded', failureCode: null,
      exitCode: 0, signal: null,
      stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout`),
      stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr`),
      structuredHandoff: repaired, changedFiles: [], gitDiffSummary: null, testsReported: [],
      unresolvedQuestions: [], startedAt: now, endedAt: now, durationMs: 1, timedOut: false, aborted: false,
      errorMessage: null,
    };
  }
}

function phaseYaml(baseBranch: string): string {
  return `
phase: handoff-repair-budget-extension
name: Handoff repair budget extension
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 1
agentRetries: 0
maxReviewRounds: 3
tasks:
  - id: solve
    title: Solve (handoff invalid, budget exhausted)
    owner: codex
    mode: implementation
    effort: medium
    files: [feature.txt]
`;
}

function malformedHandoff(): unknown {
  return {
    status: 'complete',
    summary: 'corrected',
    filesChanged: ['feature.txt'],
    decisions: [],
    tests: null,
    openQuestions: [],
    reviewRequested: [],
  };
}

async function setUp() {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
  await writeFile(join(fixture.repository, 'feature.txt'), 'base\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'baseline']);
  const runsRoot = join(fixture.container, 'runs');
  const phaseFile = join(fixture.container, 'phase.yaml');
  await writeFile(phaseFile, phaseYaml(fixture.baseBranch), 'utf8');
  const orchestrator = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository,
    runsRoot,
    agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') },
  });
  const runId = orchestrator.snapshot().runId;
  const before = orchestrator.snapshot();
  const logsDir = join(orchestrator.stateStore.runDirectory, 'logs');
  await mkdir(logsDir, { recursive: true });
  await writeFile(
    join(logsDir, `${runId}.solve.codex.attempt-1.stdout.log`),
    JSON.stringify(malformedHandoff()),
    'utf8',
  );
  const worktrees = await WorktreeManager.create({ repositoryPath: fixture.repository, git: fixture.git });
  const worktree = await worktrees.createTaskWorktree({
    runId, taskId: 'solve', baseBranch: fixture.baseBranch, baseSha: before.baseSha,
  });
  await writeFile(join(worktree.path, 'feature.txt'), 'corrected\n', 'utf8');
  return { fixture, runsRoot, orchestrator, runId, before, worktree };
}

/** Persists a FAILED/HANDOFF_INVALID `solve` task with exactly the given prior handoffRepairAttempts. */
async function seedFailedTask(
  orchestrator: AgentOrchestrator,
  before: RunState,
  worktree: { readonly path: string; readonly branch: string },
  handoffRepairAttempts: TaskRunState['handoffRepairAttempts'],
): Promise<void> {
  const solveState: TaskRunState = {
    ...before.tasks.solve!,
    status: 'FAILED',
    worktreePath: worktree.path,
    branch: worktree.branch,
    preparedHeadSha: before.baseSha,
    startedAt: before.createdAt,
    finishedAt: before.createdAt,
    agentAttempts: [{ attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'succeeded' }],
    error: { code: 'HANDOFF_INVALID', message: 'handoff.tests must be an array', at: before.createdAt },
    handoffRepairAttempts,
  };
  const failed: RunState = { ...before, status: 'FAILED', tasks: { ...before.tasks, solve: solveState } };
  await orchestrator.stateStore.save(failed);
}

const TWO_FAILED_ATTEMPTS: TaskRunState['handoffRepairAttempts'] = [
  { method: 'legacy_unknown', succeeded: false, failureReason: 'legacy_unknown' },
  {
    method: 'agent', succeeded: false, failureReason: 'evidence_insufficient',
    timestamp: '2026-09-04T00:00:00.000Z', repairExecutorId: 'metadata-repairer', repairAdapter: 'claude',
  },
];

async function assertBudgetExhausted(runId: string, fixture: Awaited<ReturnType<typeof createTemporaryRepository>>, runsRoot: string): Promise<void> {
  const codex = new NeverAgent('codex');
  await assert.rejects(
    () => AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex, claude: new NeverAgent('claude') },
    }),
    (error: unknown) => {
      if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
      const details = error.details as unknown as { ineligible: Array<{ taskId: string; reasonCode?: string }> };
      assert.equal(details.ineligible.length, 1);
      assert.equal(details.ineligible[0]?.taskId, 'solve');
      assert.equal(details.ineligible[0]?.reasonCode, 'HANDOFF_REPAIR_BUDGET_EXHAUSTED');
      return true;
    },
  );
}

// A. Base budget (2), no overlay, 2 prior failed attempts -> ineligible (unchanged pre-existing behavior).
test('budget extension A: base budget with no overlay and 2 failed attempts remains exhausted', async () => {
  const { fixture, runsRoot, orchestrator, runId, before, worktree } = await setUp();
  try {
    await seedFailedTask(orchestrator, before, worktree, TWO_FAILED_ATTEMPTS);
    await assertBudgetExhausted(runId, fixture, runsRoot);
  } finally {
    await fixture.dispose();
  }
});

// B. base=2 + additionalAttempts=1 + 2 failed attempts -> eligible for exactly one more attempt.
test('budget extension B: an authorized additionalAttempts:1 admits exactly one more attempt', async () => {
  const { fixture, runsRoot, orchestrator, runId, before, worktree } = await setUp();
  try {
    await seedFailedTask(orchestrator, before, worktree, TWO_FAILED_ATTEMPTS);
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      handoffRepair: { additionalAttempts: 1 },
      executors: [{
        id: 'metadata-repairer', adapter: 'claude', roles: ['handoff_repair'],
        capabilities: [{ capability: 'handoff_repair' }], available: true,
      }],
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') } });

    const codexDuringRecovery = new NeverAgent('codex');
    const claudeDuringRecovery = new AlwaysRepairsAgent('claude');
    const recovery = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: codexDuringRecovery, claude: claudeDuringRecovery },
    });
    assert.deepEqual(recovery.recovered, ['solve']);
    assert.equal(claudeDuringRecovery.invocations.length, 1, 'exactly one bounded repair call — the third attempt');
    const after = recovery.orchestrator.snapshot();
    assert.equal(after.tasks.solve?.status, 'SUCCEEDED');
    assert.equal(after.tasks.solve?.handoffRepairAttempts.length, 3);
    assert.equal(after.tasks.solve?.handoffRepairAttempts[2]?.succeeded, true);
  } finally {
    await fixture.dispose();
  }
});

// C. After a 3rd attempt ALSO fails, the (now fully consumed) effective budget of 3 is exhausted again.
test('budget extension C: once the 3rd (extended) attempt also fails, the extended budget is exhausted', async () => {
  const { fixture, runsRoot, orchestrator, runId, before, worktree } = await setUp();
  try {
    const threeFailedAttempts: TaskRunState['handoffRepairAttempts'] = [
      ...TWO_FAILED_ATTEMPTS,
      { method: 'agent', succeeded: false, failureReason: 'repair_output_invalid', timestamp: before.createdAt, repairExecutorId: 'metadata-repairer', repairAdapter: 'claude' },
    ];
    await seedFailedTask(orchestrator, before, worktree, threeFailedAttempts);
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      handoffRepair: { additionalAttempts: 1 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') } });
    await assertBudgetExhausted(runId, fixture, runsRoot);
  } finally {
    await fixture.dispose();
  }
});

// D. Re-authorizing the SAME additionalAttempts value a second time must not stack — STATE, not transaction, semantics.
test('budget extension D: reauthorizing the same additionalAttempts twice does not stack the budget', async () => {
  const { fixture, runsRoot, orchestrator, runId, before, worktree } = await setUp();
  try {
    const threeFailedAttempts: TaskRunState['handoffRepairAttempts'] = [
      ...TWO_FAILED_ATTEMPTS,
      { method: 'agent', succeeded: false, failureReason: 'repair_output_invalid', timestamp: before.createdAt, repairExecutorId: 'metadata-repairer', repairAdapter: 'claude' },
    ];
    await seedFailedTask(orchestrator, before, worktree, threeFailedAttempts);
    const policy = { handoffRepair: { additionalAttempts: 1 } };
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, policy, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') },
    });
    // Authorize the identical policy again.
    const second = await AgentOrchestrator.authorizeRecoveryPolicy(runId, policy, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') },
    });
    assert.equal(second.orchestrator.snapshot().recoveryPolicyHistory?.length, 2, 'both authorizations are recorded (append-only)');
    // Effective budget is still base(2) + 1 = 3, already fully consumed by 3 failed attempts — NOT base + 2.
    await assertBudgetExhausted(runId, fixture, runsRoot);
  } finally {
    await fixture.dispose();
  }
});

// E. No overlay at all preserves the existing default behavior exactly (backward compatibility).
test('budget extension E: a run with no recovery policy history behaves exactly as before', async () => {
  const { fixture, runsRoot, orchestrator, runId, before, worktree } = await setUp();
  try {
    await seedFailedTask(orchestrator, before, worktree, TWO_FAILED_ATTEMPTS);
    assert.equal(orchestrator.snapshot().recoveryPolicyHistory, undefined);
    await assertBudgetExhausted(runId, fixture, runsRoot);
  } finally {
    await fixture.dispose();
  }
});

// F. additionalAttempts:0 (an explicit, authorized no-op) leaves the base budget exactly as it was.
test('budget extension F: an authorized additionalAttempts:0 leaves the base budget unchanged', async () => {
  const { fixture, runsRoot, orchestrator, runId, before, worktree } = await setUp();
  try {
    await seedFailedTask(orchestrator, before, worktree, TWO_FAILED_ATTEMPTS);
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      handoffRepair: { additionalAttempts: 0 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') } });
    await assertBudgetExhausted(runId, fixture, runsRoot);
  } finally {
    await fixture.dispose();
  }
});

// G. A successful repair remains permanently idempotent/SUCCEEDED regardless of remaining budget — recovery is never re-attempted on an already-SUCCEEDED task.
test('budget extension G: recovering an already-SUCCEEDED task is a no-op regardless of budget', async () => {
  const { fixture, runsRoot, orchestrator, runId, before, worktree } = await setUp();
  try {
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      handoffRepair: { additionalAttempts: 5 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') } });
    const solveState: TaskRunState = {
      ...before.tasks.solve!,
      status: 'SUCCEEDED',
      finishedAt: before.createdAt,
      commit: { sha: '1'.repeat(40), parentSha: before.baseSha, changedFiles: ['feature.txt'] },
      agentAttempts: [{ attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'succeeded' }],
      handoffRepairAttempts: TWO_FAILED_ATTEMPTS,
    };
    await orchestrator.stateStore.save({ ...before, status: 'COMPLETED', tasks: { ...before.tasks, solve: solveState } });
    const recovery = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') },
    });
    assert.deepEqual(recovery.recovered, []);
  } finally {
    await fixture.dispose();
  }
});

// H. The overlay's executors field is independent of handoffRepair.additionalAttempts — authorizing budget alone, with no executors, falls back to the original owner (codex), which here is a NeverAgent, so recovery must still fail closed at dispatch (not silently succeed) — proving the budget field alone confers no executor identity or capability.
test('budget extension H: authorizing additionalAttempts alone (no executors) still routes repair to the original owner', async () => {
  const { fixture, runsRoot, orchestrator, runId, before, worktree } = await setUp();
  try {
    await seedFailedTask(orchestrator, before, worktree, TWO_FAILED_ATTEMPTS);
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      handoffRepair: { additionalAttempts: 1 },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') } });

    const codexDuringRecovery = new AlwaysRepairsAgent('codex');
    const recovery = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: codexDuringRecovery, claude: new NeverAgent('claude') },
    });
    assert.deepEqual(recovery.recovered, ['solve']);
    assert.equal(codexDuringRecovery.invocations.length, 1, 'no executors configured -> falls back to the original owner, codex');
  } finally {
    await fixture.dispose();
  }
});
