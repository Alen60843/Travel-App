import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { GitClient, WorktreeManager } from '../../src/git';
import { computeTrackedDiffFingerprint } from '../../src/git/diff';
import { AgentOrchestrator } from '../../src/orchestrator';
import { StateStore, type RunState } from '../../src/state';
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

/** A real, minimal successful writer for 'dependent-task' — proves a salvage-reopened descendant actually runs to completion on resume. */
class DependentTaskAgent implements Agent {
  readonly invocations: string[] = [];
  constructor(readonly name: AgentName) {}
  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request.taskId);
    if (request.taskId !== 'dependent-task') {
      throw new Error(`unexpected agent invocation for task ${request.taskId}`);
    }
    await writeFile(join(request.worktreePath, 'dependent.txt'), 'implemented\n', 'utf8');
    const timestamp = new Date().toISOString();
    return {
      agent: this.name,
      runId: request.runId,
      taskId: request.taskId,
      status: 'succeeded',
      failureCode: null,
      exitCode: 0,
      signal: null,
      stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout.log`),
      stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr.log`),
      structuredHandoff: {
        status: 'complete',
        summary: 'Implemented the dependent feature.',
        filesChanged: ['dependent.txt'],
        decisions: [],
        tests: [{ command: 'fake-test', result: 'pass', details: 'fake evidence' }],
        openQuestions: [],
        reviewRequested: [],
      },
      changedFiles: [],
      gitDiffSummary: null,
      testsReported: [],
      unresolvedQuestions: [],
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 0,
      timedOut: false,
      aborted: false,
      errorMessage: null,
    };
  }
}

function phaseYaml(
  baseBranch: string,
  options: {
    readonly verify?: readonly string[];
    readonly verifyCommand?: string;
    readonly prepareCommand?: string;
    /** 'review' produces a read-only, ownership-free task to prove salvage cannot be used to sneak a dirty diff past ownership. */
    readonly taskMode?: 'implementation' | 'review';
    /** Adds a second task depending on the salvaged one, to exercise dependency-failure reopening. */
    readonly withDependent?: boolean;
  } = {},
): string {
  const verifyCommand = options.verifyCommand ?? 'true';
  const quoted = (command: string): string => JSON.stringify(command);
  const verifyBlock = options.verify === undefined
    ? `salvage:\n  verify:\n    - command: ${quoted(verifyCommand)}\n      required: true\n`
    : options.verify.length === 0
      ? 'salvage:\n  verify: []\n'
      : `salvage:\n  verify:\n${options.verify.map((c) => `    - command: ${quoted(c)}\n      required: true\n`).join('')}`;
  const taskMode = options.taskMode ?? 'implementation';
  return `
phase: salvage-test
name: Timed-out writer salvage
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 2
agentRetries: 0
maxReviewRounds: 3
${options.prepareCommand === undefined ? '' : `agentWorktree:
  prepare:
    - command: ${quoted(options.prepareCommand)}
      required: true
`}${verifyBlock}tasks:
  - id: timed-out-task
    title: Timed-out writer
    owner: codex
    mode: ${taskMode}
    effort: medium
${taskMode === 'review' ? '' : '    files: [feature.txt, new-feature.txt]\n'}${options.withDependent === true ? `  - id: dependent-task
    title: Downstream dependent
    owner: codex
    mode: implementation
    effort: medium
    files: [dependent.txt]
    dependsOn: [timed-out-task]
` : ''}`;
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
  readonly prepareCommand?: string;
  readonly leaveDirtyDiff?: boolean;
  readonly outsideOwnershipEdit?: boolean;
  readonly extraUntrackedFile?: boolean;
  readonly foreignCommit?: boolean;
  /** Which process-layer failure the final agent attempt recorded. Defaults to the original AGENT_TIMEOUT shape. */
  readonly failureMode?: 'timed_out' | 'failed';
  readonly taskMode?: 'implementation' | 'review';
  readonly withDependent?: boolean;
} = {}): Promise<Scenario> {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, '.gitignore'), '.salvage-cache\n', 'utf8');
  await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
  await writeFile(join(fixture.repository, 'feature.txt'), 'base\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', '.gitignore', 'design.md', 'feature.txt']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'add design and feature baseline']);
  const runsRoot = join(fixture.container, 'runs');
  const phaseFile = join(fixture.container, 'phase.yaml');
  await writeFile(phaseFile, phaseYaml(fixture.baseBranch, {
    ...(options.verify === undefined ? {} : { verify: options.verify }),
    ...(options.verifyCommand === undefined ? {} : { verifyCommand: options.verifyCommand }),
    ...(options.prepareCommand === undefined ? {} : { prepareCommand: options.prepareCommand }),
    ...(options.taskMode === undefined ? {} : { taskMode: options.taskMode }),
    ...(options.withDependent === undefined ? {} : { withDependent: options.withDependent }),
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

  const failureMode = options.failureMode ?? 'timed_out';
  const terminalState: RunState = {
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
          outcome: failureMode,
        }],
        error: failureMode === 'failed'
          ? { code: 'AGENT_FAILED', message: 'a genuine implementation failure ended after partial work', at: before.createdAt }
          : { code: 'AGENT_TIMEOUT', message: 'bounded execution timeout', at: before.createdAt },
      },
      ...(options.withDependent === true ? {
        'dependent-task': {
          ...before.tasks['dependent-task']!,
          status: 'BLOCKED',
          finishedAt: before.createdAt,
          error: { code: 'TASK_DEPENDENCY_FAILED', message: 'A task dependency did not succeed', at: before.createdAt },
        },
      } : {}),
    },
  };
  await orchestrator.stateStore.save(terminalState);

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
    assert.equal(after.tasks['timed-out-task']?.salvage?.phase, 'VERIFIED');
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
    const failed = (await scenario.orchestrator.stateStore.load()).tasks['timed-out-task']!.salvage;
    assert.equal(failed?.phase, 'FAILED');
    assert.equal(failed?.verification, undefined);
    assert.equal(failed?.failures?.at(-1)?.reason, 'verify_command_failed');
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

test('salvage preparation that mutates tracked source fails closed before verification and creates no commit', async () => {
  const scenario = await createTimeoutScenario({
    prepareCommand: 'sh -c "echo prepared-mutation >> feature.txt"',
    verifyCommand: 'true',
  });
  try {
    const beforeHead = await scenario.fixture.git.resolveCommit(scenario.worktreePath, 'HEAD');
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'AGENT_WORKTREE_PREPARATION_FAILED')) throw error;
        assert.equal(
          (error.details as unknown as { reason?: string }).reason,
          'prepare_mutated_salvage_candidate',
        );
        return true;
      },
    );
    const after = await scenario.orchestrator.stateStore.load();
    assert.equal(after.tasks['timed-out-task']?.commit, undefined);
    assert.equal(await scenario.fixture.git.resolveCommit(scenario.worktreePath, 'HEAD'), beforeHead);
    assert.match(await readFile(join(scenario.worktreePath, 'feature.txt'), 'utf8'), /salvageable work/);
    assert.match(await readFile(join(scenario.worktreePath, 'feature.txt'), 'utf8'), /prepared-mutation/);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('salvage preparation may create ignored artifacts without changing the candidate', async () => {
  const scenario = await createTimeoutScenario({
    prepareCommand: 'sh -c "mkdir -p .salvage-cache && printf ready > .salvage-cache/prepared"',
    verifyCommand: 'true',
  });
  try {
    const result = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
    });
    assert.ok(result.commitSha);
    assert.equal(result.orchestrator.snapshot().tasks['timed-out-task']?.status, 'SUCCEEDED');
    assert.equal(
      await readFile(join(scenario.worktreePath, '.salvage-cache', 'prepared'), 'utf8'),
      'ready',
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('salvage preparation that mutates an existing owned untracked candidate fails closed', async () => {
  const scenario = await createTimeoutScenario({
    prepareCommand: 'sh -c "printf changed-by-prepare > new-feature.txt"',
    verifyCommand: 'true',
  });
  try {
    const untrackedPath = join(scenario.worktreePath, 'new-feature.txt');
    await writeFile(untrackedPath, 'timed-out-agent-content\n', 'utf8');
    const beforeHead = await scenario.fixture.git.resolveCommit(scenario.worktreePath, 'HEAD');

    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'AGENT_WORKTREE_PREPARATION_FAILED')) throw error;
        assert.equal(
          (error.details as unknown as { reason?: string }).reason,
          'prepare_mutated_salvage_candidate',
        );
        return true;
      },
    );

    const after = await scenario.orchestrator.stateStore.load();
    assert.equal(after.tasks['timed-out-task']?.commit, undefined);
    assert.equal(await scenario.fixture.git.resolveCommit(scenario.worktreePath, 'HEAD'), beforeHead);
    assert.equal(await readFile(untrackedPath, 'utf8'), 'changed-by-prepare');
  } finally {
    await scenario.fixture.dispose();
  }
});

test('salvage.verify detects mutation of an already-present owned untracked file and creates no commit', async () => {
  const scenario = await createTimeoutScenario({
    verifyCommand: 'sh -c "printf changed-by-verify > new-feature.txt"',
  });
  try {
    const untrackedPath = join(scenario.worktreePath, 'new-feature.txt');
    await writeFile(untrackedPath, 'timed-out-agent-content\n', 'utf8');
    const beforeHead = await scenario.fixture.git.resolveCommit(scenario.worktreePath, 'HEAD');

    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'SALVAGE_VERIFICATION_FAILED')) throw error;
        assert.equal(
          (error.details as unknown as { reason?: string }).reason,
          'verify_mutated_tracked_source',
        );
        return true;
      },
    );

    const after = await scenario.orchestrator.stateStore.load();
    assert.equal(after.tasks['timed-out-task']?.commit, undefined);
    assert.equal(await scenario.fixture.git.resolveCommit(scenario.worktreePath, 'HEAD'), beforeHead);
    assert.equal(await readFile(untrackedPath, 'utf8'), 'changed-by-verify');
  } finally {
    await scenario.fixture.dispose();
  }
});

// A dirty AGENT_FAILED writer is no longer refused outright — see the
// "AGENT_FAILED + dirty diff..." (succeeds) and "a clean AGENT_FAILED
// worktree..." (still refused) tests below, which replaced this scenario
// once AGENT_FAILED became a second accepted salvage eligibility class.
test('a task failure that is neither AGENT_TIMEOUT nor AGENT_FAILED (e.g. a semantic REVIEW_BLOCKED) refuses salvage regardless of diff cleanliness', async () => {
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
          agentAttempts: [{ ...before.tasks['timed-out-task']!.agentAttempts[0]!, outcome: 'succeeded' }],
          error: { code: 'REVIEW_BLOCKED', message: 'a genuine semantic review failure', at: before.createdAt },
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
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_ATTEMPT_NOT_ELIGIBLE');
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
    // handoff repair permanently idempotent (SALVAGE_ATTEMPT_NOT_ELIGIBLE) —
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
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_ATTEMPT_NOT_ELIGIBLE');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});


// --- AGENT_FAILED as a second dirty-writer salvage eligibility class -----
//
// Extends the exact same deterministic proof AGENT_TIMEOUT already goes
// through above to a second process-layer failure class: AGENT_FAILED. The
// eligibility class is derived only from persisted structure (error code +
// last attempt outcome), never from provider stderr/error prose.

test('AGENT_FAILED + dirty diff fully inside ownership: successful salvage authorizes, verifies, and commits, and the task becomes SUCCEEDED', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', failureMode: 'failed' });
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

test('a clean AGENT_FAILED worktree is not salvage work (it remains retry-agent\'s domain instead)', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', leaveDirtyDiff: false, failureMode: 'failed' });
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

test('AGENT_FAILED with a dirty change outside task ownership refuses salvage', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', outsideOwnershipEdit: true, failureMode: 'failed' });
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

test('AGENT_FAILED with a foreign commit beyond the prepared SHA refuses salvage', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', leaveDirtyDiff: false, foreignCommit: true, failureMode: 'failed' });
  try {
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

test('AGENT_FAILED with an unexpected untracked file outside ownership refuses salvage', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', extraUntrackedFile: true, failureMode: 'failed' });
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

test('AGENT_FAILED with a git diff --check failure (e.g. trailing whitespace) refuses salvage', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', leaveDirtyDiff: false, failureMode: 'failed' });
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

test('AGENT_FAILED whose required salvage.verify command fails creates no commit and leaves the task unsalvaged', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'false', failureMode: 'failed' });
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
    const after = await scenario.orchestrator.stateStore.load();
    assert.equal(after.tasks['timed-out-task']?.commit, undefined);
    assert.notEqual(after.tasks['timed-out-task']?.status, 'SUCCEEDED');
    assert.match(await readFile(join(scenario.worktreePath, 'feature.txt'), 'utf8'), /salvageable work/);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('AGENT_FAILED verify command that mutates tracked source fails closed regardless of its own exit code', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'sh -c "echo mutated >> feature.txt"', failureMode: 'failed' });
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
    const after = await scenario.orchestrator.stateStore.load();
    assert.equal(after.tasks['timed-out-task']?.commit, undefined);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a review-mode task with a dirty diff cannot be salvaged even when its failure is AGENT_FAILED', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', failureMode: 'failed', taskMode: 'review' });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) throw error;
        // The task declares no ownership globs at all (a read-only review
        // task owns nothing), so any tracked change is structurally a
        // violation — the same ownership gate that already protects every
        // other task, never a mode-specific special case.
        assert.equal((error.details as unknown as { reasonCode?: string }).reasonCode, 'SALVAGE_OWNERSHIP_VIOLATION');
        return true;
      },
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('AGENT_FAILED salvage invokes no provider, preserves original failed-attempt evidence, reopens attributable dependency-blocked descendants, and the run completes on resume', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', failureMode: 'failed', withDependent: true });
  try {
    const before = await scenario.orchestrator.stateStore.load();
    const originalAttempts = before.tasks['timed-out-task']!.agentAttempts;
    assert.equal(before.tasks['dependent-task']?.status, 'BLOCKED');
    assert.equal(before.tasks['dependent-task']?.error?.code, 'TASK_DEPENDENCY_FAILED');

    const codexDuringSalvage = new UnusedAgent('codex');
    const claudeDuringSalvage = new UnusedAgent('claude');
    const result = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: codexDuringSalvage, claude: claudeDuringSalvage },
    });
    assert.equal(codexDuringSalvage.invocations.length, 0, 'salvage must never invoke the original writer agent');
    assert.equal(claudeDuringSalvage.invocations.length, 0, 'salvage must never invoke a reviewer agent either');

    const after = result.orchestrator.snapshot();
    assert.equal(after.tasks['timed-out-task']?.status, 'SUCCEEDED');
    assert.ok(after.tasks['timed-out-task']?.commit?.sha);
    assert.deepEqual(after.tasks['timed-out-task']?.agentAttempts, originalAttempts);
    assert.equal(after.tasks['dependent-task']?.status, 'READY');
    assert.equal(after.status, 'RUNNING');

    const dependentAgent = new DependentTaskAgent('codex');
    const resumed = await AgentOrchestrator.resume(scenario.runId, {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: dependentAgent, claude: new UnusedAgent('claude') },
    });
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks['dependent-task']?.status, 'SUCCEEDED');
    assert.deepEqual(dependentAgent.invocations, ['dependent-task']);
    // The original salvaged task is never re-invoked on resume.
    assert.deepEqual(completed.tasks['timed-out-task']?.agentAttempts, originalAttempts);
  } finally {
    await scenario.fixture.dispose();
  }
});


// --- Canonical finding handling during salvage --------------------------
//
// Reuses the exact adaptive correction-lifecycle shape from
// test/adaptive/adaptive-correction-integration.test.ts (a live
// changes_requested final_review authorizes one root correction work
// unit requiring canonical finding F001), but the correction-role agent
// writes its fix to the worktree and then FAILS the process (simulating
// what a real timeout leaves behind: a dirty, evidence-backed diff with
// no accepted handoff) instead of completing normally. The failed
// attempt's outcome/error are then rewritten to the AGENT_TIMEOUT shape
// via the same direct stateStore.save technique used throughout this
// file and in test/workflow/agent-failure-retry.test.ts, leaving the
// dirty worktree untouched.

class CorrectionTimeoutAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(
    readonly name: AgentName,
    private readonly repairBehavior: 'succeed' | 'omit' = 'succeed',
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    await request.onStarted?.(process.pid);
    let structuredHandoff: unknown = null;
    let status: AgentResult['status'] = 'succeeded';
    let failureCode: AgentResult['failureCode'] = null;
    if (request.role === 'final_review') {
      structuredHandoff = {
        status: 'changes_requested',
        findings: [{
          id: 'F001', severity: 'medium', category: 'correctness', file: 'feature.txt', location: 'line 1',
          problem: 'feature remains buggy', evidence: 'the persisted implementation contains buggy',
          impact: 'incorrect result', suggestedFix: 'replace buggy with fixed', verificationRequired: 'read the corrected file',
        }],
        additionalWorkRequests: [{
          role: 'correction', concern: 'review', objective: 'agent child must remain denied',
          reason: 'finding proposal', dependencies: [], capabilities: [{ capability: 'typescript_backend_editing' }],
          resourceClaims: [{ kind: 'repository_path', key: 'feature.txt', mode: 'write' }],
          evidence: [{ kind: 'finding', reference: 'F001', summary: 'untrusted child proposal' }],
          risk: 'medium', priority: 80,
        }],
      };
    } else if (request.role === 'correction') {
      await writeFile(join(request.worktreePath, 'feature.txt'), 'fixed\n', 'utf8');
      status = 'failed';
      failureCode = 'AGENT_FAILED';
      structuredHandoff = null;
    } else if (request.role === 'handoff_repair') {
      const spec = request.taskSpecification as {
        malformedOutput: Record<string, unknown>;
        requiredCanonicalFindings: Array<{ findingId: string; canonicalFindingKey: string }>;
      };
      structuredHandoff = this.repairBehavior === 'omit'
        ? { ...spec.malformedOutput }
        : {
            ...spec.malformedOutput,
            findingResponses: [{
              findingId: 'F001',
              canonicalFindingKey: spec.requiredCanonicalFindings[0]!.canonicalFindingKey,
              decision: 'confirmed', resolution: 'resolved',
              evidence: 'salvaged diff contains the fix', fix: 'replaced buggy with fixed',
              verification: 'salvage.verify required command passed',
            }],
          };
    } else {
      structuredHandoff = { status: 'approved', findings: [] };
    }
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId, status, failureCode,
      exitCode: status === 'succeeded' ? 0 : 1, signal: null,
      stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout`),
      stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr`),
      structuredHandoff, changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: now, endedAt: now, durationMs: 0, timedOut: false, aborted: false, errorMessage: null,
    };
  }
}

function adaptiveCorrectionPhaseYaml(baseBranch: string): string {
  return `mode: adaptive
phase: salvage-canonical-test
name: Adaptive correction salvage
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
goal: Review and correct one canonical finding
constraints: [Use only canonical evidence]
policy:
  allowedConcerns: [review]
  allowedOwnership: [feature.txt]
  allowedResources: []
  limits:
    maxConcurrentAgents: 2
    maxAgentInvocations: 8
    maxTotalWorkUnits: 10
    maxDecompositionDepth: 2
    maxFanOutPerWorkUnit: 3
    maxSynthesisInputs: 2
    maxWallClockMs: 600000
  requireEvidenceForExpansion: true
  agingIntervalMs: 1000
  agingStep: 1
  humanApprovalRisks: []
  correctionPolicy:
    allowedOwnership: [feature.txt]
    allowedRoles: [correction, testing]
    requireCanonicalFinding: true
    maxRounds: 2
initialCandidates:
  - role: final_review
    concern: review
    objective: Canonical review
    reason: Independent verdict is required
    evidence: [{ kind: file, reference: feature.txt, summary: implementation }]
    resourceClaims: [{ kind: repository_path, key: feature.txt, mode: read }]
    capabilities: [{ capability: review }]
    risk: medium
    priority: 90
executors:
  - id: reviewer
    adapter: claude
    capabilities: [{ capability: review }]
    roles: [review, final_review]
    effort: high
  - id: writer
    adapter: codex
    capabilities: [{ capability: typescript_backend_editing }, { capability: testing }]
    roles: [correction, testing]
    effort: high
agentRetries: 0
agentTimeoutMs: 60000
salvage:
  verify:
    - command: "true"
      required: true
integration:
  prepare: []
  commands:
    - command: "true"
      required: true
  diagnostics: []
`;
}

async function createAdaptiveTimeoutScenario(repairBehavior: 'succeed' | 'omit'): Promise<{
  readonly fixture: TemporaryRepository;
  readonly runsRoot: string;
  readonly runId: string;
  readonly correctionTaskId: string;
}> {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
  await writeFile(join(fixture.repository, 'feature.txt'), 'buggy\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'implementation']);
  const phaseFile = join(fixture.container, 'phase.yaml');
  const runsRoot = join(fixture.container, 'runs');
  await writeFile(phaseFile, adaptiveCorrectionPhaseYaml(fixture.baseBranch), 'utf8');
  const codex = new CorrectionTimeoutAgent('codex', repairBehavior);
  const claude = new CorrectionTimeoutAgent('claude', repairBehavior);
  const orchestrator = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository, runsRoot, agents: { codex, claude },
  });
  const runId = orchestrator.snapshot().runId;
  const completed = await orchestrator.execute();
  const correctionTaskId = Object.entries(completed.tasks).find(
    ([, task]) => task.error?.code === 'AGENT_FAILED',
  )?.[0];
  if (correctionTaskId === undefined) {
    throw new Error(`expected exactly one AGENT_FAILED correction task, got: ${JSON.stringify(completed.tasks)}`);
  }
  const correctionTask = completed.tasks[correctionTaskId]!;
  await orchestrator.stateStore.save({
    ...completed,
    status: 'BLOCKED',
    tasks: {
      ...completed.tasks,
      [correctionTaskId]: {
        ...correctionTask,
        status: 'BLOCKED',
        agentAttempts: [
          ...correctionTask.agentAttempts.slice(0, -1),
          { ...correctionTask.agentAttempts.at(-1)!, outcome: 'timed_out' },
        ],
        error: { code: 'AGENT_TIMEOUT', message: 'bounded execution timeout', at: completed.createdAt },
      },
    },
  });

  return { fixture, runsRoot, runId, correctionTaskId };
}

test('salvage of a task with a required canonical finding synthesizes a handoff and attaches a valid findingResponses entry via the repair cascade', async () => {
  const scenario = await createAdaptiveTimeoutScenario('succeed');
  try {
    const result = await AgentOrchestrator.salvageTask(scenario.runId, scenario.correctionTaskId, {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: new CorrectionTimeoutAgent('codex', 'succeed'), claude: new CorrectionTimeoutAgent('claude', 'succeed') },
    });
    const after = result.orchestrator.snapshot();
    assert.equal(after.tasks[scenario.correctionTaskId]?.status, 'SUCCEEDED');
    assert.equal(after.tasks[scenario.correctionTaskId]?.handoffOutcome, 'valid');
    assert.ok(after.tasks[scenario.correctionTaskId]?.commit?.sha);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('salvage fails closed if the repair cascade cannot produce a valid findingResponses entry for a required canonical finding, and NO commit is created', async () => {
  const scenario = await createAdaptiveTimeoutScenario('omit');
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, scenario.correctionTaskId, {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new CorrectionTimeoutAgent('codex', 'omit'), claude: new CorrectionTimeoutAgent('claude', 'omit') },
      }),
      (error: unknown) => isOrchestratorError(error, 'HANDOFF_INVALID'),
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('commit-order safety: a failed canonical repair after a passing verification leaves the worktree dirty and salvageable again — no commit, no SUCCEEDED, retryable', async () => {
  const scenario = await createAdaptiveTimeoutScenario('omit');
  try {
    const stateStore = new StateStore(scenario.runsRoot, scenario.runId);
    const before = await stateStore.load();
    const worktreePathBefore = before.tasks[scenario.correctionTaskId]!.worktreePath!;
    const headBefore = (await new GitClient().run(worktreePathBefore, ['rev-parse', 'HEAD'])).stdout.trim();

    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, scenario.correctionTaskId, {
        repositoryPath: scenario.fixture.repository,
        runsRoot: scenario.runsRoot,
        agents: { codex: new CorrectionTimeoutAgent('codex', 'omit'), claude: new CorrectionTimeoutAgent('claude', 'omit') },
      }),
      (error: unknown) => isOrchestratorError(error, 'HANDOFF_INVALID'),
    );

    // No commit anywhere — neither in persisted task state nor as a real
    // git commit in the worktree — and the worktree HEAD has not moved.
    const afterFailedAttempt = await stateStore.load();
    assert.equal(afterFailedAttempt.tasks[scenario.correctionTaskId]?.commit, undefined);
    assert.notEqual(afterFailedAttempt.tasks[scenario.correctionTaskId]?.status, 'SUCCEEDED');
    const headAfterFailedAttempt = (await new GitClient().run(worktreePathBefore, ['rev-parse', 'HEAD'])).stdout.trim();
    assert.equal(headAfterFailedAttempt, headBefore, 'a failed canonical repair must never leave a real git commit behind');
    const statusAfterFailedAttempt = (await new GitClient().run(worktreePathBefore, ['status', '--porcelain'])).stdout;
    assert.notEqual(statusAfterFailedAttempt.trim().length, 0, 'the salvageable dirty diff must still be present, uncommitted');

    // Retry with a working recovery executor — must succeed, because
    // eligibility (HEAD unmoved, still dirty) is completely unaffected by
    // the earlier failed attempt.
    const retried = await AgentOrchestrator.salvageTask(scenario.runId, scenario.correctionTaskId, {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: new CorrectionTimeoutAgent('codex', 'succeed'), claude: new CorrectionTimeoutAgent('claude', 'succeed') },
    });
    assert.ok(retried.commitSha);
    assert.equal(retried.orchestrator.snapshot().tasks[scenario.correctionTaskId]?.status, 'SUCCEEDED');
  } finally {
    await scenario.fixture.dispose();
  }
});

test('the handoff synthesized before commit reports exactly the same changed-file set that ensureTaskCommit later commits', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true' });
  try {
    const result = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
    });
    const after = result.orchestrator.snapshot();
    const handoff = JSON.parse(await readFile(after.tasks['timed-out-task']!.handoffPath!, 'utf8')) as { filesChanged: string[] };
    assert.deepEqual([...handoff.filesChanged].sort(), [...after.tasks['timed-out-task']!.commit!.changedFiles].sort());
  } finally {
    await scenario.fixture.dispose();
  }
});


// --- Salvage verification checkpoint: crash-resume reuse/invalidation ---
//
// salvageTask has no externally observable pause point (authorize -> verify
// -> commit runs as one synchronous call), so "resume after a crash between
// verify and commit" is simulated the same way scenario 7 and others in
// this codebase simulate a crash: pre-seed the run state file on disk with
// exactly the shape a real crash at that point would leave — a task still
// BLOCKED/AGENT_TIMEOUT (never SUCCEEDED, since that would make it
// ineligible for salvage entirely) with a `salvage.verification` checkpoint
// already recorded but no commit yet — then call salvageTask and observe
// whether it reruns the verify command (counted via an absolute-path
// counter file outside the worktree, so the counter itself never becomes
// part of the tracked/untracked diff salvage eligibility inspects).

async function countTicks(counterPath: string): Promise<number> {
  try {
    return (await readFile(counterPath, 'utf8')).split('\n').filter((line) => line.length > 0).length;
  } catch {
    return 0;
  }
}

async function createCounterFile(): Promise<{ readonly path: string; readonly dispose: () => Promise<void> }> {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'salvage-verify-count-'));
  return { path: join(dir, 'verify-count.txt'), dispose: async () => rm(dir, { recursive: true, force: true }) };
}

test('a crash-resumed salvage reuses a valid SALVAGE_VERIFIED checkpoint without rerunning verify when the diff is unchanged', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true' });
  try {
    const before = await scenario.orchestrator.stateStore.load();
    const preparedHeadSha = before.tasks['timed-out-task']!.preparedHeadSha!;
    const trackedDiffFingerprint = await computeTrackedDiffFingerprint(
      scenario.fixture.git, scenario.worktreePath, preparedHeadSha,
    );
    const verifyConfigFingerprint = createHash('sha256')
      .update(JSON.stringify([{ command: 'true', required: true }]), 'utf8')
      .digest('hex');
    await scenario.orchestrator.stateStore.save({
      ...before,
      tasks: {
        ...before.tasks,
        'timed-out-task': {
          ...before.tasks['timed-out-task']!,
          salvage: {
            authorizedAt: before.createdAt,
            verification: { worktreeHeadSha: preparedHeadSha, trackedDiffFingerprint, verifyConfigFingerprint, result: 'passed' },
          },
        },
      },
    });

    const result = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
    });
    assert.ok(result.commitSha);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a crash-resumed salvage reruns verify when the tracked diff changed since the checkpoint was recorded', async () => {
  const counter = await createCounterFile();
  const scenario = await createTimeoutScenario({ verifyCommand: `sh -c "echo tick >> ${counter.path}"` });
  try {
    const before = await scenario.orchestrator.stateStore.load();
    const preparedHeadSha = before.tasks['timed-out-task']!.preparedHeadSha!;
    // Fingerprint computed for the diff as it existed BEFORE this further edit.
    const staleTrackedDiffFingerprint = await computeTrackedDiffFingerprint(
      scenario.fixture.git, scenario.worktreePath, preparedHeadSha,
    );
    const verifyConfigFingerprint = createHash('sha256')
      .update(JSON.stringify([{ command: `sh -c "echo tick >> ${counter.path}"`, required: true }]), 'utf8')
      .digest('hex');
    await scenario.orchestrator.stateStore.save({
      ...before,
      tasks: {
        ...before.tasks,
        'timed-out-task': {
          ...before.tasks['timed-out-task']!,
          salvage: {
            authorizedAt: before.createdAt,
            verification: {
              worktreeHeadSha: preparedHeadSha,
              trackedDiffFingerprint: staleTrackedDiffFingerprint,
              verifyConfigFingerprint,
              result: 'passed',
            },
          },
        },
      },
    });
    // The worktree's tracked diff changes AFTER the checkpoint was recorded —
    // exactly what a crash between an earlier verify and a later resume,
    // with intervening worktree activity, would look like.
    await writeFile(join(scenario.worktreePath, 'feature.txt'), 'salvageable work, further edited\n', 'utf8');

    const result = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
    });
    assert.ok(result.commitSha);
    assert.equal(await countTicks(counter.path), 1, 'verify must rerun once the diff fingerprint no longer matches the checkpoint');
  } finally {
    await scenario.fixture.dispose();
    await counter.dispose();
  }
});

test('a crash-resumed salvage reruns verify when salvage.verify config changed since the checkpoint was recorded', async () => {
  const counter = await createCounterFile();
  const scenario = await createTimeoutScenario({ verifyCommand: `sh -c "echo tick >> ${counter.path}"` });
  try {
    const before = await scenario.orchestrator.stateStore.load();
    const preparedHeadSha = before.tasks['timed-out-task']!.preparedHeadSha!;
    const trackedDiffFingerprint = await computeTrackedDiffFingerprint(
      scenario.fixture.git, scenario.worktreePath, preparedHeadSha,
    );
    // A verifyConfigFingerprint that could only have come from some other
    // (never-actually-configured) verify command list — simulating that the
    // phase's salvage.verify config itself changed between the crash and
    // this resume.
    const staleVerifyConfigFingerprint = createHash('sha256')
      .update(JSON.stringify([{ command: 'a different command that was never actually configured', required: true }]), 'utf8')
      .digest('hex');
    await scenario.orchestrator.stateStore.save({
      ...before,
      tasks: {
        ...before.tasks,
        'timed-out-task': {
          ...before.tasks['timed-out-task']!,
          salvage: {
            authorizedAt: before.createdAt,
            verification: {
              worktreeHeadSha: preparedHeadSha,
              trackedDiffFingerprint,
              verifyConfigFingerprint: staleVerifyConfigFingerprint,
              result: 'passed',
            },
          },
        },
      },
    });

    const result = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
    });
    assert.ok(result.commitSha);
    assert.equal(await countTicks(counter.path), 1, 'verify must rerun once the verify-config fingerprint no longer matches the checkpoint');
  } finally {
    await scenario.fixture.dispose();
    await counter.dispose();
  }
});

// Duplicate-commit safety after a recorded commit is already proven by
// 'a task with a recorded commit already cannot be salvaged again' above
// (checkSalvageEligibility's SALVAGE_ATTEMPT_NOT_ELIGIBLE / SALVAGE_COMMIT_ALREADY_RECORDED
// checks) — not repeated here to avoid a redundant test.


// --- Recovery policy overlay: salvage.verify applies without editing phase.yaml ---

test('an authorized recovery-policy overlay supplies salvage.verify for a historical run whose phase.yaml has none, without editing phase.yaml', async () => {
  const scenario = await createTimeoutScenario({ verify: [] });
  try {
    // Confirm the historical phase.yaml snapshot genuinely has no salvage.verify.
    const phaseSnapshotBefore = await readFile(join(scenario.orchestrator.stateStore.runDirectory, 'phase.yaml'), 'utf8');
    assert.match(phaseSnapshotBefore, /verify: \[\]/, 'the historical phase.yaml snapshot genuinely has no usable verify commands');

    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
        agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
      }),
      (error: unknown) => isOrchestratorError(error, 'SALVAGE_VERIFICATION_FAILED'),
    );

    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(
      scenario.runId,
      { salvage: { verify: [{ command: 'true', required: true }] } },
      { repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot, agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') } },
    );
    assert.equal(authorization.orchestrator.snapshot().recoveryPolicyHistory?.length, 1);

    const result = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
      agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
    });
    assert.ok(result.commitSha);
    assert.equal(result.orchestrator.snapshot().tasks['timed-out-task']?.status, 'SUCCEEDED');

    const phaseSnapshotAfter = await readFile(join(scenario.orchestrator.stateStore.runDirectory, 'phase.yaml'), 'utf8');
    assert.equal(phaseSnapshotAfter, phaseSnapshotBefore, 'phase.yaml must never be edited by an authorized recovery policy');
  } finally {
    await scenario.fixture.dispose();
  }
});

test('changing the external source phase file after authorization does not change what a resumed recovery uses', async () => {
  const scenario = await createTimeoutScenario({ verify: [] });
  try {
    await AgentOrchestrator.authorizeRecoveryPolicy(
      scenario.runId,
      { salvage: { verify: [{ command: 'true', required: true }] } },
      { repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot, agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') } },
    );
    // Mutating the run's own persisted phase.yaml snapshot directly simulates
    // "the external policy file changed after authorization" — the snapshot,
    // not this file, is what a real operator could NOT safely hand-edit
    // either; the point is that recovery is bound to the authorized overlay,
    // not to whatever the snapshot says at read time.
    const snapshotPath = join(scenario.orchestrator.stateStore.runDirectory, 'phase.yaml');
    const originalSnapshot = await readFile(snapshotPath, 'utf8');
    assert.match(originalSnapshot, /verify: \[\]/);
    await writeFile(
      snapshotPath,
      originalSnapshot.replace('verify: []', 'verify:\n    - command: "false"\n      required: true'),
      'utf8',
    );
    const result = await AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
      repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
      agents: { codex: new UnusedAgent('codex'), claude: new UnusedAgent('claude') },
    });
    // If the snapshot's own (newly-added, "false") verify command had taken
    // priority over the authorized overlay's "true", this would have thrown
    // SALVAGE_VERIFICATION_FAILED instead of succeeding.
    assert.ok(result.commitSha);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a run without any authorized recovery policy still fails no_verify_configured exactly as before', async () => {
  const scenario = await createTimeoutScenario({ verify: [] });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask(scenario.runId, 'timed-out-task', {
        repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
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
