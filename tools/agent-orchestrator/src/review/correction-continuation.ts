import { createHash } from 'node:crypto';

import type { IntegrationCommand, PhaseConfig } from '../config';
import { OrchestratorError } from '../errors';
import { parseWorkRequestDraft } from '../adaptive/validation';
import type { WorkRequestDraft } from '../adaptive/types';
import type { RunState } from '../state/run-state';
import { assertNoParallelOwnershipOverlap, normalizeRepositoryPath } from '../tasks';
import { parseTaskSpec, type TaskSpec } from '../tasks/task-schema';

export interface ReviewCorrectionAuthorization {
  readonly id: string;
  readonly version: 1;
  readonly runId: string;
  readonly reviewTaskId: string;
  readonly reviewArtifactPath: string;
  readonly reviewArtifactSha256: string;
  readonly findingIds: readonly string[];
  readonly correctionRequestIndex: number;
  readonly correctionRequestHash: string;
  readonly reviewedHeadSha: string;
  readonly reviewedCodeInputs: readonly { readonly taskId: string; readonly commitSha: string }[];
  readonly reviewedCodeInputsHash: string;
  readonly sourceAttempt: number;
  readonly sourceRound: number;
  readonly correctionTask: TaskSpec;
  readonly authorizedBy: 'human';
  readonly authorizedAt: string;
}

export interface ReviewCorrectionContinuation {
  readonly authorization: ReviewCorrectionAuthorization;
  readonly phase: 'AUTHORIZED' | 'CORRECTION_RUNNING' | 'CORRECTION_SUCCEEDED' | 'REVIEW_REOPENED';
  readonly correctionCommitSha?: string;
  readonly reviewReopenedAt?: string;
}

export function canonicalHash(value: unknown): string {
  const canonical = (item: unknown): unknown => Array.isArray(item)
    ? item.map(canonical)
    : item !== null && typeof item === 'object'
      ? Object.fromEntries(Object.entries(item).filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]))
      : item;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function authorizationId(value: Omit<ReviewCorrectionAuthorization, 'id' | 'authorizedBy' | 'authorizedAt'>): string {
  return canonicalHash(value);
}

function refuse(message: string): never {
  throw new OrchestratorError('TASK_STATE_INVALID', `Review correction: ${message}`);
}

function object(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) refuse(`${path} has invalid fields`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) refuse(`${path} must be non-empty text`);
  return value;
}

function digest(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[a-f0-9]{64}$/.test(result)) refuse(`${path} must be a sha256 digest`);
  return result;
}

function sha(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[a-f0-9]{40,64}$/.test(result)) refuse(`${path} must be a full commit SHA`);
  return result;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) refuse(`${path} must be an integer >= ${minimum}`);
  return Number(value);
}

function parseCommand(value: unknown, path: string): IntegrationCommand {
  const entry = object(value, ['command', 'required', 'timeoutMs'], path);
  if (entry.required !== true) refuse(`${path}.required must be true`);
  const timeoutMs = entry.timeoutMs === undefined ? undefined : integer(entry.timeoutMs, `${path}.timeoutMs`, 1_000);
  return { command: text(entry.command, `${path}.command`), required: true, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

export function parseReviewCorrectionContinuations(value: unknown): ReviewCorrectionContinuation[] {
  if (!Array.isArray(value)) refuse('reviewCorrections must be an array');
  const entries = value.map((raw, index): ReviewCorrectionContinuation => {
    const item = object(raw, ['authorization', 'phase', 'correctionCommitSha', 'reviewReopenedAt'], `reviewCorrections[${index}]`);
    const auth = object(item.authorization, [
      'id', 'version', 'runId', 'reviewTaskId', 'reviewArtifactPath', 'reviewArtifactSha256', 'findingIds',
      'correctionRequestIndex', 'correctionRequestHash', 'reviewedHeadSha', 'reviewedCodeInputs',
      'reviewedCodeInputsHash', 'sourceAttempt', 'sourceRound', 'correctionTask', 'authorizedBy', 'authorizedAt',
    ], `reviewCorrections[${index}].authorization`);
    if (auth.version !== 1 || auth.authorizedBy !== 'human') refuse('authorization version/provenance is invalid');
    if (!Array.isArray(auth.findingIds) || auth.findingIds.length === 0) refuse('authorization must bind findings');
    const findingIds = auth.findingIds.map((id, findingIndex) => text(id, `findingIds[${findingIndex}]`));
    if (new Set(findingIds).size !== findingIds.length) refuse('authorization has duplicate finding IDs');
    if (!Array.isArray(auth.reviewedCodeInputs)) refuse('reviewedCodeInputs must be an array');
    const reviewedCodeInputs = auth.reviewedCodeInputs.map((rawInput, inputIndex) => {
      const input = object(rawInput, ['taskId', 'commitSha'], `reviewedCodeInputs[${inputIndex}]`);
      return { taskId: text(input.taskId, 'taskId'), commitSha: sha(input.commitSha, 'commitSha') };
    });
    const rawTask = object(auth.correctionTask, [
      'id', 'title', 'owner', 'effort', 'model', 'mode', 'files', 'dependsOn', 'writer', 'timeoutMs',
      'instructions', 'condition', 'verification',
    ], 'correctionTask');
    if (!Array.isArray(rawTask.verification) || rawTask.verification.length === 0) refuse('correction task verification is required');
    const verification = rawTask.verification.map((command, commandIndex) => parseCommand(command, `verification[${commandIndex}]`));
    const { verification: _verification, ...phaseShape } = rawTask;
    const correctionTask = { ...parseTaskSpec(phaseShape, 0), verification };
    const identity = {
      version: 1 as const,
      runId: text(auth.runId, 'runId'), reviewTaskId: text(auth.reviewTaskId, 'reviewTaskId'),
      reviewArtifactPath: text(auth.reviewArtifactPath, 'reviewArtifactPath'),
      reviewArtifactSha256: digest(auth.reviewArtifactSha256, 'reviewArtifactSha256'),
      findingIds, correctionRequestIndex: integer(auth.correctionRequestIndex, 'correctionRequestIndex'),
      correctionRequestHash: digest(auth.correctionRequestHash, 'correctionRequestHash'),
      reviewedHeadSha: sha(auth.reviewedHeadSha, 'reviewedHeadSha'), reviewedCodeInputs,
      reviewedCodeInputsHash: digest(auth.reviewedCodeInputsHash, 'reviewedCodeInputsHash'),
      sourceAttempt: integer(auth.sourceAttempt, 'sourceAttempt', 1), sourceRound: integer(auth.sourceRound, 'sourceRound', 1),
      correctionTask,
    };
    if (identity.reviewedCodeInputsHash !== canonicalHash(reviewedCodeInputs)) refuse('reviewed code-input digest mismatch');
    const id = digest(auth.id, 'authorization.id');
    if (id !== authorizationId(identity)) refuse('authorization identity digest mismatch');
    if (!Number.isFinite(Date.parse(text(auth.authorizedAt, 'authorizedAt')))) refuse('authorization timestamp is invalid');
    const phase = text(item.phase, 'phase');
    if (!['AUTHORIZED', 'CORRECTION_RUNNING', 'CORRECTION_SUCCEEDED', 'REVIEW_REOPENED'].includes(phase)) refuse('continuation phase is invalid');
    const correctionCommitSha = item.correctionCommitSha === undefined ? undefined : sha(item.correctionCommitSha, 'correctionCommitSha');
    if (['CORRECTION_SUCCEEDED', 'REVIEW_REOPENED'].includes(phase) !== (correctionCommitSha !== undefined)) refuse('continuation commit checkpoint conflicts with phase');
    const reviewReopenedAt = item.reviewReopenedAt === undefined ? undefined : text(item.reviewReopenedAt, 'reviewReopenedAt');
    if ((phase === 'REVIEW_REOPENED') !== (reviewReopenedAt !== undefined)) refuse('review reopen checkpoint conflicts with phase');
    return { authorization: { id, ...identity, authorizedBy: 'human', authorizedAt: auth.authorizedAt as string }, phase: phase as ReviewCorrectionContinuation['phase'],
      ...(correctionCommitSha === undefined ? {} : { correctionCommitSha }), ...(reviewReopenedAt === undefined ? {} : { reviewReopenedAt }) };
  });
  if (new Set(entries.map((entry) => entry.authorization.id)).size !== entries.length) refuse('duplicate review correction authorization');
  const reviewIds = entries.map((entry) => entry.authorization.reviewTaskId);
  if (new Set(reviewIds).size !== reviewIds.length) refuse('more than one correction continuation exists for a review task');
  return entries;
}

export function validateCorrectionRequest(requestValue: unknown, findingIds: readonly string[]): WorkRequestDraft {
  const request = parseWorkRequestDraft(requestValue);
  if (request.role !== 'correction') refuse('selected work request must have role correction');
  if ((request.dependencies?.length ?? 0) !== 0) refuse('v1 correction request dependencies must be empty');
  const claims = request.resourceClaims ?? [];
  if (claims.some((claim) => claim.kind !== 'repository_path')) refuse('v1 supports repository-path claims only');
  const write = claims.filter((claim) => claim.mode === 'write');
  if (write.length === 0) refuse('correction request must include non-empty write ownership');
  for (const claim of claims) normalizeRepositoryPath(claim.key);
  for (const evidence of request.evidence ?? []) {
    if (evidence.kind === 'finding') {
      if (!findingIds.includes(evidence.reference)) refuse(`finding evidence ${evidence.reference} is not in the accepted review`);
      continue;
    }
    if (evidence.kind === 'file' || evidence.kind === 'test') {
      const line = /^(.+):([1-9][0-9]*)$/.exec(evidence.reference);
      normalizeRepositoryPath(line?.[1] ?? evidence.reference);
    }
  }
  return request;
}

export function correctionVerification(request: WorkRequestDraft): readonly IntegrationCommand[] {
  const focused = [...new Set((request.evidence ?? []).flatMap((evidence) => {
    if (evidence.kind !== 'file' && evidence.kind !== 'test') return [];
    const path = /^(.+):([1-9][0-9]*)$/.exec(evidence.reference)?.[1] ?? evidence.reference;
    return /\.spec\.ts$/.test(path) ? [path] : [];
  }))];
  return [
    { command: 'pnpm --filter @tripwith/api typecheck', required: true, timeoutMs: 600_000 },
    ...focused.map((path) => ({ command: `pnpm --filter @tripwith/api test -- --runInBand --runTestsByPath ${path}`, required: true, timeoutMs: 900_000 })),
    { command: 'pnpm --filter @tripwith/api test -- --runInBand --testPathPatterns=apps/api/src/chat/presence/.*\\.int-spec\\.ts$', required: true, timeoutMs: 1_800_000 },
    { command: 'pnpm --filter @tripwith/api test -- --runInBand', required: true, timeoutMs: 1_800_000 },
  ];
}

export function buildCorrectionTask(config: PhaseConfig, review: TaskSpec, request: WorkRequestDraft, idSeed: string): TaskSpec {
  const writes = (request.resourceClaims ?? []).filter((claim) => claim.mode === 'write').map((claim) => claim.key);
  const reads = (request.resourceClaims ?? []).filter((claim) => claim.mode === 'read').map((claim) => claim.key);
  const task: TaskSpec = {
    id: `review-correction-${idSeed.slice(0, 20)}`,
    title: request.objective,
    owner: 'codex', effort: 'high', mode: 'correction', writer: true, files: writes,
    dependsOn: [...review.dependsOn], timeoutMs: config.agentTimeoutMs,
    instructions: [request.objective, request.reason, `Authorized read scope: ${reads.join(', ') || '(none)'}`,
      'Address only the accepted review findings and authorized write scope. Do not widen ownership.',
      'Add focused EVENT presence integration coverage inside the authorized presence scope; retain caller/target denial and bidirectional block cases.',
      'Do not edit the separate Phase 7 composed-test tree unless it is explicitly in write ownership; report any remaining scope gap.'].join('\n'),
    verification: correctionVerification(request),
  };
  const { verification: _verification, ...phaseShape } = task;
  parseTaskSpec(phaseShape, 0);
  return task;
}

export function applyReviewCorrectionOverlays(config: PhaseConfig, state: Pick<RunState, 'reviewCorrections'>): PhaseConfig {
  let tasks = [...config.tasks];
  for (const continuation of state.reviewCorrections ?? []) {
    const { correctionTask, reviewTaskId } = continuation.authorization;
    if (tasks.some((task) => task.id === correctionTask.id)) refuse('correction task collides with existing graph');
    const review = tasks.find((task) => task.id === reviewTaskId);
    if (review === undefined || !['review', 'final_review'].includes(review.mode) || review.writer) refuse('authorized source review is missing or ineligible');
    tasks = [...tasks.map((task) => task.id === reviewTaskId
      ? { ...task, dependsOn: [...new Set([...task.dependsOn, correctionTask.id])] }
      : task), correctionTask];
  }
  assertNoParallelOwnershipOverlap(tasks);
  return { ...config, tasks };
}
