import { createHash } from 'node:crypto';
import type { PhaseConfig, IntegrationCommand } from '../config';
import { OrchestratorError } from '../errors';
import { parseWorkRequestDraft } from '../adaptive/validation';
import type { WorkRequestDraft } from '../adaptive/types';
import type { TaskRunState, TaskCommitState, RunState, StoredError, IntegrationCommandState } from '../state/run-state';
import { TaskGraph, assertNoParallelOwnershipOverlap } from '../tasks';
import { parseTaskSpec, type TaskSpec } from '../tasks/task-schema';
import { normalizeRepositoryPath, ownershipGlobsOverlap } from '../tasks/ownership';

export function replanHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item) ? item.map(canonical)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => [k, canonical(v)]))
      : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function refuse(message: string): never { throw new OrchestratorError('TASK_STATE_INVALID', `Static replan: ${message}`); }

export interface ReplanOverlay {
  readonly followup: TaskSpec;
  readonly patches: readonly { readonly taskId: string; readonly dependsOn: readonly string[]; readonly files: readonly string[] }[];
}
export interface ReplanProposal {
  readonly id: string;
  readonly version: 1;
  readonly runId: string;
  readonly sourceTaskId: string;
  readonly handoffPath: string;
  readonly handoffSha256: string;
  readonly preparedHeadSha: string;
  readonly trackedDiffFingerprint: string;
  readonly treeFingerprint: string;
  readonly sourceStateHash: string;
  readonly contextHash: string;
  readonly sourceError: StoredError;
  /** Present only when the in-memory request used a persisted semantic normalization. */
  readonly evidenceNormalizationIds?: readonly string[];
  /** Present only when v2 applied one persisted, human-authorized interpretation. */
  readonly interpretationIds?: readonly string[];
  readonly request: WorkRequestDraft;
  readonly overlay: ReplanOverlay;
  readonly verify: readonly IntegrationCommand[];
  readonly prepare: readonly IntegrationCommand[];
}
export interface ReplanEvidenceTransformation {
  readonly evidenceIndex: number;
  readonly originalEvidenceHash: string;
  readonly originalKind: string;
  readonly normalizedKind: string;
  readonly originalReference: string;
  readonly normalizedReference: string;
}
export interface ReplanInterpretation {
  readonly id: string;
  readonly version: 2;
  readonly runId: string;
  readonly sourceTaskId: string;
  readonly handoffSha256: string;
  readonly preparedHeadSha: string;
  readonly trackedDiffFingerprint: string;
  readonly treeFingerprint: string;
  readonly requestIndex: number;
  readonly originalRequestHash: string;
  readonly resourceClaims: readonly { readonly kind: 'repository_path'; readonly key: string; readonly mode: 'read' | 'write' }[];
  readonly evidenceTransformations: readonly ReplanEvidenceTransformation[];
  readonly authorizedBy: 'human';
  readonly authorizedAt: string;
}
export type ReplanInterpretationIdentity = Omit<ReplanInterpretation, 'id' | 'authorizedBy' | 'authorizedAt'>;
export function replanInterpretationId(identity: ReplanInterpretationIdentity): string { return replanHash(identity); }
export interface ReplanEvidenceNormalization {
  readonly id: string;
  readonly version: 1;
  readonly sourceTaskId: string;
  readonly handoffSha256: string;
  readonly requestIndex: number;
  readonly evidenceIndex: number;
  readonly originalEvidenceHash: string;
  readonly originalKind: 'test';
  readonly normalizedKind: 'file';
  readonly reference: string;
  readonly reason: 'TEST_REFERENCE_IS_REPOSITORY_PATH';
  readonly preparedHeadSha: string;
  readonly trackedDiffFingerprint: string;
  readonly treeFingerprint: string;
  readonly authorizedBy: 'human';
  readonly authorizedAt: string;
}
export type ReplanEvidenceNormalizationIdentity = Omit<ReplanEvidenceNormalization, 'id' | 'authorizedBy' | 'authorizedAt'>;

export function replanEvidenceNormalizationId(identity: ReplanEvidenceNormalizationIdentity): string {
  return replanHash(identity);
}
export interface ReplanAuthorization {
  readonly proposalId: string;
  readonly authorizedBy: 'human';
  readonly authorizedAt: string;
  readonly overlayHash: string;
}
export interface TaskReplanState {
  readonly proposalId: string;
  readonly phase: 'CHECKPOINT_PREPARING' | 'CHECKPOINT_READY' | 'FOLLOWUP_RUNNING' | 'COMPOSED_VERIFIED' | 'RESOLVED';
  readonly checkpoint?: TaskCommitState;
  readonly verificationAttempts: readonly {
    readonly at: string;
    readonly headSha: string;
    readonly fingerprint: string;
    readonly passed: boolean;
    readonly commands: readonly IntegrationCommandState[];
  }[];
}

/** Execution evidence is checked at authorization, never retroactively on load. */
export function assertPristine(task: TaskRunState | undefined): void {
  if (task === undefined || !['PENDING', 'BLOCKED'].includes(task.status)
    || (task.status === 'BLOCKED' && task.error?.code !== 'TASK_DEPENDENCY_FAILED')
    || (task.status === 'PENDING' && task.error !== undefined && task.error.code !== 'TASK_DEPENDENCY_FAILED')
    || task.agentAttempts.length !== 0 || task.reviewRounds !== 0 || task.reviewPaths.length !== 0
    || task.handoffRepairAttempts.length !== 0 || (task.agentFailureRecoveries?.length ?? 0) !== 0
    || ['worktreePath', 'branch', 'preparedHeadSha', 'commit', 'handoffPath', 'handoffOutcome', 'startedAt', 'skipReason', 'preparation', 'salvage', 'replan'].some((key) => (task as unknown as Record<string, unknown>)[key] !== undefined)) {
    refuse(`downstream task ${task?.id ?? '(missing)'} is not pristine and dependency-blocked/pending`);
  }
}

/** A newly authorized broad scope must follow completed overlapping sibling writers. */
export function followupDependencies(config: PhaseConfig, state: RunState, source: TaskSpec, files: readonly string[]): string[] {
  const graph = new TaskGraph(config.tasks);
  const dependencies = new Set(source.dependsOn);
  for (const candidate of graph.topologicalOrder()) {
    if (!candidate.writer || candidate.id === source.id || graph.hasDependencyPath(source.id, candidate.id)
      || graph.hasDependencyPath(candidate.id, source.id)
      || !candidate.files.some((owned) => files.some((file) => ownershipGlobsOverlap(owned, file)))) continue;
    const prior = state.tasks[candidate.id];
    if (prior?.status !== 'SUCCEEDED' && prior?.status !== 'SKIPPED') refuse(`overlapping writer ${candidate.id} is not already successful/skipped`);
    if (prior.status === 'SKIPPED' && (candidate.condition === undefined || prior.skipReason === undefined)) refuse(`overlapping writer ${candidate.id} has no conditional skip evidence`);
    dependencies.add(candidate.id);
  }
  return [...dependencies];
}

/** Bounded rewiring: direct source reviews and their future correction tasks only. */
export function buildOverlay(config: PhaseConfig, source: TaskSpec, followup: TaskSpec): ReplanOverlay {
  new TaskGraph(config.tasks);
  const reviews = config.tasks.filter((task) => ['review', 'final_review'].includes(task.mode) && !task.writer && task.dependsOn.includes(source.id));
  if (reviews.length === 0) refuse('source has no existing downstream review');
  const patches = config.tasks.flatMap<ReplanOverlay['patches'][number]>((task) => {
    if (reviews.some((review) => review.id === task.id)) return [{ taskId: task.id, dependsOn: [...new Set([...task.dependsOn, followup.id])], files: task.files }];
    if (task.mode === 'correction' && task.writer && reviews.some((review) => task.dependsOn.includes(review.id))) {
      return [{ taskId: task.id, dependsOn: task.dependsOn, files: [...new Set([...task.files, ...source.files, ...followup.files])] }];
    }
    return [];
  });
  return { followup, patches };
}

export function applyReplanOverlays(config: PhaseConfig, state: Pick<RunState, 'replanProposals' | 'replanAuthorizations'>): PhaseConfig {
  let effective = config;
  for (const grant of state.replanAuthorizations ?? []) {
    const proposal = state.replanProposals?.find((entry) => entry.id === grant.proposalId);
    if (proposal === undefined || replanHash(proposal.overlay) !== grant.overlayHash) refuse('authorization overlay digest mismatch');
    const source = effective.tasks.find((task) => task.id === proposal.sourceTaskId);
    if (source === undefined || effective.tasks.some((task) => task.id === proposal.overlay.followup.id)) refuse('overlay source missing or follow-up already exists in base config');
    if (replanHash(buildOverlay(effective, source, proposal.overlay.followup)) !== grant.overlayHash) refuse('overlay differs from bounded downstream rewiring');
    const patches = new Map(proposal.overlay.patches.map((patch) => [patch.taskId, patch]));
    effective = { ...effective, tasks: [
      ...effective.tasks.map((task) => { const patch = patches.get(task.id); return patch === undefined ? task : { ...task, dependsOn: patch.dependsOn, files: patch.files }; }),
      { ...proposal.overlay.followup, checkpointInputs: [{ proposalId: proposal.id, sourceTaskId: source.id }] },
    ] };
  }
  new TaskGraph(effective.tasks);
  assertNoParallelOwnershipOverlap(effective.tasks);
  return effective;
}

function object(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some((key) => !keys.includes(key))) refuse('invalid persisted replan fields');
  return value as Record<string, unknown>;
}
function text(value: unknown): string { if (typeof value !== 'string' || !value.trim()) refuse('missing replan string'); return value; }
function digest(value: unknown): string { const result = text(value); if (!/^[a-f0-9]{64}$/.test(result)) refuse('invalid replan digest'); return result; }
function sha(value: unknown): string { const result = text(value); if (!/^[a-f0-9]{40}$/.test(result)) refuse('invalid replan commit'); return result; }
function array(value: unknown): unknown[] { if (!Array.isArray(value)) refuse('invalid replan array'); return value; }
function strings(value: unknown): string[] { return array(value).map(text); }

export function parseReplanProposals(value: unknown): ReplanProposal[] {
  return array(value).map((raw) => {
    const p = object(raw, ['id', 'version', 'runId', 'sourceTaskId', 'handoffPath', 'handoffSha256', 'preparedHeadSha', 'trackedDiffFingerprint', 'treeFingerprint', 'sourceStateHash', 'contextHash', 'sourceError', 'evidenceNormalizationIds', 'interpretationIds', 'request', 'overlay', 'verify', 'prepare']);
    if (p.version !== 1) refuse('unsupported proposal version');
    for (const key of ['runId', 'sourceTaskId', 'handoffPath']) text(p[key]);
    for (const key of ['id', 'handoffSha256', 'trackedDiffFingerprint', 'treeFingerprint', 'sourceStateHash', 'contextHash']) digest(p[key]);
    sha(p.preparedHeadSha);
    const overlay = object(p.overlay, ['followup', 'patches']);
    const followup = parseTaskSpec(overlay.followup, 0);
    const patches = array(overlay.patches).map((rawPatch) => {
      const patch = object(rawPatch, ['taskId', 'dependsOn', 'files']);
      return { taskId: text(patch.taskId), dependsOn: strings(patch.dependsOn), files: strings(patch.files) };
    });
    const sourceError = object(p.sourceError, ['code', 'message', 'at', 'details']);
    if (sourceError.code !== 'REVIEW_BLOCKED') refuse('invalid source error');
    text(sourceError.message); text(sourceError.at);
    for (const commands of [array(p.verify), array(p.prepare)]) for (const rawCommand of commands) {
      const command = object(rawCommand, ['command', 'required', 'timeoutMs']);
      text(command.command);
      if (typeof command.required !== 'boolean' || (command.timeoutMs !== undefined && (!Number.isSafeInteger(command.timeoutMs) || Number(command.timeoutMs) < 1000))) refuse('invalid verification command');
    }
    if (!(p.verify as IntegrationCommand[]).some((command) => command.required)) refuse('proposal has no required verification');
    const evidenceNormalizationIds = p.evidenceNormalizationIds === undefined ? undefined : strings(p.evidenceNormalizationIds).map(digest);
    if (evidenceNormalizationIds !== undefined && new Set(evidenceNormalizationIds).size !== evidenceNormalizationIds.length) refuse('proposal has duplicate evidence normalizations');
    const interpretationIds = p.interpretationIds === undefined ? undefined : strings(p.interpretationIds).map(digest);
    if (interpretationIds !== undefined && (interpretationIds.length !== 1 || new Set(interpretationIds).size !== interpretationIds.length)) refuse('proposal must bind exactly one interpretation');
    const proposal = { ...p, ...(evidenceNormalizationIds === undefined ? {} : { evidenceNormalizationIds }), ...(interpretationIds === undefined ? {} : { interpretationIds }), request: parseWorkRequestDraft(p.request), overlay: { followup, patches } } as unknown as ReplanProposal;
    const { id, ...body } = proposal;
    if (replanHash(body) !== id) refuse('proposal digest mismatch');
    return proposal;
  });
}

export function parseReplanInterpretations(value: unknown): ReplanInterpretation[] {
  const entries = array(value).map((raw) => {
    const entry = object(raw, ['id', 'version', 'runId', 'sourceTaskId', 'handoffSha256', 'preparedHeadSha', 'trackedDiffFingerprint', 'treeFingerprint', 'requestIndex', 'originalRequestHash', 'resourceClaims', 'evidenceTransformations', 'authorizedBy', 'authorizedAt']);
    if (entry.version !== 2 || entry.authorizedBy !== 'human' || !Number.isSafeInteger(entry.requestIndex) || Number(entry.requestIndex) < 0) refuse('invalid v2 interpretation');
    const resourceClaims = array(entry.resourceClaims).map((rawClaim) => {
      const claim = object(rawClaim, ['kind', 'key', 'mode']);
      if (claim.kind !== 'repository_path' || !['read', 'write'].includes(String(claim.mode))) refuse('interpretation contains an invalid resource claim');
      const key = text(claim.key); normalizeRepositoryPath(key);
      return { kind: 'repository_path' as const, key, mode: claim.mode as 'read' | 'write' };
    });
    const evidenceTransformations = array(entry.evidenceTransformations).map((rawTransform) => {
      const transform = object(rawTransform, ['evidenceIndex', 'originalEvidenceHash', 'originalKind', 'normalizedKind', 'originalReference', 'normalizedReference']);
      if (!Number.isSafeInteger(transform.evidenceIndex) || Number(transform.evidenceIndex) < 0) refuse('invalid interpretation evidence index');
      const originalKind = text(transform.originalKind); const normalizedKind = text(transform.normalizedKind);
      const originalReference = text(transform.originalReference); const normalizedReference = text(transform.normalizedReference);
      if (normalizedKind !== originalKind && !(originalKind === 'test' && normalizedKind === 'file')) refuse('interpretation contains an unsupported kind transformation');
      const lineMatch = /^([^:]+):([1-9][0-9]*)$/.exec(originalReference);
      if (normalizedReference !== originalReference && (lineMatch === null || lineMatch[1] !== normalizedReference)) refuse('interpretation contains an unsupported reference transformation');
      if (normalizedReference !== originalReference || normalizedKind === 'file') normalizeRepositoryPath(normalizedReference);
      if (normalizedReference === originalReference && normalizedKind === originalKind) refuse('interpretation contains a no-op evidence transformation');
      return { evidenceIndex: Number(transform.evidenceIndex), originalEvidenceHash: digest(transform.originalEvidenceHash), originalKind, normalizedKind, originalReference, normalizedReference };
    });
    if (new Set(evidenceTransformations.map((item) => item.evidenceIndex)).size !== evidenceTransformations.length) refuse('interpretation targets evidence more than once');
    const identity: ReplanInterpretationIdentity = { version: 2, runId: text(entry.runId), sourceTaskId: text(entry.sourceTaskId), handoffSha256: digest(entry.handoffSha256), preparedHeadSha: sha(entry.preparedHeadSha), trackedDiffFingerprint: digest(entry.trackedDiffFingerprint), treeFingerprint: digest(entry.treeFingerprint), requestIndex: Number(entry.requestIndex), originalRequestHash: digest(entry.originalRequestHash), resourceClaims, evidenceTransformations };
    const id = digest(entry.id);
    if (id !== replanInterpretationId(identity)) refuse('interpretation digest mismatch');
    const authorizedAt = text(entry.authorizedAt);
    if (!Number.isFinite(Date.parse(authorizedAt))) refuse('invalid interpretation authorization');
    return { id, ...identity, authorizedBy: 'human' as const, authorizedAt };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) refuse('duplicate interpretation');
  return entries;
}

export function parseReplanEvidenceNormalizations(value: unknown): ReplanEvidenceNormalization[] {
  const normalizations = array(value).map((raw) => {
    const entry = object(raw, ['id', 'version', 'sourceTaskId', 'handoffSha256', 'requestIndex', 'evidenceIndex', 'originalEvidenceHash', 'originalKind', 'normalizedKind', 'reference', 'reason', 'preparedHeadSha', 'trackedDiffFingerprint', 'treeFingerprint', 'authorizedBy', 'authorizedAt']);
    if (entry.version !== 1 || entry.originalKind !== 'test' || entry.normalizedKind !== 'file'
      || entry.reason !== 'TEST_REFERENCE_IS_REPOSITORY_PATH' || entry.authorizedBy !== 'human') refuse('unsupported evidence normalization');
    if (!Number.isSafeInteger(entry.requestIndex) || Number(entry.requestIndex) < 0
      || !Number.isSafeInteger(entry.evidenceIndex) || Number(entry.evidenceIndex) < 0) refuse('invalid evidence normalization index');
    const identity: ReplanEvidenceNormalizationIdentity = {
      version: 1,
      sourceTaskId: text(entry.sourceTaskId),
      handoffSha256: digest(entry.handoffSha256),
      requestIndex: Number(entry.requestIndex),
      evidenceIndex: Number(entry.evidenceIndex),
      originalEvidenceHash: digest(entry.originalEvidenceHash),
      originalKind: 'test',
      normalizedKind: 'file',
      reference: text(entry.reference),
      reason: 'TEST_REFERENCE_IS_REPOSITORY_PATH',
      preparedHeadSha: sha(entry.preparedHeadSha),
      trackedDiffFingerprint: digest(entry.trackedDiffFingerprint),
      treeFingerprint: digest(entry.treeFingerprint),
    };
    const id = digest(entry.id);
    if (replanEvidenceNormalizationId(identity) !== id) refuse('evidence normalization digest mismatch');
    const authorizedAt = text(entry.authorizedAt);
    if (!Number.isFinite(Date.parse(authorizedAt))) refuse('invalid evidence normalization authorization');
    return { id, ...identity, authorizedBy: 'human' as const, authorizedAt };
  });
  if (new Set(normalizations.map((entry) => entry.id)).size !== normalizations.length) refuse('duplicate evidence normalization');
  return normalizations;
}

export function parseReplanAuthorizations(value: unknown): ReplanAuthorization[] {
  const grants = array(value).map((raw) => {
    const grant = object(raw, ['proposalId', 'authorizedBy', 'authorizedAt', 'overlayHash']);
    if (grant.authorizedBy !== 'human' || !Number.isFinite(Date.parse(text(grant.authorizedAt)))) refuse('explicit human authorization required');
    return { proposalId: digest(grant.proposalId), authorizedBy: 'human' as const, authorizedAt: text(grant.authorizedAt), overlayHash: digest(grant.overlayHash) };
  });
  if (new Set(grants.map((grant) => grant.proposalId)).size !== grants.length) refuse('duplicate authorization');
  return grants;
}

export function parseTaskReplan(value: unknown): TaskReplanState {
  const entry = object(value, ['proposalId', 'phase', 'checkpoint', 'verificationAttempts']);
  digest(entry.proposalId);
  if (!['CHECKPOINT_PREPARING', 'CHECKPOINT_READY', 'FOLLOWUP_RUNNING', 'COMPOSED_VERIFIED', 'RESOLVED'].includes(text(entry.phase))) refuse('invalid checkpoint lifecycle');
  if (entry.checkpoint !== undefined) {
    const checkpoint = object(entry.checkpoint, ['sha', 'parentSha', 'changedFiles']);
    sha(checkpoint.sha); sha(checkpoint.parentSha); strings(checkpoint.changedFiles).forEach(normalizeRepositoryPath);
  } else if (entry.phase !== 'CHECKPOINT_PREPARING') refuse('checkpoint missing after preparation');
  for (const raw of array(entry.verificationAttempts)) {
    const attempt = object(raw, ['at', 'headSha', 'fingerprint', 'passed', 'commands']);
    text(attempt.at); sha(attempt.headSha); digest(attempt.fingerprint);
    if (typeof attempt.passed !== 'boolean') refuse('invalid verification result');
    for (const rawCommand of array(attempt.commands)) {
      const command = object(rawCommand, ['command', 'required', 'timeoutMs', 'termination', 'timedOut', 'exitCode', 'signal', 'durationMs', 'stdoutPath', 'stderrPath']);
      text(command.command); text(command.stdoutPath); text(command.stderrPath);
      if (typeof command.required !== 'boolean' || typeof command.timedOut !== 'boolean'
        || !Number.isSafeInteger(command.timeoutMs) || Number(command.timeoutMs) <= 0
        || typeof command.durationMs !== 'number' || !Number.isFinite(command.durationMs) || command.durationMs < 0
        || (command.exitCode !== null && !Number.isInteger(command.exitCode))
        || ![null, 'timeout', 'aborted'].includes(command.termination as null)
        || (command.signal !== null && typeof command.signal !== 'string')) refuse('invalid composed command result');
    }
  }
  if (['COMPOSED_VERIFIED', 'RESOLVED'].includes(String(entry.phase)) && !(entry.verificationAttempts as { passed: boolean }[]).at(-1)?.passed) refuse('resolution lacks passing verification');
  return entry as unknown as TaskReplanState;
}

/** Cross-link persisted authority, lifecycle and canonical results; hashes alone are insufficient. */
export function assertReplanState(state: Pick<RunState, 'runId' | 'strategy' | 'tasks' | 'replanEvidenceNormalizations' | 'replanInterpretations' | 'replanProposals' | 'replanAuthorizations'>): void {
  const normalizations = state.replanEvidenceNormalizations ?? [];
  const interpretations = state.replanInterpretations ?? [];
  const proposals = state.replanProposals ?? [];
  const grants = state.replanAuthorizations ?? [];
  if (state.strategy === 'adaptive' && (normalizations.length > 0 || interpretations.length > 0 || proposals.length > 0 || grants.length > 0)) refuse('adaptive state cannot contain static replans');
  for (const normalization of normalizations) if (state.tasks[normalization.sourceTaskId] === undefined) refuse('evidence normalization source task is missing');
  for (const interpretation of interpretations) if (interpretation.runId !== state.runId || state.tasks[interpretation.sourceTaskId] === undefined) refuse('interpretation source binding is invalid');
  for (const task of Object.values(state.tasks)) for (const failure of task.salvage?.failures ?? []) {
    const { id, ...body } = failure;
    if (id !== replanHash({ runId: state.runId, taskId: task.id, ...body })) refuse('salvage failure digest mismatch');
  }
  if (new Set(proposals.map((entry) => entry.id)).size !== proposals.length) refuse('duplicate proposal');
  for (const proposal of proposals) {
    const bound = [...(proposal.evidenceNormalizationIds ?? [])].sort();
    const expected = normalizations.filter((entry) => entry.sourceTaskId === proposal.sourceTaskId && entry.handoffSha256 === proposal.handoffSha256)
      .map((entry) => entry.id).sort();
    if (replanHash(bound) !== replanHash(expected)) refuse('proposal does not bind its exact evidence normalizations');
    const boundInterpretations = [...(proposal.interpretationIds ?? [])].sort();
    const expectedInterpretations = interpretations.filter((entry) => entry.sourceTaskId === proposal.sourceTaskId && entry.handoffSha256 === proposal.handoffSha256).map((entry) => entry.id).sort();
    if (replanHash(boundInterpretations) !== replanHash(expectedInterpretations)) refuse('proposal does not bind its exact interpretation');
  }
  const sources = new Set<string>();
  for (const grant of grants) {
    const proposal = proposals.find((entry) => entry.id === grant.proposalId);
    if (proposal === undefined || proposal.runId !== state.runId || replanHash(proposal.overlay) !== grant.overlayHash) refuse('grant does not match its proposal');
    if (sources.has(proposal.sourceTaskId)) refuse('source already has a replan');
    sources.add(proposal.sourceTaskId);
    const source = state.tasks[proposal.sourceTaskId];
    const followup = state.tasks[proposal.overlay.followup.id];
    if (source?.replan?.proposalId !== proposal.id || followup === undefined) refuse('grant lacks source lifecycle or follow-up');
    const lifecycle = source.replan;
    if (lifecycle.checkpoint !== undefined && lifecycle.checkpoint.parentSha !== proposal.preparedHeadSha) refuse('checkpoint parent differs from intent');
    if (['COMPOSED_VERIFIED', 'RESOLVED'].includes(lifecycle.phase)) {
      const last = lifecycle.verificationAttempts.at(-1)!;
      const expected = [...proposal.prepare, ...proposal.verify];
      if (followup.status !== 'SUCCEEDED' || followup.commit?.sha !== last.headSha || last.commands.length !== expected.length
        || last.commands.some((command, index) => command.command !== expected[index]!.command || command.required !== expected[index]!.required
          || (command.required && (command.exitCode !== 0 || command.signal !== null || command.termination !== null || command.timedOut)))) refuse('composed verification does not prove all authorized required commands passed');
    }
    if (lifecycle.phase === 'RESOLVED') {
      if (source.status !== 'SUCCEEDED' || source.commit === undefined || replanHash(source.commit) !== replanHash(lifecycle.checkpoint)
        || followup.status !== 'SUCCEEDED' || followup.commit === undefined) refuse('resolution differs from composed canonical results');
    } else if (source.status !== 'BLOCKED' || source.commit !== undefined || source.handoffPath !== proposal.handoffPath) refuse('unresolved checkpoint cannot be canonical');
    if (lifecycle.phase === 'CHECKPOINT_PREPARING' && (followup.status !== 'PENDING' || followup.agentAttempts.length > 0 || followup.worktreePath !== undefined)) refuse('follow-up ran before checkpoint readiness');
  }
  for (const task of Object.values(state.tasks)) {
    if (task.replan !== undefined && !grants.some((entry) => entry.proposalId === task.replan!.proposalId
      && proposals.some((proposal) => proposal.id === entry.proposalId && proposal.sourceTaskId === task.id))) refuse('task has an unauthorized checkpoint lifecycle');
  }
}
