import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type {
  Agent,
  AgentName,
  AgentRequest,
  AgentResult,
} from '../../src/agents';
import { ensureTaskCommit } from '../../src/git';
import { WorktreeManager } from '../../src/git/worktree-manager';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunState } from '../../src/state';
import { createTemporaryRepository } from '../git/helpers';

interface AgentInvocation {
  readonly agent: AgentName;
  readonly taskId: string;
  readonly role: AgentRequest['role'];
  readonly access: AgentRequest['access'];
  readonly dependencyHandoffCount: number;
  readonly previousFindingCount: number;
}

class WorkflowAgent implements Agent {
  readonly invocations: AgentInvocation[] = [];

  constructor(readonly name: AgentName) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push({
      agent: this.name,
      taskId: request.taskId,
      role: request.role,
      access: request.access,
      dependencyHandoffCount: request.dependencyHandoffs.length,
      previousFindingCount: request.previousReviewFindings.length,
    });
    await request.onStarted?.(process.pid);

    let output: unknown;
    if (request.taskId === 'implementation') {
      assert.equal(request.access, 'writer');
      await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
      output = completeHandoff('Implemented the feature.', ['feature.txt']);
    } else if (request.taskId === 'review') {
      assert.equal(request.access, 'read_only');
      assert.equal(request.dependencyHandoffs.length, 1);
      output = changesRequestedReview();
    } else if (request.taskId === 'correction') {
      assert.equal(request.access, 'writer');
      assert.equal(request.previousReviewFindings.length, 1);
      await appendFile(join(request.worktreePath, 'feature.txt'), ' corrected', 'utf8');
      output = completeHandoff('Corrected the confirmed finding.', ['feature.txt']);
    } else if (request.taskId === 'final-review') {
      assert.equal(request.access, 'read_only');
      assert.equal(request.previousReviewFindings.length, 1);
      output = { status: 'approved', findings: [] };
    } else {
      throw new Error(`Unexpected fake-agent task: ${request.taskId}`);
    }
    return successfulResult(this.name, request, output);
  }
}

class NeverCalledAgent implements Agent {
  constructor(readonly name: AgentName) {}

  run(request: AgentRequest): Promise<AgentResult> {
    throw new Error(`Agent should not be rerun while recovering ${request.taskId}`);
  }
}

class SignalAwareAgent implements Agent {
  readonly name = 'codex' as const;

  async run(request: AgentRequest): Promise<AgentResult> {
    await request.onStarted?.(process.pid);
    await new Promise<void>((resolveAbort) => {
      if (request.abortSignal?.aborted === true) resolveAbort();
      else request.abortSignal?.addEventListener('abort', () => resolveAbort(), { once: true });
    });
    const timestamp = new Date().toISOString();
    return {
      agent: this.name,
      runId: request.runId,
      taskId: request.taskId,
      status: 'aborted',
      failureCode: 'AGENT_ABORTED',
      exitCode: null,
      signal: 'SIGTERM',
      stdoutPath: join(request.artifactsDirectory, 'aborted.stdout.log'),
      stderrPath: join(request.artifactsDirectory, 'aborted.stderr.log'),
      structuredHandoff: null,
      changedFiles: [],
      gitDiffSummary: null,
      testsReported: [],
      unresolvedQuestions: [],
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 0,
      timedOut: false,
      aborted: true,
      errorMessage: 'cancelled by test signal',
    };
  }
}

test('fake agents complete implementation, cross-review, correction, final review, and integration', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);
    const phaseFile = join(fixture.container, 'phase.yaml');
    await writeFile(phaseFile, workflowPhase(fixture.baseBranch), 'utf8');
    const codex = new WorkflowAgent('codex');
    const claude = new WorkflowAgent('claude');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });

    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.integration.status, 'SUCCEEDED');
    assert.equal(completed.integration.integratedTaskCommits.length, 2);
    assert.deepEqual(
      [...codex.invocations, ...claude.invocations]
        .sort((left, right) => left.taskId.localeCompare(right.taskId))
        .map(({ taskId, role, access }) => ({ taskId, role, access })),
      [
        { taskId: 'correction', role: 'correction', access: 'writer' },
        { taskId: 'final-review', role: 'final_review', access: 'read_only' },
        { taskId: 'implementation', role: 'implementation', access: 'writer' },
        { taskId: 'review', role: 'review', access: 'read_only' },
      ],
    );
    assert.equal(
      await readFile(join(completed.integration.worktreePath!, 'feature.txt'), 'utf8'),
      'implemented corrected',
    );
    await assert.rejects(readFile(join(fixture.repository, 'feature.txt'), 'utf8'));

    const events = (await readFile(orchestrator.stateStore.eventsPath, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { name: string });
    assert.ok(events.some(({ name }) => name === 'FINDING_REPORTED'));
    assert.equal(events.at(-1)?.name, 'RUN_COMPLETED');
    assert.equal((await orchestrator.cleanup()).length, 5);
  } finally {
    await fixture.dispose();
  }
});

test('resume recovers a committed complete task without invoking its agent again', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);
    const immutableBase = await fixture.git.resolveCommit(fixture.repository, 'HEAD');
    const phaseFile = join(fixture.container, 'resume-phase.yaml');
    await writeFile(phaseFile, resumePhase(fixture.baseBranch), 'utf8');
    const runsRoot = join(fixture.container, 'runs');
    const initial = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: {
        codex: new NeverCalledAgent('codex'),
        claude: new NeverCalledAgent('claude'),
      },
    });
    const beforeCrash = initial.snapshot();
    assert.equal(beforeCrash.baseSha, immutableBase);

    const manager = await WorktreeManager.create({
      repositoryPath: fixture.repository,
      git: fixture.git,
    });
    const worktree = await manager.createTaskWorktree({
      runId: beforeCrash.runId,
      taskId: 'implementation',
      baseBranch: beforeCrash.baseBranch,
      baseSha: beforeCrash.baseSha,
    });
    await writeFile(join(worktree.path, 'feature.txt'), 'recovered', 'utf8');
    const committed = await ensureTaskCommit(fixture.git, {
      worktreePath: worktree.path,
      baseSha: beforeCrash.baseSha,
      agent: 'codex',
      taskId: 'implementation',
      summary: 'recovered task',
    });
    const attempt = 1;
    const stdoutPath = join(
      initial.stateStore.runDirectory,
      'logs',
      `${beforeCrash.runId}.implementation.codex.attempt-${attempt}.stdout.log`,
    );
    await mkdir(join(initial.stateStore.runDirectory, 'logs'), { recursive: true });
    await writeFile(
      stdoutPath,
      JSON.stringify(completeHandoff('Recovered complete task.', ['feature.txt'])),
      'utf8',
    );
    const interrupted: RunState = {
      ...beforeCrash,
      status: 'RUNNING',
      tasks: {
        implementation: {
          ...beforeCrash.tasks.implementation!,
          status: 'RUNNING',
          worktreePath: worktree.path,
          branch: worktree.branch,
          preparedHeadSha: beforeCrash.baseSha,
          startedAt: '2026-08-21T12:00:00.000Z',
          agentAttempts: [
            {
              attempt,
              agent: 'codex',
              startedAt: '2026-08-21T12:00:00.000Z',
              pid: 2_147_483_647,
            },
          ],
        },
      },
    };
    await initial.stateStore.save(interrupted);

    const resumed = await AgentOrchestrator.resume(beforeCrash.runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: {
        codex: new NeverCalledAgent('codex'),
        claude: new NeverCalledAgent('claude'),
      },
    });
    assert.equal(resumed.snapshot().tasks.implementation?.status, 'SUCCEEDED');
    assert.equal(resumed.snapshot().tasks.implementation?.commit?.sha, committed.commitSha);

    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(
      await readFile(join(completed.integration.worktreePath!, 'feature.txt'), 'utf8'),
      'recovered',
    );
    assert.equal((await resumed.cleanup()).length, 2);
  } finally {
    await fixture.dispose();
  }
});

test('orchestrator abort propagates to the agent and persists a cancelled run', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);
    const phaseFile = join(fixture.container, 'cancel-phase.yaml');
    await writeFile(phaseFile, resumePhase(fixture.baseBranch), 'utf8');
    const controller = new AbortController();
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: {
        codex: new SignalAwareAgent(),
        claude: new NeverCalledAgent('claude'),
      },
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);

    const cancelled = await orchestrator.execute();
    assert.equal(cancelled.status, 'CANCELLED');
    assert.equal(cancelled.tasks.implementation?.status, 'CANCELLED');
    assert.equal(cancelled.integration.status, 'CANCELLED');
    assert.equal((await orchestrator.cleanup()).length, 1);
  } finally {
    await fixture.dispose();
  }
});

function workflowPhase(baseBranch: string): string {
  return `
phase: smoke
name: Fake-agent workflow
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 1
maxReviewRounds: 2
tasks:
  - id: implementation
    title: Implement
    owner: codex
    mode: implementation
    effort: medium
    files: [feature.txt]
  - id: review
    title: Review
    owner: claude
    mode: review
    effort: high
    dependsOn: [implementation]
  - id: correction
    title: Correct
    owner: codex
    mode: correction
    effort: high
    files: [feature.txt]
    dependsOn: [review]
  - id: final-review
    title: Final review
    owner: claude
    mode: final_review
    effort: high
    dependsOn: [correction]
integration:
  commands:
    - node -e "process.exit(0)"
`;
}

function resumePhase(baseBranch: string): string {
  return `
phase: smoke-resume
name: Fake-agent resume
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
tasks:
  - id: implementation
    title: Implement
    owner: codex
    mode: implementation
    effort: medium
    files: [feature.txt]
integration:
  commands:
    - node -e "process.exit(0)"
`;
}

function completeHandoff(summary: string, filesChanged: readonly string[]): unknown {
  return {
    status: 'complete',
    summary,
    filesChanged,
    decisions: [],
    tests: [{ command: 'fake-test', result: 'pass', details: 'fake evidence' }],
    openQuestions: [],
    reviewRequested: [],
  };
}

function changesRequestedReview(): unknown {
  return {
    status: 'changes_requested',
    findings: [
      {
        id: 'F001',
        severity: 'medium',
        category: 'correctness',
        file: 'feature.txt',
        location: 'content',
        problem: 'The implementation needs a correction.',
        evidence: 'The fake implementation contains only its initial state.',
        impact: 'The intended corrected state is absent.',
        suggestedFix: 'Append the corrected state.',
        verificationRequired: 'Verify the integrated file contains both states.',
      },
    ],
  };
}

function successfulResult(
  agent: AgentName,
  request: AgentRequest,
  structuredHandoff: unknown,
): AgentResult {
  const timestamp = new Date().toISOString();
  return {
    agent,
    runId: request.runId,
    taskId: request.taskId,
    status: 'succeeded',
    failureCode: null,
    exitCode: 0,
    signal: null,
    stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout.log`),
    stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr.log`),
    structuredHandoff,
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
