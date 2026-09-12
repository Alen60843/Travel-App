import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, symlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import type { Agent, AgentRequest, AgentResult } from '../../src/agents';
import { AgentOrchestrator } from '../../src/orchestrator';
import { computeTrackedDiffFingerprint, GitClient, WorktreeManager, integrateTaskCommits, type GitRunOptions } from '../../src/git';
import { StateStore, validateRunState, type RunState, type TaskRunState } from '../../src/state';
import { parseHandoff, writeHandoff } from '../../src/handoff';
import { applyReplanOverlays, replanHash, type ReplanProposal } from '../../src/replan/model';
import { isSupportedStaticReplanSourceMode, taskCodeInputs } from '../../src/replan/static-replanner';
import { treeFingerprint } from '../../src/replan/checkpoint';
import { TASK_MODES, TaskGraph, TaskScheduler, type TaskMode } from '../../src/tasks';
import { isOrchestratorError } from '../../src/errors';
import { createTemporaryRepository } from '../git/helpers';

const eventPath = 'apps/api/src/events/event.ts';
const chatPath = 'apps/api/src/chat/chat.ts';
const transportFixPath = 'apps/api/src/chat/transport/event.ts';
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
      const path = this.escapeOwnership ? eventPath
        : request.allowedFileOwnership.includes('apps/api/src/chat/transport/**') ? transportFixPath : chatPath;
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
      const repaired = await Promise.all([chatPath, transportFixPath].map(async (path) =>
        readFile(join(cwd, path), 'utf8').catch(() => '')));
      assert.ok(repaired.some((content) => /Chat (authorized|corrected)/.test(content)));
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

async function fixture(
  verify?: string | ((container: string) => string),
  conventionalRunsRoot = false,
  sourceMode: TaskMode = 'implementation',
  verificationTopology = false,
  sourceWriter = true,
) {
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
    salvage: { verify: [(typeof verify === 'function' ? verify(repository.container) : verify) ?? `node -e "const fs=require('node:fs');if(!fs.readFileSync('${eventPath}','utf8').startsWith('Event checkpoint')||!fs.readFileSync('${verificationTopology ? transportFixPath : chatPath}','utf8').startsWith('Chat authorized'))process.exit(1)"`] },
    tasks: [
      { id: 'durable', title: 'Durable', owner: 'codex', mode: 'implementation', files: ['durable.txt'] },
      { id: 'realtime', title: 'Realtime', owner: 'codex', mode: 'implementation', files: ['apps/api/src/chat/transport/**'], dependsOn: ['durable'] },
      { id: 'presence', title: 'Presence', owner: 'codex', mode: 'implementation', files: ['apps/api/src/chat/presence/**'], dependsOn: ['realtime'] },
      ...(verificationTopology ? [
        { id: 'unrelated', title: 'Unrelated branch', owner: 'codex', mode: 'implementation', files: ['unrelated.txt'] },
        { id: 'event', title: 'Composed verification', owner: 'codex', mode: sourceMode, writer: sourceWriter, files: ['apps/api/src/events/**'], dependsOn: ['presence'] },
        { id: 'phase-final', title: 'Phase final review', owner: 'claude', mode: 'final_review', files: [], dependsOn: ['event'] },
      ] : [
        { id: 'event', title: 'Event', owner: 'codex', mode: sourceMode, writer: sourceWriter, files: ['apps/api/src/events/**'], dependsOn: ['durable'] },
        { id: 'review', title: 'Event review', owner: 'claude', mode: 'review', files: [], dependsOn: ['event'] },
        { id: 'correction', title: 'Event correction', owner: 'codex', mode: 'correction', files: ['apps/api/src/events/**'], dependsOn: ['review'], condition: { reviewOf: 'review', skipIfStatus: ['approved'] } },
        { id: 'final-review', title: 'Event final review', owner: 'claude', mode: 'final_review', files: [], dependsOn: ['correction'], condition: { reviewOf: 'review', skipIfStatus: ['approved'] } },
        { id: 'composed', title: 'Phase composed verification', owner: 'codex', mode: 'testing', writer: false, files: [], dependsOn: ['final-review'] },
        { id: 'phase-final', title: 'Phase final review', owner: 'claude', mode: 'final_review', files: [], dependsOn: ['composed'] },
      ]),
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
  for (const id of ['durable', 'realtime', 'presence', ...(verificationTopology ? ['unrelated'] : [])]) {
    const parentSha = await repository.git.resolveCommit(dependencyTree.path, 'HEAD');
    const path = id === 'durable' ? 'durable.txt' : id === 'unrelated' ? 'unrelated.txt'
      : `apps/api/src/chat/${id === 'realtime' ? 'transport' : 'presence'}/feature.txt`;
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
  const sourceInputs = verificationTopology ? commits.filter((commit) => ['durable', 'realtime', 'presence'].includes(commit.taskId))
    : commits.filter((commit) => commit.taskId === 'durable');
  assert.equal((await integrateTaskCommits(repository.git, worktree.path, sourceInputs)).status, 'succeeded');
  const preparedHeadSha = await repository.git.resolveCommit(worktree.path, 'HEAD');
  await writeFile(join(worktree.path, eventPath), 'Event checkpoint\n');
  const request = verificationTopology ? { ...draft,
    resourceClaims: [{ kind: 'repository_path' as const, key: 'apps/api/src/chat/transport/**', mode: 'write' as const }, { kind: 'repository_path' as const, key: 'apps/api/src/events/**', mode: 'read' as const }],
    evidence: [{ kind: 'file' as const, reference: 'apps/api/src/chat/transport/feature.txt', summary: 'Obsolete Event transport gate' }, { kind: 'test' as const, reference: 'fixture', summary: 'Composed contract' }],
  } : draft;
  const handoffPath = await writeHandoff(join(store.runDirectory, 'handoffs'), 'event', parseHandoff({ ...complete([eventPath]), status: 'blocked', additionalWorkRequests: [request] }));
  tasks.event = { ...tasks.event!, status: 'BLOCKED', worktreePath: worktree.path, branch: worktree.branch, preparedHeadSha,
    agentAttempts: [{ attempt: 1, agent: 'codex', startedAt: initial.createdAt, finishedAt: initial.createdAt, outcome: 'succeeded' }],
    handoffPath, handoffOutcome: 'valid', error: { code: 'REVIEW_BLOCKED', message: 'Chat outside ownership', at: initial.createdAt } };
  for (const id of verificationTopology ? ['phase-final'] : ['review', 'correction', 'final-review', 'composed', 'phase-final']) tasks[id] = { ...tasks[id]!, status: 'BLOCKED', error: { code: 'TASK_DEPENDENCY_FAILED', message: 'Source blocked', at: initial.createdAt } };
  await store.save({ ...initial, status: 'BLOCKED', tasks });
  return { repository, manager, worktree, options, store, orchestrator, runId: initial.runId, handoffPath,
    normalize: (evidenceIndex = 0, normalizedKind = 'file', requestIndex = 0) => AgentOrchestrator.normalizeReplanEvidence(initial.runId, 'event',
      { requestIndex, evidenceIndex, normalizedKind }, options),
    interpret: (request: Parameters<typeof AgentOrchestrator.interpretReplan>[2]) => AgentOrchestrator.interpretReplan(initial.runId, 'event', request, options),
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

async function assertProposalRefusedWithoutMutation(
  f: Fixture,
  validate: (error: unknown) => boolean = (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'),
): Promise<void> {
  const beforeState = await readFile(f.store.statePath, 'utf8');
  const beforeEvents = await readFile(f.store.eventsPath, 'utf8');
  const beforeHead = await f.repository.git.resolveCommit(f.worktree.path, 'HEAD');
  const beforeStatus = await f.repository.git.run(f.worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const beforeSource = await readFile(join(f.worktree.path, eventPath));
  await assert.rejects(f.propose(), validate);
  assert.equal(await readFile(f.store.statePath, 'utf8'), beforeState);
  assert.equal(await readFile(f.store.eventsPath, 'utf8'), beforeEvents);
  assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), beforeHead);
  assert.equal((await f.repository.git.run(f.worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout, beforeStatus.stdout);
  assert.deepEqual(await readFile(join(f.worktree.path, eventPath)), beforeSource);
  assert.equal((await f.store.load()).replanProposals, undefined);
  noProviders(f);
}

async function assertNormalizationRefusedWithoutMutation(f: Fixture, call: () => Promise<unknown> = () => f.normalize()): Promise<void> {
  const beforeState = await readFile(f.store.statePath, 'utf8');
  const beforeEvents = await readFile(f.store.eventsPath, 'utf8');
  const beforeHead = await f.repository.git.resolveCommit(f.worktree.path, 'HEAD');
  const beforeStatus = await f.repository.git.run(f.worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  await assert.rejects(call());
  assert.equal(await readFile(f.store.statePath, 'utf8'), beforeState);
  assert.equal(await readFile(f.store.eventsPath, 'utf8'), beforeEvents);
  assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), beforeHead);
  assert.equal((await f.repository.git.run(f.worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout, beforeStatus.stdout);
  noProviders(f);
}

async function installHistoricalEvidence(f: Fixture, evidence: { kind: string; reference: string; summary?: string } = {
  kind: 'test', reference: eventPath, summary: 'Repository test-file evidence mislabeled as a command',
}): Promise<void> {
  await replaceRequest(f, (handoff) => {
    handoff.additionalWorkRequests[0].evidence = [{ summary: 'Repository test-file evidence mislabeled as a command', ...evidence }];
  });
}

async function installExactHistoricalEvidence(f: Fixture): Promise<void> {
  await replaceRequest(f, (handoff) => {
    handoff.additionalWorkRequests[0].evidence = [
      { kind: 'file', reference: chatPath, summary: 'Existing Chat implementation lacks the Event policy' },
      { kind: 'test', reference: eventPath, summary: 'Repository test-file evidence mislabeled as a command' },
    ];
  });
}

async function installLegacyFailedSalvage(f: Fixture): Promise<void> {
  const at = new Date().toISOString();
  const stdoutPath = join(f.store.runDirectory, 'logs', 'legacy-stdout'); const stderrPath = join(f.store.runDirectory, 'logs', 'legacy-stderr');
  await mkdir(join(f.store.runDirectory, 'logs'), { recursive: true }); await writeFile(stdoutPath, 'failed\n'); await writeFile(stderrPath, 'diagnostic\n');
  await f.editTask('event', (task) => ({ ...task, salvage: { authorizedAt: at } }));
  await f.store.appendEvent({ name: 'SALVAGE_AUTHORIZED', timestamp: at, runId: f.runId, taskId: 'event' });
  await f.store.appendEvent({ name: 'SALVAGE_COMMAND_FINISHED', timestamp: at, runId: f.runId, taskId: 'event', data: { command: 'fixture', required: true, exitCode: 1, signal: null, termination: null, timedOut: false, stdoutPath, stderrPath, hostVerification: true } });
  await f.store.appendEvent({ name: 'SALVAGE_VERIFICATION_FAILED', timestamp: at, runId: f.runId, taskId: 'event', data: { reason: 'verify_command_failed' } });
}

test('static replan source modes are exactly implementation and testing', () => {
  assert.deepEqual(TASK_MODES.filter(isSupportedStaticReplanSourceMode), ['implementation', 'testing']);
});

test('v2 explicitly selects one request, removes an exact claim, normalizes line references, and reclassifies file-shaped evidence', async () => {
  const f = await fixture(undefined, false, 'testing', true);
  await replaceRequest(f, (handoff) => {
    const selected = handoff.additionalWorkRequests[0];
    selected.resourceClaims = [
      { kind: 'repository_path', key: 'apps/api/src/chat/transport/**', mode: 'write' },
      { kind: 'repository_path', key: 'apps/api/src/chat/presence/**', mode: 'write' },
      { kind: 'repository_path', key: 'apps/api/src/events/**', mode: 'read' },
    ];
    selected.evidence = [
      { kind: 'file', reference: `${eventPath}:1`, summary: 'Exact source line' },
      { kind: 'test', reference: eventPath, summary: 'File-shaped historical evidence' },
    ];
    handoff.additionalWorkRequests.unshift({ ...selected, objective: 'Unselected request' });
  });
  const selectedClaims = [
    { kind: 'repository_path' as const, key: 'apps/api/src/chat/transport/**', mode: 'write' as const },
    { kind: 'repository_path' as const, key: 'apps/api/src/events/**', mode: 'read' as const },
  ];
  const interpretation = await f.interpret({ requestIndex: 1, resourceClaims: selectedClaims, evidenceTransformations: [
    { evidenceIndex: 0, normalizedReference: eventPath },
    { evidenceIndex: 1, normalizedKind: 'file' },
  ] });
  assert.equal(interpretation.version, 2);
  assert.equal(interpretation.requestIndex, 1);
  assert.deepEqual(interpretation.resourceClaims, selectedClaims);
  assert.deepEqual(interpretation.evidenceTransformations.map((entry) => [entry.originalReference, entry.normalizedReference, entry.normalizedKind]), [
    [`${eventPath}:1`, eventPath, 'file'], [eventPath, eventPath, 'file'],
  ]);
  const proposal = await f.propose();
  assert.deepEqual(proposal.interpretationIds, [interpretation.id]);
  const { id: _id, ...proposalBody } = proposal;
  assert.equal(proposal.id, replanHash(proposalBody));
  const { interpretationIds: _interpretationIds, ...rawSemanticBody } = proposalBody;
  assert.notEqual(proposal.id, replanHash(rawSemanticBody));
  assert.deepEqual(proposal.request.resourceClaims, selectedClaims);
  assert.equal(proposal.request.objective, 'Enforce Event lifecycle in Chat');
  assert.deepEqual(proposal.request.evidence?.map((entry) => [entry.kind, entry.reference]), [['file', eventPath], ['file', eventPath]]);
  assert.equal((await f.store.load()).replanProposals?.[0]?.id, proposal.id);
  noProviders(f);
});

test('removing an interpretation after proposal persistence invalidates authorization replay', async () => {
  const f = await fixture(); await f.interpret({ requestIndex: 0 }); const proposal = await f.propose();
  const state = await f.store.load();
  await assert.rejects(f.store.save({ ...state, replanInterpretations: [] }), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  assert.equal((await f.store.load()).replanInterpretations?.length, 1);
  assert.equal((await f.authorize(proposal)).id, proposal.id);
  noProviders(f);
});

test('v2 interpretation is content-hashed and proposal replay refuses source drift', async () => {
  const f = await fixture();
  const interpretation = await f.interpret({ requestIndex: 0 });
  await writeFile(join(f.worktree.path, eventPath), 'Event checkpoint changed\n');
  await assert.rejects(f.propose(), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  const persisted = JSON.parse(await readFile(f.store.statePath, 'utf8'));
  persisted.replanInterpretations[0].requestIndex = 1;
  await writeFile(f.store.statePath, `${JSON.stringify(persisted, null, 2)}\n`);
  await assert.rejects(f.store.load(), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  assert.equal(interpretation.authorizedBy, 'human');
  noProviders(f);
});

test('v2 permits only a same-path write-to-read claim downgrade', async () => {
  const f = await fixture();
  const interpretation = await f.interpret({ requestIndex: 0, resourceClaims: [
    { kind: 'repository_path', key: 'apps/api/src/chat/**', mode: 'read' },
    { kind: 'repository_path', key: 'apps/api/src/events/**', mode: 'read' },
  ] });
  assert.equal(interpretation.resourceClaims[0]?.mode, 'read');
  await assert.rejects(f.propose(), /write scope must be nonempty/);
  noProviders(f);
});

for (const scenario of ['claim-mode-escalation', 'claim-glob-rewrite', 'new-path', 'bad-request-index', 'line-zero', 'line-negative', 'line-nonnumeric', 'arbitrary-colon', 'missing-file', 'outside-scope', 'symlink', 'real-test-command'] as const) {
  test(`v2 interpretation refuses ${scenario} without persistence or providers`, async () => {
    const f = await fixture();
    if (scenario === 'symlink') await symlink('../../../design.md', join(f.worktree.path, 'apps/api/src/events/link.ts'));
    await replaceRequest(f, (handoff) => {
      const reference = scenario === 'line-zero' ? `${eventPath}:0` : scenario === 'line-negative' ? `${eventPath}:-1`
        : scenario === 'line-nonnumeric' ? `${eventPath}:abc` : scenario === 'arbitrary-colon' ? 'fixture:thing'
          : scenario === 'missing-file' ? 'apps/api/src/events/missing.ts:1' : scenario === 'outside-scope' ? 'design.md:1'
            : scenario === 'symlink' ? 'apps/api/src/events/link.ts:1' : `${eventPath}:1`;
      handoff.additionalWorkRequests[0].evidence = [{ kind: 'file', reference, summary: 'Line' }];
      if (scenario === 'real-test-command') handoff.additionalWorkRequests[0].evidence = [{ kind: 'test', reference: 'fixture', summary: 'Real command' }];
    });
    const before = await readFile(f.store.statePath, 'utf8');
    const claims: any[] = scenario === 'claim-mode-escalation' ? [{ kind: 'repository_path', key: 'apps/api/src/events/**', mode: 'write' }]
      : scenario === 'claim-glob-rewrite' ? [{ kind: 'repository_path', key: 'apps/api/src/chat/*', mode: 'write' }]
        : scenario === 'new-path' ? [{ kind: 'repository_path', key: 'apps/api/src/new/**', mode: 'write' }]
        : draft.resourceClaims;
    const normalizedReference = scenario === 'missing-file' ? 'apps/api/src/events/missing.ts' : scenario === 'outside-scope' ? 'design.md'
      : scenario === 'symlink' ? 'apps/api/src/events/link.ts' : eventPath;
    await assert.rejects(f.interpret({ requestIndex: scenario === 'bad-request-index' ? 9 : 0, resourceClaims: claims,
      evidenceTransformations: [{ evidenceIndex: 0, ...(scenario === 'real-test-command' ? { normalizedKind: 'file' }
        : { normalizedReference }) }],
    }), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
    assert.equal(await readFile(f.store.statePath, 'utf8'), before);
    noProviders(f);
  });
}

test('terminal failed salvage remains eligible while authorized, verifying, verified, and legacy salvage refuse', async () => {
  for (const phase of ['AUTHORIZED', 'VERIFYING', 'VERIFIED', 'legacy'] as const) {
    const f = await fixture();
    await f.editTask('event', (task) => ({ ...task, salvage: phase === 'legacy' ? { authorizedAt: task.error!.at }
      : phase === 'VERIFIED' ? { authorizedAt: task.error!.at, phase, verification: { worktreeHeadSha: task.preparedHeadSha!, trackedDiffFingerprint: 'x', verifyConfigFingerprint: 'y', result: 'passed' } }
        : { authorizedAt: task.error!.at, phase } }));
    await assertProposalRefusedWithoutMutation(f);
  }
  const f = await fixture();
  const trackedDiffFingerprint = await computeTrackedDiffFingerprint(f.repository.git, f.worktree.path, (await f.store.load()).tasks.event!.preparedHeadSha!);
  await f.editTask('event', (task) => {
    const body = { failedAt: task.error!.at, source: 'runtime' as const, reason: 'verify_command_failed', worktreeHeadSha: task.preparedHeadSha!, trackedDiffFingerprint, evidenceHash: 'b'.repeat(64) };
    return { ...task, salvage: { authorizedAt: task.error!.at, phase: 'FAILED', failures: [{ id: replanHash({ runId: f.runId, taskId: task.id, ...body }), ...body }] } };
  });
  assert.ok((await f.propose()).id);
  noProviders(f);
});

test('legacy failed-salvage finalizer binds exact event evidence, is idempotent, and enables interpretation without executing work', async () => {
  const f = await fixture();
  await installLegacyFailedSalvage(f);
  const beforeHead = await f.repository.git.resolveCommit(f.worktree.path, 'HEAD');
  const failure = await AgentOrchestrator.finalizeFailedSalvage(f.runId, 'event', f.options);
  const afterFirst = await readFile(f.store.eventsPath, 'utf8');
  assert.equal((await f.store.load()).tasks.event!.salvage?.phase, 'FAILED');
  assert.equal((await f.store.load()).tasks.event!.salvage?.failures?.[0]?.id, failure.id);
  assert.deepEqual(await AgentOrchestrator.finalizeFailedSalvage(f.runId, 'event', f.options), failure);
  assert.equal(await readFile(f.store.eventsPath, 'utf8'), afterFirst);
  assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), beforeHead);
  assert.ok((await f.propose()).id);
  noProviders(f);
});

test('concurrent legacy finalization cannot append two terminal records', async () => {
  const f = await fixture(); await installLegacyFailedSalvage(f);
  const results = await Promise.allSettled([AgentOrchestrator.finalizeFailedSalvage(f.runId, 'event', f.options), AgentOrchestrator.finalizeFailedSalvage(f.runId, 'event', f.options)]);
  assert.ok(results.some((result) => result.status === 'fulfilled'));
  const state = await f.store.load();
  assert.equal(state.tasks.event!.salvage?.failures?.length, 1);
  assert.equal((await readFile(f.store.eventsPath, 'utf8')).split('\n').filter((line) => line.includes('SALVAGE_FAILED_FINALIZED')).length, 1);
  noProviders(f);
});

test('legacy failed-salvage finalizer refuses contradictory later success', async () => {
  const f = await fixture(); const at = new Date().toISOString();
  const stdoutPath = join(f.store.runDirectory, 'logs', 'legacy-stdout'); const stderrPath = join(f.store.runDirectory, 'logs', 'legacy-stderr');
  await mkdir(join(f.store.runDirectory, 'logs'), { recursive: true }); await writeFile(stdoutPath, 'failed\n'); await writeFile(stderrPath, 'diagnostic\n');
  await f.editTask('event', (task) => ({ ...task, salvage: { authorizedAt: at } }));
  await f.store.appendEvent({ name: 'SALVAGE_AUTHORIZED', timestamp: at, runId: f.runId, taskId: 'event' });
  await f.store.appendEvent({ name: 'SALVAGE_COMMAND_FINISHED', timestamp: at, runId: f.runId, taskId: 'event', data: { command: 'fixture', required: true, exitCode: 1, stdoutPath, stderrPath, hostVerification: true } });
  await f.store.appendEvent({ name: 'SALVAGE_VERIFICATION_FAILED', timestamp: at, runId: f.runId, taskId: 'event', data: { reason: 'verify_command_failed' } });
  await f.store.appendEvent({ name: 'SALVAGE_VERIFIED', timestamp: at, runId: f.runId, taskId: 'event' });
  await assert.rejects(AgentOrchestrator.finalizeFailedSalvage(f.runId, 'event', f.options), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  assert.equal((await f.store.load()).tasks.event!.salvage?.phase, undefined);
  noProviders(f);
});

test('legacy failed-salvage finalizer fails closed when exact command logs are absent', async () => {
  const f = await fixture(); const at = new Date().toISOString();
  await f.editTask('event', (task) => ({ ...task, salvage: { authorizedAt: at } }));
  await f.store.appendEvent({ name: 'SALVAGE_AUTHORIZED', timestamp: at, runId: f.runId, taskId: 'event' });
  await f.store.appendEvent({ name: 'SALVAGE_COMMAND_FINISHED', timestamp: at, runId: f.runId, taskId: 'event', data: { command: 'fixture', required: true, exitCode: 1, hostVerification: true } });
  await f.store.appendEvent({ name: 'SALVAGE_VERIFICATION_FAILED', timestamp: at, runId: f.runId, taskId: 'event', data: { reason: 'verify_command_failed' } });
  await assert.rejects(AgentOrchestrator.finalizeFailedSalvage(f.runId, 'event', f.options), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
  assert.equal((await f.store.load()).tasks.event!.salvage?.phase, undefined);
  noProviders(f);
});

test('Phase-7-shaped v2 flow preserves the raw handoff through failed-salvage finalization, interpretation, checkpoint, follow-up, composed verification, and final review', async () => {
  const f = await fixture(undefined, false, 'testing', true);
  await replaceRequest(f, (handoff) => {
    const implementation = handoff.additionalWorkRequests[0];
    implementation.resourceClaims = [
      { kind: 'repository_path', key: 'apps/api/src/chat/transport/**', mode: 'write' },
      { kind: 'repository_path', key: 'apps/api/src/chat/presence/**', mode: 'write' },
      { kind: 'repository_path', key: 'apps/api/src/events/**', mode: 'read' },
    ];
    implementation.evidence = [
      { kind: 'file', reference: 'apps/api/src/chat/transport/feature.txt:1', summary: 'Transport defect line' },
      { kind: 'file', reference: 'apps/api/src/chat/presence/feature.txt:1', summary: 'Presence evidence retained read-only' },
      { kind: 'test', reference: eventPath, summary: 'File-shaped source evidence' },
    ];
    handoff.additionalWorkRequests.push({ ...implementation, role: 'testing', objective: 'Unselected test work' });
  });
  const rawHandoff = await readFile(f.handoffPath);
  await installLegacyFailedSalvage(f);
  await AgentOrchestrator.finalizeFailedSalvage(f.runId, 'event', f.options);
  const interpretation = await f.interpret({ requestIndex: 0, resourceClaims: [
    { kind: 'repository_path', key: 'apps/api/src/chat/transport/**', mode: 'write' },
    { kind: 'repository_path', key: 'apps/api/src/chat/presence/**', mode: 'read' },
    { kind: 'repository_path', key: 'apps/api/src/events/**', mode: 'read' },
  ], evidenceTransformations: [
    { evidenceIndex: 0, normalizedReference: 'apps/api/src/chat/transport/feature.txt' },
    { evidenceIndex: 1, normalizedReference: 'apps/api/src/chat/presence/feature.txt' },
    { evidenceIndex: 2, normalizedKind: 'file' },
  ] });
  const proposal = await f.propose();
  assert.deepEqual(proposal.interpretationIds, [interpretation.id]);
  await f.authorize(proposal);
  const result = await (await AgentOrchestrator.resume(f.runId, f.options)).execute();
  assert.equal(result.status, 'COMPLETED');
  assert.equal(result.tasks.event!.status, 'SUCCEEDED');
  assert.equal(result.tasks[proposal.overlay.followup.id]!.status, 'SUCCEEDED');
  assert.deepEqual(await readFile(f.handoffPath), rawHandoff);
});

for (const mode of TASK_MODES.filter((candidate) => !isSupportedStaticReplanSourceMode(candidate))) {
  test(`static replan refuses ${mode} source mode`, async () => {
    const f = await fixture(undefined, false, mode, false, mode !== 'debate');
    try {
      await assertProposalRefusedWithoutMutation(f);
    } finally { await f.repository.dispose(); }
  });
}

test('static replan refuses a non-writer testing source', async () => {
  const f = await fixture(undefined, false, 'testing', false, false);
  try {
    await assertProposalRefusedWithoutMutation(f);
  } finally { await f.repository.dispose(); }
});

for (const scenario of [
  'wrong-error', 'provider-failed', 'provider-timed-out', 'provider-unfinished', 'missing-handoff',
  'invalid-handoff', 'handoff-not-blocked', 'canonical-commit', 'salvage-evidence', 'empty-partial-diff',
  'outside-ownership', 'overlapping-followup', 'stale-prepared-head', 'dependency-drift',
  'multiple-work-requests', 'malformed-request', 'wrong-request-role',
] as const) {
  test(`testing-writer source retains eligibility gate: ${scenario}`, async () => {
    const f = await fixture(undefined, false, 'testing', true);
    try {
      if (scenario === 'wrong-error') await f.editTask('event', (task) => ({ ...task, error: { ...task.error!, code: 'AGENT_FAILED' } }));
      if (scenario === 'provider-failed' || scenario === 'provider-timed-out') await f.editTask('event', (task) => ({ ...task,
        agentAttempts: [{ ...task.agentAttempts.at(-1)!, outcome: scenario === 'provider-failed' ? 'failed' : 'timed_out' }],
      }));
      if (scenario === 'provider-unfinished') await f.editTask('event', (task) => {
        const { finishedAt: _finishedAt, ...attempt } = task.agentAttempts.at(-1)!;
        return { ...task, agentAttempts: [attempt] };
      });
      if (scenario === 'missing-handoff') await f.editTask('event', (task) => {
        const { handoffPath: _path, handoffOutcome: _outcome, ...rest } = task;
        return rest;
      });
      if (scenario === 'invalid-handoff') await f.editTask('event', (task) => ({ ...task, handoffOutcome: 'invalid' }));
      if (scenario === 'handoff-not-blocked') await replaceRequest(f, (handoff) => { handoff.status = 'complete'; });
      if (scenario === 'canonical-commit') await f.editTask('event', (task) => ({ ...task,
        commit: { sha: task.preparedHeadSha!, parentSha: f.orchestrator.snapshot().baseSha, changedFiles: [eventPath] },
      }));
      if (scenario === 'salvage-evidence') await f.editTask('event', (task) => ({ ...task,
        salvage: { authorizedAt: task.agentAttempts.at(-1)!.finishedAt! },
      }));
      if (scenario === 'empty-partial-diff') await writeFile(join(f.worktree.path, eventPath), 'Event base\n');
      if (scenario === 'outside-ownership') {
        await writeFile(join(f.worktree.path, transportFixPath), 'Outside source ownership\n');
        await replaceRequest(f, (handoff) => { handoff.filesChanged.push(transportFixPath); });
      }
      if (scenario === 'overlapping-followup') await replaceRequest(f, (handoff) => {
        handoff.additionalWorkRequests[0].resourceClaims[0].key = 'apps/api/src/events/**';
      });
      if (scenario === 'stale-prepared-head') await f.editTask('event', (task) => ({ ...task, preparedHeadSha: f.orchestrator.snapshot().baseSha }));
      if (scenario === 'dependency-drift') await f.editTask('presence', (task) => ({ ...task, status: 'FAILED' }));
      if (scenario === 'multiple-work-requests') await replaceRequest(f, (handoff) => {
        handoff.additionalWorkRequests.push({ ...handoff.additionalWorkRequests[0] });
      });
      if (scenario === 'malformed-request') await replaceRequest(f, (handoff) => { handoff.additionalWorkRequests[0].objective = ''; });
      if (scenario === 'wrong-request-role') await replaceRequest(f, (handoff) => { handoff.additionalWorkRequests[0].role = 'review'; });
      await assertProposalRefusedWithoutMutation(f, scenario === 'outside-ownership'
        ? (error) => isOrchestratorError(error, 'OWNERSHIP_VIOLATION')
        : scenario === 'malformed-request' ? () => true : undefined);
    } finally { await f.repository.dispose(); }
  });
}

test('testing-writer proposal refuses while another replan is unresolved', async () => {
  const f = await fixture(undefined, false, 'testing', true);
  try {
    const proposal = await f.propose();
    await f.authorize(proposal);
    const before = await readFile(f.store.statePath, 'utf8');
    await assert.rejects(f.propose(), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
    assert.equal(await readFile(f.store.statePath, 'utf8'), before);
    noProviders(f);
  } finally { await f.repository.dispose(); }
});

test('testing-writer source checkpoints partial tests and resumes through its existing final review', async () => {
  const f = await fixture(undefined, false, 'testing', true);
  try {
    const original = await f.store.load();
    const frozen = await readFile(join(f.store.runDirectory, 'phase.yaml'));
    const proposal = await f.propose();
    assert.equal(proposal.overlay.followup.mode, 'implementation');
    assert.deepEqual(proposal.overlay.followup.files, ['apps/api/src/chat/transport/**']);
    assert.deepEqual(proposal.overlay.patches, [{ taskId: 'phase-final', dependsOn: ['event', proposal.overlay.followup.id], files: [] }]);
    assert.equal(proposal.overlay.patches.some((patch) => ['review', 'correction'].includes(patch.taskId)), false);
    noProviders(f);

    await f.authorize(proposal);
    const authorized = await f.store.load();
    const checkpoint = authorized.tasks.event!.replan!.checkpoint!;
    assert.equal(authorized.tasks.event!.status, 'BLOCKED');
    assert.equal(authorized.tasks.event!.commit, undefined);
    assert.deepEqual(checkpoint.changedFiles, [eventPath]);
    assert.equal(authorized.integration.status, 'PENDING');
    assert.equal(authorized.integration.worktreePath, undefined);

    const resumed = await AgentOrchestrator.resume(f.runId, f.options);
    const effectiveSource = resumed.config.tasks.find((task) => task.id === 'event')!;
    const followup = resumed.config.tasks.find((task) => task.id === proposal.overlay.followup.id)!;
    const finalReview = resumed.config.tasks.find((task) => task.id === 'phase-final')!;
    assert.equal(effectiveSource.mode, 'testing');
    assert.deepEqual(effectiveSource.files, ['apps/api/src/events/**']);
    assert.deepEqual(followup.dependsOn, ['presence']);
    assert.deepEqual(followup.checkpointInputs, [{ proposalId: proposal.id, sourceTaskId: 'event' }]);
    assert.deepEqual(finalReview.dependsOn, ['event', followup.id]);
    assert.equal(resumed.config.tasks.some((task) => ['review', 'correction'].includes(task.id)), false);
    assert.deepEqual(taskCodeInputs(resumed.config, resumed.snapshot(), followup).map((input) => input.taskId),
      ['durable', 'realtime', 'presence', 'event']);
    new TaskGraph(resumed.config.tasks);
    await assert.rejects((resumed as unknown as { integrateAndVerify(): Promise<void> }).integrateAndVerify(), /Unresolved source checkpoints/);

    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks.event!.replan!.phase, 'RESOLVED');
    assert.equal(completed.tasks.event!.commit!.sha, checkpoint.sha);
    assert.deepEqual(completed.tasks.event!.commit!.changedFiles, [eventPath]);
    assert.deepEqual(completed.tasks[followup.id]!.commit!.changedFiles, [transportFixPath]);
    assert.notEqual(completed.tasks[followup.id]!.commit!.sha, checkpoint.sha);
    assert.equal(completed.tasks['phase-final']!.status, 'SUCCEEDED');
    assert.deepEqual(completed.tasks.unrelated, original.tasks.unrelated);
    assert.deepEqual(await readFile(join(f.store.runDirectory, 'phase.yaml')), frozen);
  } finally { await f.repository.dispose(); }
});

test('failed composed verification preserves testing-source checkpoint and distinct follow-up for retry', async () => {
  const f = await fixture((container) => `node -e "process.exit(require('node:fs').existsSync('${join(container, 'gate-ready')}')?0:1)"`, false, 'testing', true);
  try {
    const proposal = await f.propose();
    await f.authorize(proposal);
    const checkpoint = (await f.store.load()).tasks.event!.replan!.checkpoint!;
    const failed = await (await AgentOrchestrator.resume(f.runId, f.options)).execute();
    const followup = failed.tasks[proposal.overlay.followup.id]!;
    assert.equal(failed.status, 'BLOCKED');
    assert.equal(failed.tasks.event!.status, 'BLOCKED');
    assert.equal(failed.tasks.event!.commit, undefined);
    assert.equal(failed.tasks.event!.replan!.checkpoint!.sha, checkpoint.sha);
    assert.deepEqual(failed.tasks.event!.replan!.checkpoint!.changedFiles, [eventPath]);
    assert.deepEqual(followup.commit!.changedFiles, [transportFixPath]);
    assert.notEqual(followup.commit!.sha, checkpoint.sha);
    assert.equal(failed.tasks['phase-final']!.status, 'BLOCKED');
    assert.equal(failed.integration.status, 'PENDING');
    assert.equal(failed.integration.worktreePath, undefined);
  } finally { await f.repository.dispose(); }
});

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

test('historical test-file evidence normalizes immutably and completes the real replan path', async () => {
  const f = await fixture();
  try {
    await installExactHistoricalEvidence(f);
    const originalHandoff = await readFile(f.handoffPath);
    const originalSource = await readFile(join(f.worktree.path, eventPath));
    const originalHead = await f.repository.git.resolveCommit(f.worktree.path, 'HEAD');
    const originalStatus = (await f.repository.git.run(f.worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout;
    const originalTree = await treeFingerprint(f.repository.git, f.worktree.path, originalHead, true);
    const originalWorktrees = await f.manager.listOwned();
    const originalState = await f.store.load();
    const beforeEvents = await readFile(f.store.eventsPath, 'utf8');
    await assert.rejects(f.propose(), (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
    const normalization = await f.normalize(1);
    assert.equal(normalization.originalKind, 'test');
    assert.equal(normalization.normalizedKind, 'file');
    assert.equal(normalization.reference, eventPath);
    assert.equal(normalization.requestIndex, 0);
    assert.equal(normalization.evidenceIndex, 1);
    assert.equal(normalization.reason, 'TEST_REFERENCE_IS_REPOSITORY_PATH');
    assert.deepEqual(await readFile(f.handoffPath), originalHandoff);
    assert.deepEqual(await readFile(join(f.worktree.path, eventPath)), originalSource);
    assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), originalHead);
    assert.equal((await f.repository.git.run(f.worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).stdout, originalStatus);
    assert.equal(await treeFingerprint(f.repository.git, f.worktree.path, originalHead, true), originalTree);
    assert.deepEqual(await f.manager.listOwned(), originalWorktrees);
    noProviders(f);
    const persisted = await f.store.load();
    assert.deepEqual(persisted.replanEvidenceNormalizations, [normalization]);
    const { updatedAt: _normalizedAt, replanEvidenceNormalizations: _normalizations, ...persistedRest } = persisted;
    const { updatedAt: _originalAt, ...originalRest } = originalState;
    assert.deepEqual(persistedRest, originalRest);
    const eventsAfterFirst = await readFile(f.store.eventsPath, 'utf8');
    const audit = eventsAfterFirst.trim().split('\n').map((line) => JSON.parse(line)).filter((event) => event.name === 'REPLAN_EVIDENCE_NORMALIZED');
    assert.equal(audit.length, 1);
    assert.equal(audit[0].taskId, 'event');
    assert.equal(audit[0].data.normalizationId, normalization.id);
    assert.equal(audit[0].data.reference, eventPath);
    assert.equal(audit[0].data.evidenceIndex, 1);
    assert.equal(audit[0].data.originalEvidenceHash, normalization.originalEvidenceHash);
    assert.notEqual(eventsAfterFirst, beforeEvents);
    assert.deepEqual(await f.normalize(1), normalization);
    assert.equal(await readFile(f.store.eventsPath, 'utf8'), eventsAfterFirst);
    assert.deepEqual((await f.store.load()).replanEvidenceNormalizations, [normalization]);

    const proposal = await f.propose();
    assert.deepEqual(proposal.evidenceNormalizationIds, [normalization.id]);
    assert.deepEqual(proposal.request.evidence, [
      { kind: 'file', reference: chatPath, summary: 'Existing Chat implementation lacks the Event policy' },
      { kind: 'file', reference: eventPath, summary: 'Repository test-file evidence mislabeled as a command' },
    ]);
    const { id: _id, evidenceNormalizationIds: _normalizationIds, ...unboundBody } = proposal;
    assert.notEqual(replanHash(unboundBody), proposal.id);
    noProviders(f);
    await f.authorize(proposal);
    noProviders(f);
    const completed = await (await AgentOrchestrator.resume(f.runId, f.options)).execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks.event!.replan!.proposalId, proposal.id);
    assert.deepEqual(await readFile(f.handoffPath), originalHandoff);
  } finally { await f.repository.dispose(); }
});

test('the historical handoff remains invalid for proposal without an authorized normalization', async () => {
  const f = await fixture();
  try {
    await installExactHistoricalEvidence(f);
    await assertProposalRefusedWithoutMutation(f);
  } finally { await f.repository.dispose(); }
});

for (const result of ['pass', 'fail', 'not_run'] as const) {
  test(`a matching ${result} handoff test command cannot be converted to file evidence`, async () => {
    const f = await fixture();
    try {
      await installHistoricalEvidence(f);
      await replaceRequest(f, (handoff) => { handoff.tests = [{ command: eventPath, result, details: 'Exact command identity' }]; });
      await assertNormalizationRefusedWithoutMutation(f);
    } finally { await f.repository.dispose(); }
  });
}

for (const scenario of ['file-to-test', 'test-to-diff', 'test-to-schema', 'outside-repository', 'outside-scope', 'missing-file', 'not-changed-file', 'symlink'] as const) {
  test(`evidence normalization refuses ${scenario}`, async () => {
    const f = await fixture();
    try {
      if (scenario === 'file-to-test') await installHistoricalEvidence(f, { kind: 'file', reference: eventPath });
      else if (scenario === 'outside-repository') await installHistoricalEvidence(f, { kind: 'test', reference: '../event.ts' });
      else if (scenario === 'outside-scope') await installHistoricalEvidence(f, { kind: 'test', reference: 'design.md' });
      else if (scenario === 'missing-file') {
        await installHistoricalEvidence(f, { kind: 'test', reference: 'apps/api/src/events/missing.ts' });
        await replaceRequest(f, (handoff) => { handoff.filesChanged = ['apps/api/src/events/missing.ts']; });
      } else if (scenario === 'not-changed-file') {
        await writeFile(join(f.worktree.path, 'apps/api/src/events/context.ts'), 'Context\n');
        await installHistoricalEvidence(f, { kind: 'test', reference: 'apps/api/src/events/context.ts' });
      } else if (scenario === 'symlink') {
        const link = 'apps/api/src/events/link.ts';
        await symlink(eventPath.split('/').at(-1)!, join(f.worktree.path, link));
        await installHistoricalEvidence(f, { kind: 'test', reference: link });
        await replaceRequest(f, (handoff) => { handoff.filesChanged.push(link); });
      } else await installHistoricalEvidence(f);
      await assertNormalizationRefusedWithoutMutation(f, () => f.normalize(0,
        scenario === 'file-to-test' ? 'test' : scenario === 'test-to-diff' ? 'diff' : scenario === 'test-to-schema' ? 'schema' : 'file'));
    } finally { await f.repository.dispose(); }
  });
}

for (const scenario of ['wrong-request-index', 'missing-evidence-index', 'negative-evidence-index', 'malformed-handoff'] as const) {
  test(`evidence normalization refuses ${scenario}`, async () => {
    const f = await fixture();
    try {
      await installHistoricalEvidence(f);
      if (scenario === 'malformed-handoff') await writeFile(f.handoffPath, '{');
      const call = scenario === 'wrong-request-index' ? () => f.normalize(0, 'file', 1)
        : scenario === 'missing-evidence-index' ? () => f.normalize(99)
          : scenario === 'negative-evidence-index' ? () => f.normalize(-1) : () => f.normalize();
      await assertNormalizationRefusedWithoutMutation(f, call);
    } finally { await f.repository.dispose(); }
  });
}

for (const scenario of ['handoff-bytes-changed', 'reference-changed', 'summary-changed', 'worktree-changed'] as const) {
  test(`proposal refuses when normalized ${scenario}`, async () => {
    const f = await fixture();
    try {
      await installHistoricalEvidence(f);
      await f.normalize();
      if (scenario === 'handoff-bytes-changed') await writeFile(f.handoffPath, `${await readFile(f.handoffPath, 'utf8')}\n`);
      else if (scenario === 'reference-changed') await replaceRequest(f, (handoff) => { handoff.additionalWorkRequests[0].evidence[0].reference = chatPath; });
      else if (scenario === 'summary-changed') await replaceRequest(f, (handoff) => { handoff.additionalWorkRequests[0].evidence[0].summary = 'Changed summary'; });
      else await writeFile(join(f.worktree.path, eventPath), 'Event changed after normalization\n');
      await assertProposalRefusedWithoutMutation(f);
    } finally { await f.repository.dispose(); }
  });
}

test('normalization refuses a source with an already persisted proposal', async () => {
  const f = await fixture();
  try {
    await f.propose();
    await installHistoricalEvidence(f);
    await assertNormalizationRefusedWithoutMutation(f);
  } finally { await f.repository.dispose(); }
});

for (const scenario of ['removed', 'changed'] as const) {
  test(`authorization refuses when proposal normalization state is ${scenario}`, async () => {
    const f = await fixture();
    try {
      await installHistoricalEvidence(f);
      await f.normalize();
      const proposal = await f.propose();
      const state = JSON.parse(await readFile(f.store.statePath, 'utf8'));
      if (scenario === 'removed') delete state.replanEvidenceNormalizations;
      else state.replanEvidenceNormalizations[0].reference = chatPath;
      await writeFile(f.store.statePath, `${JSON.stringify(state, null, 2)}\n`);
      await assert.rejects(f.authorize(proposal));
      assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), proposal.preparedHeadSha);
      noProviders(f);
    } finally { await f.repository.dispose(); }
  });
}

for (const scenario of ['source-ineligible', 'integration-started', 'run-not-quiescent'] as const) {
  test(`evidence normalization refuses when ${scenario}`, async () => {
    const f = await fixture();
    try {
      await installHistoricalEvidence(f);
      if (scenario === 'source-ineligible') await f.editTask('event', (task) => ({ ...task, handoffOutcome: 'invalid' }));
      if (scenario === 'integration-started') await f.edit((state) => ({ ...state, integration: { ...state.integration, status: 'RUNNING' } }));
      if (scenario === 'run-not-quiescent') await f.editTask('presence', (task) => ({ ...task, status: 'RUNNING' }));
      await assertNormalizationRefusedWithoutMutation(f);
    } finally { await f.repository.dispose(); }
  });
}

test('host CLI persists evidence normalization without executing the replan', async () => {
  const f = await fixture(undefined, true);
  try {
    await installExactHistoricalEvidence(f);
    const result = spawnSync(process.execPath, [resolve(__dirname, '../../src/cli.js'), 'normalize-replan-evidence', f.runId, 'event', '1', 'file'],
      { cwd: f.repository.repository, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.normalization.reference, eventPath);
    assert.match(output.manualNextStep, /agents:propose-replan/);
    const state = await f.store.load();
    assert.equal(state.replanEvidenceNormalizations!.length, 1);
    assert.equal(state.replanProposals, undefined);
    assert.equal(state.tasks.event!.replan, undefined);
    assert.equal(await f.repository.git.resolveCommit(f.worktree.path, 'HEAD'), state.tasks.event!.preparedHeadSha);
    noProviders(f);
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
    assert.equal('replanEvidenceNormalizations' in validateRunState(old), false);
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
      for (const call of [() => f.normalize(), () => f.authorize(proposal), () => AgentOrchestrator.resume(f.runId, f.options),
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
