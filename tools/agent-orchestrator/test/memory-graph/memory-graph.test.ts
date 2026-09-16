import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../../src/canonical-json';
import { isOrchestratorError } from '../../src/errors';
import { buildMemoryGraph, getRelevantMemory, type MemoryGraphEdge,
  type MemoryReader, type RelevantMemoryQuery } from '../../src/memory-graph';
import { createMemoryEntry, type FailureMemoryBody, type MemoryEntry,
  type MemoryEntryBody, type MemoryQuery, type MemorySubject } from '../../src/memory';

const taskSubject: MemorySubject = { kind: 'task', taskId: 'phase7-final-review' };

function provenance(
  sourceKind: MemoryEntryBody['provenance']['sourceKind'],
  subject: MemorySubject,
  runId?: string,
): MemoryEntryBody['provenance'] {
  return {
    sourceKind,
    producerVersion: 1,
    ...(runId === undefined ? {} : { runId }),
    ...(subject.kind === 'task' ? { taskId: subject.taskId } : {}),
    references: [],
  };
}

function failure(
  runId = 'run-a',
  classification: FailureMemoryBody['data']['classification'] = 'AGENT_EXECUTABLE_DRIFT',
  subject: MemorySubject = taskSubject,
): Extract<MemoryEntry, { readonly kind: 'FAILURE' }> {
  return createMemoryEntry({
    version: 1,
    kind: 'FAILURE',
    subject,
    data: { diagnosisVersion: 1, classification },
    provenance: provenance('failure_diagnosis', subject, runId),
  }) as Extract<MemoryEntry, { readonly kind: 'FAILURE' }>;
}

function action(
  source: MemoryEntry,
  options: {
    sourceId?: string;
    subject?: MemorySubject;
    classification?: FailureMemoryBody['data']['classification'];
    runId?: string;
  } = {},
): Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }> {
  const subject = options.subject ?? source.subject;
  return createMemoryEntry({
    version: 1,
    kind: 'ACTION_CANDIDATE',
    subject,
    data: {
      actionVersion: 1,
      actionId: options.classification === 'MALFORMED_REVIEW_OUTPUT'
        ? 'RETRY_REVIEW_OUTPUT'
        : 'REPIN_AGENT_EXECUTABLE',
      mutatesState: true,
      execution: 'manual',
      authority: { kind: 'human', required: true },
      basisClassification: options.classification ?? 'AGENT_EXECUTABLE_DRIFT',
      sourceFailureMemoryId: options.sourceId ?? source.id,
    },
    provenance: provenance('action_mapping', subject, options.runId ?? source.provenance.runId),
  }) as Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }>;
}

function outcome(
  source: MemoryEntry,
  options: { sourceId?: string; subject?: MemorySubject; runId?: string } = {},
): Extract<MemoryEntry, { readonly kind: 'OUTCOME' }> {
  const subject = options.subject ?? source.subject;
  return createMemoryEntry({
    version: 1,
    kind: 'OUTCOME',
    subject,
    data: { sourceActionMemoryId: options.sourceId ?? source.id, status: 'succeeded', resultCode: 'verified' },
    provenance: provenance('outcome', subject, options.runId ?? source.provenance.runId),
  }) as Extract<MemoryEntry, { readonly kind: 'OUTCOME' }>;
}

function decision(subject: MemorySubject = taskSubject, runId = 'run-a'):
Extract<MemoryEntry, { readonly kind: 'DECISION' }> {
  return createMemoryEntry({ version: 1, kind: 'DECISION', subject,
    data: { key: 'transport', value: 'structured', rationale: 'Trusted input.' },
    provenance: provenance('trusted_decision', subject, runId) }) as Extract<MemoryEntry, { readonly kind: 'DECISION' }>;
}

function invariant(subject: MemorySubject = taskSubject, runId = 'run-a'):
Extract<MemoryEntry, { readonly kind: 'INVARIANT' }> {
  return createMemoryEntry({ version: 1, kind: 'INVARIANT', subject,
    data: { key: 'authorization', rule: true, rationale: 'Trusted input.' },
    provenance: provenance('trusted_invariant', subject, runId) }) as Extract<MemoryEntry, { readonly kind: 'INVARIANT' }>;
}

function hasEdge(edges: readonly MemoryGraphEdge[], relation: MemoryGraphEdge['relation'], source: unknown, target: unknown): boolean {
  return edges.some((edge) => edge.relation === relation
    && canonicalJson(edge.source) === canonicalJson(source)
    && canonicalJson(edge.target) === canonicalJson(target));
}

class FixtureReader implements MemoryReader {
  readonly entries: readonly MemoryEntry[];
  getCalls = 0;
  listCalls = 0;

  constructor(entries: readonly MemoryEntry[]) { this.entries = entries; }

  async getMemory(id: string): Promise<MemoryEntry | undefined> {
    this.getCalls += 1;
    return this.entries.find((entry) => entry.id === id);
  }

  async listMemory(query: MemoryQuery = {}): Promise<readonly MemoryEntry[]> {
    this.listCalls += 1;
    return this.entries.filter((entry) =>
      (query.kind === undefined || entry.kind === query.kind)
      && (query.subject === undefined || canonicalJson(entry.subject) === canonicalJson(query.subject))
      && (query.runId === undefined || entry.provenance.runId === query.runId)
      && (query.taskId === undefined || entry.provenance.taskId === query.taskId));
  }
}

function query(reader: MemoryReader, value: RelevantMemoryQuery = { subject: taskSubject }) {
  return getRelevantMemory(reader, value);
}

test('graph construction is deterministic for every input ordering', () => {
  const f = failure();
  const a = action(f);
  const o = outcome(a);
  const entries = [o, decision(), a, invariant(), f];
  assert.equal(canonicalJson(buildMemoryGraph(entries)), canonicalJson(buildMemoryGraph([...entries].reverse())));
});

test('pure graph projection imports no I/O/store/provider and uses no clock or randomness', async () => {
  const source = (await Promise.all(['graph.ts', 'query.ts'].map((name) =>
    readFile(resolve(__dirname, `../../../src/memory-graph/${name}`), 'utf8')))).join('\n');
  const imports = source.split('\n').filter((line) => line.startsWith('import ')).join('\n');
  assert.doesNotMatch(imports, /node:fs|MemoryStore|StateStore|Claude|Codex|child_process/);
  assert.doesNotMatch(source, /Date\.|random|process\.|putMemory|appendEvent|writeFile/);
});

test('MemoryReader is structural and does not require a concrete MemoryStore', async () => {
  const reader = new FixtureReader([failure()]);
  assert.equal((await query(reader)).failures.length, 1);
  assert.equal(reader.listCalls, 1);
  assert.equal(reader.getCalls, 0);
});

test('FAILURE creates an AFFECTED relation to its exact structured subject', () => {
  const f = failure();
  assert.ok(hasEdge(buildMemoryGraph([f]).edges, 'AFFECTED',
    { kind: 'memory', memoryId: f.id }, { kind: 'subject', subject: taskSubject }));
});

test('FAILURE with provenance runId creates an OCCURRED_IN relation', () => {
  const f = failure('run-a');
  assert.ok(hasEdge(buildMemoryGraph([f]).edges, 'OCCURRED_IN',
    { kind: 'memory', memoryId: f.id }, { kind: 'run', runId: 'run-a' }));
});

test('ACTION_CANDIDATE creates the exact FAILURE to candidate relation', () => {
  const f = failure();
  const a = action(f);
  assert.ok(hasEdge(buildMemoryGraph([a, f]).edges, 'CANDIDATE_ACTION',
    { kind: 'memory', memoryId: f.id }, { kind: 'memory', memoryId: a.id }));
});

test('OUTCOME creates the exact ACTION_CANDIDATE to outcome relation', () => {
  const f = failure();
  const a = action(f);
  const o = outcome(a);
  assert.ok(hasEdge(buildMemoryGraph([o, f, a]).edges, 'OUTCOME',
    { kind: 'memory', memoryId: a.id }, { kind: 'memory', memoryId: o.id }));
});

test('trusted DECISION creates only its structured ABOUT relation', () => {
  const entry = decision();
  assert.deepEqual(buildMemoryGraph([entry]).edges, [{ relation: 'ABOUT',
    source: { kind: 'memory', memoryId: entry.id }, target: { kind: 'subject', subject: taskSubject } }]);
});

test('trusted INVARIANT creates only its structured ABOUT relation', () => {
  const entry = invariant();
  assert.deepEqual(buildMemoryGraph([entry]).edges, [{ relation: 'ABOUT',
    source: { kind: 'memory', memoryId: entry.id }, target: { kind: 'subject', subject: taskSubject } }]);
});

test('action reference to a missing failure fails closed', () => {
  const f = failure();
  const a = action(f, { sourceId: 'f'.repeat(64) });
  assert.throws(() => buildMemoryGraph([a]), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('action reference to the wrong Memory kind fails closed', () => {
  const d = decision();
  const a = action(d, { sourceId: d.id });
  assert.throws(() => buildMemoryGraph([d, a]), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('action and failure subject mismatch fails closed', () => {
  const f = failure();
  const a = action(f, { subject: { kind: 'task', taskId: 'other-task' } });
  assert.throws(() => buildMemoryGraph([f, a]), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('action basis classification mismatch fails closed', () => {
  const f = failure();
  const a = action(f, { classification: 'MALFORMED_REVIEW_OUTPUT' });
  assert.throws(() => buildMemoryGraph([f, a]), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('outcome reference to a missing action fails closed', () => {
  const a = action(failure());
  const o = outcome(a, { sourceId: 'e'.repeat(64) });
  assert.throws(() => buildMemoryGraph([o]), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('outcome reference to the wrong Memory kind fails closed', () => {
  const f = failure();
  const o = outcome(f, { sourceId: f.id });
  assert.throws(() => buildMemoryGraph([f, o]), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('outcome and action subject mismatch fails closed', () => {
  const f = failure();
  const a = action(f);
  const o = outcome(a, { subject: { kind: 'integration' } });
  assert.throws(() => buildMemoryGraph([f, a, o]), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('a FAILURE without an action remains a valid graph', () => {
  const graph = buildMemoryGraph([failure()]);
  assert.deepEqual(graph.edges.map((edge) => edge.relation), ['AFFECTED', 'OCCURRED_IN']);
});

test('exact task subject query excludes unrelated and merely similar task subjects', async () => {
  const exact = failure();
  const unrelated = failure('run-a', 'AGENT_EXECUTABLE_DRIFT', { kind: 'task', taskId: 'phase7-final-review-extra' });
  const result = await query(new FixtureReader([unrelated, exact]));
  assert.deepEqual(result.failures.map((entry) => entry.id), [exact.id]);
});

test('same exact task query without runId returns deterministic facts across runs', async () => {
  const first = failure('run-a');
  const firstAction = action(first);
  const second = failure('run-b', 'MALFORMED_REVIEW_OUTPUT');
  const secondAction = action(second, { classification: 'MALFORMED_REVIEW_OUTPUT' });
  const result = await query(new FixtureReader([secondAction, first, second, firstAction]));
  assert.deepEqual(new Set(result.failures.map((entry) => entry.provenance.runId)), new Set(['run-a', 'run-b']));
  assert.deepEqual(result.actionCandidates.map((entry) => entry.data.actionId).sort(),
    ['REPIN_AGENT_EXECUTABLE', 'RETRY_REVIEW_OUTPUT']);
});

test('task query with runId returns only that physical run', async () => {
  const first = failure('run-a');
  const second = failure('run-b', 'MALFORMED_REVIEW_OUTPUT');
  const result = await query(new FixtureReader([first, action(first), second,
    action(second, { classification: 'MALFORMED_REVIEW_OUTPUT' })]),
  { subject: taskSubject, runId: 'run-a' });
  assert.deepEqual([...result.failures, ...result.actionCandidates].map((entry) => entry.provenance.runId),
    ['run-a', 'run-a']);
});

test('run subject requires provenance runId to distinguish physical runs', async () => {
  const subject: MemorySubject = { kind: 'run' };
  const first = failure('run-a', 'AGENT_EXECUTABLE_DRIFT', subject);
  const second = failure('run-b', 'MALFORMED_REVIEW_OUTPUT', subject);
  const result = await query(new FixtureReader([first, second]), { subject, runId: 'run-b' });
  assert.deepEqual(result.failures.map((entry) => entry.id), [second.id]);
});

test('integration subject query uses exact structured subject identity', async () => {
  const integration = failure('run-a', 'INTEGRATION_ENVIRONMENT_MISMATCH', { kind: 'integration' });
  const result = await query(new FixtureReader([failure(), integration]), { subject: { kind: 'integration' } });
  assert.deepEqual(result.failures.map((entry) => entry.id), [integration.id]);
});

test('result groups are ID ordered and graph ordering is stable despite reader order', async () => {
  const f = failure();
  const a = action(f);
  const entries = [invariant(), a, decision(), f];
  const left = await query(new FixtureReader(entries));
  const right = await query(new FixtureReader([...entries].reverse()));
  assert.equal(canonicalJson(left), canonicalJson(right));
  assert.deepEqual(left.failures.map((entry) => entry.id), [f.id]);
  assert.deepEqual(left.actionCandidates.map((entry) => entry.id), [a.id]);
});

test('query is one bounded read and performs no Memory writes, provider calls, or run mutation', async () => {
  const reader = new FixtureReader([]);
  const before = canonicalJson(reader.entries);
  const result = await query(reader);
  assert.equal(reader.listCalls, 1);
  assert.equal(reader.getCalls, 0);
  assert.equal(canonicalJson(reader.entries), before);
  assert.deepEqual(result.failures, []);
  assert.deepEqual(result.edges, []);
});

test('completed real Phase 7 with no captured Memory returns the empty deterministic result', async () => {
  const result = await query(new FixtureReader([]), { subject: { kind: 'run' },
    runId: 'run-20260910100819-8ddbdc28' });
  assert.deepEqual({ failures: result.failures, actionCandidates: result.actionCandidates,
    outcomes: result.outcomes, decisions: result.decisions, invariants: result.invariants,
    nodes: result.nodes, edges: result.edges },
  { failures: [], actionCandidates: [], outcomes: [], decisions: [], invariants: [], nodes: [], edges: [] });
});
