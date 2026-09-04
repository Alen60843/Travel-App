import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentRequest, AgentResult } from '../../src/agents';
import { WorktreeManager } from '../../src/git';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunState, TaskRunState } from '../../src/state';
import { createTemporaryRepository } from '../git/helpers';

/**
 * A provider-neutral, fake-agent-only scenario shaped like the real Phase 6
 * dogfood state (run-20260904124350-dc56690c, never read or touched here):
 *
 *   f001-task (~work-000001): BLOCKED/AGENT_TIMEOUT, an authorized dirty
 *     diff in an owned file, no commit -> salvaged via AgentOrchestrator.salvageTask.
 *   f002-task (~work-000002): FAILED/HANDOFF_INVALID, a real preserved
 *     stdout log with a deterministically-repairable malformed key, PLUS a
 *     legacy handoffRepairAttempted=true/handoffRepairSucceeded=false shape
 *     (exactly the real run's persisted shape) -> recovered via
 *     AgentOrchestrator.recoverHandoffFailures, exercising the legacy
 *     migration in the same call.
 *   f003-task (~work-000003): already SUCCEEDED with a commit.
 *   work4-task (~work-000004, F003's targeted re-verification): already SUCCEEDED.
 *
 * Canonical-finding handling during salvage/recovery is deliberately NOT
 * exercised here — it's already proven in isolation by
 * test/workflow/agent-timeout-salvage.test.ts and
 * test/adaptive/adaptive-continuation.test.ts. This test's unique job is
 * the formal invariant: recovering f001/f002 in a single shared run must
 * never alter f003/work4's persisted state.
 */

class NeverAgent implements Agent {
  constructor(readonly name: 'codex' | 'claude') {}
  async run(request: AgentRequest): Promise<AgentResult> {
    throw new Error(`unexpected agent invocation for role ${request.role} (task ${request.taskId})`);
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
  verify:
    - command: "true"
      required: true
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

function malformedButDeterministicallyRepairableHandoff(): unknown {
  return {
    status: 'complete',
    summary: 'corrected F002',
    filesChanged: ['f002.txt'],
    // The exact real defect shape from the actual Phase 5/6 dogfood
    // recovery this repair tier was hardened against: a description
    // annotated onto the key itself, which deterministicallyRepairHandoffKeys
    // renames back to the bare form without any agent call.
    'decisions (non-obvious constraints)': ['reused existing helper'],
    tests: [{ command: 'fake-test', result: 'pass', details: 'fake evidence' }],
    openQuestions: [],
    reviewRequested: [],
  };
}

test('Phase6-shaped acceptance: salvaging f001-task and recovering f002-task leaves f003-task and work4-task provably unchanged', async () => {
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

    const worktrees = await WorktreeManager.create({ repositoryPath: fixture.repository });

    // f001-task: real registered worktree with a dirty, owned, uncommitted diff.
    const f001Worktree = await worktrees.createTaskWorktree({
      runId, taskId: 'f001-task', baseBranch: fixture.baseBranch, baseSha: before.baseSha,
    });
    await writeFile(join(f001Worktree.path, 'f001.txt'), 'salvageable F001 fix\n', 'utf8');

    // f002-task: real registered worktree with the agent's uncommitted fix
    // still dirty (the Orchestrator, never the agent, creates the task
    // commit — only once a handoff is actually accepted) plus a real
    // preserved stdout log containing a deterministically-repairable
    // malformed handoff, matching how recoverHandoffInvalidTask actually
    // re-reads evidence from disk.
    const f002Worktree = await worktrees.createTaskWorktree({
      runId, taskId: 'f002-task', baseBranch: fixture.baseBranch, baseSha: before.baseSha,
    });
    await writeFile(join(f002Worktree.path, 'f002.txt'), 'corrected F002\n', 'utf8');
    const logsDir = join(orchestrator.stateStore.runDirectory, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, `${runId}.f002-task.codex.attempt-1.stdout.log`),
      JSON.stringify(malformedButDeterministicallyRepairableHandoff()),
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
        message: "handoff.decisions (non-obvious constraints): is not a supported field",
        at: before.createdAt,
      },
      // The real protected run's exact persisted legacy shape — proves the
      // migration (Task 2) and budget accounting (Task 4) both engage for
      // real inside this same recovery call. Omitting handoffRepairAttempts
      // (set to undefined above, stripped below) is essential: its mere
      // presence as [] would short-circuit normalizeHandoffRepairAttempts
      // before it ever looks at these legacy booleans.
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

    // --- Recover f001-task via real salvageTask -------------------------
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

    // --- Recover f002-task via real recoverHandoffFailures ---------------
    const recovery = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new NeverAgent('codex'), claude: new NeverAgent('claude') },
    });
    assert.deepEqual(recovery.recovered, ['f002-task']);
    const afterRecovery = recovery.orchestrator.snapshot();
    assert.equal(afterRecovery.tasks['f002-task']?.status, 'SUCCEEDED');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts.length, 2, 'the migrated legacy attempt plus the new deterministic-repair attempt');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[0]?.method, 'legacy_unknown');
    assert.equal(afterRecovery.tasks['f002-task']?.handoffRepairAttempts[1]?.method, 'deterministic');

    // --- Formal invariant: F003/work4 remain provably unchanged ----------
    assert.deepEqual(afterRecovery.tasks['f003-task'], f003Before, 'f003-task must remain unchanged after recovering f002-task');
    assert.deepEqual(afterRecovery.tasks['work4-task'], work4Before, 'work4-task must remain unchanged after recovering f002-task');
    // ...and unchanged relative to the very first snapshot taken before
    // either recovery — the complete round trip touches no sibling task.
    assert.deepEqual(afterRecovery.tasks['f001-task'], afterSalvage.tasks['f001-task'], 'f001-task must be unaffected by the later f002-task recovery');
  } finally {
    await fixture.dispose();
  }
});
