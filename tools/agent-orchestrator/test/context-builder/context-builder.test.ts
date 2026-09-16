import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../../src/canonical-json';
import { buildContextBundle, MAX_CONTEXT_BUNDLE_CANONICAL_BYTES,
  type ContextBuildResult, type ContextBundle, type ContextBuilderInput,
  type RepositoryNavigationContext } from '../../src/context-builder';
import { isOrchestratorError } from '../../src/errors';
import type { FailureClassification, FailureDiagnosis } from '../../src/failure-intelligence/types';
import { buildMemoryGraph, type RelevantMemoryResult } from '../../src/memory-graph';
import { createMemoryEntry, type MemoryEntry, type MemorySubject } from '../../src/memory';

const subject: MemorySubject = { kind: 'task', taskId: 'task-x' };

function diagnosis(
  status: FailureDiagnosis['status'] = 'diagnosed',
  options: {
    runId?: string;
    subject?: FailureDiagnosis['subject'];
    classification?: FailureClassification;
    summary?: string;
  } = {},
): FailureDiagnosis {
  return {
    version: 1,
    status,
    runId: options.runId ?? 'run-b',
    subject: options.subject ?? { kind: 'task', taskId: 'task-x' },
    ...(status === 'diagnosed'
      ? { classification: options.classification ?? 'MALFORMED_REVIEW_OUTPUT', agent: 'claude' as const }
      : {}),
    evidence: [{ kind: 'state', reference: 'task:task-x.error', summary: options.summary ?? 'Current evidence.' }],
  };
}

function memoryProvenance(
  sourceKind: MemoryEntry['provenance']['sourceKind'],
  runId?: string,
): MemoryEntry['provenance'] {
  return { sourceKind, producerVersion: 1, ...(runId === undefined ? {} : { runId }),
    taskId: 'task-x', references: ['artifact:source'] };
}

function failure(runId: string, classification: FailureClassification):
Extract<MemoryEntry, { readonly kind: 'FAILURE' }> {
  return createMemoryEntry({ version: 1, kind: 'FAILURE', subject,
    data: { diagnosisVersion: 1, classification },
    provenance: memoryProvenance('failure_diagnosis', runId) }) as
    Extract<MemoryEntry, { readonly kind: 'FAILURE' }>;
}

function action(source: Extract<MemoryEntry, { readonly kind: 'FAILURE' }>, actionId:
'REPIN_AGENT_EXECUTABLE' | 'RETRY_REVIEW_OUTPUT'):
Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }> {
  return createMemoryEntry({ version: 1, kind: 'ACTION_CANDIDATE', subject,
    data: { actionVersion: 1, actionId, mutatesState: true, execution: 'manual',
      authority: { kind: 'human', required: true }, basisClassification: source.data.classification,
      sourceFailureMemoryId: source.id },
    provenance: memoryProvenance('action_mapping', source.provenance.runId) }) as
    Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }>;
}

function outcome(source: Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }>):
Extract<MemoryEntry, { readonly kind: 'OUTCOME' }> {
  return createMemoryEntry({ version: 1, kind: 'OUTCOME', subject,
    data: { sourceActionMemoryId: source.id, status: 'succeeded', resultCode: 'verified' },
    provenance: memoryProvenance('outcome', source.provenance.runId) }) as
    Extract<MemoryEntry, { readonly kind: 'OUTCOME' }>;
}

function invariant(key = 'authorization-required'):
Extract<MemoryEntry, { readonly kind: 'INVARIANT' }> {
  return createMemoryEntry({ version: 1, kind: 'INVARIANT', subject,
    data: { key, rule: { required: true }, rationale: 'Trusted repository rule.' },
    provenance: memoryProvenance('trusted_invariant') }) as
    Extract<MemoryEntry, { readonly kind: 'INVARIANT' }>;
}

function decision(runId: string, key = 'transport'):
Extract<MemoryEntry, { readonly kind: 'DECISION' }> {
  return createMemoryEntry({ version: 1, kind: 'DECISION', subject,
    data: { key, value: 'structured', rationale: 'Trusted decision.' },
    provenance: memoryProvenance('trusted_decision', runId) }) as
    Extract<MemoryEntry, { readonly kind: 'DECISION' }>;
}

function relevantMemory(
  entries: readonly MemoryEntry[] = [],
  scope: { subject?: MemorySubject; runId?: string } = {},
): RelevantMemoryResult {
  const graph = buildMemoryGraph(entries);
  return {
    ...graph,
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

const repositoryContext: RepositoryNavigationContext = {
  hints: [
    { path: 'src/shared.ts', score: 70, reasons: ['imported by src/x.ts'] },
    { path: 'src/x.ts', score: 100, reasons: ['task symbol', 'explicit task reference'] },
  ],
  scannedFileCount: 20,
  truncated: false,
  maxHints: 12,
};

function input(overrides: Partial<ContextBuilderInput> = {}): ContextBuilderInput {
  return {
    runId: 'run-b',
    subject,
    repositoryContext,
    diagnosis: diagnosis(),
    relevantMemory: relevantMemory(),
    ...overrides,
  };
}

function ready(result: ContextBuildResult): ContextBundle {
  assert.equal(result.status, 'ready');
  return result as ContextBundle;
}

function fullHistory(): readonly MemoryEntry[] {
  const oldFailure = failure('run-a', 'AGENT_EXECUTABLE_DRIFT');
  const oldAction = action(oldFailure, 'REPIN_AGENT_EXECUTABLE');
  const currentFailure = failure('run-b', 'MALFORMED_REVIEW_OUTPUT');
  const currentAction = action(currentFailure, 'RETRY_REVIEW_OUTPUT');
  return [outcome(oldAction), currentAction, invariant(), oldFailure, currentFailure, oldAction];
}

test('identical semantic inputs produce a deterministic Context Bundle', () => {
  const entries = fullHistory();
  const first = buildContextBundle(input({ relevantMemory: relevantMemory(entries) }));
  const loaded = relevantMemory([...entries].reverse());
  const shuffled: RelevantMemoryResult = {
    ...loaded,
    failures: [...loaded.failures].reverse(),
    actionCandidates: [...loaded.actionCandidates].reverse(),
  };
  const second = buildContextBundle(input({ repositoryContext: {
    ...repositoryContext, hints: [...repositoryContext.hints].reverse(),
  }, relevantMemory: shuffled }));
  assert.equal(canonicalJson(first), canonicalJson(second));
});

test('builder core is pure and has no I/O, store, Git, process, provider, clock, or randomness dependency', async () => {
  const source = await readFile(resolve(__dirname, '../../../src/context-builder/builder.ts'), 'utf8');
  const imports = source.split('\n').filter((line) => line.startsWith('import ')).join('\n');
  assert.doesNotMatch(imports, /node:|MemoryStore|StateStore|GitClient|repository-context|Claude|Codex|GPT/);
  assert.doesNotMatch(source,
    /Date\.|randomUUID|Math\.random|process\.|writeFile|putMemory|appendEvent|\bspawn\(|\bexec\(/);
});

test('provider-independent schema contains no provider-specific context or prompt fields', () => {
  const bundle = ready(buildContextBundle(input()));
  assert.doesNotMatch(canonicalJson(bundle), /ClaudePrompt|CodexPrompt|CoordinatorPrompt|providerMessage/);
});

test('diagnosis runId mismatch fails closed', () => {
  assert.throws(() => buildContextBundle(input({ diagnosis: diagnosis('diagnosed', { runId: 'run-a' }) })),
    (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('diagnosis subject mismatch fails closed for task and subject kind differences', () => {
  for (const mismatch of [{ kind: 'task', taskId: 'other' }, { kind: 'task' },
    { kind: 'integration' }] as const) {
    assert.throws(() => buildContextBundle(input({ diagnosis: diagnosis('diagnosed', { subject: mismatch }) })),
      (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  }
});

test('relevant Memory subject mismatch fails closed', () => {
  assert.throws(() => buildContextBundle(input({
    relevantMemory: relevantMemory([], { subject: { kind: 'integration' } }),
  })), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('conflicting relevant Memory runId fails closed', () => {
  assert.throws(() => buildContextBundle(input({ relevantMemory: relevantMemory([], { runId: 'run-a' }) })),
    (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('cross-run relevant Memory with no runId constraint is accepted', () => {
  const entries = fullHistory();
  const bundle = ready(buildContextBundle(input({ relevantMemory: relevantMemory(entries) })));
  assert.deepEqual(bundle.memory.historicalRuns.map((group) => group.runId), ['run-a']);
  assert.equal(bundle.memory.currentRun.failures.length, 1);
});

test('repository hints remain ordered advisory structured data', () => {
  const repository = ready(buildContextBundle(input())).repository;
  assert.equal(repository.status, 'available');
  if (repository.status !== 'available') return;
  assert.equal(repository.authority, 'navigation_only');
  assert.deepEqual(repository.hints.map((hint) => hint.path), ['src/x.ts', 'src/shared.ts']);
  assert.deepEqual(repository.hints[0]?.reasons, ['explicit task reference', 'task symbol']);
  assert.equal(repository.scannedFileCount, 20);
});

test('null repository context produces explicit unavailable status without failing', () => {
  const bundle = ready(buildContextBundle(input({ repositoryContext: null })));
  assert.deepEqual(bundle.repository, { status: 'unavailable', authority: 'navigation_only' });
  assert.equal(bundle.sourceState.repositoryTruncated, null);
});

test('Graph Context truncation and maximum metadata are preserved explicitly', () => {
  const bundle = ready(buildContextBundle(input({ repositoryContext: {
    ...repositoryContext, truncated: true, maxHints: 2,
  } })));
  assert.equal(bundle.repository.status === 'available' && bundle.repository.truncated, true);
  assert.equal(bundle.repository.status === 'available' && bundle.repository.maxHints, 2);
  assert.equal(bundle.sourceState.repositoryTruncated, true);
});

test('diagnosed current failure and its evidence are preserved as current truth', () => {
  const current = diagnosis('diagnosed', { classification: 'MALFORMED_REVIEW_OUTPUT' });
  const bundle = ready(buildContextBundle(input({ diagnosis: current })));
  assert.deepEqual(bundle.current.diagnosis, current);
});

test('unknown remains unknown despite diagnosed historical Memory', () => {
  const old = failure('run-a', 'AGENT_EXECUTABLE_DRIFT');
  const bundle = ready(buildContextBundle(input({ diagnosis: diagnosis('unknown'),
    relevantMemory: relevantMemory([old, action(old, 'REPIN_AGENT_EXECUTABLE')]) })));
  assert.equal(bundle.current.diagnosis.status, 'unknown');
  assert.deepEqual(bundle.current.actionCandidates, []);
  assert.equal(bundle.memory.historicalRuns[0]?.facts.failures.length, 1);
});

test('no_active_failure remains current truth and maps no historical action into current candidates', () => {
  const old = failure('run-a', 'AGENT_EXECUTABLE_DRIFT');
  const bundle = ready(buildContextBundle(input({ diagnosis: diagnosis('no_active_failure'),
    relevantMemory: relevantMemory([old, action(old, 'REPIN_AGENT_EXECUTABLE')]) })));
  assert.equal(bundle.current.diagnosis.status, 'no_active_failure');
  assert.deepEqual(bundle.current.actionCandidates, []);
});

test('Action Mapping is reused and portable candidates keep semantic IDs without CLI metadata', async () => {
  const source = await readFile(resolve(__dirname, '../../../src/context-builder/builder.ts'), 'utf8');
  assert.match(source, /mapFailureToActions\(diagnosis\)/);
  assert.doesNotMatch(source, /RETRY_REVIEW_OUTPUT|REPIN_AGENT_EXECUTABLE|agents:/);
  const candidate = ready(buildContextBundle(input())).current.actionCandidates[0];
  assert.equal(candidate?.actionId, 'RETRY_REVIEW_OUTPUT');
  assert.deepEqual(Object.keys(candidate ?? {}).sort(),
    ['actionId', 'authority', 'basis', 'execution', 'mutatesState', 'subject', 'version']);
  assert.doesNotMatch(canonicalJson(candidate), /pnpm|agents:retry-review-output/);
});

test('historical action never becomes the current candidate action', () => {
  const oldFailure = failure('run-a', 'AGENT_EXECUTABLE_DRIFT');
  const bundle = ready(buildContextBundle(input({ relevantMemory:
    relevantMemory([oldFailure, action(oldFailure, 'REPIN_AGENT_EXECUTABLE')]) })));
  assert.deepEqual(bundle.current.actionCandidates.map((entry) => entry.actionId), ['RETRY_REVIEW_OUTPUT']);
  assert.deepEqual(bundle.memory.historicalRuns[0]?.facts.actionCandidates
    .map((entry) => entry.data.actionId), ['REPIN_AGENT_EXECUTABLE']);
});

test('Memory is separated into current-run, historical-run, and repository-scoped facts', () => {
  const bundle = ready(buildContextBundle(input({ relevantMemory: relevantMemory(fullHistory()) })));
  assert.deepEqual(bundle.memory.currentRun.failures.map((entry) => entry.provenance.runId), ['run-b']);
  assert.deepEqual(bundle.memory.historicalRuns.map((entry) => entry.runId), ['run-a']);
  assert.deepEqual(bundle.memory.historicalRuns[0]?.facts.failures
    .map((entry) => entry.provenance.runId), ['run-a']);
  assert.equal(bundle.memory.repositoryScoped.invariants[0]?.provenance.runId, undefined);
});

test('multiple historical physical runs remain independently and deterministically grouped', () => {
  const runC = decision('run-c', 'c');
  const runA = decision('run-a', 'a');
  const bundle = ready(buildContextBundle(input({ relevantMemory: relevantMemory([runC, runA]) })));
  assert.deepEqual(bundle.memory.historicalRuns.map((entry) => entry.runId), ['run-a', 'run-c']);
  assert.deepEqual(bundle.memory.historicalRuns.map((entry) => entry.facts.decisions[0]?.data.key), ['a', 'c']);
});

test('Memory Graph relations are preserved structurally without new inference or cross-run chains', () => {
  const entries = fullHistory();
  const memory = relevantMemory(entries);
  const bundle = ready(buildContextBundle(input({ relevantMemory: memory })));
  assert.deepEqual(new Set(bundle.memory.edges.map((edge) => edge.relation)),
    new Set(['AFFECTED', 'OCCURRED_IN', 'CANDIDATE_ACTION', 'OUTCOME', 'ABOUT']));
  assert.equal(bundle.memory.edges.some((edge) => !memory.edges.some((source) =>
    canonicalJson(source) === canonicalJson(edge))), false);
});

test('Memory provenance, evidence references, subjects, and structured values are retained', () => {
  const rule = invariant();
  const old = failure('run-a', 'AGENT_EXECUTABLE_DRIFT');
  const bundle = ready(buildContextBundle(input({ relevantMemory: relevantMemory([rule, old]) })));
  const historical = bundle.memory.historicalRuns[0]?.facts.failures[0];
  assert.deepEqual(historical?.provenance.references, ['artifact:source']);
  assert.deepEqual(historical?.subject, subject);
  assert.deepEqual(bundle.memory.repositoryScoped.invariants[0]?.data.rule, { required: true });
});

test('repository, memory groups, facts, actions, and edges have deterministic explicit ordering', () => {
  const bundle = ready(buildContextBundle(input({ relevantMemory: relevantMemory(fullHistory()) })));
  assert.deepEqual(bundle.repository.status === 'available'
    ? bundle.repository.hints.map((hint) => hint.path) : [], ['src/x.ts', 'src/shared.ts']);
  for (const facts of [bundle.memory.currentRun, bundle.memory.repositoryScoped,
    ...bundle.memory.historicalRuns.map((entry) => entry.facts)]) {
    for (const group of [facts.failures, facts.actionCandidates, facts.outcomes, facts.decisions, facts.invariants]) {
      const ids = group.map((entry) => entry.memoryId);
      assert.deepEqual(ids, [...ids].sort());
    }
  }
  const edges = bundle.memory.edges.map(canonicalJson);
  assert.deepEqual(edges, [...edges].sort());
});

test('builder does not mutate caller-owned arrays while ordering', () => {
  const memory = relevantMemory(fullHistory());
  const repositoryHints = [...repositoryContext.hints].reverse();
  const originalFailureIds = memory.failures.map((entry) => entry.id);
  const originalActionIds = memory.actionCandidates.map((entry) => entry.id);
  const originalHintPaths = repositoryHints.map((entry) => entry.path);
  buildContextBundle(input({ repositoryContext: { ...repositoryContext, hints: repositoryHints },
    relevantMemory: memory }));
  assert.deepEqual(memory.failures.map((entry) => entry.id), originalFailureIds);
  assert.deepEqual(memory.actionCandidates.map((entry) => entry.id), originalActionIds);
  assert.deepEqual(repositoryHints.map((entry) => entry.path), originalHintPaths);
});

test('bounded ready context advertises the fixed canonical safety ceiling', () => {
  const bundle = ready(buildContextBundle(input()));
  assert.equal(bundle.sourceState.maximumCanonicalBytes, MAX_CONTEXT_BUNDLE_CANONICAL_BYTES);
  assert.ok(new TextEncoder().encode(canonicalJson(bundle)).byteLength <= MAX_CONTEXT_BUNDLE_CANONICAL_BYTES);
});

test('hard context-bound overflow is explicit and never returns a silently truncated bundle', () => {
  const result = buildContextBundle(input({ diagnosis: diagnosis('diagnosed', {
    summary: 'x'.repeat(MAX_CONTEXT_BUNDLE_CANONICAL_BYTES),
  }) }));
  assert.equal(result.status, 'limit_exceeded');
  if (result.status !== 'limit_exceeded') return;
  assert.equal(result.limit.kind, 'canonical_bytes');
  assert.equal(result.limit.maximumBytes, MAX_CONTEXT_BUNDLE_CANONICAL_BYTES);
  assert.ok(result.limit.actualBytes > result.limit.maximumBytes);
  assert.equal('current' in result, false);
});

test('completed Phase-7-shaped input preserves no_active_failure without resurrecting history', () => {
  const bundle = ready(buildContextBundle({
    runId: 'run-20260910100819-8ddbdc28',
    subject: { kind: 'run' },
    repositoryContext: null,
    diagnosis: { version: 1, status: 'no_active_failure', runId: 'run-20260910100819-8ddbdc28',
      subject: { kind: 'run' }, evidence: [{ kind: 'state', reference: 'run.status', summary: 'COMPLETED' }] },
    relevantMemory: relevantMemory([], { subject: { kind: 'run' }, runId: 'run-20260910100819-8ddbdc28' }),
  }));
  assert.equal(bundle.current.diagnosis.status, 'no_active_failure');
  assert.deepEqual(bundle.current.actionCandidates, []);
  assert.equal(bundle.sourceState.memoryFactCount, 0);
  assert.deepEqual(bundle.memory.historicalRuns, []);
});
