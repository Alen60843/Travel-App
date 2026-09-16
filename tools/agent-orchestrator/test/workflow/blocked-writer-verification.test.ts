import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentRequest, AgentResult } from '../../src/agents';
import { GitClient, WorktreeManager } from '../../src/git';
import { computeTrackedDiffFingerprint } from '../../src/git/diff';
import { parseHandoff } from '../../src/handoff';
import { AgentOrchestrator } from '../../src/orchestrator';
import type { RunEvent, RunState, TaskRunState } from '../../src/state';
import { createTemporaryRepository } from '../git/helpers';

class ReviewAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(readonly name: 'codex' | 'claude') {}
  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    assert.equal(request.role, 'review', 'only the later normal resume may invoke review');
    assert.ok(request.dependencyHandoffs.some((handoff) => parseHandoff(handoff).status === 'complete'));
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId,
      status: 'succeeded', failureCode: null, exitCode: 0, signal: null,
      stdoutPath: join(request.artifactsDirectory, 'stdout'), stderrPath: join(request.artifactsDirectory, 'stderr'),
      structuredHandoff: { status: 'approved', findings: [] },
      changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: now, endedAt: now, durationMs: 1, timedOut: false, aborted: false, errorMessage: null,
    };
  }
}

const nodeCommand = (code: string) => `node -e ${JSON.stringify(code)}`;
const counterCommand = nodeCommand("require('node:fs').appendFileSync('.recovery-cache', 'x')");
const blockedHandoff = {
  status: 'blocked', summary: 'Provider sandbox cannot reach 127.0.0.1:5432', filesChanged: ['feature.txt'],
  decisions: ['Preserve the implementation for host verification'],
  tests: [{ command: 'database test', result: 'not_run', details: 'Provider environment could not reach PostgreSQL' }],
  openQuestions: ['Host database verification remains necessary'], reviewRequested: ['Review concurrency behavior'],
  knownRisks: ['Concurrency requires deterministic database coverage'],
};

async function scenario(options: { verify?: string; prepare?: string; mode?: string; optionalOnly?: boolean; noVerify?: boolean } = {}) {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, '.gitignore'), '.recovery-cache\n.prepare-cache\n');
  await writeFile(join(fixture.repository, 'design.md'), '# Design\n');
  await writeFile(join(fixture.repository, 'feature.txt'), 'base\n');
  await fixture.git.run(fixture.repository, ['add', '--', '.gitignore', 'design.md', 'feature.txt']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'fixture baseline']);
  const phaseFile = join(fixture.container, 'phase.yaml');
  await writeFile(phaseFile, `phase: blocked-writer
name: Blocked writer host verification
baseBranch: ${fixture.baseBranch}
canonicalDesignDocument: design.md
agentRetries: 0
concurrency: 1
salvage:
  verify: ${options.noVerify ? '[]' : `\n    - command: ${JSON.stringify(options.verify ?? counterCommand)}\n      required: ${!options.optionalOnly}`}
${options.prepare ? `agentWorktree:\n  prepare:\n    - command: ${JSON.stringify(options.prepare)}\n      required: true\n` : ''}tasks:
  - id: prerequisite
    title: Prerequisite
    owner: codex
    mode: implementation
    files: [dependency.txt]
  - id: writer
    title: Implementation blocked by external verification
    owner: codex
    mode: ${options.mode ?? 'implementation'}
    dependsOn: [prerequisite]
    files: [feature.txt, new-feature.txt]
  - id: review
    title: Review implementation
    owner: claude
    mode: review
    dependsOn: [writer]
    files: []
  - id: downstream
    title: Downstream review
    owner: claude
    mode: review
    dependsOn: [review]
    files: []
integration:
  commands:
    - command: "true"
      required: true
`);
  const agents = { codex: new ReviewAgent('codex'), claude: new ReviewAgent('claude') };
  const execution = { repositoryPath: fixture.repository, runsRoot: join(fixture.container, 'runs'), agents };
  const orchestrator = await AgentOrchestrator.start(phaseFile, execution);
  const before = orchestrator.snapshot();
  const manager = await WorktreeManager.create({ repositoryPath: fixture.repository });
  const worktree = await manager.createTaskWorktree({
    runId: before.runId, taskId: 'writer', baseBranch: fixture.baseBranch, baseSha: before.baseSha,
  });
  await writeFile(join(worktree.path, 'feature.txt'), 'implemented work\n');
  const originalPath = join(orchestrator.stateStore.runDirectory, 'handoffs', 'writer.json');
  const originalBytes = JSON.stringify(blockedHandoff, null, 4) + '\n';
  await writeFile(originalPath, originalBytes);
  const dependencyError = { code: 'TASK_DEPENDENCY_FAILED' as const, message: 'A dependency did not succeed', at: before.createdAt };
  const blocked: RunState = {
    ...before, status: 'BLOCKED', tasks: {
      ...before.tasks,
      prerequisite: { ...before.tasks.prerequisite!, status: 'SKIPPED', skipReason: 'fixture prerequisite not needed' },
      writer: {
        ...before.tasks.writer!, status: 'BLOCKED', worktreePath: worktree.path, branch: worktree.branch,
        preparedHeadSha: before.baseSha, startedAt: before.createdAt, finishedAt: before.createdAt,
        agentAttempts: [{ attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'succeeded' }],
        handoffOutcome: 'valid', handoffPath: originalPath,
        error: { code: 'REVIEW_BLOCKED', message: blockedHandoff.summary, at: before.createdAt },
      },
      review: { ...before.tasks.review!, status: 'BLOCKED', error: dependencyError, finishedAt: before.createdAt },
      downstream: { ...before.tasks.downstream!, status: 'BLOCKED', error: dependencyError, finishedAt: before.createdAt },
    },
  };
  await orchestrator.stateStore.save(blocked);
  return {
    fixture, execution, orchestrator, worktree, originalPath, originalBytes, runId: before.runId,
    recover: (git?: GitClient) => AgentOrchestrator.verifyBlockedTask(before.runId, 'writer', { ...execution, ...(git ? { git } : {}) }),
    editState: async (edit: (state: RunState) => RunState) => orchestrator.stateStore.save(edit(await orchestrator.stateStore.load())),
    editWriter: async (edit: (task: TaskRunState) => TaskRunState) => {
      const state = await orchestrator.stateStore.load();
      await orchestrator.stateStore.save({ ...state, tasks: { ...state.tasks, writer: edit(state.tasks.writer!) } });
    },
  };
}

type Scenario = Awaited<ReturnType<typeof scenario>>;
const events = async (s: Scenario): Promise<RunEvent[]> => (await readFile(s.orchestrator.stateStore.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as RunEvent);
const countVerifications = async (s: Scenario) => (await readFile(join(s.worktree.path, '.recovery-cache'), 'utf8').catch(() => '')).length;
const noProviders = (s: Scenario) => {
  assert.equal(s.execution.agents.codex.invocations.length, 0);
  assert.equal(s.execution.agents.claude.invocations.length, 0);
};

async function assertRefusesWithoutMutation(s: Scenario) {
  const state = await readFile(s.orchestrator.stateStore.statePath, 'utf8');
  const history = await readFile(s.orchestrator.stateStore.eventsPath, 'utf8');
  const head = await s.fixture.git.resolveCommit(s.worktree.path, 'HEAD');
  const fingerprint = await computeTrackedDiffFingerprint(s.fixture.git, s.worktree.path, s.orchestrator.snapshot().baseSha);
  await assert.rejects(s.recover);
  assert.equal(await readFile(s.orchestrator.stateStore.statePath, 'utf8'), state);
  assert.equal(await readFile(s.orchestrator.stateStore.eventsPath, 'utf8'), history);
  assert.equal(await s.fixture.git.resolveCommit(s.worktree.path, 'HEAD'), head);
  assert.equal(await computeTrackedDiffFingerprint(s.fixture.git, s.worktree.path, s.orchestrator.snapshot().baseSha), fingerprint);
  noProviders(s);
}

test('real dogfood shape recovers one canonical commit, preserves blocked evidence, reopens descendants, and resumes the same run to review', async () => {
  const s = await scenario();
  try {
    const prior = await s.orchestrator.stateStore.load();
    const result = await s.recover();
    noProviders(s);
    const after = await result.orchestrator.stateStore.load();
    assert.equal(after.runId, s.runId);
    assert.equal(after.status, 'RUNNING');
    assert.equal(after.tasks.writer!.status, 'SUCCEEDED');
    assert.equal(after.tasks.review!.status, 'READY');
    assert.equal(after.tasks.downstream!.status, 'PENDING');
    assert.deepEqual(after.tasks.prerequisite, prior.tasks.prerequisite);
    assert.deepEqual(after.tasks.writer!.agentAttempts, prior.tasks.writer!.agentAttempts);
    assert.deepEqual(after.tasks.writer!.handoffRepairAttempts, prior.tasks.writer!.handoffRepairAttempts);
    assert.equal(await readFile(s.originalPath, 'utf8'), s.originalBytes);
    assert.notEqual(after.tasks.writer!.handoffPath, s.originalPath);
    const recovered = parseHandoff(await readFile(after.tasks.writer!.handoffPath!, 'utf8'));
    assert.equal(recovered.status, 'complete');
    assert.deepEqual(recovered.tests.slice(0, 1), blockedHandoff.tests);
    assert.equal(recovered.tests.at(-1)!.result, 'pass');
    assert.match(recovered.tests.at(-1)!.details!, /Deterministic host verification/);
    assert.deepEqual(recovered.knownRisks, blockedHandoff.knownRisks);
    assert.deepEqual(recovered.decisions.slice(0, 1), blockedHandoff.decisions);
    const proof = JSON.parse(await readFile(join(dirname(after.tasks.writer!.handoffPath!), 'host-verification.json'), 'utf8'));
    assert.equal(proof.error.code, 'REVIEW_BLOCKED');
    assert.equal(proof.attempt.outcome, 'succeeded');
    assert.equal(proof.verified.commands[0].exitCode, 0);
    assert.equal(proof.worktreePath, s.worktree.path);
    assert.equal(typeof proof.verified.commands[0].durationMs, 'number');
    assert.equal(await readFile(proof.verified.commands[0].stderrPath, 'utf8'), '');
    assert.equal((await s.fixture.git.run(s.worktree.path, ['rev-list', '--count', `${prior.baseSha}..HEAD`])).stdout.trim(), '1');
    assert.match((await s.fixture.git.run(s.worktree.path, ['log', '-1', '--format=%s'])).stdout, /^agent\(codex\): writer Recovered blocked writer/);
    assert.equal(after.tasks.writer!.commit!.sha, result.commitSha);
    assert.equal(await countVerifications(s), 1);
    await assertRefusesWithoutMutation(s);
    const resumed = await AgentOrchestrator.resume(s.runId, s.execution);
    assert.equal(resumed.snapshot().tasks.writer!.status, 'SUCCEEDED');
    const completed = await resumed.execute();
    assert.equal(completed.tasks.review!.status, 'SUCCEEDED');
    assert.equal(s.execution.agents.codex.invocations.length, 0);
    assert.equal(s.execution.agents.claude.invocations.length, 2);
    assert.equal(await readFile(s.originalPath, 'utf8'), s.originalBytes);
  } finally { await s.fixture.dispose(); }
});

test('resume alone leaves a valid blocked writer blocked, dirty, and uncommitted', async () => {
  const s = await scenario();
  try {
    const resumed = await AgentOrchestrator.resume(s.runId, s.execution);
    const after = await resumed.execute();
    assert.equal(after.status, 'BLOCKED');
    assert.equal(after.tasks.writer!.status, 'BLOCKED');
    assert.equal(after.tasks.writer!.commit, undefined);
    assert.equal(await countVerifications(s), 0);
    noProviders(s);
  } finally { await s.fixture.dispose(); }
});

const rejections: Record<string, (s: Scenario) => Promise<unknown>> = {
  clean: (s) => writeFile(join(s.worktree.path, 'feature.txt'), 'base\n'),
  'foreign commit / moved HEAD': async (s) => {
    await s.fixture.git.run(s.worktree.path, ['add', '--', 'feature.txt']);
    await s.fixture.git.run(s.worktree.path, ['commit', '-m', 'foreign commit']);
  },
  'ownership violation': (s) => writeFile(join(s.worktree.path, 'design.md'), 'foreign edit\n'),
  'unexpected untracked file': (s) => writeFile(join(s.worktree.path, 'foreign.txt'), 'foreign\n'),
  'missing artifact': (s) => rm(s.originalPath),
  'invalid artifact': (s) => writeFile(s.originalPath, '{ invalid'),
  'complete handoff': (s) => writeFile(s.originalPath, JSON.stringify({ ...blockedHandoff, status: 'complete' })),
  'failed handoff': (s) => writeFile(s.originalPath, JSON.stringify({ ...blockedHandoff, status: 'failed' })),
  'missing handoff path': (s) => s.editWriter(({ handoffPath: _path, ...task }) => task),
  'invalid accepted outcome': (s) => s.editWriter((task) => ({ ...task, handoffOutcome: 'invalid' })),
  'missing accepted outcome': (s) => s.editWriter(({ handoffOutcome: _outcome, ...task }) => task),
  'process failed': (s) => s.editWriter((task) => ({ ...task, agentAttempts: task.agentAttempts.map((attempt) => ({ ...attempt, outcome: 'failed' })) })),
  'process timed out': (s) => s.editWriter((task) => ({ ...task, agentAttempts: task.agentAttempts.map((attempt) => ({ ...attempt, outcome: 'timed_out' })) })),
  'missing process attempt': (s) => s.editWriter((task) => ({ ...task, agentAttempts: [] })),
  'recorded commit': (s) => s.editWriter((task) => ({ ...task, commit: { sha: task.preparedHeadSha!, parentSha: task.preparedHeadSha!, changedFiles: ['feature.txt'] } })),
  'unsatisfied dependency': (s) => s.editState((state) => ({ ...state, tasks: { ...state.tasks, prerequisite: { ...state.tasks.prerequisite!, status: 'FAILED' } } })),
  'dependency drift': (s) => s.editState((state) => ({ ...state, tasks: { ...state.tasks, prerequisite: { ...state.tasks.prerequisite!, status: 'SUCCEEDED', commit: { sha: state.baseSha, parentSha: state.baseSha, changedFiles: ['dependency.txt'] } } } })),
  'started integration': (s) => s.editState((state) => ({ ...state, integration: { ...state.integration, status: 'RUNNING' } })),
  integrated: (s) => s.editState((state) => ({ ...state, integration: { ...state.integration, integratedTaskCommits: [state.baseSha] } })),
  'wrong registration': (s) => s.editWriter((task) => ({ ...task, branch: 'agent/wrong' })),
};
for (const [name, arrange] of Object.entries(rejections)) {
  test(`eligibility rejects ${name} without mutation`, async () => {
    const s = await scenario();
    try { await arrange(s); await assertRefusesWithoutMutation(s); }
    finally { await s.fixture.dispose(); }
  });
}
for (const mode of ['review', 'debate', 'escalation', 'synthesis', 'final_review']) {
  test(`eligibility rejects ${mode} tasks sharing REVIEW_BLOCKED`, async () => {
    const s = await scenario({ mode });
    try { await assertRefusesWithoutMutation(s); } finally { await s.fixture.dispose(); }
  });
}
for (const config of [{ noVerify: true }, { optionalOnly: true }]) {
  test(`eligibility requires deterministic required verification: ${JSON.stringify(config)}`, async () => {
    const s = await scenario(config);
    try { await assertRefusesWithoutMutation(s); } finally { await s.fixture.dispose(); }
  });
}

test('required verification failure preserves original handoff and candidate without a commit', async () => {
  const s = await scenario({ verify: 'false' });
  try {
    const fingerprint = await computeTrackedDiffFingerprint(s.fixture.git, s.worktree.path, s.orchestrator.snapshot().baseSha);
    await assert.rejects(s.recover, { code: 'SALVAGE_VERIFICATION_FAILED' });
    const after = await s.orchestrator.stateStore.load();
    assert.equal(after.tasks.writer!.status, 'BLOCKED');
    assert.equal(after.tasks.writer!.commit, undefined);
    assert.equal(after.tasks.writer!.salvage!.verification, undefined);
    assert.equal(after.tasks.writer!.salvage!.phase, 'FAILED');
    assert.equal(after.tasks.writer!.salvage!.failures?.at(-1)?.reason, 'verify_command_failed');
    assert.equal(await computeTrackedDiffFingerprint(s.fixture.git, s.worktree.path, after.baseSha), fingerprint);
    assert.equal(await readFile(s.originalPath, 'utf8'), s.originalBytes);
    assert.ok((await events(s)).some((event) => event.name === 'SALVAGE_COMMAND_FINISHED'));
    noProviders(s);
  } finally { await s.fixture.dispose(); }
});

for (const phase of ['verify', 'prepare'] as const) {
  for (const candidate of ['tracked', 'existing untracked', 'new untracked', 'commit', 'ignored']) {
    test(`${phase} cannot mutate ${candidate} candidate content (ignored artifacts allowed)`, async () => {
      const file = candidate === 'tracked' ? 'feature.txt' : candidate === 'ignored' ? '.prepare-cache' : 'new-feature.txt';
      const command = candidate === 'commit'
        ? nodeCommand("require('node:child_process').execFileSync('git', ['commit', '--allow-empty', '-m', 'unauthorized'])")
        : nodeCommand(`require('node:fs').writeFileSync(${JSON.stringify(file)}, 'mutated\\n')`);
      const s = await scenario({ [phase]: command });
      try {
        if (candidate === 'existing untracked') await writeFile(join(s.worktree.path, file), 'original untracked bytes\n');
        if (candidate === 'ignored') {
          const recovered = await s.recover();
          assert.equal(recovered.orchestrator.snapshot().tasks.writer!.status, 'SUCCEEDED');
        } else {
          await assert.rejects(s.recover, { code: phase === 'verify' ? 'SALVAGE_VERIFICATION_FAILED' : 'AGENT_WORKTREE_PREPARATION_FAILED' });
          const after = await s.orchestrator.stateStore.load();
          assert.equal(after.tasks.writer!.status, 'BLOCKED');
          assert.equal(after.tasks.writer!.commit, undefined);
          assert.equal(after.tasks.writer!.salvage!.verification, undefined);
        }
        assert.equal(await readFile(s.originalPath, 'utf8'), s.originalBytes);
        noProviders(s);
      } finally { await s.fixture.dispose(); }
    });
  }
}

class CrashBeforeCommit extends GitClient {
  override async run(...args: Parameters<GitClient['run']>): ReturnType<GitClient['run']> {
    if (args[1][0] === 'add') throw new Error('simulated crash before commit');
    return super.run(...args);
  }
}

for (const change of ['none', 'tracked', 'untracked', 'verify config', 'prepare config', 'original handoff']) {
  test(`crash checkpoint reuse is bound to candidate, config and original evidence: ${change}`, async () => {
    const s = await scenario();
    try {
      await assert.rejects(() => s.recover(new CrashBeforeCommit()), /simulated crash/);
      const checkpoint = (await s.orchestrator.stateStore.load()).tasks.writer!.salvage!.verification!;
      assert.equal(checkpoint.result, 'passed');
      assert.equal(await countVerifications(s), 1);
      if (change === 'tracked') await writeFile(join(s.worktree.path, 'feature.txt'), 'changed after checkpoint\n');
      if (change === 'untracked') await writeFile(join(s.worktree.path, 'new-feature.txt'), 'new after checkpoint\n');
      if (change === 'original handoff') await writeFile(s.originalPath, JSON.stringify({ ...blockedHandoff, decisions: ['Updated evidence'] }));
      if (change === 'verify config') await AgentOrchestrator.authorizeRecoveryPolicy(s.runId,
        { salvage: { verify: [{ command: counterCommand, required: true }, { command: 'true', required: true }] } }, s.execution);
      if (change === 'prepare config') {
        // Simulate a changed loaded snapshot in an isolated fixture, never a real run.
        const path = join(s.orchestrator.stateStore.runDirectory, 'phase.yaml');
        await writeFile(path, (await readFile(path, 'utf8')) + '\nagentWorktree:\n  prepare:\n    - command: "true"\n      required: true\n');
      }
      const resumed = await AgentOrchestrator.resume(s.runId, s.execution);
      assert.equal(resumed.snapshot().tasks.writer!.status, 'BLOCKED', 'resume must not consume a verification checkpoint');
      const result = await s.recover();
      assert.equal(result.orchestrator.snapshot().tasks.writer!.status, 'SUCCEEDED');
      assert.equal(await countVerifications(s), change === 'none' ? 1 : 2);
      assert.equal(await readFile(checkpoint.recoveredHandoffPath!, 'utf8').then((source) => parseHandoff(source).status), 'complete');
      noProviders(s);
      await assertRefusesWithoutMutation(s);
    } finally { await s.fixture.dispose(); }
  });
}

test('owned new files and unchanged cherry-picked dependency commits are eligible', async () => {
  const s = await scenario();
  try {
    const manager = await WorktreeManager.create({ repositoryPath: s.fixture.repository });
    const dependency = await manager.createTaskWorktree({ runId: s.runId, taskId: 'prerequisite', baseBranch: s.fixture.baseBranch, baseSha: s.orchestrator.snapshot().baseSha });
    await writeFile(join(dependency.path, 'dependency.txt'), 'dependency work\n');
    await s.fixture.git.run(dependency.path, ['add', '--', 'dependency.txt']);
    await s.fixture.git.run(dependency.path, ['commit', '-m', 'dependency task']);
    const sha = await s.fixture.git.resolveCommit(dependency.path, 'HEAD');
    await s.fixture.git.run(s.worktree.path, ['cherry-pick', '-x', sha]);
    const preparedHeadSha = await s.fixture.git.resolveCommit(s.worktree.path, 'HEAD');
    await s.editState((state) => ({ ...state, tasks: {
      ...state.tasks,
      prerequisite: { ...state.tasks.prerequisite!, status: 'SUCCEEDED', commit: { sha, parentSha: state.baseSha, changedFiles: ['dependency.txt'] } },
      writer: { ...state.tasks.writer!, preparedHeadSha },
    } }));
    await writeFile(join(s.worktree.path, 'new-feature.txt'), 'new owned work\n');
    const result = await s.recover();
    assert.deepEqual(result.orchestrator.snapshot().tasks.writer!.commit!.changedFiles, ['feature.txt', 'new-feature.txt']);
    assert.equal(result.orchestrator.snapshot().tasks.writer!.commit!.parentSha, preparedHeadSha);
    noProviders(s);
  } finally { await s.fixture.dispose(); }
});

test('independently blocked descendants remain blocked', async () => {
  const s = await scenario();
  try {
    await s.editState((state) => ({ ...state, tasks: { ...state.tasks,
      downstream: { ...state.tasks.downstream!, error: { code: 'REVIEW_BLOCKED', message: 'Independent blocker', at: state.createdAt } },
    } }));
    const prior = (await s.orchestrator.stateStore.load()).tasks.downstream;
    const result = await s.recover();
    assert.equal(result.orchestrator.snapshot().tasks.review!.status, 'READY');
    assert.deepEqual(result.orchestrator.snapshot().tasks.downstream, prior);
  } finally { await s.fixture.dispose(); }
});

test('dependency-only descendants with execution artifacts fail closed before verification', async () => {
  const s = await scenario();
  try {
    await s.editState((state) => ({ ...state, tasks: { ...state.tasks,
      review: { ...state.tasks.review!, handoffOutcome: 'invalid' },
    } }));
    await assertRefusesWithoutMutation(s);
  } finally { await s.fixture.dispose(); }
});

test('crash after authorization still requires verification', async () => {
  const s = await scenario();
  try {
    await s.editWriter((task) => ({ ...task, salvage: { authorizedAt: s.orchestrator.snapshot().createdAt } }));
    await s.recover();
    assert.equal(await countVerifications(s), 1);
    noProviders(s);
  } finally { await s.fixture.dispose(); }
});

class CrashAfterCommit extends GitClient {
  override async run(...args: Parameters<GitClient['run']>): ReturnType<GitClient['run']> {
    const result = await super.run(...args);
    if (args[1][0] === 'commit') throw new Error('simulated crash after commit');
    return result;
  }
}

test('crash after creating a commit refuses a second commit or recovery history', async () => {
  const s = await scenario();
  try {
    await assert.rejects(() => s.recover(new CrashAfterCommit()), /simulated crash after commit/);
    assert.equal((await s.orchestrator.stateStore.load()).tasks.writer!.status, 'BLOCKED');
    assert.equal((await s.fixture.git.run(s.worktree.path, ['rev-list', '--count', `${s.orchestrator.snapshot().baseSha}..HEAD`])).stdout.trim(), '1');
    await assertRefusesWithoutMutation(s);
    assert.equal(await countVerifications(s), 1);
  } finally { await s.fixture.dispose(); }
});

test('adaptive state is explicitly rejected before any continuation reconciliation', async () => {
  const s = await scenario();
  try {
    const path = join(s.fixture.container, 'adaptive.yaml');
    await writeFile(path, `mode: adaptive
phase: unsupported-adaptive
name: Adaptive rejection
goal: Review implementation
constraints: [Preserve evidence]
baseBranch: ${s.fixture.baseBranch}
canonicalDesignDocument: design.md
policy:
  allowedConcerns: [review]
  allowedOwnership: ['**']
  allowedResources: []
  limits:
    maxConcurrentAgents: 1
    maxAgentInvocations: 4
    maxTotalWorkUnits: 4
    maxDecompositionDepth: 1
    maxFanOutPerWorkUnit: 2
    maxSynthesisInputs: 2
    maxWallClockMs: 600000
  requireEvidenceForExpansion: true
  agingIntervalMs: 1000
  agingStep: 1
  humanApprovalRisks: []
initialCandidates:
  - role: review
    concern: review
    objective: Review work
    reason: Independent review
    evidence: [{ kind: file, reference: design.md, summary: implementation }]
    resourceClaims: [{ kind: repository_path, key: design.md, mode: read }]
    capabilities: [{ capability: review }]
    risk: medium
    priority: 90
executors:
  - id: reviewer
    adapter: claude
    capabilities: [{ capability: review }]
    roles: [review]
    effort: high
`);
    const adaptive = await AgentOrchestrator.start(path, s.execution);
    const before = await readFile(adaptive.stateStore.statePath, 'utf8');
    const history = await readFile(adaptive.stateStore.eventsPath, 'utf8');
    await assert.rejects(() => AgentOrchestrator.verifyBlockedTask(adaptive.snapshot().runId, 'writer', s.execution), /does not support adaptive runs/);
    assert.equal(await readFile(adaptive.stateStore.statePath, 'utf8'), before);
    assert.equal(await readFile(adaptive.stateStore.eventsPath, 'utf8'), history);
    noProviders(s);
  } finally { await s.fixture.dispose(); }
});
