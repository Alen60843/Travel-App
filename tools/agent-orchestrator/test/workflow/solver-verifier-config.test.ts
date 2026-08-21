import assert from 'node:assert/strict';
import test from 'node:test';

import { isOrchestratorError } from '../../src/errors';
import {
  expandSolverVerifierWorkflow,
  parseSolverVerifierPhaseFile,
  SEMANTIC_ROLE_BY_TASK_MODE,
} from '../../src/workflow/solver-verifier';

function baseFile(workflowOverrides: Record<string, unknown> = {}): unknown {
  return {
    phase: 'sv-test',
    name: 'Solver/Verifier config test',
    baseBranch: 'main',
    workflow: {
      mode: 'solver_verifier',
      files: ['apps/api/src/example/**'],
      solver: { agent: 'codex', effort: 'high' },
      verifier: { agent: 'claude', effort: 'high' },
      correction: { agent: 'codex', effort: 'high' },
      maxCorrectionRounds: 1,
      ...workflowOverrides,
    },
    deterministicGate: { commands: ['node -e "process.exit(0)"'] },
  };
}

test('a minimal solver_verifier file parses and expands to solve -> verify -> fix -> reverify', () => {
  const parsed = parseSolverVerifierPhaseFile(baseFile());
  const config = expandSolverVerifierWorkflow(parsed);
  assert.deepEqual(
    config.tasks.map((task) => task.id),
    ['solve', 'verify', 'fix', 'reverify'],
  );
  assert.equal(config.tasks[0]?.mode, 'implementation');
  assert.equal(config.tasks[1]?.mode, 'review');
  assert.equal(config.tasks[2]?.mode, 'correction');
  assert.equal(config.tasks[3]?.mode, 'final_review');
  assert.deepEqual(config.tasks[3]?.dependsOn, ['fix']);
  assert.equal(config.maxReviewRounds, 2);
});

test('maxCorrectionRounds: 0 expands to only solve -> verify, no fix/reverify', () => {
  const parsed = parseSolverVerifierPhaseFile(
    baseFile({ maxCorrectionRounds: 0 }),
  );
  const config = expandSolverVerifierWorkflow(parsed);
  assert.deepEqual(
    config.tasks.map((task) => task.id),
    ['solve', 'verify'],
  );
  assert.equal(config.maxReviewRounds, 1);
});

test('escalation.enabled adds a judge task depending on the final reverify', () => {
  const parsed = parseSolverVerifierPhaseFile(
    baseFile({
      escalation: { enabled: true, agent: 'claude', effort: 'extra_high' },
    }),
  );
  const config = expandSolverVerifierWorkflow(parsed);
  assert.deepEqual(
    config.tasks.map((task) => task.id),
    ['solve', 'verify', 'fix', 'reverify', 'judge'],
  );
  const judge = config.tasks.find((task) => task.id === 'judge');
  assert.equal(judge?.mode, 'escalation');
  assert.deepEqual(judge?.dependsOn, ['reverify']);
  assert.equal(judge?.writer, false);
});

test('escalation without a correction round (maxCorrectionRounds: 0) is rejected', () => {
  assert.throws(
    () =>
      expandSolverVerifierWorkflow(
        parseSolverVerifierPhaseFile(
          baseFile({
            maxCorrectionRounds: 0,
            escalation: { enabled: true, agent: 'claude', effort: 'high' },
          }),
        ),
      ),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('maxCorrectionRounds outside {0,1} is rejected at parse time, not clamped', () => {
  assert.throws(
    () => parseSolverVerifierPhaseFile(baseFile({ maxCorrectionRounds: 2 })),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('model is threaded onto the generated task when supplied, absent otherwise', () => {
  const parsed = parseSolverVerifierPhaseFile(
    baseFile({ solver: { agent: 'codex', effort: 'high', model: 'gpt-5-example' } }),
  );
  const config = expandSolverVerifierWorkflow(parsed);
  const solve = config.tasks.find((task) => task.id === 'solve');
  assert.equal(solve?.model, 'gpt-5-example');
  const verify = config.tasks.find((task) => task.id === 'verify');
  assert.equal(verify?.model, undefined);
});

test('unknown workflow keys are rejected rather than silently ignored', () => {
  assert.throws(
    () => parseSolverVerifierPhaseFile(baseFile({ unexpectedField: true })),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('an unsupported workflow.mode is rejected', () => {
  assert.throws(
    () => parseSolverVerifierPhaseFile(baseFile({ mode: 'not_a_real_mode' })),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});

test('the generated task graph passes the same DAG/ownership validation as a hand-written phase file', () => {
  // expandSolverVerifierWorkflow calls parsePhaseConfig internally; a config
  // that reached this point already survived cycle detection and ownership
  // overlap checks with zero special-casing for this workflow shape.
  const config = expandSolverVerifierWorkflow(parseSolverVerifierPhaseFile(baseFile()));
  assert.equal(config.tasks.length, 4);
});

test('SEMANTIC_ROLE_BY_TASK_MODE names every generated task mode', () => {
  for (const mode of ['implementation', 'review', 'correction', 'final_review', 'escalation']) {
    assert.ok(mode in SEMANTIC_ROLE_BY_TASK_MODE, `missing role mapping for ${mode}`);
  }
  assert.equal(SEMANTIC_ROLE_BY_TASK_MODE.implementation, 'SOLVER');
  assert.equal(SEMANTIC_ROLE_BY_TASK_MODE.review, 'VERIFIER');
  assert.equal(SEMANTIC_ROLE_BY_TASK_MODE.final_review, 'VERIFIER');
  assert.equal(SEMANTIC_ROLE_BY_TASK_MODE.correction, 'FIXER');
  assert.equal(SEMANTIC_ROLE_BY_TASK_MODE.escalation, 'JUDGE');
  assert.equal(SEMANTIC_ROLE_BY_TASK_MODE.integration, 'INTEGRATOR');
});
