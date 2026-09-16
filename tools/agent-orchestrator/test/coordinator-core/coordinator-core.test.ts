import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../../src/canonical-json';
import { buildContextBundle, MAX_CONTEXT_BUNDLE_CANONICAL_BYTES,
  type ContextBuildResult, type ContextBuilderInput, type ContextBundle } from '../../src/context-builder';
import { coordinate, MAX_COORDINATOR_REASON_BYTES, MAX_COORDINATOR_REFERENCES,
  parseCoordinatorProposal, type CoordinatorProposal, type CoordinatorReasoner } from '../../src/coordinator-core';
import type { FailureClassification, FailureDiagnosis } from '../../src/failure-intelligence/types';
import { buildMemoryGraph, type RelevantMemoryResult } from '../../src/memory-graph';
import { createMemoryEntry, type MemoryEntry, type MemorySubject } from '../../src/memory';

const subject: MemorySubject = { kind: 'task', taskId: 'task-x' };
const evidenceReference = 'task:task-x.error';

function diagnosis(
  status: FailureDiagnosis['status'] = 'diagnosed',
  classification: FailureClassification = 'MALFORMED_REVIEW_OUTPUT',
): FailureDiagnosis {
  return {
    version: 1,
    status,
    runId: 'run-b',
    subject: { kind: 'task', taskId: 'task-x' },
    ...(status === 'diagnosed' ? { classification, agent: 'claude' as const } : {}),
    evidence: [{ kind: 'state', reference: evidenceReference, summary: 'Current evidence.' }],
  };
}

function failure(runId: string, classification: FailureClassification):
Extract<MemoryEntry, { readonly kind: 'FAILURE' }> {
  return createMemoryEntry({
    version: 1,
    kind: 'FAILURE',
    subject,
    data: { diagnosisVersion: 1, classification },
    provenance: { sourceKind: 'failure_diagnosis', producerVersion: 1, runId,
      taskId: 'task-x', references: ['artifact:source'] },
  }) as Extract<MemoryEntry, { readonly kind: 'FAILURE' }>;
}

function action(source: Extract<MemoryEntry, { readonly kind: 'FAILURE' }>):
Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }> {
  return createMemoryEntry({
    version: 1,
    kind: 'ACTION_CANDIDATE',
    subject,
    data: { actionVersion: 1, actionId: 'REPIN_AGENT_EXECUTABLE', mutatesState: true,
      execution: 'manual', authority: { kind: 'human', required: true },
      basisClassification: source.data.classification, sourceFailureMemoryId: source.id },
    provenance: { sourceKind: 'action_mapping', producerVersion: 1,
      ...(source.provenance.runId === undefined ? {} : { runId: source.provenance.runId }),
      taskId: 'task-x', references: ['artifact:source'] },
  }) as Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }>;
}

function relevantMemory(entries: readonly MemoryEntry[] = [], scope: {
  subject?: MemorySubject;
  runId?: string;
} = {}): RelevantMemoryResult {
  return {
    ...buildMemoryGraph(entries),
    subject: scope.subject ?? subject,
    ...(scope.runId === undefined ? {} : { runId: scope.runId }),
    failures: entries.filter((entry): entry is Extract<MemoryEntry, { readonly kind: 'FAILURE' }> =>
      entry.kind === 'FAILURE'),
    actionCandidates: entries.filter((entry): entry is Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }> =>
      entry.kind === 'ACTION_CANDIDATE'),
    outcomes: entries.filter((entry): entry is Extract<MemoryEntry, { readonly kind: 'OUTCOME' }> =>
      entry.kind === 'OUTCOME'),
    decisions: entries.filter((entry): entry is Extract<MemoryEntry, { readonly kind: 'DECISION' }> =>
      entry.kind === 'DECISION'),
    invariants: entries.filter((entry): entry is Extract<MemoryEntry, { readonly kind: 'INVARIANT' }> =>
      entry.kind === 'INVARIANT'),
  };
}

function context(status: FailureDiagnosis['status'] = 'diagnosed', options: {
  classification?: FailureClassification;
  history?: readonly MemoryEntry[];
  repositoryAvailable?: boolean;
} = {}): ContextBundle {
  const result = buildContextBundle({
    runId: 'run-b',
    subject,
    diagnosis: diagnosis(status, options.classification),
    relevantMemory: relevantMemory(options.history),
    repositoryContext: options.repositoryAvailable === false ? null : {
      hints: [{ path: 'src/review.ts', score: 100, reasons: ['current failure'] }],
      scannedFileCount: 10,
      truncated: false,
      maxHints: 12,
    },
  });
  assert.equal(result.status, 'ready');
  return result as ContextBundle;
}

function history(): readonly MemoryEntry[] {
  const oldFailure = failure('run-a', 'AGENT_EXECUTABLE_DRIFT');
  return [oldFailure, action(oldFailure)];
}

function proposal(decision: CoordinatorProposal['decision'], overrides: Record<string, unknown> = {}): unknown {
  return {
    version: 1,
    decision,
    ...(decision === 'select_action' ? { actionId: 'RETRY_REVIEW_OUTPUT' } : {}),
    reason: 'Bounded conclusion from current evidence.',
    supportingReferences: [],
    ...overrides,
  };
}

class FakeReasoner implements CoordinatorReasoner {
  calls = 0;
  readonly contexts: ContextBundle[] = [];

  constructor(private readonly response: unknown | ((context: ContextBundle) => unknown | Promise<unknown>)) {}

  async propose(input: ContextBundle): Promise<unknown> {
    this.calls += 1;
    this.contexts.push(input);
    return typeof this.response === 'function' ? this.response(input) : this.response;
  }
}

function decided(result: Awaited<ReturnType<typeof coordinate>>) {
  assert.equal(result.status, 'decided');
  if (result.status !== 'decided') throw new Error('Expected decided result');
  return result.decision;
}

function invalid(result: Awaited<ReturnType<typeof coordinate>>): void {
  assert.deepEqual(result.status === 'reasoner_failed' ? result.code : undefined, 'PROPOSAL_INVALID');
}

test('strict parser accepts valid NO_ACTION', () => {
  assert.deepEqual(parseCoordinatorProposal(proposal('no_action')), proposal('no_action'));
});

test('strict parser accepts valid SELECT_ACTION', () => {
  assert.deepEqual(parseCoordinatorProposal(proposal('select_action')), proposal('select_action'));
});

test('strict parser accepts valid HUMAN_REQUIRED', () => {
  assert.deepEqual(parseCoordinatorProposal(proposal('human_required')), proposal('human_required'));
});

test('strict parser rejects unknown top-level fields', () => {
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', { confidence: 1 })));
});

test('strict parser rejects the wrong version', () => {
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', { version: 2 })));
});

test('strict parser rejects an unknown decision enum', () => {
  assert.throws(() => parseCoordinatorProposal(proposal('guess' as CoordinatorProposal['decision'])));
});

test('strict parser rejects actionId on non-action proposals', () => {
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', { actionId: 'RETRY_REVIEW_OUTPUT' })));
});

test('strict parser rejects model-controlled action and scope metadata', () => {
  for (const extra of [
    { authority: { kind: 'human', required: false } },
    { mutatesState: false },
    { execution: 'automatic' },
    { command: 'agents:retry-review-output' },
    { args: ['run-b'] },
    { subject },
    { runId: 'run-evil' },
  ]) {
    assert.throws(() => parseCoordinatorProposal(proposal('select_action', extra)));
  }
});

test('strict parser rejects empty and whitespace-only reasons', () => {
  for (const reason of ['', '  \n ']) {
    assert.throws(() => parseCoordinatorProposal(proposal('no_action', { reason })));
  }
});

test('strict parser bounds reason by UTF-8 bytes', () => {
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', {
    reason: 'é'.repeat(Math.floor(MAX_COORDINATOR_REASON_BYTES / 2) + 1),
  })));
});

test('strict parser enforces the supporting-reference count bound', () => {
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', {
    supportingReferences: Array.from({ length: MAX_COORDINATOR_REFERENCES + 1 }, (_, index) =>
      ({ kind: 'current_evidence', reference: `evidence-${index}` })),
  })));
});

test('strict parser rejects malformed references and reference fields', () => {
  for (const reference of [
    { kind: 'unknown', reference: 'x' },
    { kind: 'memory' },
    { kind: 'memory', memoryId: 'x', path: 'src/x.ts' },
    { kind: 'repository_hint', path: '' },
  ]) {
    assert.throws(() => parseCoordinatorProposal(proposal('no_action', { supportingReferences: [reference] })));
  }
});

test('strict parser rejects duplicate references instead of repairing them', () => {
  const reference = { kind: 'current_evidence', reference: evidenceReference };
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', {
    supportingReferences: [reference, reference],
  })));
});

test('strict parser rejects inherited fields, class instances, symbols, and sparse reference arrays', () => {
  const inherited = Object.create(proposal('no_action') as object) as unknown;
  class ProposalLike {
    version = 1;
    decision = 'no_action';
    reason = 'A class is not provider JSON.';
    supportingReferences: unknown[] = [];
  }
  const symbolField = { ...proposal('no_action') as Record<string, unknown>, [Symbol('extra')]: true };
  const sparseReferences = Array<unknown>(1);
  assert.throws(() => parseCoordinatorProposal(inherited));
  assert.throws(() => parseCoordinatorProposal(new ProposalLike()));
  assert.throws(() => parseCoordinatorProposal(symbolField));
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', {
    supportingReferences: sparseReferences,
  })));
});

test('strict parser rejects a top-level decision getter without invoking it', () => {
  const input = proposal('no_action') as Record<string, unknown>;
  let calls = 0;
  Object.defineProperty(input, 'decision', { enumerable: true, get: () => {
    calls += 1;
    return 'no_action';
  } });
  assert.throws(() => parseCoordinatorProposal(input));
  assert.equal(calls, 0);
});

test('strict parser rejects a top-level reason getter without invoking it', () => {
  const input = proposal('no_action') as Record<string, unknown>;
  let calls = 0;
  Object.defineProperty(input, 'reason', { enumerable: true, get: () => {
    calls += 1;
    return 'A bounded reason.';
  } });
  assert.throws(() => parseCoordinatorProposal(input));
  assert.equal(calls, 0);
});

test('strict parser rejects a select_action actionId getter without invoking it', () => {
  const input = proposal('select_action') as Record<string, unknown>;
  let calls = 0;
  Object.defineProperty(input, 'actionId', { enumerable: true, get: () => {
    calls += 1;
    return 'RETRY_REVIEW_OUTPUT';
  } });
  assert.throws(() => parseCoordinatorProposal(input));
  assert.equal(calls, 0);
});

test('strict parser rejects a supportingReferences getter without invoking it', () => {
  const input = proposal('no_action') as Record<string, unknown>;
  let calls = 0;
  Object.defineProperty(input, 'supportingReferences', { enumerable: true, get: () => {
    calls += 1;
    return [];
  } });
  assert.throws(() => parseCoordinatorProposal(input));
  assert.equal(calls, 0);
});

test('strict parser rejects a nested reference kind getter without invoking it', () => {
  const reference: Record<string, unknown> = { reference: evidenceReference };
  let calls = 0;
  Object.defineProperty(reference, 'kind', { enumerable: true, get: () => {
    calls += 1;
    return 'current_evidence';
  } });
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', {
    supportingReferences: [reference],
  })));
  assert.equal(calls, 0);
});

test('strict parser rejects a nested reference payload getter without invoking it', () => {
  const reference: Record<string, unknown> = { kind: 'memory' };
  let calls = 0;
  Object.defineProperty(reference, 'memoryId', { enumerable: true, get: () => {
    calls += 1;
    return '0'.repeat(64);
  } });
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', {
    supportingReferences: [reference],
  })));
  assert.equal(calls, 0);
});

test('strict parser rejects setter-only and non-enumerable required fields', () => {
  const setterOnly = proposal('no_action') as Record<string, unknown>;
  Object.defineProperty(setterOnly, 'reason', { enumerable: true, set: () => undefined });
  const nonEnumerable = proposal('no_action') as Record<string, unknown>;
  Object.defineProperty(nonEnumerable, 'decision', { enumerable: false, value: 'no_action' });
  assert.throws(() => parseCoordinatorProposal(setterOnly));
  assert.throws(() => parseCoordinatorProposal(nonEnumerable));
});

test('strict parser rejects accessor array elements without invoking them', () => {
  const references: unknown[] = [];
  let calls = 0;
  Object.defineProperty(references, '0', { enumerable: true, get: () => {
    calls += 1;
    return { kind: 'current_evidence', reference: evidenceReference };
  } });
  assert.throws(() => parseCoordinatorProposal(proposal('no_action', {
    supportingReferences: references,
  })));
  assert.equal(calls, 0);
});

test('strict parser rejects nonstandard, non-dense, and extra-property reference arrays', () => {
  const nonstandard: unknown[] = [];
  Object.setPrototypeOf(nonstandard, null);
  const nonEnumerable: unknown[] = [];
  Object.defineProperty(nonEnumerable, '0', {
    enumerable: false,
    value: { kind: 'current_evidence', reference: evidenceReference },
  });
  const extra = [{ kind: 'current_evidence', reference: evidenceReference }];
  Object.defineProperty(extra, 'other', { enumerable: true, value: true });
  for (const supportingReferences of [nonstandard, nonEnumerable, extra]) {
    assert.throws(() => parseCoordinatorProposal(proposal('no_action', { supportingReferences })));
  }
});

test('strict parser continues to accept a normal JSON.parse-produced proposal', () => {
  const input = JSON.parse(JSON.stringify(proposal('select_action', {
    supportingReferences: [{ kind: 'current_evidence', reference: evidenceReference }],
  }))) as unknown;
  assert.deepEqual(parseCoordinatorProposal(input), input);
});

test('strict parser continues to accept null-prototype enumerable data objects', () => {
  const input = Object.assign(Object.create(null) as Record<string, unknown>, {
    version: 1,
    decision: 'human_required',
    reason: 'Human review is required.',
    supportingReferences: [],
  });
  assert.deepEqual(parseCoordinatorProposal(input), {
    version: 1,
    decision: 'human_required',
    reason: 'Human review is required.',
    supportingReferences: [],
  });
});

test('all three valid supporting-reference kinds resolve exactly', async () => {
  const entries = history();
  const input = context('diagnosed', { history: entries });
  const result = await coordinate(input, new FakeReasoner(proposal('select_action', {
    supportingReferences: [
      { kind: 'current_evidence', reference: evidenceReference },
      { kind: 'memory', memoryId: entries[0]!.id },
      { kind: 'repository_hint', path: 'src/review.ts' },
    ],
  })));
  assert.equal(decided(result).kind, 'SELECT_ACTION');
});

test('fabricated current evidence is rejected without fuzzy matching', async () => {
  invalid(await coordinate(context(), new FakeReasoner(proposal('select_action', {
    supportingReferences: [{ kind: 'current_evidence', reference: `${evidenceReference}.similar` }],
  }))));
});

test('fabricated Memory ID is rejected', async () => {
  invalid(await coordinate(context(), new FakeReasoner(proposal('select_action', {
    supportingReferences: [{ kind: 'memory', memoryId: '0'.repeat(64) }],
  }))));
});

test('fabricated or unavailable repository hint is rejected', async () => {
  invalid(await coordinate(context(), new FakeReasoner(proposal('select_action', {
    supportingReferences: [{ kind: 'repository_hint', path: 'src/review.tsx' }],
  }))));
  invalid(await coordinate(context('diagnosed', { repositoryAvailable: false }),
    new FakeReasoner(proposal('select_action', {
      supportingReferences: [{ kind: 'repository_hint', path: 'src/review.ts' }],
    }))));
});

test('no_active_failure allows NO_ACTION even with historical failures', async () => {
  const decision = decided(await coordinate(context('no_active_failure', { history: history() }),
    new FakeReasoner(proposal('no_action'))));
  assert.equal(decision.kind, 'NO_ACTION');
});

test('no_active_failure rejects SELECT_ACTION and cannot resurrect history', async () => {
  invalid(await coordinate(context('no_active_failure', { history: history() }),
    new FakeReasoner(proposal('select_action', { actionId: 'REPIN_AGENT_EXECUTABLE' }))));
});

test('no_active_failure rejects HUMAN_REQUIRED as a claimed current blocker', async () => {
  invalid(await coordinate(context('no_active_failure'), new FakeReasoner(proposal('human_required'))));
});

test('diagnosed rejects NO_ACTION', async () => {
  invalid(await coordinate(context(), new FakeReasoner(proposal('no_action'))));
});

test('diagnosed allows exact current SELECT_ACTION', async () => {
  const decision = decided(await coordinate(context(), new FakeReasoner(proposal('select_action'))));
  assert.equal(decision.kind, 'SELECT_ACTION');
  assert.equal(decision.kind === 'SELECT_ACTION' && decision.selectedAction.actionId, 'RETRY_REVIEW_OUTPUT');
});

test('diagnosed allows HUMAN_REQUIRED without inventing an action', async () => {
  const decision = decided(await coordinate(context(), new FakeReasoner(proposal('human_required'))));
  assert.equal(decision.kind, 'HUMAN_REQUIRED');
  assert.equal('selectedAction' in decision, false);
});

test('unknown rejects NO_ACTION despite historical diagnosis Memory', async () => {
  invalid(await coordinate(context('unknown', { history: history() }), new FakeReasoner(proposal('no_action'))));
});

test('unknown rejects SELECT_ACTION despite historical candidates', async () => {
  invalid(await coordinate(context('unknown', { history: history() }),
    new FakeReasoner(proposal('select_action', { actionId: 'REPIN_AGENT_EXECUTABLE' }))));
});

test('unknown allows HUMAN_REQUIRED', async () => {
  assert.equal(decided(await coordinate(context('unknown'),
    new FakeReasoner(proposal('human_required')))).kind, 'HUMAN_REQUIRED');
});

test('historical ActionId cannot satisfy current action selection', async () => {
  const input = context('diagnosed', { history: history() });
  invalid(await coordinate(input,
    new FakeReasoner(proposal('select_action', { actionId: 'REPIN_AGENT_EXECUTABLE' }))));
});

test('current-vs-historical adversarial context accepts only the current action', async () => {
  const input = context('diagnosed', { history: history() });
  const rejected = await coordinate(input,
    new FakeReasoner(proposal('select_action', { actionId: 'REPIN_AGENT_EXECUTABLE' })));
  const accepted = await coordinate(input, new FakeReasoner(proposal('select_action')));
  invalid(rejected);
  assert.equal(decided(accepted).kind, 'SELECT_ACTION');
});

test('selected action metadata is copied exactly from the trusted current candidate', async () => {
  const input = context();
  const decision = decided(await coordinate(input, new FakeReasoner(proposal('select_action'))));
  assert.equal(decision.kind, 'SELECT_ACTION');
  if (decision.kind !== 'SELECT_ACTION') return;
  assert.deepEqual(decision.selectedAction, input.current.actionCandidates[0]);
  assert.notEqual(decision.selectedAction, input.current.actionCandidates[0]);
  assert.equal('command' in decision.selectedAction, false);
});

test('hostile reasoner mutation cannot change authority, mutation, execution, or scope', async () => {
  const input = context();
  const reasoner = new FakeReasoner((seen: ContextBundle) => {
    const mutable = seen as unknown as {
      scope: { runId: string };
      current: { actionCandidates: Array<{
        mutatesState: boolean;
        execution: string;
        authority: { required: boolean };
      }> };
    };
    mutable.scope.runId = 'run-evil';
    mutable.current.actionCandidates[0]!.mutatesState = false;
    mutable.current.actionCandidates[0]!.execution = 'automatic';
    mutable.current.actionCandidates[0]!.authority.required = false;
    return proposal('select_action');
  });
  const decision = decided(await coordinate(input, reasoner));
  assert.equal(decision.scope.runId, 'run-b');
  assert.equal(decision.kind, 'SELECT_ACTION');
  if (decision.kind !== 'SELECT_ACTION') return;
  assert.equal(decision.selectedAction.mutatesState, true);
  assert.equal(decision.selectedAction.execution, 'manual');
  assert.deepEqual(decision.selectedAction.authority, { kind: 'human', required: true });
  assert.equal(input.current.actionCandidates[0]?.authority.required, true);
});

test('MANUAL_INSPECTION is selectable only when it is a current candidate', async () => {
  const input = context('diagnosed', { classification: 'PROVIDER_OUTPUT_CONTRACT_FAILURE' });
  const decision = decided(await coordinate(input, new FakeReasoner(proposal('select_action', {
    actionId: 'MANUAL_INSPECTION',
  }))));
  assert.equal(decision.kind, 'SELECT_ACTION');
  if (decision.kind !== 'SELECT_ACTION') return;
  assert.equal(decision.selectedAction.actionId, 'MANUAL_INSPECTION');
  assert.equal(decision.selectedAction.mutatesState, false);
  assert.equal(decision.selectedAction.authority.required, false);
});

test('duplicate current action IDs with incompatible semantics fail closed', async () => {
  const input = context();
  const current = input.current.actionCandidates[0]!;
  const malformed: ContextBundle = {
    ...input,
    current: { ...input.current, actionCandidates: [current, { ...current, mutatesState: false }] },
  };
  invalid(await coordinate(malformed, new FakeReasoner(proposal('select_action'))));
});

test('context limit_exceeded invokes the reasoner zero times', async () => {
  const limited = buildContextBundle({
    runId: 'run-b',
    subject,
    repositoryContext: null,
    diagnosis: { ...diagnosis(), evidence: [{ kind: 'state', reference: evidenceReference,
      summary: 'x'.repeat(MAX_CONTEXT_BUNDLE_CANONICAL_BYTES) }] },
    relevantMemory: relevantMemory(),
  });
  assert.equal(limited.status, 'limit_exceeded');
  const reasoner = new FakeReasoner(proposal('no_action'));
  const result = await coordinate(limited, reasoner);
  assert.equal(result.status, 'context_unavailable');
  assert.equal(reasoner.calls, 0);
  assert.equal(result.status === 'context_unavailable' && result.reason, 'limit_exceeded');
});

test('ready context invokes the reasoner exactly once even for malformed output', async () => {
  const reasoner = new FakeReasoner({ malformed: true });
  invalid(await coordinate(context(), reasoner));
  assert.equal(reasoner.calls, 1);
});

test('reasoner throw produces a bounded deterministic failure without retry', async () => {
  const first = new FakeReasoner(() => { throw new Error('secret first failure'); });
  const second = new FakeReasoner(() => { throw new TypeError('different failure'); });
  const firstResult = await coordinate(context(), first);
  const secondResult = await coordinate(context(), second);
  assert.equal(first.calls, 1);
  assert.equal(second.calls, 1);
  assert.equal(canonicalJson(firstResult), canonicalJson(secondResult));
  assert.equal(firstResult.status === 'reasoner_failed' && firstResult.code, 'REASONER_ERROR');
  assert.doesNotMatch(canonicalJson(firstResult), /secret|different/);
});

test('malformed reasoner output never becomes HUMAN_REQUIRED', async () => {
  const result = await coordinate(context(), new FakeReasoner({ version: 1, decision: 'human_required' }));
  invalid(result);
  assert.equal(result.status === 'decided' && result.decision.kind === 'HUMAN_REQUIRED', false);
});

test('same context and proposal produce byte-equivalent canonical decisions', async () => {
  const input = context();
  const first = await coordinate(input, new FakeReasoner(proposal('select_action')));
  const second = await coordinate(input, new FakeReasoner(proposal('select_action')));
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test('Coordinator Core source has no I/O, store, provider, agent, execution, or persistence dependency', async () => {
  const root = resolve(__dirname, '../../../src/coordinator-core');
  const sources = await Promise.all(['coordinator.ts', 'proposal.ts', 'types.ts']
    .map((file) => readFile(resolve(root, file), 'utf8')));
  const combined = sources.join('\n');
  const imports = combined.split('\n').filter((line) => line.startsWith('import ')).join('\n');
  assert.doesNotMatch(imports,
    /node:|agents|claude|codex|openai|gemini|StateStore|MemoryStore|repository-context|adaptive/iu);
  assert.doesNotMatch(combined,
    /writeFile|appendEvent|putMemory|createTask|child_process|\bspawn\(|\bexec\(|retry-integration|authorize|process\.|Date\.|Math\.random/);
});

test('Phase-7-shaped completed context yields canonical NO_ACTION with a fake reasoner', async () => {
  const runId = 'run-20260910100819-8ddbdc28';
  const runSubject: MemorySubject = { kind: 'run' };
  const shapedInput: ContextBuilderInput = {
    runId,
    subject: runSubject,
    repositoryContext: null,
    diagnosis: { version: 1, status: 'no_active_failure', runId, subject: { kind: 'run' },
      evidence: [{ kind: 'state', reference: 'run.status', summary: 'COMPLETED' }] },
    relevantMemory: relevantMemory([], { subject: runSubject, runId }),
  };
  const built: ContextBuildResult = buildContextBundle(shapedInput);
  const decision = decided(await coordinate(built, new FakeReasoner(proposal('no_action', {
    supportingReferences: [{ kind: 'current_evidence', reference: 'run.status' }],
  }))));
  assert.deepEqual(decision, {
    version: 1,
    scope: { runId, subject: { kind: 'run' } },
    kind: 'NO_ACTION',
    reason: 'Bounded conclusion from current evidence.',
    supportingReferences: [{ kind: 'current_evidence', reference: 'run.status' }],
  });
});
