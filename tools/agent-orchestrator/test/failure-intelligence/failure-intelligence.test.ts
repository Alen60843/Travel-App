import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import type { PhaseConfig } from '../../src/config';
import { diagnoseFailure } from '../../src/failure-intelligence/classifier';
import {
  createRunState,
  StateStore,
  type AgentAttemptState,
  type RunEvent,
  type RunState,
  type TaskRunState,
} from '../../src/state';
import type { TaskSpec } from '../../src/tasks';
import { createTemporaryRepository } from '../git/helpers';

const timestamp = '2026-09-15T00:00:00.000Z';
const taskId = 'subject';

function taskSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    id: taskId,
    title: 'Failure intelligence subject',
    owner: 'claude',
    effort: 'high',
    mode: 'implementation',
    files: ['owned/**'],
    dependsOn: [],
    writer: true,
    ...overrides,
  };
}

function phaseConfig(tasks: readonly TaskSpec[]): PhaseConfig {
  return {
    phase: 1,
    name: 'Failure intelligence fixture',
    baseBranch: 'phase4/base',
    canonicalDesignDocument: 'shared.txt',
    concurrency: 1,
    maxReviewRounds: 2,
    agentRetries: 0,
    agentTimeoutMs: 60_000,
    agentWorktree: { prepare: [] },
    tasks,
    integration: { prepare: [], commands: [{ command: 'true', required: true }], diagnostics: [] },
    maxHandoffRepairAttempts: 1,
    salvage: { verify: [] },
  };
}

interface Fixture {
  readonly root: string;
  readonly store: StateStore;
  readonly config: PhaseConfig;
  state: RunState;
  dispose(): Promise<void>;
}

async function fixture(
  tasks: readonly TaskSpec[],
  update: (state: RunState) => RunState,
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'failure-intelligence-'));
  const runId = 'run-fi-fixture';
  const store = new StateStore(join(root, 'runs'), runId);
  const initial = createRunState({
    runId,
    phase: 1,
    repositoryRoot: root,
    baseBranch: 'phase4/base',
    baseSha: 'a'.repeat(40),
    tasks,
    clock: () => new Date(timestamp),
  });
  const state = update(initial);
  await store.initialize(state);
  await writeFile(store.eventsPath, '');
  await writeFile(join(store.runDirectory, 'phase.yaml'), 'fixture: true\n');
  return {
    root,
    store,
    config: phaseConfig(tasks),
    state,
    dispose: async () => rm(root, { recursive: true, force: true }),
  };
}

function error(code: TaskRunState['error'] extends infer _ ? RunState['errors'][number]['code'] : never, message: string) {
  return { code, message, at: timestamp };
}

function attempt(number: number, outcome: NonNullable<AgentAttemptState['outcome']>, agent: AgentAttemptState['agent'] = 'claude'): AgentAttemptState {
  return { attempt: number, agent, startedAt: timestamp, finishedAt: timestamp, outcome };
}

async function appendEvents(store: StateStore, events: readonly Omit<RunEvent, 'runId' | 'timestamp'>[]): Promise<void> {
  for (const event of events) await store.appendEvent({ ...event, runId: store.runId, timestamp });
}

async function appendReviewAttempt(
  store: StateStore,
  round: number,
  value: AgentAttemptState,
): Promise<void> {
  await appendEvents(store, [
    { name: 'REVIEW_STARTED', taskId, data: { round } },
    { name: 'AGENT_STARTED', taskId, data: { agent: value.agent, attempt: value.attempt } },
    { name: 'AGENT_FINISHED', taskId, data: { agent: value.agent, attempt: value.attempt, status: value.outcome, exitCode: value.outcome === 'succeeded' ? 0 : 1 } },
    { name: 'HANDOFF_REPAIR_ATTEMPTED', taskId, data: { method: 'none', succeeded: false, failureReason: 'evidence_insufficient' } },
    { name: 'TASK_FAILED', taskId, data: { code: 'REVIEW_BLOCKED', status: 'FAILED' } },
  ]);
}

function failedTask(
  state: RunState,
  patch: Partial<TaskRunState>,
): RunState {
  return {
    ...state,
    status: 'FAILED',
    tasks: {
      ...state.tasks,
      [taskId]: {
        ...state.tasks[taskId]!,
        status: 'FAILED',
        finishedAt: timestamp,
        ...patch,
      },
    },
  };
}

test('detects AGENT_EXECUTABLE_DRIFT from exact persisted spawn ENOENT without finding a replacement', async () => {
  const missing = join(tmpdir(), `missing-codex-${process.pid}`);
  const spec = taskSpec({ owner: 'codex' });
  const value = await fixture([spec], (state) => failedTask({ ...state, agentExecutables: { codex: missing } }, {
    error: error('AGENT_FAILED', `spawn ${missing} ENOENT`),
    agentAttempts: [attempt(1, 'failed', 'codex')],
  }));
  try {
    const availableReplacement = join(value.root, 'codex');
    await writeFile(availableReplacement, '#!/bin/sh\nexit 99\n');
    await chmod(availableReplacement, 0o755);
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.classification, 'AGENT_EXECUTABLE_DRIFT');
    assert.equal(diagnosis.recommendedAction?.id, 'repin-agent-executable');
    assert.match(diagnosis.recommendedAction?.command ?? '', /<absolute-executable-path>/);
    assert.doesNotMatch(diagnosis.recommendedAction?.command ?? '', new RegExp(availableReplacement));
  } finally { await value.dispose(); }
});

test('MALFORMED_REVIEW_OUTPUT requires a succeeded provider and an unaccepted strict review parse', async () => {
  const spec = taskSpec({ mode: 'review', writer: false });
  const provider = attempt(1, 'succeeded');
  const value = await fixture([spec], (state) => failedTask(state, {
    error: error('REVIEW_BLOCKED', 'review: must be an object'),
    agentAttempts: [provider],
    handoffOutcome: 'invalid',
  }));
  try {
    await appendReviewAttempt(value.store, 1, provider);
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.classification, 'MALFORMED_REVIEW_OUTPUT');
    assert.equal(diagnosis.recommendedAction?.id, 'retry-review-output');
    assert.equal(diagnosis.recommendedAction?.requiresHumanAuthorization, true);
  } finally { await value.dispose(); }
});

test('a failed provider process is not classified as malformed review output', async () => {
  const spec = taskSpec({ mode: 'review', writer: false });
  const provider = attempt(1, 'failed');
  const value = await fixture([spec], (state) => failedTask(state, {
    error: error('AGENT_FAILED', 'provider exited 1'),
    agentAttempts: [provider],
  }));
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.notEqual(diagnosis.classification, 'MALFORMED_REVIEW_OUTPUT');
  } finally { await value.dispose(); }
});

test('consumed same-round Claude retry with two prompt-only successes is PROVIDER_OUTPUT_CONTRACT_FAILURE', async () => {
  const spec = taskSpec({ mode: 'final_review', writer: false });
  const first = attempt(1, 'succeeded');
  const second = attempt(2, 'succeeded');
  const firstText = 'Review complete. Final Verdict: Approved';
  let stdoutPath = '';
  const value = await fixture([spec], (state) => {
    const roundOnePath = join(state.repositoryRoot, 'runs', state.runId, 'reviews', `${taskId}.round-1.json`);
    stdoutPath = join(state.repositoryRoot, 'runs', 'run-fi-fixture', 'logs',
      `${state.runId}.${taskId}.claude.attempt-1.stdout.log`);
    const reviewError = error('REVIEW_BLOCKED', 'review: must be an object');
    return failedTask(state, {
      error: reviewError,
      agentAttempts: [first, second],
      handoffOutcome: 'invalid',
      reviewRounds: 1,
      reviewPaths: [roundOnePath],
      preparedHeadSha: 'b'.repeat(40),
      reviewOutputRecoveries: [{
        version: 2,
        runId: state.runId,
        taskId,
        reviewRound: 2,
        taskReviewRound: 2,
        preparedHeadSha: 'b'.repeat(40),
        acceptedReviewArtifacts: [{ round: 1, path: roundOnePath, sha256: 'd'.repeat(64) }],
        recovery: 1,
        authorizedAt: timestamp,
        previousRunStatus: 'FAILED',
        previousTaskStatus: 'FAILED',
        error: reviewError,
        attempt: first,
        previousHandoffOutcome: 'invalid',
        stdoutPath,
        stdoutSha256: createHash('sha256').update(firstText).digest('hex'),
        reopenedTaskIds: [],
      }],
    });
  });
  try {
    await writeFile(stdoutPath, firstText);
    await writeFile(join(value.store.runDirectory, 'logs', `${value.store.runId}.${taskId}.claude.attempt-2.stdout.log`),
      'All checks passed. Final Verdict: Approved');
    await appendReviewAttempt(value.store, 2, first);
    await appendReviewAttempt(value.store, 2, second);
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.classification, 'PROVIDER_OUTPUT_CONTRACT_FAILURE');
    assert.equal(diagnosis.recommendedAction?.id, 'continue-claude-review-output');
    assert.match(diagnosis.evidence.at(-1)?.summary ?? '', /no prose was interpreted as approval/i);

    const structuredContract = 'e'.repeat(64);
    const original = value.state.tasks[taskId]!;
    const firstWithContract = { ...original.agentAttempts[0]!, structuredOutputContractId: structuredContract };
    const secondWithContract = { ...original.agentAttempts[1]!, structuredOutputContractId: structuredContract };
    const recovery = original.reviewOutputRecoveries![0]!;
    const outsideMigration = await diagnoseFailure({ ...value, state: { ...value.state, tasks: {
      ...value.state.tasks,
      [taskId]: { ...original, agentAttempts: [firstWithContract, secondWithContract],
        reviewOutputRecoveries: [{ ...recovery, attempt: firstWithContract }] },
    } } });
    assert.equal(outsideMigration.classification, 'PROVIDER_OUTPUT_CONTRACT_FAILURE');
    assert.equal(outsideMigration.recommendedAction?.id, 'manual-inspection');
    assert.equal(outsideMigration.recommendedAction?.command, undefined);
    assert.equal(outsideMigration.recommendedAction?.requiresHumanAuthorization, false);
  } finally { await value.dispose(); }
});

test('a single malformed Claude response is not a provider contract failure', async () => {
  const spec = taskSpec({ mode: 'final_review', writer: false });
  const provider = attempt(1, 'succeeded');
  const value = await fixture([spec], (state) => failedTask(state, {
    error: error('REVIEW_BLOCKED', 'review: must be an object'),
    agentAttempts: [provider],
    handoffOutcome: 'invalid',
  }));
  try {
    await appendReviewAttempt(value.store, 1, provider);
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.classification, 'MALFORMED_REVIEW_OUTPUT');
    assert.notEqual(diagnosis.classification, 'PROVIDER_OUTPUT_CONTRACT_FAILURE');
  } finally { await value.dispose(); }
});

function handoff(additionalWorkRequests?: unknown): unknown {
  return {
    status: 'blocked',
    summary: 'Bounded task result.',
    filesChanged: [],
    decisions: [],
    tests: [],
    openQuestions: [],
    reviewRequested: [],
    ...(additionalWorkRequests === undefined ? {} : { additionalWorkRequests }),
  };
}

function workRequest(resourceClaims: readonly unknown[]): unknown {
  return {
    role: 'implementation',
    concern: 'missing owned component',
    objective: 'Implement the required component.',
    reason: 'The accepted handoff proves the current ownership is insufficient.',
    dependencies: [],
    capabilities: [],
    resourceClaims,
    evidence: [{ kind: 'file', reference: 'outside/component.ts', summary: 'Required component location.' }],
    risk: 'medium',
    priority: 50,
  };
}

async function ownershipFixture(payload: unknown, ownedFiles: readonly string[] = ['owned/**']): Promise<Fixture> {
  const spec = taskSpec({ files: ownedFiles });
  const value = await fixture([spec], (state) => failedTask(state, {
    status: 'BLOCKED',
    error: error('REVIEW_BLOCKED', 'Additional owned work is required'),
    handoffOutcome: 'valid',
    handoffPath: join(state.repositoryRoot, 'runs', state.runId, 'handoffs', `${taskId}.json`),
  }));
  value.state = { ...value.state, status: 'BLOCKED', tasks: { ...value.state.tasks,
    [taskId]: { ...value.state.tasks[taskId]!, status: 'BLOCKED' } } };
  await value.store.save(value.state);
  await writeFile(value.state.tasks[taskId]!.handoffPath!, `${JSON.stringify(payload)}\n`);
  return value;
}

test('OWNERSHIP_EXPANSION_REQUIRED requires a validated out-of-scope write claim', async () => {
  const value = await ownershipFixture(handoff([workRequest([
    { kind: 'repository_path', key: 'outside/**', mode: 'write' },
  ])]));
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.classification, 'OWNERSHIP_EXPANSION_REQUIRED');
    assert.equal(diagnosis.recommendedAction?.id, 'propose-replan');
  } finally { await value.dispose(); }
});

test('vague accepted handoff prose cannot trigger ownership expansion', async () => {
  const value = await ownershipFixture(handoff());
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.notEqual(diagnosis.classification, 'OWNERSHIP_EXPANSION_REQUIRED');
  } finally { await value.dispose(); }
});

const ownershipContainmentCases = [
  { name: 'literal file beneath owned glob is contained', owned: ['src/api/**'], claims: ['src/api/foo.ts'], expected: 'unknown' },
  { name: 'exact ownership glob is contained', owned: ['src/api/**'], claims: ['src/api/**'], expected: 'unknown' },
  { name: 'broader parent glob requires expansion', owned: ['src/api/**'], claims: ['src/**'], expected: 'OWNERSHIP_EXPANSION_REQUIRED' },
  { name: 'narrower child glob is contained', owned: ['src/**'], claims: ['src/api/**'], expected: 'unknown' },
  { name: 'deeper descendant glob is contained', owned: ['src/api/**'], claims: ['src/api/foo/**'], expected: 'unknown' },
  { name: 'ambiguous segment wildcard is not guessed safe or outside', owned: ['src/api/**'], claims: ['src/api*'], expected: 'unknown' },
  { name: 'one outside claim requires expansion alongside a contained claim', owned: ['src/api/**'], claims: ['src/api/**', 'src/other/**'], expected: 'OWNERSHIP_EXPANSION_REQUIRED' },
] as const;

for (const value of ownershipContainmentCases) {
  test(`ownership containment: ${value.name}`, async () => {
    const fixtureValue = await ownershipFixture(handoff([workRequest(value.claims.map((key) =>
      ({ kind: 'repository_path', key, mode: 'write' }))) ]), value.owned);
    try {
      const diagnosis = await diagnoseFailure(fixtureValue);
      assert.equal(diagnosis.classification ?? diagnosis.status, value.expected);
    } finally { await fixtureValue.dispose(); }
  });
}

test('read-only resource claims do not trigger write ownership expansion', async () => {
  const value = await ownershipFixture(handoff([workRequest([
    { kind: 'repository_path', key: 'outside/**', mode: 'read' },
  ])]), ['src/api/**']);
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.notEqual(diagnosis.classification, 'OWNERSHIP_EXPANSION_REQUIRED');
  } finally { await value.dispose(); }
});

test('malformed or unaccepted handoff evidence cannot trigger ownership expansion', async () => {
  const malformed = await ownershipFixture({ prose: 'Please also edit outside/**.' }, ['src/api/**']);
  const unaccepted = await ownershipFixture(handoff([workRequest([
    { kind: 'repository_path', key: 'outside/**', mode: 'write' },
  ])]), ['src/api/**']);
  unaccepted.state = { ...unaccepted.state, tasks: { ...unaccepted.state.tasks,
    [taskId]: { ...unaccepted.state.tasks[taskId]!, handoffOutcome: 'invalid' } } };
  try {
    for (const value of [malformed, unaccepted]) {
      const diagnosis = await diagnoseFailure(value);
      assert.equal(diagnosis.status, 'unknown');
      assert.notEqual(diagnosis.classification, 'OWNERSHIP_EXPANSION_REQUIRED');
    }
  } finally { await malformed.dispose(); await unaccepted.dispose(); }
});

test('persisted unresolved replan state proves ownership expansion without restarting proposal', async () => {
  const spec = taskSpec();
  const value = await fixture([spec], (state) => failedTask(state, {
    status: 'BLOCKED',
    error: error('REVIEW_BLOCKED', 'scope gap'),
  }));
  try {
    const diagnosis = await diagnoseFailure({ ...value, state: { ...value.state, status: 'BLOCKED', tasks: {
      ...value.state.tasks, [taskId]: { ...value.state.tasks[taskId]!, status: 'BLOCKED',
        replan: { proposalId: 'c'.repeat(64), phase: 'CHECKPOINT_READY', verificationAttempts: [] } },
    } } });
    assert.equal(diagnosis.classification, 'OWNERSHIP_EXPANSION_REQUIRED');
    assert.equal(diagnosis.recommendedAction?.id, 'manual-inspection');
    assert.equal(diagnosis.recommendedAction?.requiresHumanAuthorization, false);
  } finally { await value.dispose(); }
});

async function integrationFixture(failureText: string, stderrPathOverride?: string, oversized = false): Promise<Fixture> {
  const spec = taskSpec();
  const value = await fixture([spec], (state) => ({
    ...state,
    status: 'BLOCKED',
    tasks: { ...state.tasks, [taskId]: { ...state.tasks[taskId]!, status: 'SUCCEEDED', finishedAt: timestamp } },
    integration: {
      status: 'BLOCKED',
      integratedTaskCommits: [],
      error: error('INTEGRATION_TEST_FAILED', 'A required integration command failed'),
    },
  }));
  const logs = join(value.store.runDirectory, 'logs', 'integration');
  await mkdir(logs, { recursive: true });
  const passOut = join(logs, '01-first-gate.stdout.log');
  const passErr = join(logs, '01-first-gate.stderr.log');
  const failOut = join(logs, '02-database-gate.stdout.log');
  const failErr = stderrPathOverride ?? join(logs, '02-database-gate.stderr.log');
  await writeFile(passOut, 'ok\n'); await writeFile(passErr, ''); await writeFile(failOut, '');
  if (stderrPathOverride === undefined) await writeFile(failErr, oversized ? 'x'.repeat(2 * 1024 * 1024 + 1) : failureText);
  await appendEvents(value.store, [
    { name: 'INTEGRATION_STARTED' },
    { name: 'INTEGRATION_COMMAND_FINISHED', data: { index: 0, command: 'first-gate', required: true, exitCode: 0, timedOut: false, termination: null, stdoutPath: passOut, stderrPath: passErr } },
    { name: 'INTEGRATION_COMMAND_FINISHED', data: { index: 1, command: 'database-gate', required: true, exitCode: 2, timedOut: false, termination: null, stdoutPath: failOut, stderrPath: failErr } },
    { name: 'RUN_BLOCKED', data: { code: 'INTEGRATION_TEST_FAILED' } },
  ]);
  return value;
}

async function retriedIntegrationFixture(options: {
  readonly archivedAttempts: number;
  readonly currentFailure: string;
  readonly emittedBoundaries?: number;
  readonly currentLogLocation?: 'live' | 'archived';
  readonly omitCurrentLog?: boolean;
}): Promise<Fixture> {
  const spec = taskSpec();
  const archivedIntegration = () => ({
    status: 'BLOCKED' as const,
    integratedTaskCommits: [],
    error: error('INTEGRATION_TEST_FAILED', 'Archived required integration command failure'),
  });
  const value = await fixture([spec], (state) => ({
    ...state,
    status: 'BLOCKED',
    tasks: { ...state.tasks, [taskId]: { ...state.tasks[taskId]!, status: 'SUCCEEDED', finishedAt: timestamp } },
    integration: {
      status: 'BLOCKED',
      integratedTaskCommits: [],
      error: error('INTEGRATION_TEST_FAILED', 'Current required integration command failure'),
    },
    integrationAttempts: Array.from({ length: options.archivedAttempts }, archivedIntegration),
  }));
  const liveLogs = join(value.store.runDirectory, 'logs', 'integration');
  await mkdir(liveLogs, { recursive: true });
  const passOut = join(liveLogs, '01-first-gate.stdout.log');
  const passErr = join(liveLogs, '01-first-gate.stderr.log');
  const failOut = join(liveLogs, '02-database-gate.stdout.log');
  const liveFailErr = join(liveLogs, '02-database-gate.stderr.log');
  await writeFile(passOut, 'ok\n');
  await writeFile(passErr, '');
  await writeFile(failOut, '');
  if (options.omitCurrentLog !== true) await writeFile(liveFailErr, options.currentFailure);

  for (let attemptNumber = 1; attemptNumber <= options.archivedAttempts; attemptNumber += 1) {
    const archivedLogs = join(value.store.runDirectory, 'logs', `integration-attempt-${attemptNumber}`);
    await mkdir(archivedLogs, { recursive: true });
    await writeFile(join(archivedLogs, '02-database-gate.stderr.log'),
      'psql: connection to server at "localhost", port 55432 failed: Connection refused\n');
  }

  const currentFailErr = options.currentLogLocation === 'archived'
    ? join(value.store.runDirectory, 'logs', `integration-attempt-${options.archivedAttempts}`, '02-database-gate.stderr.log')
    : liveFailErr;
  const events: Omit<RunEvent, 'runId' | 'timestamp'>[] = [{ name: 'INTEGRATION_STARTED' }];
  const boundaryCount = options.emittedBoundaries ?? options.archivedAttempts;
  for (let attemptNumber = 1; attemptNumber <= options.archivedAttempts + 1; attemptNumber += 1) {
    const current = attemptNumber === options.archivedAttempts + 1;
    events.push(
      { name: 'INTEGRATION_COMMAND_FINISHED', data: { index: 0, command: 'first-gate', required: true,
        exitCode: 0, timedOut: false, termination: null, stdoutPath: passOut, stderrPath: passErr } },
      { name: 'INTEGRATION_COMMAND_FINISHED', data: { index: 1, command: 'database-gate', required: true,
        exitCode: 2, timedOut: false, termination: null, stdoutPath: failOut,
        stderrPath: current ? currentFailErr : liveFailErr } },
      { name: 'RUN_BLOCKED', data: { code: 'INTEGRATION_TEST_FAILED' } },
    );
    if (attemptNumber <= boundaryCount) {
      events.push({ name: 'RUN_RESUMED', data: { recoveryMode: 'integration_retry' } });
    }
  }
  await appendEvents(value.store, events);
  return value;
}

test('INTEGRATION_ENVIRONMENT_MISMATCH requires a later connection failure after earlier required gates passed', async () => {
  const value = await integrationFixture('psql: error: connection to server at "localhost", port 55432 failed: Connection refused\n');
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.classification, 'INTEGRATION_ENVIRONMENT_MISMATCH');
    assert.equal(diagnosis.recommendedAction?.id, 'retry-integration');
  } finally { await value.dispose(); }
});

test('a genuine failing assertion is not misclassified as an integration environment mismatch', async () => {
  const value = await integrationFixture('AssertionError: expected 1 to equal 2\n');
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.notEqual(diagnosis.classification, 'INTEGRATION_ENVIRONMENT_MISMATCH');
  } finally { await value.dispose(); }
});

test('current retry attempt cannot inherit archived connection-refused evidence at reused positional paths', async () => {
  const value = await retriedIntegrationFixture({ archivedAttempts: 1,
    currentFailure: 'AssertionError: current attempt expected 1 to equal 2\n' });
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.notEqual(diagnosis.classification, 'INTEGRATION_ENVIRONMENT_MISMATCH');
  } finally { await value.dispose(); }
});

test('a proven connection failure in the current retry attempt still classifies', async () => {
  const value = await retriedIntegrationFixture({ archivedAttempts: 1,
    currentFailure: 'connect ECONNREFUSED localhost:55432\n' });
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.classification, 'INTEGRATION_ENVIRONMENT_MISMATCH');
    assert.match(diagnosis.evidence.find((entry) => entry.kind === 'event')?.summary ?? '', /current attempt 2/i);
  } finally { await value.dispose(); }
});

test('missing current-attempt logs fail closed even when an archived attempt proves connection refusal', async () => {
  const value = await retriedIntegrationFixture({ archivedAttempts: 1, currentFailure: '', omitCurrentLog: true });
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.equal(diagnosis.classification, undefined);
  } finally { await value.dispose(); }
});

test('current attempt events cannot cite an archived attempt log', async () => {
  const value = await retriedIntegrationFixture({ archivedAttempts: 1,
    currentFailure: 'AssertionError: current attempt failed\n', currentLogLocation: 'archived' });
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.equal(diagnosis.classification, undefined);
  } finally { await value.dispose(); }
});

test('two retry cycles select only attempt 3 evidence', async () => {
  const productFailure = await retriedIntegrationFixture({ archivedAttempts: 2,
    currentFailure: 'AssertionError: attempt 3 product test failed\n' });
  const environmentFailure = await retriedIntegrationFixture({ archivedAttempts: 2,
    currentFailure: 'could not connect to server: Connection refused\n' });
  try {
    const productDiagnosis = await diagnoseFailure(productFailure);
    assert.equal(productDiagnosis.status, 'unknown');
    assert.notEqual(productDiagnosis.classification, 'INTEGRATION_ENVIRONMENT_MISMATCH');
    const environmentDiagnosis = await diagnoseFailure(environmentFailure);
    assert.equal(environmentDiagnosis.classification, 'INTEGRATION_ENVIRONMENT_MISMATCH');
    assert.match(environmentDiagnosis.evidence.find((entry) => entry.kind === 'event')?.summary ?? '', /current attempt 3/i);
  } finally { await productFailure.dispose(); await environmentFailure.dispose(); }
});

test('archive state without its matching retry boundary fails closed', async () => {
  const value = await retriedIntegrationFixture({ archivedAttempts: 2, emittedBoundaries: 1,
    currentFailure: 'connect ECONNREFUSED localhost:55432\n' });
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.equal(diagnosis.classification, undefined);
  } finally { await value.dispose(); }
});

test('completed Phase-7-shaped state returns no_active_failure instead of historical classifications', async () => {
  const spec = taskSpec({ mode: 'final_review', writer: false });
  const value = await fixture([spec], (state) => ({
    ...state,
    status: 'COMPLETED',
    tasks: { ...state.tasks, [taskId]: { ...state.tasks[taskId]!, status: 'SUCCEEDED', finishedAt: timestamp } },
    integration: { status: 'SUCCEEDED', integratedTaskCommits: [] },
    integrationAttempts: [{ status: 'BLOCKED', integratedTaskCommits: [], error: error('INTEGRATION_TEST_FAILED', 'historical') }],
  }));
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'no_active_failure');
    assert.equal(diagnosis.classification, undefined);
    assert.equal(diagnosis.recommendedAction, undefined);
  } finally { await value.dispose(); }
});

test('multiple independent blockers return deterministic unknown evidence rather than arbitrary selection', async () => {
  const first = taskSpec({ id: 'z-task' });
  const second = taskSpec({ id: 'a-task' });
  const value = await fixture([first, second], (state) => ({
    ...state,
    status: 'FAILED',
    tasks: Object.fromEntries(Object.entries(state.tasks).map(([id, task]) => [id, {
      ...task, status: 'FAILED', finishedAt: timestamp, error: error('AGENT_FAILED', `${id} failed`),
    }])),
  }));
  try {
    const one = await diagnoseFailure(value);
    const two = await diagnoseFailure(value);
    assert.equal(one.status, 'unknown');
    assert.deepEqual(one, two);
    assert.deepEqual(one.evidence.slice(1).map((entry) => entry.reference), ['task:a-task.status', 'task:z-task.status']);
  } finally { await value.dispose(); }
});

test('outside-run integration log paths fail closed', async () => {
  const outside = join(tmpdir(), `outside-fi-${process.pid}.log`);
  await writeFile(outside, 'connect ECONNREFUSED localhost:55432\n');
  const value = await integrationFixture('', outside);
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.equal(diagnosis.classification, undefined);
  } finally { await value.dispose(); await rm(outside, { force: true }); }
});

test('oversized connection logs fail closed instead of producing a guessed diagnosis', async () => {
  const value = await integrationFixture('connect ECONNREFUSED localhost:55432\n', undefined, true);
  try {
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.equal(diagnosis.classification, undefined);
  } finally { await value.dispose(); }
});

test('unreadable connection evidence fails closed instead of producing a guessed diagnosis', async () => {
  const value = await integrationFixture('connect ECONNREFUSED localhost:55432\n');
  try {
    await rm(join(value.store.runDirectory, 'logs', 'integration', '02-database-gate.stderr.log'));
    const diagnosis = await diagnoseFailure(value);
    assert.equal(diagnosis.status, 'unknown');
    assert.equal(diagnosis.classification, undefined);
  } finally { await value.dispose(); }
});

test('diagnose CLI is byte-stable, deterministic, provider-free, and creates no commit or worktree', async () => {
  const repository = await createTemporaryRepository();
  try {
    const runId = 'run-fi-cli';
    const runsRoot = join(repository.repository, 'tools', 'agent-orchestrator', 'runs');
    const store = new StateStore(runsRoot, runId);
    const spec = taskSpec({ owner: 'codex' });
    const marker = join(repository.container, 'provider-invoked');
    const executable = join(repository.container, 'codex');
    await writeFile(executable, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(executable, 0o755);
    const state = {
      ...createRunState({ runId, phase: 1, repositoryRoot: repository.repository,
        baseBranch: repository.baseBranch, baseSha: repository.baseSha, tasks: [spec],
        agentExecutables: { codex: executable }, clock: () => new Date(timestamp) }),
      status: 'COMPLETED' as const,
      tasks: { [taskId]: { id: taskId, status: 'SUCCEEDED' as const, agentAttempts: [], reviewRounds: 0,
        reviewPaths: [], handoffRepairAttempts: [], finishedAt: timestamp } },
      integration: { status: 'SUCCEEDED' as const, integratedTaskCommits: [] },
    };
    await store.initialize(state);
    await writeFile(store.eventsPath, '');
    const phase = [
      'phase: 1',
      'name: Failure intelligence CLI fixture',
      `baseBranch: ${repository.baseBranch}`,
      'canonicalDesignDocument: shared.txt',
      'concurrency: 1',
      'maxReviewRounds: 2',
      'agentRetries: 0',
      'agentTimeoutMs: 60000',
      'tasks:',
      `  - id: ${taskId}`,
      '    title: Subject',
      '    owner: codex',
      '    effort: high',
      '    mode: implementation',
      '    files: ["owned/**"]',
      '    dependsOn: []',
      '    writer: true',
      'integration:',
      '  commands:',
      '    - command: "true"',
      '      required: true',
      '',
    ].join('\n');
    const phasePath = join(store.runDirectory, 'phase.yaml');
    await writeFile(phasePath, phase);
    const before = await Promise.all([readFile(store.statePath), readFile(store.eventsPath), readFile(phasePath)]);
    const head = await repository.git.resolveCommit(repository.repository, 'HEAD');
    const cli = resolve(__dirname, '../../src/cli.js');
    const first = spawnSync(process.execPath, [cli, 'diagnose', runId], { cwd: repository.repository, encoding: 'utf8' });
    const second = spawnSync(process.execPath, [cli, 'diagnose', runId], { cwd: repository.repository, encoding: 'utf8' });
    const explicit = spawnSync(process.execPath, [cli, 'diagnose', runId, taskId], { cwd: repository.repository, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(explicit.status, 0, explicit.stderr);
    assert.equal(first.stdout, second.stdout);
    assert.equal(JSON.parse(first.stdout).diagnosis.status, 'no_active_failure');
    assert.deepEqual(JSON.parse(explicit.stdout).diagnosis.subject, { kind: 'task', taskId });
    const after = await Promise.all([readFile(store.statePath), readFile(store.eventsPath), readFile(phasePath)]);
    assert.deepEqual(after, before);
    assert.equal(await repository.git.resolveCommit(repository.repository, 'HEAD'), head);
    assert.equal(spawnSync('test', ['!', '-e', marker]).status, 0);
    assert.equal(spawnSync('test', ['!', '-e', join(repository.repository, '.agent-worktrees')]).status, 0);
  } finally { await repository.dispose(); }
});
