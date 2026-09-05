import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { WorktreeManager } from '../../src/git';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunState, TaskRunState } from '../../src/state';
import { createTemporaryRepository } from '../git/helpers';

/**
 * A provider-neutral, fake-agent-only scenario shaped like the real Phase 6
 * dogfood state (run-20260904124350-dc56690c, never read or touched here)
 * AND the three additional real-recovery blockers found on top of it:
 *
 *   f001-task (~work-000001): BLOCKED/AGENT_TIMEOUT, an authorized dirty
 *     diff in an owned file, no commit. The phase's OWN salvage config has
 *     NO usable verify commands (salvage.verify: [] — the historical
 *     phase.yaml predates salvage.verify entirely, matching the real run).
 *     An authorized recovery-policy overlay supplies salvage.verify without
 *     ever editing phase.yaml -> salvaged via AgentOrchestrator.salvageTask.
 *   f002-task (~work-000002): FAILED/HANDOFF_INVALID, a real preserved
 *     stdout log whose defect (a wrong-typed field) neither the framing nor
 *     deterministic-key repair tier can fix, forcing the agent repair tier
 *     — PLUS a legacy handoffRepairAttempted=true/handoffRepairSucceeded=false
 *     shape (exactly the real run's persisted shape). The SAME authorized
 *     overlay configures a recovery executor on claude; the original owner
 *     (codex) is asserted to never be invoked during recovery, simulating
 *     "original owner/quota unavailable" -> recovered via
 *     AgentOrchestrator.recoverHandoffFailures, exercising the legacy
 *     migration and provider-neutral routing in the same call, without
 *     rerunning code generation (the diff is untouched).
 *   f003-task (~work-000003): already SUCCEEDED with a commit.
 *   work4-task (~work-000004, F003's targeted re-verification): already SUCCEEDED.
 *
 * This test's unique job is the formal invariant: authorizing a recovery
 * policy and recovering f001/f002 in a single shared run must never alter
 * f003/work4's persisted state, and must never edit the run's immutable
 * phase.yaml snapshot.
 */

class NeverAgent implements Agent {
  constructor(readonly name: AgentName) {}
  async run(request: AgentRequest): Promise<AgentResult> {
    throw new Error(`unexpected agent invocation for role ${request.role} (task ${request.taskId}, agent ${this.name})`);
  }
}

/** The configured recovery executor for f002-task's handoff_repair — never the original owner (codex). */
class MetadataRepairAgent implements Agent {
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
phase: phase6-dogfood-acceptance
name: Phase 6 dogfood recovery acceptance
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 4
agentRetries: 0
maxReviewRounds: 3
salvage:
  verify: []
tasks:
  - id: f001-task
    title: F001 correction (timed out)
    owner: codex
    mode: implementation
    effort: medium
    files: [f001.txt]
  - id: f002-task
    title: F002 testing correction (handoff invalid)
    owner: codex
    mode: implementation
    effort: medium
    files: [f002.txt]
  - id: f003-task
    title: F003 testing correction (already succeeded)
    owner: codex
    mode: implementation
    effort: medium
    files: [f003.txt]
  - id: work4-task
    title: F003 targeted re-verification (already succeeded)
    owner: claude
    mode: review
    effort: medium
    files: []
    dependsOn: [f003-task]
`;
}

/**
 * A defect neither framing (no prose wrapping — this is already bare JSON)
 * nor deterministic key-rename (every key name is already exactly right)
 * can fix: `tests` is the wrong TYPE. Only the bounded agent repair tier —
 * here, the configured recovery executor, never the original owner — can
 * plausibly correct it.
 */
function malformedRequiringAgentRepair(): unknown {
  return {
    status: 'complete',
    summary: 'corrected F002',
    filesChanged: ['f002.txt'],
    decisions: [],
    tests: null,
    openQuestions: [],
    reviewRequested: [],
  };
}

test('Phase6-shaped acceptance: authorizing a recovery policy, then salvaging f001-task and recovering f002-task via the configured recovery executor, leaves f003-task and work4-task provably unchanged', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await writeFile(join(fixture.repository, 'f001.txt'), 'base\n', 'utf8');
    await writeFile(join(fixture.repository, 'f002.txt'), 'base\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'f001.txt', 'f002.txt']);
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
    const phaseSnapshotBefore = await readFile(join(orchestrator.stateStore.runDirectory, 'phase.yaml'), 'utf8');

    const worktrees = await WorktreeManager.create({ repositoryPath: fixture.repository });

    // f001-task: real registered worktree with a dirty, owned, uncommitted diff.
    const f001Worktree = await worktrees.createTaskWorktree({
      runId, taskId: 'f001-task', baseBranch: fixture.baseBranch, baseSha: before.baseSha,
    });
    await writeFile(join(f001Worktree.path, 'f001.txt'), 'salvageable F001 fix\n', 'utf8');

    // f002-task: real registered worktree with the agent's uncommitted fix
    // still dirty (the Orchestrator, never the agent, creates the task
    // commit — only once a handoff is actually accepted) plus a real
    // preserved stdout log containing the agent-tier-only malformed handoff.
    const f002Worktree = await worktrees.createTaskWorktree({
      runId, taskId: 'f002-task', baseBranch: fixture.baseBranch, baseSha: before.baseSha,
    });
    await writeFile(join(f002Worktree.path, 'f002.txt'), 'corrected F002\n', 'utf8');
    const logsDir = join(orchestrator.stateStore.runDirectory, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, `${runId}.f002-task.codex.attempt-1.stdout.log`),
      JSON.stringify(malformedRequiringAgentRepair()),
      'utf8',
    );

    const f001State: TaskRunState = {
      ...before.tasks['f001-task']!,
      status: 'BLOCKED',
      worktreePath: f001Worktree.path,
      branch: f001Worktree.branch,
      preparedHeadSha: before.baseSha,
      startedAt: before.createdAt,
      finishedAt: before.createdAt,
      agentAttempts: [{
        attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'timed_out',
      }],
      error: { code: 'AGENT_TIMEOUT', message: 'bounded execution timeout', at: before.createdAt },
    };
    const f002State: TaskRunState = {
      ...before.tasks['f002-task']!,
      status: 'FAILED',
      worktreePath: f002Worktree.path,
      branch: f002Worktree.branch,
      preparedHeadSha: before.baseSha,
      startedAt: before.createdAt,
      finishedAt: before.createdAt,
      agentAttempts: [{
        attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'succeeded',
      }],
      error: {
        code: 'HANDOFF_INVALID',
        message: 'handoff.tests must be an array',
        at: before.createdAt,
      },
      // The real protected run's exact persisted legacy shape — proves the
      // migration (Task 2) and budget accounting (Task 4) both engage for
      // real inside this same recovery call. Omitting handoffRepairAttempts
      // (stripped below) is essential: its mere presence as [] would
      // short-circuit normalizeHandoffRepairAttempts before it ever looks
      // at these legacy booleans.
      handoffRepairAttempted: true,
      handoffRepairSucceeded: false,
    } as unknown as TaskRunState;
    delete (f002State as unknown as Record<string, unknown>).handoffRepairAttempts;
    const f003State: TaskRunState = {
      ...before.tasks['f003-task']!,
      status: 'SUCCEEDED',
      finishedAt: before.createdAt,
      handoffPath: join(orchestrator.stateStore.runDirectory, 'handoffs', 'f003-task.json'),
      handoffOutcome: 'valid',
      commit: { sha: '1'.repeat(40), parentSha: before.baseSha, changedFiles: ['f003.txt'] },
      agentAttempts: [{
        attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'succeeded',
      }],
    };
    const work4State: TaskRunState = {
      ...before.tasks['work4-task']!,
      status: 'SUCCEEDED',
      finishedAt: before.createdAt,
      handoffPath: join(orchestrator.stateStore.runDirectory, 'handoffs', 'work4-task.json'),
      handoffOutcome: 'valid',
      reviewPaths: [join(orchestrator.stateStore.runDirectory, 'reviews', 'work4-task-1.json')],
      agentAttempts: [{
        attempt: 1, agent: 'claude', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'succeeded',
      }],
    };

    const initial: RunState = {
      ...before,
      status: 'FAILED',
      tasks: {
        ...before.tasks,
        'f001-task': f001State,
        'f002-task': f002State,
        'f003-task': f003State,
        'work4-task': work4State,
      },
    };
    await orchestrator.stateStore.save(initial);

    const f003Before = structuredClone(f003State);
    const work4Before = structuredClone(work4State);

    // --- Authorize the one recovery-policy overlay this run needs --------
    // Covers both new blockers at once: salvage.verify (the historical
    // phase.yaml has none) and a handoff_repair executor on claude, NOT
    // the original owner codex — simulating "Codex quota unavailable".
    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      salvage: { verify: [{ command: 'true', required: true }] },
      executors: [{
        id: 'metadata-repairer', adapter: 'claude', roles: ['handoff_repair'],
        capabilities: [{ capability: 'handoff_repair' }], available: true,
      }],
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') } });
    assert.equal(authorization.orchestrator.snapshot().recoveryPolicyHistory?.length, 1);
    // The overlay never touches the immutable phase.yaml snapshot.
    const phaseSnapshotAfterAuthorization = await readFile(join(orchestrator.stateStore.runDirectory, 'phase.yaml'), 'utf8');
    assert.equal(phaseSnapshotAfterAuthorization, phaseSnapshotBefore);

    // --- Recover f001-task via real salvageTask (overlay supplies verify) -
    const salvageResult = await AgentOrchestrator.salvageTask(runId, 'f001-task', {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') },
    });
    const afterSalvage = salvageResult.orchestrator.snapshot();
    assert.equal(afterSalvage.tasks['f001-task']?.status, 'SUCCEEDED');
    assert.ok(afterSalvage.tasks['f001-task']?.commit?.sha);
    assert.deepEqual(afterSalvage.tasks['f003-task'], f003Before, 'f003-task must be untouched by salvaging f001-task');
    assert.deepEqual(afterSalvage.tasks['work4-task'], work4Before, 'work4-task must be untouched by salvaging f001-task');

    // --- Recover f002-task via real recoverHandoffFailures, routed away
    // from the original owner ---------------------------------------------
    const codexDuringRecovery = new NeverAgent('codex');
    const claudeDuringRecovery = new MetadataRepairAgent('claude');
    const recovery = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: codexDuringRecovery, claude: claudeDuringRecovery },
    });
    assert.deepEqual(recovery.recovered, ['f002-task']);
    // Codex (the original owner) was never invoked — the repair was routed
    // to the configured executor instead, exactly as authorized.
    assert.equal(claudeDuringRecovery.invocations.length, 1);
    assert.equal(claudeDuringRecovery.invocations[0]?.role, 'handoff_repair');

    const afterRecovery = recovery.orchestrator.snapshot();
    assert.equal(afterRecovery.tasks['f002-task']?.status, 'SUCCEEDED');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts.length, 2, 'the migrated legacy attempt plus the new agent-tier repair attempt');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[0]?.method, 'legacy_unknown');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[1]?.method, 'agent');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[1]?.repairExecutorId, 'metadata-repairer');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[1]?.repairAdapter, 'claude');
    // The diff itself was never touched — recovery repaired metadata only.
    assert.equal(
      (await fixture.git.run(f002Worktree.path, ['show', 'HEAD:f002.txt'])).stdout,
      'corrected F002\n',
    );

    // --- Formal invariant: F003/work4 remain provably unchanged ----------
    assert.deepEqual(afterRecovery.tasks['f003-task'], f003Before, 'f003-task must remain unchanged after recovering f002-task');
    assert.deepEqual(afterRecovery.tasks['work4-task'], work4Before, 'work4-task must remain unchanged after recovering f002-task');
    // ...and unchanged relative to the very first snapshot taken before
    // either recovery — the complete round trip touches no sibling task.
    assert.deepEqual(afterRecovery.tasks['f001-task'], afterSalvage.tasks['f001-task'], 'f001-task must be unaffected by the later f002-task recovery');

    // The immutable phase.yaml snapshot was never edited at any point.
    const phaseSnapshotFinal = await readFile(join(orchestrator.stateStore.runDirectory, 'phase.yaml'), 'utf8');
    assert.equal(phaseSnapshotFinal, phaseSnapshotBefore);
  } finally {
    await fixture.dispose();
  }
});

/**
 * The configured recovery executor's response has the EXACT real F002
 * dogfood defect: it prefaces its repaired JSON with prose and wraps it in
 * a markdown fence, instead of the earlier MetadataRepairAgent's bare JSON.
 */
class ProseFencedRepairAgent implements Agent {
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
      structuredHandoff: null,
      rawStdout: `I'll proceed directly to producing the repaired JSON.\n\n\`\`\`json\n${JSON.stringify(repaired)}\n\`\`\`\n`,
      changedFiles: [], gitDiffSummary: null, testsReported: [],
      unresolvedQuestions: [], startedAt: now, endedAt: now, durationMs: 1, timedOut: false, aborted: false,
      errorMessage: null,
    };
  }
}

test('Phase6-shaped regression: F002 with 2 exhausted handoff-repair attempts (legacy_unknown + a failed Claude repair) recovers on a 3rd, budget-extended attempt via prose-fenced JSON framing, leaving F003/work4 untouched', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await writeFile(join(fixture.repository, 'f002.txt'), 'base\n', 'utf8');
    await writeFile(join(fixture.repository, 'f003.txt'), 'base\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'f002.txt', 'f003.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'baseline']);
    const runsRoot = join(fixture.container, 'runs');
    const phaseFile = join(fixture.container, 'phase.yaml');
    // Reuses the same F001/F002/F003/work4 shape as the acceptance test
    // above; f001-task is left untouched (unregistered, never salvaged —
    // out of scope here, matching the real run's deferred F001 salvage).
    await writeFile(phaseFile, phaseYaml(fixture.baseBranch), 'utf8');

    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') },
    });
    const runId = orchestrator.snapshot().runId;
    const before = orchestrator.snapshot();
    const phaseSnapshotBefore = await readFile(join(orchestrator.stateStore.runDirectory, 'phase.yaml'), 'utf8');

    const worktrees = await WorktreeManager.create({ repositoryPath: fixture.repository });
    const f002Worktree = await worktrees.createTaskWorktree({
      runId, taskId: 'f002-task', baseBranch: fixture.baseBranch, baseSha: before.baseSha,
    });
    await writeFile(join(f002Worktree.path, 'f002.txt'), 'corrected F002\n', 'utf8');
    const logsDir = join(orchestrator.stateStore.runDirectory, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, `${runId}.f002-task.codex.attempt-1.stdout.log`),
      JSON.stringify(malformedRequiringAgentRepair()),
      'utf8',
    );

    const f002State: TaskRunState = {
      ...before.tasks['f002-task']!,
      status: 'FAILED',
      worktreePath: f002Worktree.path,
      branch: f002Worktree.branch,
      preparedHeadSha: before.baseSha,
      startedAt: before.createdAt,
      finishedAt: before.createdAt,
      agentAttempts: [{
        attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'succeeded',
      }],
      error: { code: 'HANDOFF_INVALID', message: 'handoff.tests must be an array', at: before.createdAt },
      // The real F002 shape: a migrated legacy attempt, then a native
      // agent-tier attempt that failed with evidence_insufficient — the
      // exact misclassification the framing bug caused before this fix,
      // since the repair agent's prose+fence response was never actually
      // evidence-insufficient, just unparsed.
      handoffRepairAttempts: [
        { method: 'legacy_unknown', succeeded: false, failureReason: 'legacy_unknown' },
        {
          method: 'agent', succeeded: false, failureReason: 'evidence_insufficient',
          timestamp: before.createdAt, repairExecutorId: 'metadata-repairer', repairAdapter: 'claude',
        },
      ],
    };
    const f003State: TaskRunState = {
      ...before.tasks['f003-task']!,
      status: 'SUCCEEDED',
      finishedAt: before.createdAt,
      handoffPath: join(orchestrator.stateStore.runDirectory, 'handoffs', 'f003-task.json'),
      handoffOutcome: 'valid',
      commit: { sha: '2'.repeat(40), parentSha: before.baseSha, changedFiles: ['f003.txt'] },
      agentAttempts: [{
        attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'succeeded',
      }],
    };
    const work4State: TaskRunState = {
      ...before.tasks['work4-task']!,
      status: 'SUCCEEDED',
      finishedAt: before.createdAt,
      handoffPath: join(orchestrator.stateStore.runDirectory, 'handoffs', 'work4-task.json'),
      handoffOutcome: 'valid',
      reviewPaths: [join(orchestrator.stateStore.runDirectory, 'reviews', 'work4-task-1.json')],
      agentAttempts: [{
        attempt: 1, agent: 'claude', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'succeeded',
      }],
    };
    const initial: RunState = {
      ...before,
      status: 'FAILED',
      tasks: { ...before.tasks, 'f002-task': f002State, 'f003-task': f003State, 'work4-task': work4State },
    };
    await orchestrator.stateStore.save(initial);
    const f003Before = structuredClone(f003State);
    const work4Before = structuredClone(work4State);

    // --- Proof the fix is actually necessary: without any authorized
    // policy, the base budget (2) is already exhausted by the two
    // persisted attempts above, so recovery must still refuse. ------------
    await assert.rejects(
      () => AgentOrchestrator.recoverHandoffFailures(runId, {
        repositoryPath: fixture.repository, runsRoot,
        agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
        const details = error.details as unknown as { ineligible: Array<{ taskId: string; reasonCode?: string }> };
        assert.equal(details.ineligible[0]?.taskId, 'f002-task');
        assert.equal(details.ineligible[0]?.reasonCode, 'HANDOFF_REPAIR_BUDGET_EXHAUSTED');
        return true;
      },
    );

    // --- Authorize the combined overlay: one additional attempt, plus the
    // same claude recovery executor as before -----------------------------
    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      handoffRepair: { additionalAttempts: 1 },
      executors: [{
        id: 'metadata-repairer', adapter: 'claude', roles: ['handoff_repair'],
        capabilities: [{ capability: 'handoff_repair' }], available: true,
      }],
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') } });
    assert.equal(authorization.orchestrator.snapshot().recoveryPolicyHistory?.length, 1);
    assert.equal(
      await readFile(join(orchestrator.stateStore.runDirectory, 'phase.yaml'), 'utf8'),
      phaseSnapshotBefore,
      'the overlay never touches the immutable phase.yaml snapshot',
    );

    // --- The 3rd attempt: the configured executor returns prose-fenced
    // JSON (the real bug), which framing must extract deterministically --
    const codexDuringRecovery = new NeverAgent('codex');
    const claudeDuringRecovery = new ProseFencedRepairAgent('claude');
    const recovery = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: codexDuringRecovery, claude: claudeDuringRecovery },
    });
    assert.deepEqual(recovery.recovered, ['f002-task']);
    assert.equal(claudeDuringRecovery.invocations.length, 1, 'exactly one bounded repair call — no second agent invocation');

    const afterRecovery = recovery.orchestrator.snapshot();
    assert.equal(afterRecovery.tasks['f002-task']?.status, 'SUCCEEDED');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts.length, 3);
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[0]?.method, 'legacy_unknown');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[1]?.failureReason, 'evidence_insufficient');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[2]?.method, 'agent');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[2]?.succeeded, true);
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[2]?.repairExecutorId, 'metadata-repairer');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[2]?.repairAdapter, 'claude');
    // No code regeneration occurred — the diff committed is exactly the
    // agent's original (pre-recovery) uncommitted fix.
    assert.equal(
      (await fixture.git.run(f002Worktree.path, ['show', 'HEAD:f002.txt'])).stdout,
      'corrected F002\n',
    );

    // --- Formal invariant: F003/work4 remain provably unchanged ----------
    assert.deepEqual(afterRecovery.tasks['f003-task'], f003Before, 'f003-task must remain unchanged after recovering f002-task');
    assert.deepEqual(afterRecovery.tasks['work4-task'], work4Before, 'work4-task must remain unchanged after recovering f002-task');

    const phaseSnapshotFinal = await readFile(join(orchestrator.stateStore.runDirectory, 'phase.yaml'), 'utf8');
    assert.equal(phaseSnapshotFinal, phaseSnapshotBefore);
  } finally {
    await fixture.dispose();
  }
});
