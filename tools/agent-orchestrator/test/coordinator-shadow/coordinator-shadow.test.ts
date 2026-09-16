import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { promisify } from 'node:util';
import test from 'node:test';

import { buildContextBundle, type ContextBuildResult, type ContextBundle } from '../../src/context-builder';
import {
  buildShadowContextForRun,
  coordinateShadowContext,
  coordinateShadowRun,
  ShadowCoordinatorError,
  type CapableCoordinatorReasoner,
} from '../../src/coordinator-shadow';
import type { FailureClassification, FailureDiagnosis } from '../../src/failure-intelligence/types';
import { buildMemoryGraph, type RelevantMemoryResult } from '../../src/memory-graph';
import { createMemoryEntry, type MemoryEntry, type MemoryQuery, type MemorySubject } from '../../src/memory';
import type { CapabilityProfile } from '../../src/role-capabilities';

const execFileAsync = promisify(execFile);

class FakeReasoner implements CapableCoordinatorReasoner {
  calls = 0;
  readonly contexts: ContextBundle[] = [];

  constructor(
    private readonly response: unknown,
    readonly capabilityProfile: CapabilityProfile = {
      version: 1,
      capabilities: ['structured_reasoning', 'structured_output'],
    },
  ) {}

  async propose(context: ContextBundle): Promise<unknown> {
    this.calls += 1;
    this.contexts.push(context);
    return this.response;
  }
}

test('no_active_failure plus no_action produces a canonical non-authoritative NO_ACTION report', async () => {
  const reasoner = new FakeReasoner(proposal('no_action', {
    supportingReferences: [{ kind: 'current_evidence', reference: 'run.status' }],
  }));
  const report = await coordinateShadowContext(context('no_active_failure'), reasoner);
  assert.equal(reasoner.calls, 1);
  assert.deepEqual(report, {
    version: 1,
    mode: 'shadow',
    authoritative: false,
    executed: false,
    persisted: false,
    result: {
      version: 1,
      status: 'decided',
      decision: {
        version: 1,
        scope: { runId: 'run-current', subject: { kind: 'run' } },
        kind: 'NO_ACTION',
        reason: 'Bounded shadow conclusion.',
        supportingReferences: [{ kind: 'current_evidence', reference: 'run.status' }],
      },
    },
  });
});

test('fictional action under no_active_failure remains PROPOSAL_INVALID', async () => {
  const report = await coordinateShadowContext(context('no_active_failure'),
    new FakeReasoner(proposal('select_action', { actionId: 'RETRY_INTEGRATION' })));
  assert.equal(report.result.status, 'reasoner_failed');
  if (report.result.status === 'reasoner_failed') assert.equal(report.result.code, 'PROPOSAL_INVALID');
});

test('diagnosed failure may select its exact trusted current candidate', async () => {
  const report = await coordinateShadowContext(context('diagnosed', 'MALFORMED_REVIEW_OUTPUT'),
    new FakeReasoner(proposal('select_action', { actionId: 'RETRY_REVIEW_OUTPUT' })));
  assert.equal(report.result.status, 'decided');
  if (report.result.status === 'decided') {
    assert.equal(report.result.decision.kind, 'SELECT_ACTION');
    if (report.result.decision.kind === 'SELECT_ACTION') {
      assert.equal(report.result.decision.selectedAction.actionId, 'RETRY_REVIEW_OUTPUT');
      assert.equal(report.result.decision.selectedAction.authority.required, true);
    }
  }
});

test('historical candidate cannot satisfy a current selection', async () => {
  const runSubject: MemorySubject = { kind: 'task', taskId: 'task-x' };
  const oldFailure = createMemoryEntry({
    version: 1,
    kind: 'FAILURE',
    subject: runSubject,
    data: { diagnosisVersion: 1, classification: 'AGENT_EXECUTABLE_DRIFT', agent: 'claude' },
    provenance: { sourceKind: 'failure_diagnosis', producerVersion: 1, runId: 'run-old',
      taskId: 'task-x', references: ['old:error'] },
  }) as Extract<MemoryEntry, { readonly kind: 'FAILURE' }>;
  const oldAction = createMemoryEntry({
    version: 1,
    kind: 'ACTION_CANDIDATE',
    subject: runSubject,
    data: { actionVersion: 1, actionId: 'REPIN_AGENT_EXECUTABLE', mutatesState: true,
      execution: 'manual', authority: { kind: 'human', required: true },
      basisClassification: 'AGENT_EXECUTABLE_DRIFT', sourceFailureMemoryId: oldFailure.id },
    provenance: { sourceKind: 'action_mapping', producerVersion: 1, runId: 'run-old',
      taskId: 'task-x', references: ['old:error'] },
  }) as Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }>;
  const report = await coordinateShadowContext(
    context('diagnosed', 'MALFORMED_REVIEW_OUTPUT', [oldFailure, oldAction]),
    new FakeReasoner(proposal('select_action', { actionId: 'REPIN_AGENT_EXECUTABLE' })),
  );
  assert.equal(report.result.status, 'reasoner_failed');
  if (report.result.status === 'reasoner_failed') assert.equal(report.result.code, 'PROPOSAL_INVALID');
});

test('unknown accepts HUMAN_REQUIRED and rejects NO_ACTION', async () => {
  const accepted = await coordinateShadowContext(context('unknown'),
    new FakeReasoner(proposal('human_required')));
  const rejected = await coordinateShadowContext(context('unknown'),
    new FakeReasoner(proposal('no_action')));
  assert.equal(accepted.result.status, 'decided');
  if (accepted.result.status === 'decided') assert.equal(accepted.result.decision.kind, 'HUMAN_REQUIRED');
  assert.equal(rejected.result.status, 'reasoner_failed');
});

test('context limit invokes a compatible provider zero times', async () => {
  const reasoner = new FakeReasoner(proposal('no_action'));
  const limited: ContextBuildResult = {
    version: 1,
    status: 'limit_exceeded',
    scope: { runId: 'run-current', subject: { kind: 'run' } },
    limit: { kind: 'canonical_bytes', maximumBytes: 1, actualBytes: 2 },
  };
  const report = await coordinateShadowContext(limited, reasoner);
  assert.equal(reasoner.calls, 0);
  assert.equal(report.result.status, 'context_unavailable');
});

test('capability mismatch fails before provider invocation', async () => {
  const reasoner = new FakeReasoner(proposal('no_action'), {
    version: 1,
    capabilities: ['structured_reasoning'],
  });
  await assert.rejects(() => coordinateShadowContext(context('no_active_failure'), reasoner),
    (error: unknown) => error instanceof ShadowCoordinatorError && error.code === 'CAPABILITY_MISMATCH');
  assert.equal(reasoner.calls, 0);
});

test('same shadow input and proposal produce deterministic structured output', async () => {
  const first = await coordinateShadowContext(context('unknown'), new FakeReasoner(proposal('human_required')));
  const second = await coordinateShadowContext(context('unknown'), new FakeReasoner(proposal('human_required')));
  assert.deepEqual(first, second);
});

test('requested task absent from trusted run state fails closed before provider invocation', async () => {
  const repositoryRoot = resolve(__dirname, '../../../../..');
  const reasoner = new FakeReasoner(proposal('human_required'));
  await assert.rejects(() => coordinateShadowRun({
    repositoryRoot,
    runId: 'run-20260910100819-8ddbdc28',
    taskId: 'task-does-not-exist',
    reasoner,
  }));
  assert.equal(reasoner.calls, 0);
});

test('run loading queries exact-subject Memory across runs without a physical run filter', async () => {
  const repositoryRoot = resolve(__dirname, '../../../../..');
  let query: MemoryQuery | undefined;
  await buildShadowContextForRun({
    repositoryRoot,
    runId: 'run-20260910100819-8ddbdc28',
    memoryReader: {
      getMemory: async () => undefined,
      listMemory: async (input) => {
        query = input;
        return [];
      },
    },
  });
  assert.deepEqual(query, { subject: { kind: 'run' } });
});

test('real Phase 7 fake-provider shadow is read-only across run, event, phase, and Memory artifacts', async () => {
  const repositoryRoot = resolve(__dirname, '../../../../..');
  const runId = 'run-20260910100819-8ddbdc28';
  const runRoot = join(repositoryRoot, 'tools/agent-orchestrator/runs', runId);
  const artifactPaths = ['run.json', 'events.jsonl', 'phase.yaml'].map((name) => join(runRoot, name));
  const before = await Promise.all(artifactPaths.map((path) => readFile(path)));
  const memoryRoot = join(repositoryRoot, 'tools/agent-orchestrator/memory/entries');
  const memoryBefore = await readdir(memoryRoot).catch(() => [] as string[]);
  const reasoner = new FakeReasoner(proposal('no_action', {
    supportingReferences: [{ kind: 'current_evidence', reference: 'run.status' }],
  }));
  const report = await coordinateShadowRun({ repositoryRoot, runId, reasoner });
  assert.equal(reasoner.calls, 1);
  assert.equal(report.result.status, 'decided');
  if (report.result.status === 'decided') assert.equal(report.result.decision.kind, 'NO_ACTION');
  const after = await Promise.all(artifactPaths.map((path) => readFile(path)));
  after.forEach((bytes, index) => assert.deepEqual(bytes, before[index]));
  assert.deepEqual(await readdir(memoryRoot).catch(() => [] as string[]), memoryBefore);
});

test('explicit Shadow CLI prints a deterministic non-executed report using a fake Claude executable', async () => {
  const repositoryRoot = resolve(__dirname, '../../../../..');
  const directory = await mkdtemp(join(tmpdir(), 'shadow-cli-'));
  const executable = join(directory, 'fake-claude');
  const recordPath = join(directory, 'record.json');
  try {
    await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.RECORD_PATH, JSON.stringify({ args: process.argv.slice(2), stdin }));
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: {
    version: 1, decision: 'no_action', reason: 'No active failure.',
    supportingReferences: [{ kind: 'current_evidence', reference: 'run.status' }]
  }}));
});
`, 'utf8');
    await chmod(executable, 0o700);
    const cli = resolve(__dirname, '../../src/cli.js');
    const result = await execFileAsync(process.execPath, [cli, 'coordinate-shadow-claude',
      'run-20260910100819-8ddbdc28'], {
      cwd: repositoryRoot,
      env: { ...process.env, CLAUDE_EXECUTABLE: executable, RECORD_PATH: recordPath },
    });
    const report = JSON.parse(result.stdout) as Record<string, unknown>;
    assert.equal(report.mode, 'shadow');
    assert.equal(report.authoritative, false);
    assert.equal(report.executed, false);
    assert.equal(report.persisted, false);
    const record = JSON.parse(await readFile(recordPath, 'utf8')) as { args: string[]; stdin: string };
    assert.ok(record.args.includes('--tools'));
    assert.match(record.stdin, /run-20260910100819-8ddbdc28/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test('Shadow module contains no recovery, execution, persistence, or normal orchestrator hook', async () => {
  const shadow = await readFile(resolve(__dirname, '../../../src/coordinator-shadow/shadow.ts'), 'utf8');
  assert.doesNotMatch(shadow,
    /putMemory|appendEvent|save\(|withRunMutationLock|retryIntegration|retryReview|repin|resume\(|executeDecision/u);
  const orchestrator = await readFile(resolve(__dirname, '../../../src/orchestrator.ts'), 'utf8');
  assert.doesNotMatch(orchestrator, /coordinator-shadow|coordinateShadow/u);
});

function context(
  status: FailureDiagnosis['status'],
  classification: FailureClassification = 'MALFORMED_REVIEW_OUTPUT',
  entries: readonly MemoryEntry[] = [],
): ContextBundle {
  const subject: MemorySubject = status === 'no_active_failure'
    ? { kind: 'run' }
    : { kind: 'task', taskId: 'task-x' };
  const diagnosis: FailureDiagnosis = {
    version: 1,
    status,
    runId: 'run-current',
    subject,
    ...(status === 'diagnosed' ? { classification, agent: 'claude' as const } : {}),
    evidence: [{ kind: 'state', reference: status === 'no_active_failure' ? 'run.status' : 'task:task-x.error',
      summary: 'Current structured evidence.' }],
  };
  const graph = buildMemoryGraph(entries);
  const relevant: RelevantMemoryResult = {
    ...graph,
    subject,
    failures: entries.filter((entry): entry is Extract<MemoryEntry, { readonly kind: 'FAILURE' }> =>
      entry.kind === 'FAILURE'),
    actionCandidates: entries.filter((entry): entry is Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }> =>
      entry.kind === 'ACTION_CANDIDATE'),
    outcomes: [],
    decisions: [],
    invariants: [],
  };
  const result = buildContextBundle({
    runId: 'run-current',
    subject,
    diagnosis,
    relevantMemory: relevant,
    repositoryContext: null,
  });
  assert.equal(result.status, 'ready');
  return result as ContextBundle;
}

function proposal(decision: 'no_action' | 'select_action' | 'human_required', overrides: Record<string, unknown> = {}) {
  return {
    version: 1,
    decision,
    ...(decision === 'select_action' ? { actionId: 'RETRY_REVIEW_OUTPUT' } : {}),
    reason: 'Bounded shadow conclusion.',
    supportingReferences: [],
    ...overrides,
  };
}
