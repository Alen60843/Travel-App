import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { Agent, AgentRequest, AgentResult } from '../../src/agents';
import { AgentOrchestrator } from '../../src/orchestrator';
import { GitClient, WorktreeManager, integrateTaskCommits, type GitRunOptions } from '../../src/git';
import { StateStore, validateRunState, type RunState, type TaskRunState } from '../../src/state';
import { parseHandoff, writeHandoff } from '../../src/handoff';
import { applyReplanOverlays, replanHash, type ReplanProposal } from '../../src/replan/model';
import { taskCodeInputs } from '../../src/replan/static-replanner';
import { TaskGraph, TaskScheduler } from '../../src/tasks';
import { isOrchestratorError } from '../../src/errors';
import { createTemporaryRepository } from '../git/helpers';

const eventPath = 'apps/api/src/events/event.ts';
const chatPath = 'apps/api/src/chat/chat.ts';
const complete = (files: string[]) => ({ status: 'complete', summary: 'Completed authorized work', filesChanged: files,
  decisions: [], tests: [{ command: 'fixture', result: 'pass', details: 'Verified composed inputs' }], openQuestions: [], reviewRequested: [] });
const draft = { role: 'implementation', concern: 'authorization', objective: 'Enforce Event lifecycle in Chat', reason: 'Direct room operations bypass Event resolver policy',
  dependencies: [], capabilities: [{ capability: 'postgresql_testing', minimumLevel: 1 }],
  resourceClaims: [{ kind: 'repository_path', key: 'apps/api/src/chat/**', mode: 'write' }, { kind: 'repository_path', key: 'apps/api/src/events/**', mode: 'read' }],
  evidence: [{ kind: 'file', reference: chatPath, summary: 'Missing Event policy' }, { kind: 'test', reference: 'fixture', summary: 'Event-side contract' }], risk: 'high', priority: 90, estimatedCostUnits: 0 };

class ReplanAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  changesRequested = false;
  escapeOwnership = false;
  correctionEscapeOwnership = false;
  constructor(readonly name: 'codex' | 'claude') {}
  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    const cwd = request.worktreePath;
    assert.match(await readFile(join(cwd, eventPath), 'utf8'), /^Event (checkpoint|corrected)\n$/);
    let output: unknown;
    if (request.taskId.startsWith('replan-')) {
      assert.equal(await readFile(join(cwd, 'apps/api/src/chat/transport/feature.txt'), 'utf8'), 'realtime successful\n');
      assert.equal(await readFile(join(cwd, 'apps/api/src/chat/presence/feature.txt'), 'utf8'), 'presence successful\n');
      assert.ok(request.dependencyHandoffs.some((artifact) => parseHandoff(artifact).status === 'blocked'));
      const path = this.escapeOwnership ? eventPath : chatPath;
      await writeFile(join(cwd, path), 'Chat authorized\n');
      output = complete([path]);
    } else if (request.taskId === 'correction') {
      assert.equal(await readFile(join(cwd, eventPath), 'utf8'), 'Event checkpoint\n');
      assert.equal(await readFile(join(cwd, chatPath), 'utf8'), 'Chat authorized\n');
      assert.ok(request.allowedFileOwnership.includes('apps/api/src/events/**'));
      assert.ok(request.allowedFileOwnership.includes('apps/api/src/chat/**'));
      assert.deepEqual([...request.allowedFileOwnership].sort(), ['apps/api/src/chat/**', 'apps/api/src/events/**']);
      await writeFile(join(cwd, eventPath), 'Event corrected\n');
      await writeFile(join(cwd, chatPath), 'Chat corrected\n');
      const files = [eventPath, chatPath];
      if (this.correctionEscapeOwnership) {
        await writeFile(join(cwd, 'design.md'), '# Unauthorized correction\n');
        files.push('design.md');
      }
      output = { ...complete(files), findingResponses: [{ findingId: 'F001', decision: 'confirmed', resolution: 'resolved', evidence: 'Corrected Event and Chat policy', fix: 'Event and Chat corrected', verification: 'Fixture assertions' }] };
    } else if (['review', 'final-review', 'phase-final'].includes(request.taskId)) {
      assert.match(await readFile(join(cwd, chatPath), 'utf8'), /Chat (authorized|corrected)/);
      assert.match((request.taskSpecification as { actualDependencyDiff: string }).actualDependencyDiff, /Event (checkpoint|corrected)/);
      assert.match((request.taskSpecification as { actualDependencyDiff: string }).actualDependencyDiff, /Chat (authorized|corrected)/);
      output = request.taskId === 'review' && this.changesRequested
        ? { status: 'changes_requested', findings: [{ id: 'F001', severity: 'medium', category: 'security', file: chatPath, location: 'Chat policy', problem: 'Chat policy requires correction', evidence: 'Composed fixture', impact: 'Authorization defect', suggestedFix: 'Correct policy', verificationRequired: 'Fixture assertions' }] }
        : { status: 'approved', findings: [] };
    } else {
      assert.equal(request.taskId, 'composed');
      output = complete([]);
    }
    const now = new Date().toISOString();
    return { agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded', failureCode: null, exitCode: 0, signal: null,
      stdoutPath: join(request.artifactsDirectory, 'stdout'), stderrPath: join(request.artifactsDirectory, 'stderr'),
      structuredHandoff: output, changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [], startedAt: now, endedAt: now,
      durationMs: 1, timedOut: false, aborted: false, errorMessage: null };
  }
}

async function fixture(verify?: string | ((container: string) => string), conventionalRunsRoot = false) {
  const repository = await createTemporaryRepository();
  await mkdir(join(repository.repository, 'apps/api/src/events'), { recursive: true });
  await mkdir(join(repository.repository, 'apps/api/src/chat'), { recursive: true });
  await writeFile(join(repository.repository, eventPath), 'Event base\n');
  await writeFile(join(repository.repository, chatPath), 'Chat base\n');
  await writeFile(join(repository.repository, 'design.md'), '# Design\n');
  await repository.git.run(repository.repository, ['add', '.']);
  await repository.git.run(repository.repository, ['commit', '-m', 'Baseline']);
  const phasePath = join(repository.container, 'phase.yaml');
  await writeFile(phasePath, JSON.stringify({ phase: 'scope-gap', name: 'Static scope gap', baseBranch: repository.baseBranch,
    canonicalDesignDocument: 'design.md', concurrency: 1, agentRetries: 0, maxReviewRounds: 3,
    salvage: { verify: [(typeof verify === 'function' ? verify(repository.container) : verify) ?? `node -e "const fs=require('node:fs');if(!fs.readFileSync('${eventPath}','utf8').startsWith('Event checkpoint')||!fs.readFileSync('${chatPath}','utf8').startsWith('Chat authorized'))process.exit(1)"`] },
    tasks: [
      { id: 'durable', title: 'Durable', owner: 'codex', mode: 'implementation', files: ['durable.txt'] },
      { id: 'realtime', title: 'Realtime', owner: 'codex', mode: 'implementation', files: ['apps/api/src/chat/transport/**'], dependsOn: ['durable'] },
      { id: 'presence', title: 'Presence', owner: 'codex', mode: 'implementation', files: ['apps/api/src/chat/presence/**'], dependsOn: ['realtime'] },
      { id: 'event', title: 'Event', owner: 'codex', mode: 'implementation', files: ['apps/api/src/events/**'], dependsOn: ['durable'] },
      { id: 'review', title: 'Event review', owner: 'claude', mode: 'review', files: [], dependsOn: ['event'] },
      { id: 'correction', title: 'Event correction', owner: 'codex', mode: 'correction', files: ['apps/api/src/events/**'], dependsOn: ['review'], condition: { reviewOf: 'review', skipIfStatus: ['approved'] } },
      { id: 'final-review', title: 'Event final review', owner: 'claude', mode: 'final_review', files: [], dependsOn: ['correction'], condition: { reviewOf: 'review', skipIfStatus: ['approved'] } },
      { id: 'composed', title: 'Phase composed verification', owner: 'codex', mode: 'testing', writer: false, files: [], dependsOn: ['final-review'] },
      { id: 'phase-final', title: 'Phase final review', owner: 'claude', mode: 'final_review', files: [], dependsOn: ['composed'] },
    ], integration: { commands: ['true'] },
  }));
  const agents = { codex: new ReplanAgent('codex'), claude: new ReplanAgent('claude') };
  const options = { repositoryPath: repository.repository, runsRoot: conventionalRunsRoot ? join(repository.repository, 'tools/agent-orchestrator/runs') : join(repository.container, 'runs'), agents };
  const orchestrator = await AgentOrchestrator.start(phasePath, options);
  const initial = orchestrator.snapshot();
  const store = orchestrator.stateStore;
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });
  const dependencyTree = await manager.createTaskWorktree({ runId: initial.runId, taskId: 'durable', baseBranch: initial.baseBranch, baseSha: initial.baseSha });
  const tasks = { ...initial.tasks };
  const commits: { taskId: string; commitSha: string }[] = [];
  for (const id of ['durable', 'realtime', 'presence']) {
    const parentSha = await repository.git.resolveCommit(dependencyTree.path, 'HEAD');
    const path = id === 'durable' ? 'durable.txt' : `apps/api/src/chat/${id === 'realtime' ? 'transport' : 'presence'}/feature.txt`;
    await mkdir(resolve(dependencyTree.path, path, '..'), { recursive: true });
    await writeFile(join(dependencyTree.path, path), `${id} successful\n`);
    await repository.git.run(dependencyTree.path, ['add', '--', path]);
    await repository.git.run(dependencyTree.path, ['commit', '-m', `agent(codex): ${id} Completed`]);
    const sha = await repository.git.resolveCommit(dependencyTree.path, 'HEAD');
    const handoffPath = await writeHandoff(join(store.runDirectory, 'handoffs'), id, parseHandoff(complete([path])));
    tasks[id] = { ...tasks[id]!, status: 'SUCCEEDED', commit: { sha, parentSha, changedFiles: [path] }, handoffPath };
    commits.push({ taskId: id, commitSha: sha });
  }
  const worktree = await manager.createTaskWorktree({ runId: initial.runId, taskId: 'event', baseBranch: initial.baseBranch, baseSha: initial.baseSha });
  assert.equal((await integrateTaskCommits(repository.git, worktree.path, commits.filter((commit) => commit.taskId === 'durable'))).status, 'succeeded');
  const preparedHeadSha = await repository.git.resolveCommit(worktree.path, 'HEAD');
  await writeFile(join(worktree.path, eventPath), 'Event checkpoint\n');
  const handoffPath = await writeHandoff(join(store.runDirectory, 'handoffs'), 'event', parseHandoff({ ...complete([eventPath]), status: 'blocked', additionalWorkRequests: [draft] }));
  tasks.event = { ...tasks.event!, status: 'BLOCKED', worktreePath: worktree.path, branch: worktree.branch, preparedHeadSha,
    agentAttempts: [{ attempt: 1, agent: 'codex', startedAt: initial.createdAt, finishedAt: initial.createdAt, outcome: 'succeeded' }],
    handoffPath, handoffOutcome: 'valid', error: { code: 'REVIEW_BLOCKED', message: 'Chat outside ownership', at: initial.createdAt } };
  for (const id of ['review', 'correction', 'final-review', 'composed', 'phase-final']) tasks[id] = { ...tasks[id]!, status: 'BLOCKED', error: { code: 'TASK_DEPENDENCY_FAILED', message: 'Source blocked', at: initial.createdAt } };
  await store.save({ ...initial, status: 'BLOCKED', tasks });
  return { repository, worktree, options, store, orchestrator, runId: initial.runId, handoffPath,
    propose: () => AgentOrchestrator.proposeReplan(initial.runId, 'event', options),
    authorize: (proposal: ReplanProposal, git?: GitClient) => AgentOrchestrator.authorizeReplan(initial.runId, proposal.id, { ...options, ...(git === undefined ? {} : { git }) }),
    edit: async (update: (state: RunState) => RunState) => store.save(update(await store.load())),
    editTask: async (id: string, update: (task: TaskRunState) => TaskRunState) => { const state = await store.load(); await store.save({ ...state, tasks: { ...state.tasks, [id]: update(state.tasks[id]!) } }); },
  };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const noProviders = (f: Fixture) => { assert.equal(f.options.agents.codex.invocations.length, 0); assert.equal(f.options.agents.claude.invocations.length, 0); };

async function replaceRequest(f: Fixture, update: (handoff: any) => void): Promise<void> {
  const handoff = JSON.parse(await readFile(f.handoffPath, 'utf8'));
  update(handoff);
  await writeFile(f.handoffPath, `${JSON.stringify(handoff, null, 2)}\n`);
}

async function assertProposalRefusedWithoutMutation(f: Fixture): Promise<void> {
  const beforeState = await readFile(f.store.statePath, 'utf8');
  const beforeEvents = await readFile(f.store.eventsPath, 'utf8');
  const beforeHead = await f.repository.git.resolveCommit(f.worktree.path, 'HEAD');
  const beforeStatus = await f.repository.git.run(f.worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const beforeSource = await readFile(join(f.worktree.path, eventPath));
  await assert.rejects(f.propose(), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  assert.equal(await readFile(f.store.statePath, 'utf8'), beforeState);
  assert.equal(await readFile(f.store.eventsPath, 'utf8'), beforeEvents);
  assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), beforeHead);
  assert.equal((await f.repository.git.run(f.worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout, beforeStatus.stdout);
  assert.deepEqual(await readFile(join(f.worktree.path, eventPath)), beforeSource);
  assert.equal((await f.store.load()).replanProposals, undefined);
  noProviders(f);
}

for (const changesRequested of [false, true]) test(`Event + Chat end-to-end: review ${changesRequested ? 'requests Chat correction' : 'approves and skips correction'}`, async () => {
  const f = await fixture();
  try {
    f.options.agents.claude.changesRequested = changesRequested;
    const original = await f.store.load();
    const frozen = await readFile(join(f.store.runDirectory, 'phase.yaml'));
    const handoff = await readFile(f.handoffPath);
    const proposal = await f.propose();
    assert.equal(proposal.request.risk, 'high');
    assert.deepEqual(proposal.overlay.followup.files, ['apps/api/src/chat/**']);
    noProviders(f);
    assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), original.tasks.event!.preparedHeadSha);
    await f.authorize(proposal);
    noProviders(f);
    const authorized = await f.store.load();
    assert.equal(authorized.tasks.event!.status, 'BLOCKED');
    assert.equal(authorized.tasks.event!.commit, undefined);
    assert.equal(authorized.tasks.event!.replan!.phase, 'CHECKPOINT_READY');
    assert.equal(authorized.integration.status, 'PENDING');
    const resumed = await AgentOrchestrator.resume(f.runId, f.options);
    const followup = resumed.config.tasks.find((task) => task.id === proposal.overlay.followup.id)!;
    assert.deepEqual(followup.dependsOn, ['durable', 'realtime', 'presence']);
    assert.equal(followup.checkpointInputs![0]!.sourceTaskId, 'event');
    assert.ok(new TaskScheduler(resumed.config.tasks, 1, Object.fromEntries(Object.entries(resumed.snapshot().tasks).map(([id, state]) => [id, state.status]))).claimReady().some((task) => task.id === followup.id));
    assert.deepEqual(resumed.config.tasks.find((task) => task.id === 'event')!.files, ['apps/api/src/events/**']);
    assert.deepEqual(resumed.config.tasks.find((task) => task.id === 'review')!.dependsOn, ['event', followup.id]);
    const checkpoint = authorized.tasks.event!.replan!.checkpoint!;
    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify({ errors: completed.errors, tasks: Object.fromEntries(Object.entries(completed.tasks).map(([id, task]) => [id, {status: task.status, error: task.error, replan: task.replan}])) }));
    assert.equal(completed.tasks.event!.commit!.sha, checkpoint.sha);
    assert.deepEqual(completed.tasks.event!.commit!.changedFiles, [eventPath]);
    assert.deepEqual(completed.tasks[followup.id]!.commit!.changedFiles, [chatPath]);
    assert.equal(completed.tasks.event!.replan!.phase, 'RESOLVED');
    assert.equal(completed.tasks.correction!.status, changesRequested ? 'SUCCEEDED' : 'SKIPPED');
    if (changesRequested) {
      assert.deepEqual([...completed.tasks.correction!.commit!.changedFiles].sort(), [eventPath, chatPath].sort());
    }
    assert.equal(completed.tasks['final-review']!.status, changesRequested ? 'SUCCEEDED' : 'SKIPPED');
    assert.equal(completed.tasks.composed!.status, 'SUCCEEDED');
    for (const id of ['durable', 'realtime', 'presence']) assert.deepEqual(completed.tasks[id], original.tasks[id]);
    assert.deepEqual(await readFile(f.handoffPath), handoff);
    assert.deepEqual(await readFile(join(f.store.runDirectory, 'phase.yaml')), frozen);
    assert.ok([...f.options.agents.codex.invocations, ...f.options.agents.claude.invocations].every((request) => !['durable', 'realtime', 'presence', 'event'].includes(request.taskId)));
    const events = (await readFile(f.store.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line).name);
    for (const event of ['REPLAN_PROPOSED', 'REPLAN_AUTHORIZED', 'REPLAN_CHECKPOINT_PREPARING', 'REPLAN_CHECKPOINT_READY', 'REPLAN_COMPOSED_VERIFIED', 'REPLAN_RESOLVED']) assert.ok(events.includes(event));
  } finally { await f.repository.dispose(); }
});

for (const testEvidence of [
  { name: 'referenced passing test', result: 'pass', reference: 'target', accepted: true },
  { name: 'referenced failed test', result: 'fail', reference: 'target', accepted: false },
  { name: 'referenced not_run test', result: 'not_run', reference: 'target', accepted: false },
  { name: 'missing command', result: 'pass', reference: 'missing', accepted: false },
] as const) {
  test(`test evidence validation: ${testEvidence.name}`, async () => {
    const f = await fixture();
    try {
      await replaceRequest(f, (handoff) => {
        handoff.tests = [{ command: 'target', result: testEvidence.result, details: 'Persisted result' }];
        handoff.additionalWorkRequests[0].evidence = [{ kind: 'test', reference: testEvidence.reference, summary: 'Test evidence' }];
      });
      if (testEvidence.accepted) {
        const proposal = await f.propose();
        assert.equal(proposal.request.evidence![0]!.reference, 'target');
        assert.equal((await f.store.load()).replanProposals?.length, 1);
        noProviders(f);
      } else {
        await assertProposalRefusedWithoutMutation(f);
      }
    } finally { await f.repository.dispose(); }
  });
}

test('an unrelated passing test does not validate the referenced failed command', async () => {
  const f = await fixture();
  try {
    await replaceRequest(f, (handoff) => {
      handoff.tests = [
        { command: 'target', result: 'fail', details: 'The referenced test failed' },
        { command: 'unrelated', result: 'pass', details: 'Another test passed' },
      ];
      handoff.additionalWorkRequests[0].evidence = [{ kind: 'test', reference: 'target', summary: 'Failed target' }];
    });
    await assertProposalRefusedWithoutMutation(f);
  } finally { await f.repository.dispose(); }
});

for (const claim of ['apps/api/src/events/chat/**', 'apps/api/src/events/**']) {
  test(`proposal refuses follow-up source ownership claim ${claim}`, async () => {
    const f = await fixture();
    try {
      await replaceRequest(f, (handoff) => {
        handoff.additionalWorkRequests[0].resourceClaims[0].key = claim;
        handoff.additionalWorkRequests[0].evidence = [{ kind: 'test', reference: 'fixture', summary: 'Passing source test' }];
      });
      await assertProposalRefusedWithoutMutation(f);
    } finally { await f.repository.dispose(); }
  });
}

test('correction union ownership rejects a third unrelated path through production execution', async () => {
  const f = await fixture();
  try {
    f.options.agents.claude.changesRequested = true;
    f.options.agents.codex.correctionEscapeOwnership = true;
    const proposal = await f.propose();
    await f.authorize(proposal);
    const state = await (await AgentOrchestrator.resume(f.runId, f.options)).execute();
    assert.equal(state.tasks.correction!.status, 'FAILED');
    assert.equal(state.tasks.correction!.error?.code, 'OWNERSHIP_VIOLATION');
    assert.deepEqual(state.tasks.event!.commit!.changedFiles, [eventPath]);
    assert.deepEqual(state.tasks[proposal.overlay.followup.id]!.commit!.changedFiles, [chatPath]);
  } finally { await f.repository.dispose(); }
});

test('failed composed gate preserves both commits and retries on resume without re-invoking follow-up', async () => {
  const f = await fixture((container) => `node -e "process.exit(require('node:fs').existsSync('${join(container, 'gate-ready')}')?0:1)"`);
  try {
    const proposal = await f.propose(); await f.authorize(proposal);
    const first = await (await AgentOrchestrator.resume(f.runId, f.options)).execute();
    assert.equal(first.status, 'BLOCKED'); assert.equal(first.tasks.event!.status, 'BLOCKED'); assert.equal(first.tasks.event!.commit, undefined);
    assert.ok(first.tasks[proposal.overlay.followup.id]!.commit);
    const followupInvocations = () => f.options.agents.codex.invocations.filter((request) => request.taskId === proposal.overlay.followup.id).length;
    const invocations = followupInvocations();
    await writeFile(join(f.repository.container, 'gate-ready'), 'ready');
    const second = await (await AgentOrchestrator.resume(f.runId, f.options)).execute();
    assert.equal(second.tasks.event!.replan!.verificationAttempts.length, 2);
    assert.equal(followupInvocations(), invocations);
    assert.equal(second.status, 'COMPLETED');
  } finally { await f.repository.dispose(); }
});

test('follow-up ownership cannot include Event edits', async () => {
  const f = await fixture();
  try {
    f.options.agents.codex.escapeOwnership = true;
    const proposal = await f.propose(); await f.authorize(proposal);
    const state = await (await AgentOrchestrator.resume(f.runId, f.options)).execute();
    assert.equal(state.tasks[proposal.overlay.followup.id]!.status, 'FAILED');
    assert.equal(state.tasks.event!.commit, undefined);
    assert.equal(state.integration.status, 'PENDING');
  } finally { await f.repository.dispose(); }
});

class CrashGit extends GitClient {
  constructor(private readonly when: 'before' | 'after') { super(); }
  override async run(cwd: string, args: readonly string[], options?: GitRunOptions) {
    const checkpoint = args[0] === 'commit' && args.some((arg) => arg.includes('Replan-Checkpoint:'));
    if (checkpoint && this.when === 'before') throw new Error('Simulated crash before checkpoint commit');
    const result = await super.run(cwd, args, options);
    if (checkpoint && this.when === 'after') throw new Error('Simulated crash after checkpoint commit');
    return result;
  }
}
for (const when of ['before', 'after'] as const) test(`checkpoint crash ${when} commit is safely reconciled without duplicate commit`, async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose();
    await assert.rejects(f.authorize(proposal, new CrashGit(when)), /Simulated crash/);
    const interrupted = await f.store.load();
    assert.equal(interrupted.tasks.event!.replan!.phase, 'CHECKPOINT_PREPARING');
    assert.equal(interrupted.tasks.event!.commit, undefined);
    const head = await f.repository.git.resolveCommit(f.worktree.path, 'HEAD');
    await f.authorize(proposal);
    const recovered = await f.store.load();
    if (when === 'after') assert.equal(recovered.tasks.event!.replan!.checkpoint!.sha, head);
    const history = (await f.repository.git.run(f.worktree.path, ['rev-list', `${proposal.preparedHeadSha}..HEAD`])).stdout.trim().split('\n');
    assert.equal(history.length, 1);
    assert.equal(recovered.tasks.event!.status, 'BLOCKED');
    noProviders(f);
  } finally { await f.repository.dispose(); }
});

for (const field of ['agentAttempts', 'worktreePath', 'preparedHeadSha', 'commit', 'handoffPath', 'reviewPaths', 'preparation', 'reviewRounds'] as const) {
  test(`authorization refuses downstream ${field} execution evidence`, async () => {
    const f = await fixture();
    try {
      const proposal = await f.propose();
      const source = (await f.store.load()).tasks.event!;
      await f.editTask('correction', (task) => ({ ...task, ...({
        agentAttempts: { agentAttempts: source.agentAttempts }, worktreePath: { worktreePath: source.worktreePath! },
        preparedHeadSha: { preparedHeadSha: source.preparedHeadSha! }, commit: { commit: { sha: source.preparedHeadSha!, parentSha: source.preparedHeadSha!, changedFiles: [] } },
        handoffPath: { handoffPath: f.handoffPath }, reviewPaths: { reviewPaths: [f.handoffPath] }, reviewRounds: { reviewRounds: 1 },
        preparation: { preparation: { status: 'SUCCEEDED' as const, worktreePath: source.worktreePath!, headSha: source.preparedHeadSha!, commands: [], startedAt: source.agentAttempts[0]!.startedAt } },
      }[field]) }));
      await assert.rejects(f.authorize(proposal), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
      noProviders(f);
    } finally { await f.repository.dispose(); }
  });
}

for (const scenario of ['hash-mismatch', 'path-mismatch', 'missing-request', 'wrong-failure', 'integration-started', 'non-quiescent', 'foreign-commit', 'dirty-diff-changed', 'unsafe-claim', 'missing-evidence', 'symlink-artifact', 'failed-overlapping-writer', 'unproven-skipped-overlapping-writer', 'staged-outside-ownership'] as const) {
  test(`proposal/authorization fails closed: ${scenario}`, async () => {
    const f = await fixture();
    try {
      const proposal = await f.propose();
      if (scenario === 'hash-mismatch') await writeFile(f.handoffPath, (await readFile(f.handoffPath, 'utf8')) + '\n');
      if (scenario === 'path-mismatch') await f.editTask('event', (task) => ({ ...task, handoffPath: join(f.store.runDirectory, 'handoffs', 'durable.json') }));
      if (['missing-request', 'unsafe-claim', 'missing-evidence'].includes(scenario)) {
        const handoff = JSON.parse(await readFile(f.handoffPath, 'utf8'));
        if (scenario === 'missing-request') delete handoff.additionalWorkRequests;
        if (scenario === 'unsafe-claim') handoff.additionalWorkRequests[0].resourceClaims[0].key = '../outside/**';
        if (scenario === 'missing-evidence') handoff.additionalWorkRequests[0].evidence = [];
        await writeFile(f.handoffPath, JSON.stringify(handoff));
      }
      if (scenario === 'wrong-failure') await f.editTask('event', (task) => ({ ...task, error: { ...task.error!, code: 'AGENT_FAILED' } }));
      if (scenario === 'integration-started') await f.edit((state) => ({ ...state, integration: { ...state.integration, status: 'RUNNING' } }));
      if (scenario === 'non-quiescent') await f.editTask('presence', (task) => ({ ...task, status: 'RUNNING' }));
      if (scenario === 'failed-overlapping-writer') await f.editTask('presence', (task) => ({ ...task, status: 'FAILED' }));
      if (scenario === 'unproven-skipped-overlapping-writer') await f.editTask('presence', (task) => ({ ...task, status: 'SKIPPED', skipReason: 'Unproven' }));
      if (scenario === 'foreign-commit') { await f.repository.git.run(f.worktree.path, ['add', '.']); await f.repository.git.run(f.worktree.path, ['commit', '-m', 'Foreign checkpoint']); }
      if (scenario === 'dirty-diff-changed') await writeFile(join(f.worktree.path, eventPath), 'Changed after proposal\n');
      if (scenario === 'staged-outside-ownership') {
        await writeFile(join(f.worktree.path, chatPath), 'Staged outside ownership\n');
        await f.repository.git.run(f.worktree.path, ['add', '--', chatPath]);
        await writeFile(join(f.worktree.path, chatPath), 'Chat base\n');
      }
      if (scenario === 'symlink-artifact') { const { rename } = await import('node:fs/promises'); await rename(f.handoffPath, `${f.handoffPath}.real`); await symlink(`${f.handoffPath}.real`, f.handoffPath); }
      const before = await readFile(f.store.statePath, 'utf8');
      await assert.rejects(f.authorize(proposal));
      assert.equal(await readFile(f.store.statePath, 'utf8'), before);
      noProviders(f);
    } finally { await f.repository.dispose(); }
  });
}

test('repeated proposal, authorization and fresh loads are idempotent; old runs retain their shape', async () => {
  const f = await fixture();
  try {
    const old = await f.store.load();
    assert.equal('replanProposals' in validateRunState(old), false);
    const proposal = await f.propose();
    assert.equal((await f.propose()).id, proposal.id);
    await f.authorize(proposal); await f.authorize(proposal);
    let config;
    for (let i = 0; i < 3; i++) {
      const resumed = await AgentOrchestrator.resume(f.runId, f.options);
      if (config !== undefined) assert.deepEqual(resumed.config, config);
      config = resumed.config;
      assert.equal(resumed.snapshot().replanProposals!.length, 1);
      assert.equal(resumed.snapshot().replanAuthorizations!.length, 1);
      assert.equal(config.tasks.filter((task) => task.id === proposal.overlay.followup.id).length, 1);
      assert.equal(new Set(config.tasks.find((task) => task.id === 'correction')!.files).size, 2);
    }
    noProviders(f);
  } finally { await f.repository.dispose(); }
});

test('full effective graph revalidates ownership, dangling references and cycles', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose();
    const grant = { proposalId: proposal.id, authorizedBy: 'human' as const, authorizedAt: new Date().toISOString(), overlayHash: replanHash(proposal.overlay) };
    const apply = (config: typeof f.orchestrator.config) => applyReplanOverlays(config, { replanProposals: [proposal], replanAuthorizations: [grant] });
    const base = f.orchestrator.config;
    assert.throws(() => apply({ ...base, tasks: [...base.tasks, { ...proposal.overlay.followup, id: 'parallel-chat', dependsOn: [] }] }), (error) => isOrchestratorError(error, 'OWNERSHIP_OVERLAP'));
    assert.throws(() => apply({ ...base, tasks: base.tasks.map((task) => task.id === 'durable' ? { ...task, dependsOn: ['missing'] } : task) }));
    assert.throws(() => apply({ ...base, tasks: base.tasks.map((task) => task.id === 'durable' ? { ...task, dependsOn: ['phase-final'] } : task) }), (error) => isOrchestratorError(error, 'DAG_CYCLE'));
    new TaskGraph(apply(base).tasks);
  } finally { await f.repository.dispose(); }
});

test('run mutation lock excludes authorization, resume, salvage, preflight and integration commands', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose();
    await new StateStore(f.options.runsRoot, f.runId).withRunMutationLock(async () => {
      for (const call of [() => f.authorize(proposal), () => AgentOrchestrator.resume(f.runId, f.options),
        () => AgentOrchestrator.salvageTask(f.runId, 'event', f.options), () => AgentOrchestrator.retryPreflight(f.runId, 'review', f.options),
        () => AgentOrchestrator.retryIntegrationGate(f.runId, f.options), () => f.orchestrator.execute()]) {
        await assert.rejects(call(), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
      }
    });
    await f.authorize(proposal);
    noProviders(f);
  } finally { await f.repository.dispose(); }
});

test('ordinary integration rejects an unresolved checkpoint, and stale execution cannot overwrite authorization', async () => {
  const f = await fixture();
  try {
    const stale = await AgentOrchestrator.resume(f.runId, f.options);
    const proposal = await f.propose(); await f.authorize(proposal);
    await assert.rejects(stale.execute(), /Run changed after loading/);
    const current = await AgentOrchestrator.resume(f.runId, f.options);
    await assert.rejects((current as unknown as { integrateAndVerify(): Promise<void> }).integrateAndVerify(), /Unresolved source checkpoints/);
    assert.equal(current.snapshot().integration.worktreePath, undefined);
    assert.equal(taskCodeInputs(current.config, current.snapshot(), current.config.tasks.find((task) => task.id === proposal.overlay.followup.id)!).at(-1)!.commitSha,
      current.snapshot().tasks.event!.replan!.checkpoint!.sha);
    noProviders(f);
  } finally { await f.repository.dispose(); }
});

test('dependency-blocked pending review and correction are eligible without changing dependency semantics', async () => {
  const f = await fixture();
  try {
    for (const id of ['review', 'correction']) await f.editTask(id, (task) => { const { error: _error, ...rest } = task; return { ...rest, status: 'PENDING' }; });
    const proposal = await f.propose(); await f.authorize(proposal);
    const state = await (await AgentOrchestrator.resume(f.runId, f.options)).execute();
    assert.equal(state.status, 'COMPLETED');
    assert.equal(state.tasks.correction!.status, 'SKIPPED');
  } finally { await f.repository.dispose(); }
});

test('normal resume completes an authorized checkpoint intent after a crash', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose();
    await assert.rejects(f.authorize(proposal, new CrashGit('after')), /Simulated crash/);
    const head = await f.repository.git.resolveCommit(f.worktree.path, 'HEAD');
    const resumed = await AgentOrchestrator.resume(f.runId, f.options);
    noProviders(f);
    const state = await resumed.execute();
    assert.equal(state.status, 'COMPLETED');
    assert.equal(state.tasks.event!.commit!.sha, head);
    assert.equal(state.replanAuthorizations!.length, 1);
  } finally { await f.repository.dispose(); }
});

for (const scenario of ['extra-commit', 'wrong-tree', 'wrong-trailer', 'dirty-after-commit'] as const) {
  test(`checkpoint adoption refuses ${scenario} and preserves evidence`, async () => {
    const f = await fixture();
    try {
      const proposal = await f.propose();
      await assert.rejects(f.authorize(proposal, new CrashGit('after')), /Simulated crash/);
      if (scenario === 'extra-commit') await f.repository.git.run(f.worktree.path, ['commit', '--allow-empty', '-m', 'Foreign commit']);
      if (scenario === 'wrong-trailer') await f.repository.git.run(f.worktree.path, ['commit', '--amend', '-m', 'Foreign message']);
      if (scenario === 'dirty-after-commit' || scenario === 'wrong-tree') await writeFile(join(f.worktree.path, eventPath), 'Foreign content\n');
      if (scenario === 'wrong-tree') { await f.repository.git.run(f.worktree.path, ['add', '.']); await f.repository.git.run(f.worktree.path, ['commit', '--amend', '--no-edit']); }
      const head = await f.repository.git.resolveCommit(f.worktree.path, 'HEAD');
      await assert.rejects(f.authorize(proposal));
      assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), head);
      assert.equal((await f.store.load()).tasks.event!.commit, undefined);
      noProviders(f);
    } finally { await f.repository.dispose(); }
  });
}

test('checkpoint adoption binds new binary files as well as tracked changes', async () => {
  const f = await fixture();
  try {
    const path = 'apps/api/src/events/data.bin';
    await writeFile(join(f.worktree.path, path), Buffer.from([0, 1, 2, 255]));
    const handoff = JSON.parse(await readFile(f.handoffPath, 'utf8'));
    handoff.filesChanged.push(path);
    await writeFile(f.handoffPath, JSON.stringify(handoff));
    const proposal = await f.propose();
    await assert.rejects(f.authorize(proposal, new CrashGit('after')), /Simulated crash/);
    await f.authorize(proposal);
    assert.deepEqual([...(await f.store.load()).tasks.event!.replan!.checkpoint!.changedFiles].sort(), [path, eventPath].sort());
  } finally { await f.repository.dispose(); }
});

test('persisted replan validation rejects changed proposal, overlay, missing grant and premature canonical source', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose(); await f.authorize(proposal);
    const state = await f.store.load();
    const tamper = (edit: (value: any) => void) => {
      const value = JSON.parse(JSON.stringify(state)); edit(value); assert.throws(() => validateRunState(value));
    };
    tamper((value) => { value.replanProposals[0].request.objective = 'Changed'; });
    tamper((value) => { value.replanAuthorizations[0].overlayHash = '0'.repeat(64); });
    tamper((value) => { value.replanAuthorizations = []; });
    tamper((value) => { value.tasks.event.commit = value.tasks.event.replan.checkpoint; });
    tamper((value) => { value.tasks.event.replan.phase = 'RESOLVED'; });
    tamper((value) => { value.replanProposals[0].overlay.followup.dependsOn = ['event']; });
    tamper((value) => { value.replanAuthorizations[0].authorizedBy = 'agent'; });
    noProviders(f);
  } finally { await f.repository.dispose(); }
});

test('host CLI proposes, explicitly authorizes and reports checkpoint state without executing follow-up', async () => {
  const f = await fixture(undefined, true);
  try {
    const cli = (command: string, ...args: string[]) => {
      const result = spawnSync(process.execPath, [resolve(__dirname, '../../src/cli.js'), command, f.runId, ...args], { cwd: f.repository.repository, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
      return JSON.parse(result.stdout);
    };
    const proposed = cli('propose-replan', 'event');
    assert.match(proposed.manualNextStep, /agents:authorize-replan/);
    assert.equal((await f.store.load()).tasks.event!.replan, undefined);
    const authorized = cli('authorize-replan', proposed.proposal.id);
    assert.match(authorized.manualNextStep, /agents:resume/);
    const status = cli('status');
    assert.equal(status.tasks.event.status, 'BLOCKED');
    assert.equal(status.tasks.event.commitSha, null);
    assert.equal(status.tasks.event.replan.phase, 'CHECKPOINT_READY');
    assert.equal(status.tasks[proposed.proposal.overlay.followup.id].attempts, 0);
    noProviders(f);
  } finally { await f.repository.dispose(); }
});

test('a moved base between resume and execution cannot reconcile a pending checkpoint intent', async () => {
  const f = await fixture();
  try {
    const proposal = await f.propose();
    await assert.rejects(f.authorize(proposal, new CrashGit('before')), /Simulated crash/);
    const resumed = await AgentOrchestrator.resume(f.runId, f.options);
    const before = await readFile(f.store.statePath, 'utf8');
    await f.repository.git.run(f.repository.repository, ['commit', '--allow-empty', '-m', 'Base moved']);
    await assert.rejects(resumed.execute(), (error) => isOrchestratorError(error, 'BASE_BRANCH_MOVED'));
    assert.equal(await readFile(f.store.statePath, 'utf8'), before);
    assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), proposal.preparedHeadSha);
    noProviders(f);
  } finally { await f.repository.dispose(); }
});
