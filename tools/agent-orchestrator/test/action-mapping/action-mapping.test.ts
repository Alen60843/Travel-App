import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { mapFailureToActions } from '../../src/action-mapping/mapper';
import { ACTION_IDS } from '../../src/action-mapping/types';
import type { FailureClassification, FailureDiagnosis, FailureVariant } from '../../src/failure-intelligence/types';

function diagnosed(
  classification: FailureClassification,
  options: { readonly kind?: 'task' | 'integration' | 'run'; readonly variant?: FailureVariant } = {},
): FailureDiagnosis {
  const kind = options.kind ?? 'task';
  return {
    version: 1,
    status: 'diagnosed',
    runId: 'run-action-mapping',
    subject: kind === 'task' ? { kind, taskId: 'task-1' } : { kind },
    classification,
    ...(options.variant === undefined ? {} : { variant: options.variant }),
    evidence: [
      { kind: 'state', reference: 'state-ref', summary: 'Persisted state evidence.' },
      { kind: 'event', reference: 'event-ref', summary: 'Persisted event evidence.' },
    ],
  };
}

test('AGENT_EXECUTABLE_DRIFT maps to REPIN_AGENT_EXECUTABLE', () => {
  const [action] = mapFailureToActions(diagnosed('AGENT_EXECUTABLE_DRIFT'));
  assert.equal(action?.id, 'REPIN_AGENT_EXECUTABLE');
  assert.deepEqual(action?.basis, {
    classification: 'AGENT_EXECUTABLE_DRIFT',
    evidenceReferences: ['state-ref', 'event-ref'],
  });
});

test('executable repin mapping selects no replacement executable', () => {
  const [action] = mapFailureToActions(diagnosed('AGENT_EXECUTABLE_DRIFT'));
  assert.deepEqual(action?.command, {
    script: 'agents:repin-agent-executable',
    args: ['run-action-mapping', '<agent>', '<absolute-executable-path>'],
  });
  assert.equal(action?.command?.args.some((argument) => argument.startsWith('/')), false);
});

test('executable repin metadata preserves a diagnosed agent without runtime discovery', () => {
  const diagnosis = { ...diagnosed('AGENT_EXECUTABLE_DRIFT'), agent: 'codex' as const };
  const [action] = mapFailureToActions(diagnosis);
  assert.deepEqual(action?.command?.args, ['run-action-mapping', 'codex', '<absolute-executable-path>']);
});

test('MALFORMED_REVIEW_OUTPUT maps to RETRY_REVIEW_OUTPUT', () => {
  const [action] = mapFailureToActions(diagnosed('MALFORMED_REVIEW_OUTPUT'));
  assert.equal(action?.id, 'RETRY_REVIEW_OUTPUT');
  assert.deepEqual(action?.command?.args, ['run-action-mapping', 'task-1']);
});

test('specialized provider contract diagnosis maps to CONTINUE_CLAUDE_REVIEW_OUTPUT', () => {
  const [action] = mapFailureToActions(diagnosed('PROVIDER_OUTPUT_CONTRACT_FAILURE', {
    variant: 'CLAUDE_TEXT_CONTRACT_MIGRATION',
  }));
  assert.equal(action?.id, 'CONTINUE_CLAUDE_REVIEW_OUTPUT');
});

test('generic provider contract diagnosis maps only to MANUAL_INSPECTION', () => {
  const [action] = mapFailureToActions(diagnosed('PROVIDER_OUTPUT_CONTRACT_FAILURE'));
  assert.equal(action?.id, 'MANUAL_INSPECTION');
  assert.equal(action?.command, undefined);
});

test('classification and subject mismatches fail closed', () => {
  assert.deepEqual(mapFailureToActions(diagnosed('PROVIDER_OUTPUT_CONTRACT_FAILURE', { kind: 'run' })), []);
  assert.deepEqual(mapFailureToActions(diagnosed('INTEGRATION_ENVIRONMENT_MISMATCH')), []);
});

test('OWNERSHIP_EXPANSION_REQUIRED maps to PROPOSE_REPLAN when no manual variant is present', () => {
  const [action] = mapFailureToActions(diagnosed('OWNERSHIP_EXPANSION_REQUIRED'));
  assert.equal(action?.id, 'PROPOSE_REPLAN');
});

test('existing ownership checkpoint remains a MANUAL_INSPECTION candidate', () => {
  const [action] = mapFailureToActions(diagnosed('OWNERSHIP_EXPANSION_REQUIRED', {
    variant: 'EXISTING_REPLAN_CHECKPOINT',
  }));
  assert.equal(action?.id, 'MANUAL_INSPECTION');
});

test('INTEGRATION_ENVIRONMENT_MISMATCH maps to RETRY_INTEGRATION with correction-first reason', () => {
  const [action] = mapFailureToActions(diagnosed('INTEGRATION_ENVIRONMENT_MISMATCH', { kind: 'integration' }));
  assert.equal(action?.id, 'RETRY_INTEGRATION');
  assert.match(action?.reason ?? '', /Correct the external environment first/);
});

test('unknown diagnosis gets no mutating candidate', () => {
  const diagnosis: FailureDiagnosis = {
    version: 1, status: 'unknown', runId: 'run-action-mapping', subject: { kind: 'run' }, evidence: [],
  };
  assert.deepEqual(mapFailureToActions(diagnosis), []);
});

test('no_active_failure maps to no candidates', () => {
  const diagnosis: FailureDiagnosis = {
    version: 1, status: 'no_active_failure', runId: 'run-action-mapping', subject: { kind: 'run' }, evidence: [],
  };
  assert.deepEqual(mapFailureToActions(diagnosis), []);
});

test('every mutating v1 action requires explicit human authority', () => {
  const diagnoses = [
    diagnosed('AGENT_EXECUTABLE_DRIFT'),
    diagnosed('MALFORMED_REVIEW_OUTPUT'),
    diagnosed('PROVIDER_OUTPUT_CONTRACT_FAILURE', { variant: 'CLAUDE_TEXT_CONTRACT_MIGRATION' }),
    diagnosed('OWNERSHIP_EXPANSION_REQUIRED'),
    diagnosed('INTEGRATION_ENVIRONMENT_MISMATCH', { kind: 'integration' }),
  ];
  const actions = diagnoses.flatMap((diagnosis) => [...mapFailureToActions(diagnosis)]);
  assert.equal(actions.every((action) => action.mutatesState
    && action.execution === 'manual'
    && action.authority.kind === 'human'
    && action.authority.required), true);
});

test('MANUAL_INSPECTION is non-mutating and needs no authorization', () => {
  const [action] = mapFailureToActions(diagnosed('PROVIDER_OUTPUT_CONTRACT_FAILURE'));
  assert.equal(action?.mutatesState, false);
  assert.deepEqual(action?.authority, { kind: 'human', required: false });
  assert.equal(action?.execution, 'manual');
});

test('mapper has no filesystem, StateStore, provider, Git, or orchestrator dependency', async () => {
  const source = await readFile(resolve(__dirname, '../../../src/action-mapping/mapper.ts'), 'utf8');
  const imports = source.split('\n').filter((line) => line.startsWith('import ')).join('\n');
  assert.doesNotMatch(imports, /node:fs|StateStore|ClaudeAgent|CodexAgent|GitClient|AgentOrchestrator|child_process/);
});

test('mapping output is deterministic and contains no timestamps or random IDs', () => {
  const diagnosis = diagnosed('MALFORMED_REVIEW_OUTPUT');
  const first = mapFailureToActions(diagnosis);
  const second = mapFailureToActions(diagnosis);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
  assert.doesNotMatch(JSON.stringify(first), /timestamp|authorizedAt|createdAt/);
});

test('stable action IDs are symbolic and independent of CLI script strings', () => {
  assert.deepEqual(ACTION_IDS, [
    'REPIN_AGENT_EXECUTABLE',
    'RETRY_REVIEW_OUTPUT',
    'CONTINUE_CLAUDE_REVIEW_OUTPUT',
    'PROPOSE_REPLAN',
    'RETRY_INTEGRATION',
    'MANUAL_INSPECTION',
  ]);
  const [action] = mapFailureToActions(diagnosed('MALFORMED_REVIEW_OUTPUT'));
  assert.notEqual(action?.id, action?.command?.script);
});

test('command metadata is a structured hint for an unchanged authoritative command', () => {
  const actions = [
    ...mapFailureToActions(diagnosed('MALFORMED_REVIEW_OUTPUT')),
    ...mapFailureToActions(diagnosed('OWNERSHIP_EXPANSION_REQUIRED')),
    ...mapFailureToActions(diagnosed('INTEGRATION_ENVIRONMENT_MISMATCH', { kind: 'integration' })),
  ];
  assert.deepEqual(actions.map((action) => action.command?.script), [
    'agents:retry-review-output', 'agents:propose-replan', 'agents:retry-integration',
  ]);
  assert.equal(actions.every((action) => action.execution === 'manual'
    && /independently|separate authorization|explicitly retry/.test(action.reason)), true);
});

test('completed real-Phase-7-shaped diagnosis maps to no actions', () => {
  const diagnosis: FailureDiagnosis = {
    version: 1,
    status: 'no_active_failure',
    runId: 'run-20260910100819-8ddbdc28',
    subject: { kind: 'run' },
    evidence: [{ kind: 'state', reference: 'run.status', summary: 'Run status is COMPLETED.' }],
  };
  assert.deepEqual(mapFailureToActions(diagnosis), []);
});
