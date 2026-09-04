import assert from 'node:assert/strict';
import test from 'node:test';

import { parsePhaseConfigYaml } from '../../src/config';
import { isOrchestratorError } from '../../src/errors';
import {
  assertReviewRoundAllowed,
  computeExecutionWaves,
  TaskScheduler,
} from '../../src/tasks/scheduler';
import type { TaskSpec } from '../../src/tasks/task-schema';

function task(
  id: string,
  dependsOn: readonly string[] = [],
  files: readonly string[] = [`src/${id}/**`],
): TaskSpec {
  return {
    id,
    title: id,
    owner: 'codex',
    effort: 'high',
    mode: 'implementation',
    files,
    dependsOn,
    writer: true,
  };
}

test('phase YAML is decoded, validated, and defaulted', () => {
  const config = parsePhaseConfigYaml(`
phase: 5
name: Explorer
baseBranch: phase5/explorer
concurrency: 2
tasks:
  - id: query
    title: Query
    owner: codex
    mode: implementation
    effort: high
    files:
      - apps/api/src/explorer/**
    dependsOn: []
  - id: review
    title: Review
    owner: claude
    mode: review
    effort: high
    dependsOn: [query]
integration:
  prepare:
    - node --version
  commands:
    - pnpm test
`);

  assert.equal(config.agentRetries, 1);
  assert.equal(config.maxReviewRounds, 2);
  assert.equal(config.tasks[0]?.writer, true);
  assert.equal(config.tasks[1]?.writer, false);
  assert.deepEqual(config.tasks[1]?.dependsOn, ['query']);
  assert.equal(config.integration.commands[0]?.required, true);
  assert.equal(config.integration.prepare[0]?.command, 'node --version');
});

test('integration preparation is optional and static phases retain empty defaults', () => {
  const config = parsePhaseConfigYaml(`
phase: 1
name: static compatibility
baseBranch: main
tasks:
  - id: work
    title: work
    owner: codex
    mode: review
`);
  assert.deepEqual(config.integration, { prepare: [], commands: [], diagnostics: [] });
});

test('maxHandoffRepairAttempts defaults to 2 when absent from phase YAML', () => {
  const config = parsePhaseConfigYaml(`
phase: 5
name: Explorer
baseBranch: phase5/explorer
tasks:
  - id: query
    title: Query
    owner: codex
    mode: implementation
    effort: high
    files:
      - apps/api/src/explorer/**
`);
  assert.equal(config.maxHandoffRepairAttempts, 2);
});

test('maxHandoffRepairAttempts honors an explicit positive integer', () => {
  const config = parsePhaseConfigYaml(`
phase: 5
name: Explorer
baseBranch: phase5/explorer
maxHandoffRepairAttempts: 5
tasks:
  - id: query
    title: Query
    owner: codex
    mode: implementation
    effort: high
    files:
      - apps/api/src/explorer/**
`);
  assert.equal(config.maxHandoffRepairAttempts, 5);
});

test('maxHandoffRepairAttempts rejects a non-positive value', () => {
  assert.throws(
    () =>
      parsePhaseConfigYaml(`
phase: 5
name: Explorer
baseBranch: phase5/explorer
maxHandoffRepairAttempts: 0
tasks:
  - id: query
    title: Query
    owner: codex
    mode: implementation
    effort: high
    files:
      - apps/api/src/explorer/**
`),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('cycle detection reports a stable DAG_CYCLE error', () => {
  assert.throws(
    () =>
      parsePhaseConfigYaml(`
phase: 5
name: cyclic
baseBranch: phase5/explorer
tasks:
  - id: a
    title: a
    owner: codex
    mode: implementation
    files: [a/**]
    dependsOn: [b]
  - id: b
    title: b
    owner: codex
    mode: implementation
    files: [b/**]
    dependsOn: [a]
`),
    (error: unknown) => isOrchestratorError(error, 'DAG_CYCLE'),
  );
});

test('phase YAML aliases are rejected instead of expanded', () => {
  assert.throws(
    () => parsePhaseConfigYaml(`
phase: 5
name: aliases
baseBranch: phase5/explorer
tasks:
  - &task
    id: query
    title: Query
    owner: codex
    mode: implementation
    files: [query/**]
  - *task
`),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('debate mode cannot make two agents share writer access', () => {
  assert.throws(
    () => parsePhaseConfigYaml(`
phase: design
name: unsafe debate
baseBranch: phase5/explorer
tasks:
  - id: architecture
    title: Architecture debate
    owner: codex
    mode: debate
    writer: true
    files: [docs/**]
`),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('execution waves preserve dependencies and group independent work', () => {
  const tasks = [task('a'), task('b'), task('c', ['a', 'b']), task('d', ['c'])];
  assert.deepEqual(
    computeExecutionWaves(tasks).map((wave) => wave.map(({ id }) => id)),
    [['a', 'b'], ['c'], ['d']],
  );

  const scheduler = new TaskScheduler(tasks, 2);
  assert.deepEqual(scheduler.claimReady().map(({ id }) => id), ['a', 'b']);
  scheduler.transition('a', 'SUCCEEDED');
  assert.deepEqual(scheduler.claimReady(), []);
  scheduler.transition('b', 'SUCCEEDED');
  assert.deepEqual(scheduler.claimReady().map(({ id }) => id), ['c']);
  scheduler.transition('c', 'FAILED');
  assert.equal(scheduler.status('d'), 'BLOCKED');
});

test('review loops stop at the configured maximum', () => {
  assert.doesNotThrow(() => assertReviewRoundAllowed(1, 2));
  assert.throws(
    () => assertReviewRoundAllowed(2, 2),
    (error: unknown) => isOrchestratorError(error, 'BLOCKED_FOR_HUMAN_REVIEW'),
  );
});
