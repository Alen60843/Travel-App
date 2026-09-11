import { lstat, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import type { PhaseConfig } from '../config';
import { computeTrackedDiffFingerprint, inspectTaskCommits, type GitClient, type WorktreeManager, type IntegrationCommit } from '../git';
import { writeHandoff } from '../handoff';
import { IntegrationGate } from '../integration/integration-gate';
import type { RunState, StateStore, TaskRunState, RunEventName } from '../state';
import { TaskGraph, assertChangedFileOwnership, matchesOwnershipPattern, type TaskSpec } from '../tasks';
import { ownershipGlobsOverlap, normalizeRepositoryPath } from '../tasks/ownership';
import { parseTaskSpec } from '../tasks/task-schema';
import type { WorkRequestDraft } from '../adaptive/types';
import { applyReplanOverlays, assertPristine, buildOverlay, followupDependencies, replanEvidenceNormalizationId, replanHash, refuse,
  type ReplanEvidenceNormalization, type ReplanEvidenceNormalizationIdentity, type ReplanProposal, type TaskReplanState } from './model';
import { assertCodeInputHistory, changedCandidatePaths, inspectCheckpoint, readReplanHandoff, treeFingerprint } from './checkpoint';

export function taskCodeInputs(config: PhaseConfig, state: RunState, task: TaskSpec): IntegrationCommit[] {
  const graph = new TaskGraph(config.tasks);
  const result: IntegrationCommit[] = [];
  const seen = new Set<string>();
  const add = (taskId: string, commitSha: string) => { if (!seen.has(commitSha)) { result.push({ taskId, commitSha }); seen.add(commitSha); } };
  const ancestors = graph.topologicalOrder().filter((candidate) => graph.hasDependencyPath(task.id, candidate.id));
  for (const candidate of [...ancestors, task]) {
    for (const input of candidate.checkpointInputs ?? []) {
      const source = state.tasks[input.sourceTaskId];
      const grant = state.replanAuthorizations?.find((entry) => entry.proposalId === input.proposalId);
      if (grant === undefined || source?.replan?.proposalId !== input.proposalId || source.replan.checkpoint === undefined) refuse('checkpoint input is not ready and authorized');
      add(input.sourceTaskId, source.replan.checkpoint.sha);
    }
    if (candidate.id !== task.id && state.tasks[candidate.id]?.commit !== undefined) add(candidate.id, state.tasks[candidate.id]!.commit!.sha);
  }
  return result;
}

interface ReplannerContext {
  readonly config: PhaseConfig;
  readonly state: () => RunState;
  readonly store: StateStore;
  readonly git: GitClient;
  readonly worktrees: WorktreeManager;
  readonly clock: () => Date;
  readonly signal?: AbortSignal;
  readonly save: (state: RunState) => Promise<void>;
  readonly event: (name: RunEventName, taskId: string, detail: Record<string, unknown>) => Promise<void>;
}

export class StaticReplanner {
  constructor(private readonly ctx: ReplannerContext) {}

  private async quiescent(): Promise<void> {
    const state = this.ctx.state();
    if (state.strategy !== undefined || state.adaptive !== undefined) refuse('only static runs are supported');
    if (state.integration.status !== 'PENDING' || Object.keys(state.integration).some((key) => !['status', 'integratedTaskCommits'].includes(key))
      || state.integration.integratedTaskCommits.length !== 0 || (state.integrationAttempts?.length ?? 0) !== 0) refuse('integration already started');
    for (const task of Object.values(state.tasks)) {
      if (['RUNNING', 'READY'].includes(task.status)) refuse('run must be quiescent with no running or ready tasks');
      const spec = this.ctx.config.tasks.find((entry) => entry.id === task.id);
      if (task.status === 'PENDING' && (spec === undefined || spec.dependsOn.every((id) => ['SUCCEEDED', 'SKIPPED'].includes(state.tasks[id]?.status ?? '')))) refuse('pending task is runnable');
      for (const attempt of task.agentAttempts) {
        if (attempt.finishedAt === undefined) refuse('unfinished agent attempt');
        if (attempt.pid !== undefined) {
          let dead = false;
          try { process.kill(attempt.pid, 0); } catch (error) { dead = (error as NodeJS.ErrnoException).code === 'ESRCH'; }
          if (!dead) refuse('recorded agent process is still alive');
        }
      }
    }
    if ((await this.ctx.worktrees.listOwned()).some((entry) => entry.runId === state.runId && entry.kind === 'integration')) refuse('integration worktree already exists');
  }

  private async source(taskId: string) {
    const state = this.ctx.state();
    const task = state.tasks[taskId];
    const spec = this.ctx.config.tasks.find((entry) => entry.id === taskId);
    const attempt = task?.agentAttempts.at(-1);
    if (task === undefined || spec === undefined || task.status !== 'BLOCKED' || !spec.writer || spec.mode !== 'implementation'
      || task.error?.code !== 'REVIEW_BLOCKED' || attempt?.outcome !== 'succeeded' || attempt.finishedAt === undefined
      || task.handoffOutcome !== 'valid' || task.commit !== undefined || task.salvage !== undefined
      || task.worktreePath === undefined || task.branch === undefined || task.preparedHeadSha === undefined) refuse('source must be a blocked implementation writer with an accepted blocked handoff and no canonical commit');
    const worktree = await this.ctx.worktrees.assertRegistered(task.worktreePath);
    const registered = (await this.ctx.worktrees.listGitWorktrees()).find((entry) => entry.path === worktree.path);
    if (worktree.runId !== state.runId || worktree.taskId !== task.id || worktree.kind !== 'task' || worktree.branch !== task.branch
      || worktree.baseSha !== state.baseSha || registered?.branch !== `refs/heads/${task.branch}`) refuse('source worktree registration mismatch');
    const graph = new TaskGraph(this.ctx.config.tasks);
    for (const ancestor of graph.tasks.filter((entry) => graph.hasDependencyPath(task.id, entry.id))) {
      const prior = state.tasks[ancestor.id];
      if (prior?.status !== 'SUCCEEDED' && prior?.status !== 'SKIPPED') refuse('source dependencies are not satisfied');
      if (prior.status === 'SKIPPED' && (ancestor.condition === undefined || prior.skipReason === undefined)) refuse('source has an illegitimate skipped dependency');
    }
    // Bind the prepared code to exact canonical successful ancestors, not just a commit message.
    const expected = taskCodeInputs(this.ctx.config, state, spec);
    await assertCodeInputHistory(this.ctx.git, worktree.path, state.baseSha, task.preparedHeadSha, expected);
    const artifact = await readReplanHandoff(this.ctx.store, task);
    if (artifact.handoff.status !== 'blocked') refuse('source handoff is not blocked');
    return { task, spec, worktree, artifact };
  }

  private normalizedRequest(taskId: string, artifact: Awaited<ReturnType<typeof readReplanHandoff>>, normalizations: readonly ReplanEvidenceNormalization[]): {
    readonly request: WorkRequestDraft;
    readonly normalizationIds: readonly string[];
  } {
    const requests = artifact.handoff.additionalWorkRequests;
    if (requests?.length !== 1) refuse('exactly one persisted additionalWorkRequest is required');
    const sourceNormalizations = normalizations.filter((entry) => entry.sourceTaskId === taskId);
    if (sourceNormalizations.some((entry) => entry.handoffSha256 !== artifact.sha256)) refuse('source has a stale evidence normalization for another handoff digest');
    const applicable = sourceNormalizations.filter((entry) => entry.handoffSha256 === artifact.sha256);
    const evidence = [...(requests[0]!.evidence ?? [])];
    const coordinates = new Set<string>();
    for (const normalization of applicable) {
      const coordinate = `${normalization.requestIndex}:${normalization.evidenceIndex}`;
      if (coordinates.has(coordinate)) refuse('multiple evidence normalizations target the same entry');
      coordinates.add(coordinate);
      const original = requests[normalization.requestIndex]?.evidence?.[normalization.evidenceIndex];
      if (original === undefined || normalization.originalKind !== 'test' || normalization.normalizedKind !== 'file'
        || normalization.requestIndex !== 0 || original.kind !== normalization.originalKind
        || original.reference !== normalization.reference || replanHash(original) !== normalization.originalEvidenceHash
        || !artifact.handoff.filesChanged.includes(original.reference)
        || artifact.handoff.tests.some((entry) => entry.command === original.reference)) refuse('evidence normalization no longer matches its exact original entry');
      evidence[normalization.evidenceIndex] = { ...original, kind: 'file' };
    }
    return {
      request: applicable.length === 0 ? requests[0]! : { ...requests[0]!, evidence },
      normalizationIds: applicable.map((entry) => entry.id).sort(),
    };
  }

  /** The host invocation is the explicit human authorization for one immutable test -> file interpretation. */
  async normalizeEvidence(taskId: string, requestIndex: number, evidenceIndex: number, normalizedKind: string): Promise<ReplanEvidenceNormalization> {
    const state = this.ctx.state();
    if (state.status !== 'BLOCKED') refuse('evidence normalization requires a blocked run');
    await this.quiescent();
    if (Object.values(state.tasks).some((task) => task.replan !== undefined && task.replan.phase !== 'RESOLVED')) refuse('another unresolved replan exists');
    const { task, spec, worktree, artifact } = await this.source(taskId);
    if (task.replan !== undefined) refuse('source already has a replan');
    if (!Number.isSafeInteger(requestIndex) || requestIndex !== 0 || !Number.isSafeInteger(evidenceIndex) || evidenceIndex < 0) refuse('normalization requires exact request and evidence indexes');
    if (normalizedKind !== 'file') refuse('v1 supports only test to file evidence normalization');
    const requests = artifact.handoff.additionalWorkRequests;
    if (requests?.length !== 1) refuse('exactly one persisted additionalWorkRequest is required');
    const original = requests[requestIndex]?.evidence?.[evidenceIndex];
    if (original === undefined) refuse('requested evidence entry is missing');
    if (original.kind !== 'test') refuse('v1 normalization source kind must be test');
    if (artifact.handoff.tests.some((entry) => entry.command === original.reference)) refuse('matching handoff test command proves this is test evidence');
    const path = normalizeRepositoryPath(original.reference);
    if (path !== original.reference) refuse('normalization cannot change the evidence reference');
    if (!artifact.handoff.filesChanged.includes(path)) refuse('normalized file evidence must be present in source changed-file evidence');
    if (state.replanProposals?.some((proposal) => proposal.sourceTaskId === taskId)) refuse('source already has a proposal with another evidence interpretation');
    if (await this.ctx.git.resolveCommit(worktree.path, 'HEAD') !== task.preparedHeadSha) refuse('foreign commit in source worktree');
    const changed = await changedCandidatePaths(this.ctx.git, worktree.path, task.preparedHeadSha);
    if (changed.length === 0) refuse('source has no partial work');
    assertChangedFileOwnership(taskId, changed, spec.files);
    if (replanHash(changed) !== replanHash([...artifact.handoff.filesChanged].sort())) refuse('handoff changed files differ from candidate diff');
    await this.ctx.git.run(worktree.path, ['diff', '--check', task.preparedHeadSha]);
    const identity: ReplanEvidenceNormalizationIdentity = {
      version: 1,
      sourceTaskId: taskId,
      handoffSha256: artifact.sha256,
      requestIndex,
      evidenceIndex,
      originalEvidenceHash: replanHash(original),
      originalKind: 'test',
      normalizedKind: 'file',
      reference: original.reference,
      reason: 'TEST_REFERENCE_IS_REPOSITORY_PATH',
      preparedHeadSha: task.preparedHeadSha,
      trackedDiffFingerprint: await computeTrackedDiffFingerprint(this.ctx.git, worktree.path, task.preparedHeadSha),
      treeFingerprint: await treeFingerprint(this.ctx.git, worktree.path, task.preparedHeadSha, true),
    };
    const record: ReplanEvidenceNormalization = { id: replanEvidenceNormalizationId(identity), ...identity,
      authorizedBy: 'human', authorizedAt: this.ctx.clock().toISOString() };
    const existing = state.replanEvidenceNormalizations?.find((entry) => entry.id === record.id);
    const candidateNormalizations = existing === undefined ? [...(state.replanEvidenceNormalizations ?? []), record] : state.replanEvidenceNormalizations!;
    const proposal = await this.propose(taskId, false, candidateNormalizations);
    const current = await this.source(taskId);
    const currentHead = await this.ctx.git.resolveCommit(current.worktree.path, 'HEAD');
    const currentTrackedDiff = await computeTrackedDiffFingerprint(this.ctx.git, current.worktree.path, task.preparedHeadSha);
    const currentTree = await treeFingerprint(this.ctx.git, current.worktree.path, task.preparedHeadSha, true);
    if (current.artifact.sha256 !== record.handoffSha256 || proposal.preparedHeadSha !== record.preparedHeadSha
      || currentHead !== record.preparedHeadSha || currentTrackedDiff !== record.trackedDiffFingerprint
      || currentTree !== record.treeFingerprint || proposal.trackedDiffFingerprint !== record.trackedDiffFingerprint
      || proposal.treeFingerprint !== record.treeFingerprint) refuse('source changed during evidence normalization inspection');
    if (existing !== undefined) return existing;
    await this.ctx.save({ ...state, replanEvidenceNormalizations: candidateNormalizations });
    await this.ctx.event('REPLAN_EVIDENCE_NORMALIZED', taskId, { normalizationId: record.id, handoffSha256: record.handoffSha256,
      requestIndex, evidenceIndex, originalEvidenceHash: record.originalEvidenceHash, originalKind: 'test', normalizedKind: 'file',
      reference: record.reference, reason: record.reason, preparedHeadSha: record.preparedHeadSha,
      trackedDiffFingerprint: record.trackedDiffFingerprint, treeFingerprint: record.treeFingerprint, authorizedBy: 'human' });
    return record;
  }

  async propose(taskId: string, persist = true, normalizations: readonly ReplanEvidenceNormalization[] = this.ctx.state().replanEvidenceNormalizations ?? []): Promise<ReplanProposal> {
    const state = this.ctx.state();
    if (state.status !== 'BLOCKED') refuse('proposal requires a blocked run');
    await this.quiescent();
    if (Object.values(state.tasks).some((task) => task.replan !== undefined && task.replan.phase !== 'RESOLVED')) refuse('another unresolved replan exists');
    const { task, spec, worktree, artifact } = await this.source(taskId);
    if (task.replan !== undefined) refuse('v1 supports one replan per source');
    const { request, normalizationIds } = this.normalizedRequest(taskId, artifact, normalizations);
    if (request.role !== 'implementation' || request.resourceClaims?.length === 0 || request.resourceClaims === undefined
      || request.resourceClaims.some((claim) => claim.kind !== 'repository_path') || (request.evidence?.length ?? 0) === 0) refuse('request requires implementation, repository claims, and evidence');
    const files = [...new Set(request.resourceClaims.filter((claim) => claim.mode === 'write').map((claim) => claim.key))].sort();
    if (files.length === 0 || files.some((file) => spec.files.some((owned) => ownershipGlobsOverlap(file, owned)))) refuse('follow-up write scope must be nonempty and disjoint from source ownership');
    const graph = new TaskGraph(this.ctx.config.tasks);
    for (const dependency of request.dependencies ?? []) if (!graph.hasDependencyPath(taskId, dependency)) refuse('request dependencies must already be successful source ancestors');
    for (const evidence of request.evidence ?? []) {
      if (evidence.kind === 'test') {
        if (!artifact.handoff.tests.some((entry) => entry.command === evidence.reference && entry.result === 'pass')) {
          refuse('test evidence must reference an exactly matching passing handoff test');
        }
        continue;
      }
      if (!['file', 'diff', 'schema'].includes(evidence.kind)) refuse('v1 requires file or persisted test evidence');
      const path = normalizeRepositoryPath(evidence.reference);
      if (![...spec.files, ...request.resourceClaims.map((claim) => claim.key)].some((pattern) => matchesOwnershipPattern(path, pattern))) refuse('evidence is outside declared scope');
      const absolute = join(worktree.path, path);
      if (!(await lstat(absolute)).isFile() || !(await realpath(absolute)).startsWith(`${await realpath(worktree.path)}${sep}`)) refuse('evidence must resolve to an in-worktree regular file');
    }
    if (await this.ctx.git.resolveCommit(worktree.path, 'HEAD') !== task.preparedHeadSha) refuse('foreign commit in source worktree');
    const changed = await changedCandidatePaths(this.ctx.git, worktree.path, task.preparedHeadSha!);
    if (changed.length === 0) refuse('source has no partial work');
    assertChangedFileOwnership(taskId, changed, spec.files);
    if (replanHash(changed) !== replanHash([...artifact.handoff.filesChanged].sort())) refuse('handoff changed files differ from candidate diff');
    await this.ctx.git.run(worktree.path, ['diff', '--check', task.preparedHeadSha!]);
    const followup = parseTaskSpec({ id: `replan-${replanHash({ taskId, request }).slice(0, 20)}`, title: request.objective,
      owner: spec.owner, effort: spec.effort, ...(spec.model === undefined ? {} : { model: spec.model }),
      mode: request.role, writer: true, files, dependsOn: followupDependencies(this.ctx.config, state, spec, files), timeoutMs: spec.timeoutMs ?? this.ctx.config.agentTimeoutMs,
      instructions: `${request.objective}\n${request.reason}\nAuthorized read scope: ${request.resourceClaims.filter((claim) => claim.mode === 'read').map((claim) => claim.key).join(', ')}\nComplete only the authorized follow-up ownership. The source checkpoint is a partial code input, not a successful result.`,
    }, 0);
    const overlay = buildOverlay(this.ctx.config, spec, followup);
    for (const patch of overlay.patches) assertPristine(state.tasks[patch.taskId]);
    const trackedDiffFingerprint = await computeTrackedDiffFingerprint(this.ctx.git, worktree.path, task.preparedHeadSha!);
    const currentTreeFingerprint = await treeFingerprint(this.ctx.git, worktree.path, task.preparedHeadSha!, true);
    for (const normalization of normalizations.filter((entry) => normalizationIds.includes(entry.id))) {
      if (normalization.preparedHeadSha !== task.preparedHeadSha || normalization.trackedDiffFingerprint !== trackedDiffFingerprint
        || normalization.treeFingerprint !== currentTreeFingerprint) refuse('source worktree changed after evidence normalization');
    }
    const body = {
      version: 1 as const, runId: state.runId, sourceTaskId: taskId, handoffPath: artifact.path, handoffSha256: artifact.sha256,
      preparedHeadSha: task.preparedHeadSha!, trackedDiffFingerprint, treeFingerprint: currentTreeFingerprint,
      sourceStateHash: replanHash(task), contextHash: replanHash({ config: this.ctx.config, tasks: state.tasks, integration: state.integration, baseSha: state.baseSha }),
      sourceError: task.error!, ...(normalizationIds.length === 0 ? {} : { evidenceNormalizationIds: normalizationIds }),
      request, overlay, verify: this.ctx.config.salvage.verify, prepare: this.ctx.config.agentWorktree.prepare,
    };
    if (!body.verify.some((command) => command.required)) refuse('required salvage.verify commands must be configured before proposing');
    const proposal: ReplanProposal = { id: replanHash(body), ...body };
    applyReplanOverlays(this.ctx.config, { replanProposals: [proposal], replanAuthorizations: [{ proposalId: proposal.id, authorizedBy: 'human', authorizedAt: this.ctx.clock().toISOString(), overlayHash: replanHash(overlay) }] });
    if (persist && !state.replanProposals?.some((entry) => entry.id === proposal.id)) {
      await this.ctx.save({ ...state, replanProposals: [...(state.replanProposals ?? []), proposal] });
      await this.ctx.event('REPLAN_PROPOSED', taskId, { proposalId: proposal.id, risk: request.risk ?? 'medium', overlay });
    }
    return proposal;
  }

  async authorize(proposalId: string): Promise<ReplanProposal> {
    let state = this.ctx.state();
    const proposal = state.replanProposals?.find((entry) => entry.id === proposalId);
    if (proposal === undefined) refuse('unknown proposal');
    if (!state.replanAuthorizations?.some((entry) => entry.proposalId === proposalId)) {
      const current = await this.propose(proposal.sourceTaskId, false);
      if (current.id !== proposal.id) refuse('proposal evidence, diff, configuration or run state materially changed');
      const followup = proposal.overlay.followup;
      const grant = { proposalId, authorizedBy: 'human' as const, authorizedAt: this.ctx.clock().toISOString(), overlayHash: replanHash(proposal.overlay) };
      // One durable write installs human authority, immutable checkpoint intent,
      // and the waiting task. No Git mutation occurs before this boundary.
      await this.ctx.save({ ...state,
        replanAuthorizations: [...(state.replanAuthorizations ?? []), grant],
        tasks: { ...state.tasks,
          [proposal.sourceTaskId]: { ...state.tasks[proposal.sourceTaskId]!, replan: { proposalId, phase: 'CHECKPOINT_PREPARING', verificationAttempts: [] } },
          [followup.id]: { id: followup.id, status: 'PENDING', agentAttempts: [], reviewRounds: 0, reviewPaths: [], handoffRepairAttempts: [] },
        },
      });
      await this.ctx.event('REPLAN_AUTHORIZED', proposal.sourceTaskId, { proposalId, authorizedBy: 'human', overlayHash: grant.overlayHash });
      await this.ctx.event('REPLAN_CHECKPOINT_PREPARING', proposal.sourceTaskId, { proposalId, preparedHeadSha: proposal.preparedHeadSha, trackedDiffFingerprint: proposal.trackedDiffFingerprint, handoffSha256: proposal.handoffSha256 });
    }
    state = this.ctx.state();
    if (state.tasks[proposal.sourceTaskId]!.replan?.phase === 'CHECKPOINT_PREPARING') await this.prepareCheckpoint(proposal);
    else if (state.tasks[proposal.sourceTaskId]!.replan?.phase !== 'RESOLVED') {
      const { task, spec, worktree, artifact } = await this.source(proposal.sourceTaskId);
      if (artifact.sha256 !== proposal.handoffSha256) refuse('authorized source artifact changed');
      const checkpoint = await inspectCheckpoint(this.ctx.git, worktree.path, proposal, spec.files);
      if (checkpoint.headSha !== task.replan!.checkpoint!.sha) refuse('authorized checkpoint HEAD changed');
    }
    return proposal;
  }

  private async prepareCheckpoint(proposal: ReplanProposal): Promise<void> {
    const { task, spec, worktree, artifact } = await this.source(proposal.sourceTaskId);
    const { replan: _replan, ...original } = task;
    if (replanHash(original) !== proposal.sourceStateHash || artifact.sha256 !== proposal.handoffSha256) refuse('checkpoint source changed since intent');
    for (const patch of proposal.overlay.patches) assertPristine(this.ctx.state().tasks[patch.taskId]);
    const head = await this.ctx.git.resolveCommit(worktree.path, 'HEAD');
    if (head === proposal.preparedHeadSha) {
      if (await treeFingerprint(this.ctx.git, worktree.path, head, true) !== proposal.treeFingerprint) refuse('checkpoint tree changed since intent');
      const changed = await changedCandidatePaths(this.ctx.git, worktree.path, head);
      assertChangedFileOwnership(task.id, changed, spec.files);
      await this.ctx.git.run(worktree.path, ['add', '-A', '--', ...changed]);
      if (await treeFingerprint(this.ctx.git, worktree.path, head, true) !== proposal.treeFingerprint) refuse('checkpoint changed while staging');
      await this.ctx.git.run(worktree.path, ['commit', '-m', `agent(${spec.owner}): ${task.id} Authorized partial scope-gap checkpoint\n\nReplan-Checkpoint: ${proposal.id}`]);
    }
    const checked = await inspectCheckpoint(this.ctx.git, worktree.path, proposal, spec.files);
    const checkpoint = { sha: checked.headSha, parentSha: proposal.preparedHeadSha, changedFiles: checked.changedFiles };
    const state = this.ctx.state();
    await this.ctx.save({ ...state, status: 'RUNNING', tasks: { ...state.tasks,
      [task.id]: { ...state.tasks[task.id]!, replan: { ...task.replan!, phase: 'CHECKPOINT_READY', checkpoint } },
      [proposal.overlay.followup.id]: { ...state.tasks[proposal.overlay.followup.id]!, status: 'READY' },
    } });
    await this.ctx.event('REPLAN_CHECKPOINT_READY', task.id, { proposalId: proposal.id, checkpoint });
  }

  /** Called under the shared mutation lock before each ordinary static scheduler pass. */
  async advance(): Promise<boolean> {
    for (const grant of this.ctx.state().replanAuthorizations ?? []) {
      const proposal = this.ctx.state().replanProposals!.find((entry) => entry.id === grant.proposalId)!;
      let source = this.ctx.state().tasks[proposal.sourceTaskId]!;
      if (source.replan?.phase === 'RESOLVED') continue;
      if (source.replan?.phase === 'CHECKPOINT_PREPARING') await this.prepareCheckpoint(proposal);
      source = this.ctx.state().tasks[proposal.sourceTaskId]!;
      const followup = this.ctx.state().tasks[proposal.overlay.followup.id]!;
      if (followup.status !== 'SUCCEEDED') continue;
      if (followup.commit === undefined || followup.worktreePath === undefined) refuse('successful follow-up lacks commit or worktree');
      const spec = this.ctx.config.tasks.find((task) => task.id === source.id)!;
      const sourceArtifact = await readReplanHandoff(this.ctx.store, source);
      if (sourceArtifact.sha256 !== proposal.handoffSha256) refuse('blocked handoff changed after authorization');
      const checkpoint = await inspectCheckpoint(this.ctx.git, source.worktreePath!, proposal, spec.files);
      if (checkpoint.headSha !== source.replan!.checkpoint!.sha) refuse('checkpoint HEAD identity changed');
      const inspection = await inspectTaskCommits(this.ctx.git, followup.worktreePath, followup.preparedHeadSha!);
      if (!inspection.clean || inspection.commits.length !== 1 || inspection.headSha !== followup.commit.sha) refuse('follow-up changed after success');
      assertChangedFileOwnership(followup.id, inspection.changedFiles, proposal.overlay.followup.files);
      const followupSpec = this.ctx.config.tasks.find((task) => task.id === followup.id)!;
      await assertCodeInputHistory(this.ctx.git, followup.worktreePath, this.ctx.state().baseSha, followup.preparedHeadSha!, taskCodeInputs(this.ctx.config, this.ctx.state(), followupSpec));
      const before = await computeTrackedDiffFingerprint(this.ctx.git, followup.worktreePath, this.ctx.state().baseSha);
      if (source.replan!.phase !== 'COMPOSED_VERIFIED') {
        const logs = join(this.ctx.store.runDirectory, 'logs', 'replan', proposal.id, String(source.replan!.verificationAttempts.length + 1));
        const preparation = await new IntegrationGate().run({ cwd: followup.worktreePath, logsDirectory: join(logs, 'prepare'), commands: proposal.prepare, ...(this.ctx.signal === undefined ? {} : { signal: this.ctx.signal }) });
        const verification = preparation.passed
          ? await new IntegrationGate().run({ cwd: followup.worktreePath, logsDirectory: join(logs, 'verify'), commands: proposal.verify, ...(this.ctx.signal === undefined ? {} : { signal: this.ctx.signal }) })
          : preparation;
        const afterHead = await this.ctx.git.resolveCommit(followup.worktreePath, 'HEAD');
        const after = await computeTrackedDiffFingerprint(this.ctx.git, followup.worktreePath, this.ctx.state().baseSha);
        const passed = preparation.passed && verification.passed && afterHead === inspection.headSha && before === after;
        const attempt = { at: this.ctx.clock().toISOString(), headSha: inspection.headSha, fingerprint: before, passed, commands: preparation === verification ? preparation.commands : [...preparation.commands, ...verification.commands] };
        const state = this.ctx.state();
        await this.ctx.save({ ...state, status: passed ? 'RUNNING' : 'BLOCKED', tasks: { ...state.tasks,
          [source.id]: { ...source, replan: { ...source.replan!, phase: passed ? 'COMPOSED_VERIFIED' : 'FOLLOWUP_RUNNING', verificationAttempts: [...source.replan!.verificationAttempts, attempt] } },
        } });
        await this.ctx.event('REPLAN_COMPOSED_VERIFIED', source.id, { proposalId: proposal.id, ...attempt });
        if (!passed) return false;
      } else {
        const verified = source.replan!.verificationAttempts.at(-1)!;
        if (verified.headSha !== inspection.headSha || verified.fingerprint !== before) refuse('composed result changed after verification');
      }
      // Keep both tasks' commits distinct. The original blocked artifact/error
      // remain pinned by the proposal; completion gets a separate handoff.
      await inspectCheckpoint(this.ctx.git, source.worktreePath!, proposal, spec.files);
      const recoveredPath = await writeHandoff(join(this.ctx.store.runDirectory, 'replans', proposal.id), source.id, {
        ...sourceArtifact.handoff, status: 'complete', summary: `Composed verification passed for ${proposal.id}`,
        tests: this.ctx.state().tasks[source.id]!.replan!.verificationAttempts.at(-1)!.commands.slice(proposal.prepare.length).map((command) => ({
          command: command.command, result: command.exitCode === 0 && command.termination === null && command.signal === null ? 'pass' as const : 'fail' as const,
          details: `Host composed verification; logs: ${command.stdoutPath}, ${command.stderrPath}`,
        })), openQuestions: [],
      });
      const state = this.ctx.state();
      const { error: _error, ...resolved } = state.tasks[source.id]!;
      const tasks: Record<string, TaskRunState> = { ...state.tasks, [source.id]: {
        ...resolved, status: 'SUCCEEDED', commit: source.replan!.checkpoint!, handoffPath: recoveredPath,
        replan: { ...state.tasks[source.id]!.replan!, phase: 'RESOLVED' },
      } };
      const graph = new TaskGraph(this.ctx.config.tasks);
      const reopened = new Set([source.id]);
      for (const candidate of graph.topologicalOrder()) {
        if (!graph.hasDependencyPath(candidate.id, source.id) || !candidate.dependsOn.every((id) => reopened.has(id) || ['SUCCEEDED', 'SKIPPED'].includes(tasks[id]!.status))) continue;
        const task = tasks[candidate.id]!;
        if (task.status === 'PENDING') { assertPristine(task); reopened.add(candidate.id); continue; }
        if (task.status !== 'BLOCKED' || task.error?.code !== 'TASK_DEPENDENCY_FAILED') continue;
        assertPristine(task);
        const { error: _dependencyError, finishedAt: _finished, ...pristine } = task;
        tasks[candidate.id] = { ...pristine, status: 'PENDING' };
        reopened.add(candidate.id);
      }
      await this.ctx.save({ ...state, status: 'RUNNING', tasks });
      await this.ctx.event('REPLAN_RESOLVED', source.id, { proposalId: proposal.id, sourceCommit: source.replan!.checkpoint!.sha, followupCommit: followup.commit.sha });
    }
    return true;
  }
}
