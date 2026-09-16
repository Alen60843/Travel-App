import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { mapFailureToActions } from '../../src/action-mapping/mapper';
import { canonicalHash, canonicalJson } from '../../src/canonical-json';
import { isOrchestratorError } from '../../src/errors';
import type { FailureDiagnosis } from '../../src/failure-intelligence/types';
import { createMemoryEntry, MAX_MEMORY_ENTRY_BYTES, MemoryStore, memoryEntryId,
  parseMemoryEntry, projectDiagnosisToMemory, type FailureMemoryBody, type JsonValue,
  type MemoryEntry } from '../../src/memory';
import { MAX_MEMORY_SCAN_ENTRIES } from '../../src/memory/store';
import { createRunState, StateStore } from '../../src/state';
import type { TaskSpec } from '../../src/tasks';
import { createTemporaryRepository } from '../git/helpers';

const diagnosis: FailureDiagnosis = {
  version: 1,
  status: 'diagnosed',
  runId: 'run-memory',
  subject: { kind: 'task', taskId: 'subject' },
  classification: 'AGENT_EXECUTABLE_DRIFT',
  agent: 'codex',
  evidence: [
    { kind: 'state', reference: 'task:subject.error', summary: 'Presentation only.' },
    { kind: 'attempt', reference: 'attempt:1', summary: 'Presentation only.' },
  ],
};

function failureBody(overrides: Partial<FailureMemoryBody> = {}): FailureMemoryBody {
  return {
    version: 1,
    kind: 'FAILURE',
    subject: { kind: 'task', taskId: 'subject' },
    data: { diagnosisVersion: 1, classification: 'AGENT_EXECUTABLE_DRIFT', agent: 'codex' },
    provenance: { sourceKind: 'failure_diagnosis', producerVersion: 1, runId: 'run-memory',
      taskId: 'subject', references: ['task:subject.error', 'attempt:1'] },
    ...overrides,
  };
}

async function temporaryStore(): Promise<{ root: string; store: MemoryStore; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'memory-foundation-'));
  await mkdir(join(root, 'tools', 'agent-orchestrator'), { recursive: true });
  return { root, store: new MemoryStore(root), dispose: () => rm(root, { recursive: true, force: true }) };
}

test('content-addressed IDs are deterministic SHA-256 values without clock or randomness', () => {
  const first = createMemoryEntry(failureBody());
  const second = createMemoryEntry(failureBody());
  assert.equal(first.id, second.id);
  assert.match(first.id, /^[a-f0-9]{64}$/);
  assert.equal(first.id, canonicalHash(failureBody()));
});

test('semantic and provenance changes create different identities', () => {
  const baseline = createMemoryEntry(failureBody());
  const semantic = createMemoryEntry(failureBody({
    data: { diagnosisVersion: 1, classification: 'MALFORMED_REVIEW_OUTPUT' },
  }));
  const provenance = createMemoryEntry(failureBody({
    provenance: { ...failureBody().provenance, runId: 'run-other' },
  }));
  assert.notEqual(baseline.id, semantic.id);
  assert.notEqual(baseline.id, provenance.id);
});

test('diagnosed failure projects one FAILURE and linked ACTION_CANDIDATE', () => {
  const entries = projectDiagnosisToMemory(diagnosis, mapFailureToActions(diagnosis));
  assert.deepEqual(entries.map((entry) => entry.kind), ['FAILURE', 'ACTION_CANDIDATE']);
  const [failure, action] = entries;
  assert.equal(action?.kind === 'ACTION_CANDIDATE' ? action.data.sourceFailureMemoryId : undefined, failure?.id);
  assert.deepEqual(failure?.provenance.references, ['task:subject.error', 'attempt:1']);
});

test('unknown and no_active_failure project no memory', () => {
  for (const status of ['unknown', 'no_active_failure'] as const) {
    assert.deepEqual(projectDiagnosisToMemory({ version: 1, status, runId: 'run-memory',
      subject: { kind: 'run' }, evidence: [] }, []), []);
  }
});

test('projection is pure and has no filesystem, store, provider, or process dependency', async () => {
  const source = await readFile(resolve(__dirname, '../../../src/memory/projection.ts'), 'utf8');
  const imports = source.split('\n').filter((line) => line.startsWith('import ')).join('\n');
  assert.doesNotMatch(imports, /node:fs|MemoryStore|StateStore|ClaudeAgent|CodexAgent|GitClient|child_process/);
  assert.doesNotMatch(source, /Date\.now|randomUUID|process\./);
});

test('generic provider failure records MANUAL_INSPECTION, distinct from Claude continuation', () => {
  const { agent: _agent, ...diagnosisWithoutAgent } = diagnosis;
  const generic: FailureDiagnosis = { ...diagnosisWithoutAgent, classification: 'PROVIDER_OUTPUT_CONTRACT_FAILURE' };
  const specialized: FailureDiagnosis = { ...generic, variant: 'CLAUDE_TEXT_CONTRACT_MIGRATION' };
  const genericEntries = projectDiagnosisToMemory(generic, mapFailureToActions(generic));
  const specializedEntries = projectDiagnosisToMemory(specialized, mapFailureToActions(specialized));
  const genericAction = genericEntries.find((entry) => entry.kind === 'ACTION_CANDIDATE');
  const specializedAction = specializedEntries.find((entry) => entry.kind === 'ACTION_CANDIDATE');
  assert.equal(genericAction?.kind === 'ACTION_CANDIDATE' ? genericAction.data.actionId : undefined, 'MANUAL_INSPECTION');
  assert.equal(specializedAction?.kind === 'ACTION_CANDIDATE' ? specializedAction.data.actionId : undefined,
    'CONTINUE_CLAUDE_REVIEW_OUTPUT');
  assert.doesNotMatch(canonicalJson(genericAction), /pnpm|continue-claude-review-output/);
});

test('first immutable write creates, second identical write is idempotent, and reload is byte-stable', async () => {
  const value = await temporaryStore();
  try {
    const entries = projectDiagnosisToMemory(diagnosis, mapFailureToActions(diagnosis));
    const first = await Promise.all(entries.map((entry) => value.store.putMemory(entry)));
    const second = await Promise.all(entries.map((entry) => value.store.putMemory(entry)));
    assert.deepEqual(first.map((result) => result.status), ['created', 'created']);
    assert.deepEqual(second.map((result) => result.status), ['already_present', 'already_present']);
    const reloaded = new MemoryStore(value.root);
    assert.deepEqual(await reloaded.listMemory(), [...entries].sort((a, b) => a.id.localeCompare(b.id)));
  } finally { await value.dispose(); }
});

test('concurrent writers publish one identical immutable entry', async () => {
  const value = await temporaryStore();
  try {
    const entry = createMemoryEntry(failureBody());
    const results = await Promise.all([value.store.putMemory(entry), value.store.putMemory(entry)]);
    assert.deepEqual(results.map((result) => result.status).sort(), ['already_present', 'created']);
    assert.deepEqual(await value.store.getMemory(entry.id), entry);
  } finally { await value.dispose(); }
});

test('same-ID conflicting bytes and partial JSON fail closed', async () => {
  const value = await temporaryStore();
  try {
    const entry = createMemoryEntry(failureBody());
    await value.store.putMemory(entry);
    const path = join(value.store.entriesRoot, `${entry.id}.json`);
    await writeFile(path, '{partial', 'utf8');
    await assert.rejects(value.store.getMemory(entry.id), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
    await assert.rejects(value.store.putMemory(entry), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  } finally { await value.dispose(); }
});

test('unsupported versions fail closed rather than being reinterpreted', async () => {
  const value = await temporaryStore();
  try {
    const entry = createMemoryEntry(failureBody());
    await value.store.putMemory(entry);
    const malformed = { ...entry, version: 2 };
    await writeFile(join(value.store.entriesRoot, `${entry.id}.json`), `${JSON.stringify(malformed)}\n`);
    await assert.rejects(value.store.getMemory(entry.id), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  } finally { await value.dispose(); }
});

test('symlink entries and invalid or traversal IDs are rejected', async () => {
  const value = await temporaryStore();
  try {
    const entry = createMemoryEntry(failureBody());
    await value.store.putMemory(entry);
    const path = join(value.store.entriesRoot, `${entry.id}.json`);
    const target = join(value.root, 'target.json');
    await writeFile(target, `${canonicalJson(entry)}\n`);
    await unlink(path);
    await symlink(target, path);
    await assert.rejects(value.store.getMemory(entry.id), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
    await assert.rejects(value.store.getMemory('../escape'), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
    await rm(value.store.memoryRoot, { recursive: true, force: true });
    const redirected = join(value.root, 'redirected-memory');
    await mkdir(redirected);
    await symlink(redirected, value.store.memoryRoot);
    await assert.rejects(value.store.listMemory(), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  } finally { await value.dispose(); }
});

test('oversized entries and canonical entry counts above the scan limit fail closed', async () => {
  const oversized = await temporaryStore();
  try {
    const entry = createMemoryEntry(failureBody());
    await oversized.store.putMemory(entry);
    await writeFile(join(oversized.store.entriesRoot, `${entry.id}.json`), 'x'.repeat(MAX_MEMORY_ENTRY_BYTES + 1));
    await assert.rejects(oversized.store.getMemory(entry.id), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  } finally { await oversized.dispose(); }

  const bounded = await temporaryStore();
  try {
    await mkdir(bounded.store.entriesRoot, { recursive: true });
    for (let index = 0; index <= MAX_MEMORY_SCAN_ENTRIES; index += 1) {
      const id = index.toString(16).padStart(64, '0');
      await writeFile(join(bounded.store.entriesRoot, `${id}.json`), '');
    }
    await assert.rejects(bounded.store.listMemory(), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  } finally { await bounded.dispose(); }
});

test('many stale temp files consume no canonical scan budget and never appear in deterministic results', async () => {
  const value = await temporaryStore();
  try {
    const entries = projectDiagnosisToMemory(diagnosis, mapFailureToActions(diagnosis));
    for (const entry of [...entries].reverse()) await value.store.putMemory(entry);
    for (let index = 0; index < MAX_MEMORY_SCAN_ENTRIES * 2; index += 1) {
      const uuidTail = index.toString(16).padStart(12, '0');
      const name = `.${entries[0]!.id}.tmp-999-00000000-0000-4000-8000-${uuidTail}`;
      await writeFile(join(value.store.entriesRoot, name), '{orphaned-temp');
    }
    const listed = await value.store.listMemory();
    assert.deepEqual(listed.map((entry) => entry.id), entries.map((entry) => entry.id).sort());
    assert.equal(listed.some((entry) => entry.id.includes('.tmp-')), false);
  } finally { await value.dispose(); }
});

test('malformed canonical entry filenames still fail closed', async () => {
  const value = await temporaryStore();
  try {
    const entry = createMemoryEntry(failureBody());
    await value.store.putMemory(entry);
    await writeFile(join(value.store.entriesRoot, `${'f'.repeat(64)}.json`), '{partial');
    await assert.rejects(value.store.listMemory(), (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  } finally { await value.dispose(); }
});

test('listing is ID-ordered and supports exact kind, subject, run and task filters', async () => {
  const value = await temporaryStore();
  try {
    const entries = projectDiagnosisToMemory(diagnosis, mapFailureToActions(diagnosis));
    for (const entry of [...entries].reverse()) await value.store.putMemory(entry);
    const listed = await value.store.listMemory();
    assert.deepEqual(listed.map((entry) => entry.id), entries.map((entry) => entry.id).sort());
    assert.deepEqual((await value.store.listMemory({ kind: 'FAILURE' })).map((entry) => entry.kind), ['FAILURE']);
    assert.equal((await value.store.listMemory({ subject: { kind: 'task', taskId: 'subject' },
      runId: 'run-memory', taskId: 'subject' })).length, 2);
    assert.deepEqual(await value.store.listMemory({ runId: 'not-this-run' }), []);
  } finally { await value.dispose(); }
});

test('MemoryStore exposes no update or delete API', () => {
  const methods = Object.getOwnPropertyNames(MemoryStore.prototype);
  assert.equal(methods.some((name) => /update|delete|remove/i.test(name)), false);
});

test('OUTCOME, DECISION, and INVARIANT have stable schemas but no automatic projection', () => {
  const failure = createMemoryEntry(failureBody());
  const action = projectDiagnosisToMemory(diagnosis, mapFailureToActions(diagnosis))[1]!;
  const outcome = createMemoryEntry({ version: 1, kind: 'OUTCOME', subject: { kind: 'task', taskId: 'subject' },
    data: { sourceActionMemoryId: action.id, status: 'succeeded', resultCode: 'verified' },
    provenance: { sourceKind: 'outcome', producerVersion: 1, runId: 'run-memory', taskId: 'subject', references: [action.id] } });
  const decision = createMemoryEntry({ version: 1, kind: 'DECISION', subject: { kind: 'run' },
    data: { key: 'review_transport', value: { provider: 'claude', mode: 'structured' }, rationale: 'Explicit trusted input.' },
    provenance: { sourceKind: 'trusted_decision', producerVersion: 1, references: [] } });
  const invariant = createMemoryEntry({ version: 1, kind: 'INVARIANT', subject: { kind: 'integration' },
    data: { key: 'authorization_required', rule: true },
    provenance: { sourceKind: 'trusted_invariant', producerVersion: 1, references: [] } });
  assert.deepEqual([failure.kind, action.kind, outcome.kind, decision.kind, invariant.kind],
    ['FAILURE', 'ACTION_CANDIDATE', 'OUTCOME', 'DECISION', 'INVARIANT']);
  assert.deepEqual(projectDiagnosisToMemory(diagnosis, mapFailureToActions(diagnosis)).map((entry) => entry.kind),
    ['FAILURE', 'ACTION_CANDIDATE']);
});

test('plain nested JSON objects and arrays remain valid with unchanged canonical semantics', () => {
  const value = { nested: { enabled: true, values: [1, 'two', null, { deep: ['three'] }] } };
  const entry = createMemoryEntry({ version: 1, kind: 'DECISION', subject: { kind: 'run' },
    data: { key: 'nested-json', value, rationale: 'Trusted structured input.' },
    provenance: { sourceKind: 'trusted_decision', producerVersion: 1, references: [] } });
  assert.deepEqual(entry.data, { key: 'nested-json', value, rationale: 'Trusted structured input.' });
  const { id: _id, ...body } = entry;
  assert.equal(entry.id, canonicalHash(body));
});

test('Date, class instances, accessors, and unsupported nested values are rejected before creation', () => {
  class CustomValue { readonly visible = 'not plain'; }
  class CustomArray extends Array<JsonValue> {}
  const accessor = Object.defineProperty({}, 'value', { enumerable: true, get: () => 'not data' });
  const sparse = Array<JsonValue>(1);
  for (const value of [new Date(0), new CustomValue(), new CustomArray('not plain'), sparse,
    accessor, { unsupported: undefined }]) {
    assert.throws(() => createMemoryEntry({ version: 1, kind: 'DECISION', subject: { kind: 'run' },
      data: { key: 'unsupported', value: value as unknown as JsonValue, rationale: 'Rejected.' },
      provenance: { sourceKind: 'trusted_decision', producerVersion: 1, references: [] } }),
    (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  }
});

test('fixed entry and kind-specific schemas still reject unknown fields', () => {
  const body = { ...failureBody(), data: { ...failureBody().data, unexpected: true } };
  assert.throws(() => parseMemoryEntry({ ...body, id: canonicalHash(body) }),
    (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
  const topLevel = { ...failureBody(), unexpected: true };
  assert.throws(() => parseMemoryEntry({ ...topLevel, id: canonicalHash(topLevel) }),
    (error) => isOrchestratorError(error, 'STATE_CORRUPT'));
});

test('remember-diagnosis writes only Memory, is idempotent, and diagnose remains memory-read-only', async () => {
  const repository = await createTemporaryRepository();
  try {
    const runId = 'run-memory-cli';
    const taskId = 'subject';
    const missing = join(repository.container, 'missing-codex');
    const marker = join(repository.container, 'provider-invoked');
    const fakeProvider = join(repository.container, 'codex');
    await writeFile(fakeProvider, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\n`);
    await chmod(fakeProvider, 0o755);
    const spec: TaskSpec = { id: taskId, title: 'Memory subject', owner: 'codex', effort: 'high',
      mode: 'implementation', files: ['owned/**'], dependsOn: [], writer: true };
    const runsRoot = join(repository.repository, 'tools', 'agent-orchestrator', 'runs');
    const store = new StateStore(runsRoot, runId);
    const initial = createRunState({ runId, phase: 1, repositoryRoot: repository.repository,
      baseBranch: repository.baseBranch, baseSha: repository.baseSha, tasks: [spec],
      agentExecutables: { codex: missing }, clock: () => new Date('2026-09-16T00:00:00.000Z') });
    const state = { ...initial, status: 'FAILED' as const, tasks: { [taskId]: { ...initial.tasks[taskId]!,
      status: 'FAILED' as const, finishedAt: '2026-09-16T00:00:00.000Z',
      error: { code: 'AGENT_FAILED' as const, message: `spawn ${missing} ENOENT`, at: '2026-09-16T00:00:00.000Z' },
      agentAttempts: [{ attempt: 1, agent: 'codex' as const, startedAt: '2026-09-16T00:00:00.000Z',
        finishedAt: '2026-09-16T00:00:00.000Z', outcome: 'failed' as const }] } } };
    await store.initialize(state);
    await writeFile(store.eventsPath, '');
    const phasePath = join(store.runDirectory, 'phase.yaml');
    await writeFile(phasePath, [
      'phase: 1', 'name: Memory CLI fixture', `baseBranch: ${repository.baseBranch}`,
      'canonicalDesignDocument: shared.txt', 'concurrency: 1', 'maxReviewRounds: 2',
      'agentRetries: 0', 'agentTimeoutMs: 60000', 'tasks:', `  - id: ${taskId}`,
      '    title: Memory subject', '    owner: codex', '    effort: high',
      '    mode: implementation', '    files: ["owned/**"]', '    dependsOn: []',
      '    writer: true', 'integration:', '  commands:', '    - command: "true"',
      '      required: true', '',
    ].join('\n'));
    const before = await Promise.all([readFile(store.statePath), readFile(store.eventsPath), readFile(phasePath)]);
    const cli = resolve(__dirname, '../../src/cli.js');
    const diagnose = spawnSync(process.execPath, [cli, 'diagnose', runId], { cwd: repository.repository, encoding: 'utf8' });
    assert.equal(diagnose.status, 0, diagnose.stderr);
    assert.equal(spawnSync('test', ['!', '-e', join(repository.repository, 'tools/agent-orchestrator/memory')]).status, 0);
    const first = spawnSync(process.execPath, [cli, 'remember-diagnosis', runId], {
      cwd: repository.repository, encoding: 'utf8', env: { ...process.env, CODEX_EXECUTABLE: fakeProvider },
    });
    const second = spawnSync(process.execPath, [cli, 'remember-diagnosis', runId], {
      cwd: repository.repository, encoding: 'utf8', env: { ...process.env, CODEX_EXECUTABLE: fakeProvider },
    });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(JSON.parse(first.stdout), { runId, diagnosisStatus: 'diagnosed', projected: 2,
      created: 2, alreadyPresent: 0, entries: JSON.parse(first.stdout).entries });
    assert.equal(JSON.parse(second.stdout).alreadyPresent, 2);
    assert.equal((await new MemoryStore(repository.repository).listMemory()).length, 2);
    assert.deepEqual(await Promise.all([readFile(store.statePath), readFile(store.eventsPath), readFile(phasePath)]), before);
    assert.equal(spawnSync('test', ['!', '-e', marker]).status, 0);
    assert.equal(spawnSync('test', ['!', '-e', join(repository.repository, '.agent-worktrees')]).status, 0);
  } finally { await repository.dispose(); }
});

test('completed Phase-7-shaped diagnosis projects no entries', () => {
  assert.deepEqual(projectDiagnosisToMemory({ version: 1, status: 'no_active_failure',
    runId: 'run-20260910100819-8ddbdc28', subject: { kind: 'run' },
    evidence: [{ kind: 'state', reference: 'run.status', summary: 'COMPLETED' }] }, []), []);
});

test('entry identity is derived from the canonical body excluding id', () => {
  const body = failureBody();
  const entry = createMemoryEntry(body);
  assert.equal(entry.id, memoryEntryId(body));
  const { id: _id, ...withoutId } = entry;
  assert.equal(entry.id, canonicalHash(withoutId));
});
