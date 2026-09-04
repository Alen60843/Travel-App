import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { WorktreeManager } from '../../src/git';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunState } from '../../src/state';
import { createTemporaryRepository, type TemporaryRepository } from '../git/helpers';

/** Never actually invoked in these tests — salvage never calls an agent for the base flow (no canonical findings). */
class UnusedAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(readonly name: 'codex' | 'claude') {}
  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    throw new Error(`unexpected agent invocation for role ${request.role}`);
  }
}

function phaseYaml(
  baseBranch: string,
  options: { readonly verify?: readonly string[]; readonly verifyCommand?: string } = {},
): string {
  const verifyCommand = options.verifyCommand ?? 'true';
  const quoted = (command: string): string => JSON.stringify(command);
  const verifyBlock = options.verify === undefined
    ? `salvage:\n  verify:\n    - command: ${quoted(verifyCommand)}\n      required: true\n`
    : options.verify.length === 0
      ? 'salvage:\n  verify: []\n'
      : `salvage:\n  verify:\n${options.verify.map((c) => `    - command: ${quoted(c)}\n      required: true\n`).join('')}`;
  return `
phase: salvage-test
name: Timed-out writer salvage
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 2
agentRetries: 0
maxReviewRounds: 3
${verifyBlock}tasks:
  - id: timed-out-task
    title: Timed-out writer
    owner: codex
    mode: implementation
    effort: medium
    files: [feature.txt]
`;
}

interface Scenario {
  readonly fixture: TemporaryRepository;
  readonly runsRoot: string;
  readonly runId: string;
  readonly orchestrator: AgentOrchestrator;
  readonly worktreePath: string;
}

async function createTimeoutScenario(options: {
  readonly verify?: readonly string[];
  readonly verifyCommand?: string;
  readonly leaveDirtyDiff?: boolean;
  readonly outsideOwnershipEdit?: boolean;
  readonly extraUntrackedFile?: boolean;
  readonly foreignCommit?: boolean;
} = {}): Promise<Scenario> {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
  await writeFile(join(fixture.repository, 'feature.txt'), 'base\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'add design and feature baseline']);
  const runsRoot = join(fixture.container, 'runs');
  const phaseFile = join(fixture.container, 'phase.yaml');
  await writeFile(phaseFile, phaseYaml(fixture.baseBranch, {
    ...(options.verify === undefined ? {} : { verify: options.verify }),
    ...(options.verifyCommand === undefined ? {} : { verifyCommand: options.verifyCommand }),
  }), 'utf8');

  const orchestrator = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository,
    runsRoot,
    agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
  });
  const runId = orchestrator.snapshot().runId;
  const before = orchestrator.snapshot();

  const worktrees = await WorktreeManager.create({ repositoryPath: fixture.repository });
  const worktree = await worktrees.createTaskWorktree({
    runId,
    taskId: 'timed-out-task',
    baseBranch: fixture.baseBranch,
    baseSha: before.baseSha,
  });

  if (options.leaveDirtyDiff !== false) {
    await writeFile(join(worktree.path, 'feature.txt'), 'salvageable work\n', 'utf8');
  }
  if (options.outsideOwnershipEdit === true) {
    await writeFile(join(worktree.path, 'design.md'), 'unauthorized edit\n', 'utf8');
  }
  if (options.extraUntrackedFile === true) {
    await writeFile(join(worktree.path, 'stray.txt'), 'unexpected new file\n', 'utf8');
  }
  if (options.foreignCommit === true) {
    await writeFile(join(worktree.path, 'feature.txt'), 'committed anyway\n', 'utf8');
    await fixture.git.run(worktree.path, ['add', '--', 'feature.txt']);
    await fixture.git.run(worktree.path, ['commit', '-m', 'a foreign commit that should never exist here']);
  }

  const timedOut: RunState = {
    ...before,
    status: 'BLOCKED',
    tasks: {
      ...before.tasks,
      'timed-out-task': {
        ...before.tasks['timed-out-task']!,
        status: 'BLOCKED',
        worktreePath: worktree.path,
        branch: worktree.branch,
        preparedHeadSha: before.baseSha,
        startedAt: before.createdAt,
        finishedAt: before.createdAt,
        agentAttempts: [{
          attempt: 1,
          agent: 'codex',
          startedAt: before.createdAt,
          finishedAt: before.createdAt,
          outcome: 'timed_out',
        }],
        error: {
          code: 'AGENT_TIMEOUT',
          message: 'bounded execution timeout',
          at: before.createdAt,
        },
      },
    },
  };
  await orchestrator.stateStore.save(timedOut);

  return { fixture, runsRoot, runId, orchestrator, worktreePath: worktree.path };
}

test('AGENT_TIMEOUT + dirty diff fully inside ownership: successful salvage authorizes, verifies, and commits, and the task becomes SUCCEEDED', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true' });
  try {
    const result = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
    });
    const after = result.orchestrator.snapshot();
    assert.equal(after.tasks['timed-out-task']?.status, 'SUCCEEDED');
    assert.equal(after.tasks['timed-out-task']?.commit?.sha, result.commitSha);
    assert.deepEqual(after.tasks['timed-out-task']?.commit?.changedFiles, ['feature.txt']);
    assert.equal(after.tasks['timed-out-task']?.salvage?.verification?.result, 'passed');
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a clean timed-out worktree is not salvage work', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', leaveDirtyDiff: false });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_WORKTREE_CLEAN');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a dirty change outside task ownership refuses salvage', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', outsideOwnershipEdit: true });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_OWNERSHIP_VIOLATION');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a worktree with a foreign commit beyond the prepared SHA refuses salvage', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', leaveDirtyDiff: false, foreignCommit: true });
  try {
    // A genuine commit beyond preparedHeadSha always moves HEAD, so the
    // HEAD-moved check (which runs first, mirroring
    // checkStructuredOutputRecoveryEligibility's identical layering) is
    // what actually fires here; SALVAGE_WORKTREE_HAS_FOREIGN_COMMITS
    // exists as the same defensive belt-and-suspenders check its sibling
    // eligibility function has. Either way, salvage must refuse.
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_WORKTREE_HEAD_MOVED');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('an unexpected untracked file outside ownership refuses salvage', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', extraUntrackedFile: true });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_UNEXPECTED_UNTRACKED_FILE');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a git diff --check failure (e.g. trailing whitespace) refuses salvage', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', leaveDirtyDiff: false });
  try {
    await writeFile(join(scenario.worktreePath, 'feature.txt'), 'trailing whitespace   \n', 'utf8');
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_DIFF_CHECK_FAILED');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('no salvage.verify configured means the task is never salvageable', async () => {
  const scenario = await createTimeoutScenario({ verify: [] });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'SALVAGE_VERIFICATION_FAILED')) throw error;
        assert.equal((error.details as unknown as { reason?: string }).reason, 'no_verify_configured');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a required salvage.verify command failure (tracked source unchanged) prevents commit', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'false' });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'SALVAGE_VERIFICATION_FAILED')) throw error;
        assert.notEqual((error.details as unknown as { reason?: string }).reason, 'verify_mutated_tracked_source');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a verify command that mutates tracked source fails closed regardless of its own exit code', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'sh -c "echo mutated >> feature.txt"' });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'SALVAGE_VERIFICATION_FAILED')) throw error;
        assert.equal((error.details as unknown as { reason?: string }).reason, 'verify_mutated_tracked_source');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a task failure that is not AGENT_TIMEOUT (e.g. AGENT_FAILED) refuses salvage regardless of diff cleanliness', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true' });
  try {
    // scenario.orchestrator's in-memory state predates createTimeoutScenario's
    // own stateStore.save (that call persists to disk without updating this
    // instance's in-memory copy) — reload the actually-persisted state first.
    const before = await scenario.orchestrator.stateStore.load();
    await scenario.orchestrator.stateStore.save({
      ...before,
      tasks: {
        ...before.tasks,
        'timed-out-task': {
          ...before.tasks['timed-out-task']!,
          agentAttempts: [{ ...before.tasks['timed-out-task']!.agentAttempts[0]!, outcome: 'failed' }],
          error: { code: 'AGENT_FAILED', message: 'a genuine implementation failure', at: before.createdAt },
        },
      },
    });
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_NOT_TIMED_OUT');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a task with a recorded commit already cannot be salvaged again (duplicate commit is structurally impossible)', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true' });
  try {
    const first = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
    });
    assert.ok(first.commitSha);
    // Once salvaged, the task is SUCCEEDED, so a second call correctly
    // refuses at the same first check that already makes a successful
    // handoff repair permanently idempotent (SALVAGE_NOT_TIMED_OUT) —
    // SALVAGE_COMMIT_ALREADY_RECORDED exists for the case where a commit
    // is somehow recorded while status is still FAILED/BLOCKED, which
    // this normal-flow scenario never reaches. Either way, no second
    // commit is structurally possible.
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_NOT_TIMED_OUT');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});
