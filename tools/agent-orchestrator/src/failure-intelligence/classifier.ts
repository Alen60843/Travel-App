import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';

import type { PhaseConfig } from '../config';
import { extractClaudeStructuredReviewOutput, parseJsonOrNull } from '../agents';
import { effectiveAgentExecutables, unusableExecutableState } from '../agents/executable-repin';
import { OrchestratorError } from '../errors';
import { parseCommand } from '../integration/integration-gate';
import { readReplanHandoff } from '../replan/checkpoint';
import type {
  AgentAttemptState,
  ReviewOutputRecoveryV2State,
  RunEventName,
  RunState,
  StateStore,
  TaskRunState,
} from '../state';
import { RUN_EVENT_NAMES } from '../state';
import { matchesOwnershipPattern, ownershipGlobsOverlap } from '../tasks';
import type { TaskSpec } from '../tasks/task-schema';
import type { DiagnosisEvidence, FailureDiagnosis } from './types';

const MAX_EVIDENCE_BYTES = 2 * 1024 * 1024;
const REVIEW_MODES = new Set(['review', 'final_review']);
const CONNECTION_FAILURE = /(?:\bECONNREFUSED\b|connection to server[\s\S]{0,256}connection refused|could not connect to server|can't reach database server|failed to connect to (?:the )?(?:database|postgres(?:ql)?|redis)|connect:\s*connection refused)/i;

interface PersistedEvent {
  readonly name: RunEventName;
  readonly taskId?: string;
  readonly data: Readonly<Record<string, unknown>>;
  readonly line: number;
}

interface ReviewAttemptBinding {
  readonly round: number;
  readonly agent: 'codex' | 'claude';
  readonly startedLine: number;
  readonly finishedLine?: number;
  readonly finishedStatus?: string;
  readonly exitCode?: number | null;
  readonly repairRejected?: boolean;
  readonly failedLine?: number;
}

interface ReadEvidence {
  readonly bytes: Buffer;
  readonly text: string;
  readonly reference: string;
}

interface CurrentIntegrationAttempt {
  readonly attempt: number;
  readonly commands: readonly PersistedEvent[];
  readonly blocked: PersistedEvent;
}

export interface DiagnoseFailureInput {
  readonly store: StateStore;
  readonly state: RunState;
  readonly config: PhaseConfig;
  readonly taskId?: string;
}

function stateEvidence(reference: string, summary: string): DiagnosisEvidence {
  return { kind: 'state', reference, summary };
}

function unknown(
  runId: string,
  subject: FailureDiagnosis['subject'],
  evidence: readonly DiagnosisEvidence[],
): FailureDiagnosis {
  return { version: 1, status: 'unknown', runId, subject, evidence };
}

function noActiveFailure(
  state: RunState,
  subject: FailureDiagnosis['subject'],
  summary: string,
): FailureDiagnosis {
  return {
    version: 1,
    status: 'no_active_failure',
    runId: state.runId,
    subject,
    evidence: [stateEvidence(subject.kind === 'task' ? `task:${subject.taskId}.status` : 'run.status', summary)],
  };
}

/**
 * Deterministic, read-only failure diagnosis. Recommendations are candidates
 * only: every named command remains responsible for its complete eligibility
 * and authorization checks.
 */
export async function diagnoseFailure(input: DiagnoseFailureInput): Promise<FailureDiagnosis> {
  const { state } = input;
  if (input.taskId !== undefined) {
    const subject = { kind: 'task' as const, taskId: input.taskId };
    const task = state.tasks[input.taskId];
    if (task === undefined) {
      return unknown(state.runId, subject, [stateEvidence(`task:${input.taskId}`, 'The requested task is not present in persisted run state.')]);
    }
    if (state.status === 'COMPLETED' || !['FAILED', 'BLOCKED'].includes(task.status)) {
      return noActiveFailure(state, subject, `Task ${input.taskId} is ${task.status}; it is not a current failure or blocker.`);
    }
    return diagnoseTask(input, input.taskId, task);
  }

  if (state.status === 'COMPLETED') {
    return noActiveFailure(state, { kind: 'run' }, 'Run status is COMPLETED; historical failures are not active blockers.');
  }

  if (state.status !== 'FAILED' && state.status !== 'BLOCKED') {
    return noActiveFailure(state, { kind: 'run' }, `Run status is ${state.status}; no terminal active blocker is recorded.`);
  }

  const taskCandidates = Object.entries(state.tasks)
    .filter(([, task]) => ['FAILED', 'BLOCKED'].includes(task.status)
      && task.error?.code !== 'TASK_DEPENDENCY_FAILED')
    .map(([taskId]) => taskId)
    .sort();
  const integrationCandidate = ['FAILED', 'BLOCKED'].includes(state.integration.status);
  const candidateCount = taskCandidates.length + (integrationCandidate ? 1 : 0);
  if (candidateCount === 0) {
    return unknown(state.runId, { kind: 'run' }, [
      stateEvidence('run.status', `Run status is ${state.status}, but no independent failed task or integration blocker is persisted.`),
    ]);
  }
  if (candidateCount > 1) {
    const evidence: DiagnosisEvidence[] = taskCandidates.map((taskId) =>
      stateEvidence(`task:${taskId}.status`, `Task ${taskId} is an active ${state.tasks[taskId]!.status.toLowerCase()} candidate.`));
    if (integrationCandidate) {
      evidence.push(stateEvidence('integration.status', `Integration is ${state.integration.status.toLowerCase()}.`));
    }
    return unknown(state.runId, { kind: 'run' }, [
      stateEvidence('run.activeBlockers', `Persisted state contains ${candidateCount} independent active blocker candidates; subject selection is ambiguous.`),
      ...evidence,
    ]);
  }
  if (integrationCandidate) return diagnoseIntegration(input);
  const taskId = taskCandidates[0]!;
  return diagnoseTask(input, taskId, state.tasks[taskId]!);
}

async function diagnoseTask(
  input: DiagnoseFailureInput,
  taskId: string,
  task: TaskRunState,
): Promise<FailureDiagnosis> {
  const subject = { kind: 'task' as const, taskId };
  const spec = input.config.tasks.find((candidate) => candidate.id === taskId);
  if (spec === undefined) {
    return unknown(input.state.runId, subject, [
      stateEvidence(`task:${taskId}`, 'The active task has no effective phase specification.'),
    ]);
  }

  const executable = await diagnoseExecutableDrift(input, spec, task);
  if (executable !== null) return executable;

  if (REVIEW_MODES.has(spec.mode)) {
    const review = await diagnoseReviewFailure(input, spec, task);
    if (review !== null) return review;
  }

  const ownership = await diagnoseOwnershipExpansion(input, spec, task);
  if (ownership !== null) return ownership;

  return unknown(input.state.runId, subject, [
    stateEvidence(`task:${taskId}.error`, `Task is ${task.status} with ${task.error?.code ?? 'no typed error'}, but no v1 rule matched all required evidence.`),
  ]);
}

async function diagnoseExecutableDrift(
  input: DiagnoseFailureInput,
  spec: TaskSpec,
  task: TaskRunState,
): Promise<FailureDiagnosis | null> {
  const attempt = task.agentAttempts.at(-1);
  if (task.status !== 'FAILED' || task.error?.code !== 'AGENT_FAILED'
    || attempt?.outcome !== 'failed' || attempt.finishedAt === undefined
    || attempt.agent !== spec.owner || task.commit !== undefined
    || task.handoffPath !== undefined || task.reviewPaths.length !== 0
    || task.reviewRounds !== 0 || task.handoffRepairAttempts.length !== 0
    || task.handoffOutcome !== undefined) return null;

  const executable = effectiveAgentExecutables(input.state)[attempt.agent];
  if (executable === undefined || !isAbsolute(executable) || resolve(executable) !== executable
    || task.error.message !== `spawn ${executable} ENOENT`) return null;
  let unavailable: Awaited<ReturnType<typeof unusableExecutableState>>;
  try {
    unavailable = await unusableExecutableState(executable);
  } catch {
    return null;
  }
  if (unavailable !== 'missing') return null;
  return {
    version: 1,
    status: 'diagnosed',
    runId: input.state.runId,
    subject: { kind: 'task', taskId: task.id },
    classification: 'AGENT_EXECUTABLE_DRIFT',
    agent: attempt.agent,
    evidence: [
      stateEvidence(`task:${task.id}.error`, `Task failed at the agent process boundary with AGENT_FAILED for its persisted ${attempt.agent} executable.`),
      { kind: 'attempt', reference: `attempt:${attempt.attempt}`, summary: 'The latest persisted provider attempt finished with outcome failed and produced no accepted structured result.' },
      { kind: 'filesystem', reference: `agentExecutables.${attempt.agent}`, summary: 'The exact persisted executable path from the spawn ENOENT failure is now missing.' },
    ],
  };
}

async function diagnoseReviewFailure(
  input: DiagnoseFailureInput,
  spec: TaskSpec,
  task: TaskRunState,
): Promise<FailureDiagnosis | null> {
  const attempt = task.agentAttempts.at(-1);
  if (task.status !== 'FAILED' || task.error?.code !== 'REVIEW_BLOCKED'
    || attempt?.outcome !== 'succeeded' || attempt.finishedAt === undefined
    || attempt.agent !== spec.owner || spec.writer || task.handoffOutcome !== 'invalid'
    || task.commit !== undefined || task.reviewPaths.length !== task.reviewRounds) return null;

  let events: readonly PersistedEvent[];
  try {
    events = await readEvents(input.store);
  } catch {
    return null;
  }
  const bindings = reviewBindings(events, task.id);
  const current = bindings.get(attempt.attempt);
  if (current?.agent !== attempt.agent || current.finishedStatus !== 'succeeded' || current.exitCode !== 0
    || current.repairRejected !== true || current.failedLine === undefined) return null;

  const sameRoundRecoveries = (task.reviewOutputRecoveries ?? []).filter(
    (recovery): recovery is ReviewOutputRecoveryV2State =>
      recovery.version === 2 && recovery.reviewRound === current.round,
  );
  const legacyRecoveries = (task.reviewOutputRecoveries ?? []).filter((recovery) => recovery.version === undefined);
  const legacyRecoveryUnbound = legacyRecoveries.some((recovery) => bindings.get(recovery.attempt.attempt) === undefined);
  const legacySameRound = legacyRecoveries.some((recovery) => bindings.get(recovery.attempt.attempt)?.round === current.round);
  if (spec.owner === 'claude' && sameRoundRecoveries.length === 1
    && !legacyRecoveryUnbound && !legacySameRound
    && !(task.reviewOutputRecoveries ?? []).some((recovery) => recovery.version === 3)) {
    const contractFailure = await diagnoseClaudeContractFailure(input, task, attempt, current, bindings, sameRoundRecoveries[0]!);
    if (contractFailure !== null) return contractFailure;
    // A consumed retry that does not exactly match the supported migration is
    // not downgraded into an ordinary malformed-output recommendation.
    return null;
  }

  const currentRoundRejectedSuccesses = [...bindings.values()].filter((binding) =>
    binding.round === current.round && binding.finishedStatus === 'succeeded'
    && binding.exitCode === 0 && binding.repairRejected === true && binding.failedLine !== undefined);
  const explicitSameRoundRecovery = (task.reviewOutputRecoveries ?? []).some((recovery) =>
    recovery.version !== undefined && recovery.reviewRound === current.round);
  if (sameRoundRecoveries.length !== 0 || legacyRecoveryUnbound || legacySameRound
    || explicitSameRoundRecovery || currentRoundRejectedSuccesses.length !== 1) return null;
  return {
    version: 1,
    status: 'diagnosed',
    runId: input.state.runId,
    subject: { kind: 'task', taskId: task.id },
    classification: 'MALFORMED_REVIEW_OUTPUT',
    evidence: [
      stateEvidence(`task:${task.id}.error`, 'Static read-only review ended with REVIEW_BLOCKED after strict structured review validation failed.'),
      { kind: 'attempt', reference: `attempt:${attempt.attempt}`, summary: 'The provider process completed successfully; this is not a provider process failure.' },
      { kind: 'event', reference: `events.jsonl:${current.startedLine},${current.finishedLine ?? current.failedLine},${current.failedLine}`, summary: `Persisted lifecycle events bind the rejected output to review round ${current.round}.` },
      { kind: 'artifact', reference: `task:${task.id}.reviewPaths`, summary: `No accepted artifact exists for attempted task review round ${task.reviewRounds + 1}.` },
    ],
  };
}

async function diagnoseClaudeContractFailure(
  input: DiagnoseFailureInput,
  task: TaskRunState,
  currentAttempt: AgentAttemptState,
  current: ReviewAttemptBinding,
  bindings: ReadonlyMap<number, ReviewAttemptBinding>,
  recovery: ReviewOutputRecoveryV2State,
): Promise<FailureDiagnosis | null> {
  const priorAttempt = recovery.attempt;
  const prior = bindings.get(priorAttempt.attempt);
  if (input.state.strategy !== undefined || input.state.adaptive !== undefined
    || recovery.runId !== input.state.runId || recovery.taskId !== task.id
    || recovery.taskReviewRound !== task.reviewRounds + 1
    || priorAttempt.agent !== 'claude' || priorAttempt.outcome !== 'succeeded'
    || currentAttempt.agent !== 'claude' || currentAttempt.attempt !== priorAttempt.attempt + 1
    || prior?.agent !== 'claude' || prior.round !== current.round
    || prior.finishedStatus !== 'succeeded' || prior.exitCode !== 0
    || prior.repairRejected !== true || prior.failedLine === undefined) return null;

  const baseEvidence: DiagnosisEvidence[] = [
    stateEvidence(`task:${task.id}.reviewOutputRecoveries`, `The ordinary structured-review retry for round ${current.round} is already consumed.`),
    { kind: 'attempt', reference: `attempt:${priorAttempt.attempt},${currentAttempt.attempt}`, summary: 'Two consecutive Claude provider attempts succeeded while strict structured review validation rejected both outputs.' },
    { kind: 'event', reference: `events.jsonl:${prior.startedLine},${current.startedLine}`, summary: `Both rejected attempts are durably bound to the same review round ${current.round}.` },
  ];
  const expectedPriorPath = join(input.store.runDirectory, 'logs',
    `${input.state.runId}.${task.id}.claude.attempt-${priorAttempt.attempt}.stdout.log`);
  const currentPath = join(input.store.runDirectory, 'logs',
    `${input.state.runId}.${task.id}.claude.attempt-${currentAttempt.attempt}.stdout.log`);
  let specializedMigration = false;
  let logEvidence: DiagnosisEvidence | undefined;
  if (recovery.reviewRound === 2 && recovery.taskReviewRound === 2 && task.reviewRounds === 1
    && priorAttempt.structuredOutputContractId === undefined
    && currentAttempt.structuredOutputContractId === undefined
    && recovery.stdoutPath === expectedPriorPath) {
    try {
      const [priorOutput, currentOutput] = await Promise.all([
        readRunOwnedEvidence(input.store.runDirectory, recovery.stdoutPath),
        readRunOwnedEvidence(input.store.runDirectory, currentPath),
      ]);
      if (createHash('sha256').update(priorOutput.bytes).digest('hex') === recovery.stdoutSha256
        && isPromptOnlyFailure(priorOutput.text) && isPromptOnlyFailure(currentOutput.text)) {
        specializedMigration = true;
        logEvidence = { kind: 'log', reference: `${priorOutput.reference},${currentOutput.reference}`, summary: 'Both bounded stdout artifacts are prompt-only text rather than a structured Claude result envelope; no prose was interpreted as approval.' };
      }
    } catch {
      // Classification is already proven by validated state and lifecycle
      // events. Unsafe logs can never authorize the specialized candidate.
    }
  }

  return {
    version: 1,
    status: 'diagnosed',
    runId: input.state.runId,
    subject: { kind: 'task', taskId: task.id },
    classification: 'PROVIDER_OUTPUT_CONTRACT_FAILURE',
    ...(specializedMigration ? { variant: 'CLAUDE_TEXT_CONTRACT_MIGRATION' as const } : {}),
    evidence: logEvidence === undefined ? baseEvidence : [...baseEvidence, logEvidence],
  };
}

function isPromptOnlyFailure(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.length > 0 && parseJsonOrNull(trimmed) === null
    && extractClaudeStructuredReviewOutput(trimmed) === null;
}

async function diagnoseOwnershipExpansion(
  input: DiagnoseFailureInput,
  spec: TaskSpec,
  task: TaskRunState,
): Promise<FailureDiagnosis | null> {
  if (task.replan !== undefined && task.replan.phase !== 'RESOLVED') {
    return {
      version: 1,
      status: 'diagnosed',
      runId: input.state.runId,
      subject: { kind: 'task', taskId: task.id },
      classification: 'OWNERSHIP_EXPANSION_REQUIRED',
      variant: 'EXISTING_REPLAN_CHECKPOINT',
      evidence: [
        stateEvidence(`task:${task.id}.replan`, `Persisted replan phase ${task.replan.phase} proves an unresolved ownership/scope expansion workflow.`),
      ],
    };
  }
  if (task.handoffOutcome !== 'valid' || task.handoffPath === undefined) return null;

  let loaded: Awaited<ReturnType<typeof readReplanHandoff>>;
  try {
    loaded = await readReplanHandoff(input.store, task);
  } catch {
    return null;
  }
  const requests = loaded.handoff.additionalWorkRequests ?? [];
  for (const [requestIndex, request] of requests.entries()) {
    const expanded = (request.resourceClaims ?? []).filter((claim) => claim.mode === 'write'
      && (claim.kind !== 'repository_path' || writeClaimRelation(claim.key, spec) === 'outside'));
    if (expanded.length === 0) continue;
    const repositoryClaims = expanded.filter((claim) => claim.kind === 'repository_path');
    return {
      version: 1,
      status: 'diagnosed',
      runId: input.state.runId,
      subject: { kind: 'task', taskId: task.id },
      classification: 'OWNERSHIP_EXPANSION_REQUIRED',
      ...(repositoryClaims.length === expanded.length
        ? {}
        : { variant: 'NON_REPOSITORY_WRITE_BOUNDARY' as const }),
      evidence: [
        stateEvidence(`task:${task.id}.handoffOutcome`, 'The originating task has a strictly validated persisted handoff.'),
        { kind: 'artifact', reference: `handoffs/${task.id}.json#additionalWorkRequests[${requestIndex}]`, summary: `The accepted request contains ${expanded.length} write resource claim(s) outside the task's authorized write ownership.` },
      ],
    };
  }
  return null;
}

type WriteClaimRelation = 'contained' | 'outside' | 'ambiguous';

function writeClaimRelation(key: string, spec: TaskSpec): WriteClaimRelation {
  if (!spec.writer) return 'outside';
  if (!/[*?]/.test(key)) {
    return spec.files.some((pattern) => matchesOwnershipPattern(key, pattern)) ? 'contained' : 'outside';
  }
  if (spec.files.includes(key)) return 'contained';
  for (const owned of spec.files) {
    const requestedPrefix = literalGlobstarPrefix(key);
    const ownedPrefix = literalGlobstarPrefix(owned);
    if (requestedPrefix !== null && ownedPrefix !== null
      && pathSegmentsStartWith(requestedPrefix, ownedPrefix)) return 'contained';
  }
  if (spec.files.length === 1) {
    const requestedPrefix = literalGlobstarPrefix(key);
    const ownedPrefix = literalGlobstarPrefix(spec.files[0]!);
    if (requestedPrefix !== null && ownedPrefix !== null
      && pathSegmentsStartWith(ownedPrefix, requestedPrefix)) return 'outside';
  }
  return spec.files.some((pattern) => ownershipGlobsOverlap(key, pattern)) ? 'ambiguous' : 'outside';
}

/** A deliberately bounded subset proof for literal directory prefixes ending in `/**`. */
function literalGlobstarPrefix(pattern: string): readonly string[] | null {
  const segments = pattern.split('/');
  if (segments.at(-1) !== '**') return null;
  const prefix = segments.slice(0, -1);
  return prefix.length > 0 && prefix.every((segment) => segment.length > 0 && !/[*?]/.test(segment))
    ? prefix : null;
}

function pathSegmentsStartWith(value: readonly string[], prefix: readonly string[]): boolean {
  return value.length >= prefix.length && prefix.every((segment, index) => value[index] === segment);
}

async function diagnoseIntegration(input: DiagnoseFailureInput): Promise<FailureDiagnosis> {
  const subject = { kind: 'integration' as const };
  const integration = input.state.integration;
  if (integration.status !== 'BLOCKED' || integration.error?.code !== 'INTEGRATION_TEST_FAILED') {
    return unknown(input.state.runId, subject, [
      stateEvidence('integration.error', `Integration is ${integration.status} with ${integration.error?.code ?? 'no typed error'}; the v1 environment rule does not apply.`),
    ]);
  }
  let events: readonly PersistedEvent[];
  try {
    events = await readEvents(input.store);
  } catch {
    return unknown(input.state.runId, subject, [
      stateEvidence('integration.error', 'Integration is blocked with INTEGRATION_TEST_FAILED, but bounded event evidence could not be read safely.'),
    ]);
  }
  const current = currentIntegrationAttempt(input.state, events);
  if (current === null) {
    return unknown(input.state.runId, subject, [stateEvidence('integration.error', 'The current integration attempt cannot be bound exactly to persisted archive and event history.')]);
  }
  const { commands, blocked } = current;
  if (commands.length === 0 || commands.some((event, index) =>
    !validCommandEvidence(event.data) || event.data.index !== index
    || !currentIntegrationLogPaths(input.store.runDirectory, event.data))) {
    return unknown(input.state.runId, subject, [stateEvidence('integration.error', 'Current integration command or live-log evidence is incomplete, non-contiguous, or malformed.')]);
  }
  const failedIndex = commands.findIndex((event) => event.data.required === true && commandFailed(event.data));
  if (failedIndex < 0) {
    return unknown(input.state.runId, subject, [stateEvidence('integration.error', 'No failed required integration command is durably recorded for the current attempt.')]);
  }
  const failed = commands[failedIndex]!;
  const earlierRequired = commands.slice(0, failedIndex).filter((event) => event.data.required === true);
  if (earlierRequired.length === 0 || earlierRequired.some((event) => commandFailed(event.data))) {
    return unknown(input.state.runId, subject, [stateEvidence('integration.error', 'Persisted command order does not prove that earlier required integration gates passed before the failure.')]);
  }
  const stdoutPath = typeof failed.data.stdoutPath === 'string' ? failed.data.stdoutPath : undefined;
  const stderrPath = typeof failed.data.stderrPath === 'string' ? failed.data.stderrPath : undefined;
  if (stdoutPath === undefined || stderrPath === undefined) {
    return unknown(input.state.runId, subject, [stateEvidence('integration.error', 'The failed command lacks bounded stdout/stderr references.')]);
  }
  let stdout: ReadEvidence;
  let stderr: ReadEvidence;
  try {
    [stdout, stderr] = await Promise.all([
      readRunOwnedEvidence(input.store.runDirectory, stdoutPath),
      readRunOwnedEvidence(input.store.runDirectory, stderrPath),
    ]);
  } catch {
    return unknown(input.state.runId, subject, [stateEvidence('integration.error', 'The failed command logs could not be read safely within the run directory.')]);
  }
  const matching = CONNECTION_FAILURE.test(stderr.text) ? stderr
    : CONNECTION_FAILURE.test(stdout.text) ? stdout : undefined;
  if (matching === undefined) {
    return unknown(input.state.runId, subject, [
      stateEvidence('integration.error', 'Integration is blocked with INTEGRATION_TEST_FAILED, but bounded logs do not prove an external connection/environment failure.'),
      { kind: 'event', reference: `events.jsonl:${failed.line},${blocked.line}`, summary: `A required integration command failed and blocked current attempt ${current.attempt} after earlier required commands passed.` },
    ]);
  }
  return {
    version: 1,
    status: 'diagnosed',
    runId: input.state.runId,
    subject,
    classification: 'INTEGRATION_ENVIRONMENT_MISMATCH',
    evidence: [
      stateEvidence('integration.error', 'Integration is blocked with INTEGRATION_TEST_FAILED.'),
      { kind: 'event', reference: `events.jsonl:${failed.line},${blocked.line}`, summary: `${earlierRequired.length} earlier required integration command(s) passed before the later required command failed and blocked current attempt ${current.attempt}.` },
      { kind: 'log', reference: matching.reference, summary: 'The bounded failed-command log reports that its configured external connection target was unavailable.' },
    ],
  };
}

function commandFailed(data: Readonly<Record<string, unknown>>): boolean {
  return data.timedOut === true || data.termination !== null && data.termination !== undefined
    || data.exitCode !== 0;
}

function validCommandEvidence(data: Readonly<Record<string, unknown>>): boolean {
  return Number.isSafeInteger(data.index) && Number(data.index) >= 0
    && typeof data.command === 'string' && data.command.length > 0
    && typeof data.required === 'boolean'
    && (typeof data.exitCode === 'number' || data.exitCode === null)
    && typeof data.timedOut === 'boolean'
    && (data.termination === null || data.termination === 'timeout' || data.termination === 'aborted')
    && typeof data.stdoutPath === 'string' && typeof data.stderrPath === 'string';
}

function currentIntegrationAttempt(
  state: RunState,
  events: readonly PersistedEvent[],
): CurrentIntegrationAttempt | null {
  const starts = events.map((event, index) => ({ event, index })).filter(({ event }) =>
    event.name === 'INTEGRATION_STARTED' && event.taskId === undefined);
  if (starts.length !== 1) return null;
  const archived = state.integrationAttempts ?? [];
  const boundaries = events.map((event, index) => ({ event, index })).filter(({ event }) =>
    event.taskId === undefined && (event.name === 'INTEGRATION_FIX_APPLIED'
      || event.name === 'RUN_RESUMED' && event.data.recoveryMode === 'integration_retry'));
  if (boundaries.length !== archived.length) return null;

  let previousBoundary = starts[0]!.index;
  for (const [index, boundary] of boundaries.entries()) {
    if (boundary.index <= previousBoundary) return null;
    const priorBlocks = events.slice(previousBoundary + 1, boundary.index).filter((event) =>
      event.name === 'RUN_BLOCKED' && event.taskId === undefined);
    const priorBlock = priorBlocks.at(-1);
    const snapshot = archived[index];
    if (snapshot?.status !== 'BLOCKED' || snapshot.error === undefined
      || priorBlock?.data.code !== snapshot.error.code) return null;
    previousBoundary = boundary.index;
  }

  const currentEvents = events.slice(previousBoundary + 1);
  const blocks = currentEvents.filter((event) => event.name === 'RUN_BLOCKED' && event.taskId === undefined);
  if (blocks.length !== 1 || blocks[0]!.data.code !== state.integration.error?.code) return null;
  const blocked = blocks[0]!;
  const commands = currentEvents.filter((event) =>
    event.name === 'INTEGRATION_COMMAND_FINISHED' && event.taskId === undefined);
  if (commands.some((event) => event.line >= blocked.line)) return null;
  return { attempt: archived.length + 1, commands, blocked };
}

function currentIntegrationLogPaths(
  runDirectory: string,
  data: Readonly<Record<string, unknown>>,
): boolean {
  if (!Number.isSafeInteger(data.index) || typeof data.command !== 'string'
    || typeof data.stdoutPath !== 'string' || typeof data.stderrPath !== 'string') return false;
  try {
    const executable = parseCommand(data.command)[0];
    if (executable === undefined) return false;
    const stem = `${String(Number(data.index) + 1).padStart(2, '0')}-${basename(executable)}`;
    const liveLogs = join(runDirectory, 'logs', 'integration');
    return data.stdoutPath === join(liveLogs, `${stem}.stdout.log`)
      && data.stderrPath === join(liveLogs, `${stem}.stderr.log`);
  } catch {
    return false;
  }
}

async function readEvents(store: StateStore): Promise<readonly PersistedEvent[]> {
  const source = await readRunOwnedEvidence(store.runDirectory, store.eventsPath);
  const events: PersistedEvent[] = [];
  for (const [index, line] of source.text.split('\n').entries()) {
    if (line.trim() === '') continue;
    let raw: unknown;
    try { raw = JSON.parse(line) as unknown; } catch (error) {
      throw new OrchestratorError('STATE_CORRUPT', `Invalid event JSON at line ${index + 1}`, { cause: error });
    }
    if (!isRecord(raw) || raw.runId !== store.runId || typeof raw.name !== 'string'
      || !(RUN_EVENT_NAMES as readonly string[]).includes(raw.name)
      || typeof raw.timestamp !== 'string' || !Number.isFinite(Date.parse(raw.timestamp))
      || raw.taskId !== undefined && typeof raw.taskId !== 'string'
      || raw.data !== undefined && !isRecord(raw.data)) {
      throw new OrchestratorError('STATE_CORRUPT', `Invalid event identity at line ${index + 1}`);
    }
    events.push({
      name: raw.name as RunEventName,
      ...(typeof raw.taskId === 'string' ? { taskId: raw.taskId } : {}),
      data: isRecord(raw.data) ? raw.data : {},
      line: index + 1,
    });
  }
  return events;
}

function reviewBindings(
  events: readonly PersistedEvent[],
  taskId: string,
): ReadonlyMap<number, ReviewAttemptBinding> {
  const bindings = new Map<number, ReviewAttemptBinding>();
  let round: number | undefined;
  let lastFinished: number | undefined;
  for (const event of events) {
    if (event.taskId !== taskId) continue;
    if (event.name === 'REVIEW_STARTED' && Number.isSafeInteger(event.data.round) && Number(event.data.round) > 0) {
      round = Number(event.data.round);
      lastFinished = undefined;
    } else if (event.name === 'AGENT_STARTED' && round !== undefined
      && Number.isSafeInteger(event.data.attempt) && Number(event.data.attempt) > 0
      && (event.data.agent === 'codex' || event.data.agent === 'claude')) {
      const attempt = Number(event.data.attempt);
      if (bindings.has(attempt)) return new Map();
      bindings.set(attempt, { round, agent: event.data.agent, startedLine: event.line });
    } else if (event.name === 'AGENT_FINISHED' && Number.isSafeInteger(event.data.attempt)) {
      const attempt = Number(event.data.attempt);
      const binding = bindings.get(attempt);
      if (binding === undefined || binding.finishedLine !== undefined
        || event.data.agent !== binding.agent) return new Map();
      bindings.set(attempt, {
        ...binding,
        finishedLine: event.line,
        ...(typeof event.data.status === 'string' ? { finishedStatus: event.data.status } : {}),
        ...(typeof event.data.exitCode === 'number' || event.data.exitCode === null ? { exitCode: event.data.exitCode } : {}),
      });
      lastFinished = attempt;
    } else if (event.name === 'HANDOFF_REPAIR_ATTEMPTED' && lastFinished !== undefined
      && event.data.succeeded === false) {
      bindings.set(lastFinished, { ...bindings.get(lastFinished)!, repairRejected: true });
    } else if (event.name === 'TASK_FAILED' && lastFinished !== undefined
      && event.data.code === 'REVIEW_BLOCKED') {
      bindings.set(lastFinished, { ...bindings.get(lastFinished)!, failedLine: event.line });
    }
  }
  return bindings;
}

async function readRunOwnedEvidence(runDirectory: string, path: string): Promise<ReadEvidence> {
  const absoluteRun = resolve(runDirectory);
  const absolutePath = resolve(path);
  const lexical = relative(absoluteRun, absolutePath);
  if (!isAbsolute(path) || absolutePath !== path || lexical === '' || lexical === '..'
    || lexical.startsWith(`..${sep}`) || isAbsolute(lexical)) {
    throw new OrchestratorError('TASK_STATE_INVALID', 'Evidence path is outside the run directory');
  }
  const [realRun, actualPath, before] = await Promise.all([
    realpath(absoluteRun),
    realpath(absolutePath),
    lstat(absolutePath),
  ]);
  const actualRelative = relative(realRun, actualPath);
  if (actualRelative === '' || actualRelative === '..' || actualRelative.startsWith(`..${sep}`)
    || isAbsolute(actualRelative) || actualRelative !== lexical
    || !before.isFile() || before.isSymbolicLink()
    || before.size > MAX_EVIDENCE_BYTES) {
    throw new OrchestratorError('TASK_STATE_INVALID', 'Evidence is not a bounded run-owned regular file');
  }
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(absolutePath, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino
      || opened.size > MAX_EVIDENCE_BYTES) {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Evidence changed while opening');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (bytes.byteLength > MAX_EVIDENCE_BYTES || after.size !== opened.size
      || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Evidence changed while reading');
    }
    return { bytes, text: bytes.toString('utf8'), reference: actualRelative.split(sep).join('/') };
  } finally {
    await handle.close();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
