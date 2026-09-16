import assert from 'node:assert/strict';
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import test from 'node:test';

import { canonicalJson } from '../../src/canonical-json';
import {
  coordinate,
  parseCoordinatorProposal,
  type CoordinatorReasoner,
} from '../../src/coordinator-core';
import {
  CLAUDE_COORDINATOR_CAPABILITY_PROFILE,
  CLAUDE_COORDINATOR_PROPOSAL_SCHEMA,
  ClaudeCoordinatorReasoner,
  ClaudeCoordinatorReasonerError,
  buildClaudeCoordinatorPrompt,
} from '../../src/coordinator-providers';
import type { ContextBundle } from '../../src/context-builder';
import { matchCapabilities } from '../../src/role-capabilities';

const context: ContextBundle = {
  version: 1,
  status: 'ready',
  scope: { runId: 'run-shadow', subject: { kind: 'run' } },
  repository: { status: 'unavailable', authority: 'navigation_only' },
  current: {
    diagnosis: {
      version: 1,
      status: 'no_active_failure',
      runId: 'run-shadow',
      subject: { kind: 'run' },
      evidence: [{ kind: 'state', reference: 'run.status', summary: 'COMPLETED' }],
    },
    actionCandidates: [],
  },
  memory: {
    currentRun: { failures: [], actionCandidates: [], outcomes: [], decisions: [], invariants: [] },
    historicalRuns: [],
    repositoryScoped: { failures: [], actionCandidates: [], outcomes: [], decisions: [], invariants: [] },
    edges: [],
  },
  sourceState: { repositoryTruncated: null, memoryFactCount: 0, maximumCanonicalBytes: 256 * 1024 },
};

interface Fixture {
  readonly directory: string;
  readonly executable: string;
  readonly recordPath: string;
  dispose(): Promise<void>;
}

test('adapter implements CoordinatorReasoner and exposes only the satisfied coordinator profile', async () => {
  const fixture = await createFixture();
  try {
    const adapter: CoordinatorReasoner = reasoner(fixture);
    assert.equal(typeof adapter.propose, 'function');
    assert.deepEqual(CLAUDE_COORDINATOR_CAPABILITY_PROFILE, {
      version: 1,
      capabilities: ['structured_reasoning', 'structured_output'],
    });
    assert.equal(matchCapabilities('coordinator', CLAUDE_COORDINATOR_CAPABILITY_PROFILE).status, 'satisfied');
    for (const absent of ['repository_read', 'code_edit', 'code_review', 'test_execution']) {
      assert.equal(CLAUDE_COORDINATOR_CAPABILITY_PROFILE.capabilities.includes(absent as never), false);
    }
  } finally { await fixture.dispose(); }
});

test('one propose call spawns once, sends the complete canonical context on stdin, and enables no tools', async () => {
  const fixture = await createFixture();
  try {
    const proposal = validProposal();
    const adapter = reasoner(fixture, { FAKE_RESPONSE: JSON.stringify(proposal) });
    assert.deepEqual(await adapter.propose(context), proposal);
    const records = await recordsOf(fixture);
    assert.equal(records.length, 1);
    const record = records[0]!;
    assert.match(record.stdin, /Perform one bounded Coordinator decision/);
    assert.ok(record.stdin.endsWith(`ContextBundle:${canonicalJson(context)}`));
    assert.equal(record.stdin.includes('EXTERNAL_REPOSITORY_SECRET'), false);
    assert.equal(record.args.includes(record.stdin), false);
    assertArgPair(record.args, '--tools', '');
    assertArgPair(record.args, '--permission-mode', 'dontAsk');
    assertArgPair(record.args, '--mcp-config', '{"mcpServers":{}}');
    assertArgPair(record.args, '--setting-sources', '');
    assert.equal(record.args.includes('--safe-mode'), false);
    for (const flag of ['-p', '--no-session-persistence', '--disable-slash-commands',
      '--strict-mcp-config', '--no-chrome', '--json-schema']) assert.ok(record.args.includes(flag), flag);
  } finally { await fixture.dispose(); }
});

test('production transport schema is flat and contains no JSON Schema combinators', () => {
  const keys = collectKeys(CLAUDE_COORDINATOR_PROPOSAL_SCHEMA);
  for (const forbidden of [
    'oneOf', 'anyOf', 'allOf', 'if', 'then', 'else', 'dependentSchemas', 'discriminator',
  ]) assert.equal(keys.has(forbidden), false, forbidden);
});

test('flat transport schema bounds known proposal and reference fields without conditional semantics', () => {
  const schema = CLAUDE_COORDINATOR_PROPOSAL_SCHEMA;
  assert.equal(schema.type, 'object');
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.required, ['version', 'decision', 'reason', 'supportingReferences']);
  assert.deepEqual(schema.properties.decision.enum, ['no_action', 'select_action', 'human_required']);
  assert.equal((schema.required as readonly string[]).includes('actionId'), false);
  assert.deepEqual(schema.properties.actionId.enum, [
    'REPIN_AGENT_EXECUTABLE', 'RETRY_REVIEW_OUTPUT', 'CONTINUE_CLAUDE_REVIEW_OUTPUT',
    'PROPOSE_REPLAN', 'RETRY_INTEGRATION', 'MANUAL_INSPECTION',
  ]);
  assert.equal(schema.properties.supportingReferences.maxItems, 16);
  const reference = schema.properties.supportingReferences.items;
  assert.equal(reference.additionalProperties, false);
  assert.equal(reference.minProperties, 2);
  assert.equal(reference.maxProperties, 2);
  assert.deepEqual(reference.required, ['kind']);
  assert.deepEqual(reference.properties.kind.enum,
    ['current_evidence', 'memory', 'repository_hint']);
  assert.deepEqual(Object.keys(reference.properties), ['kind', 'reference', 'memoryId', 'path']);
});

test('prompt states exact proposal and supporting-reference semantic shapes', () => {
  const prompt = buildClaudeCoordinatorPrompt(context);
  assert.match(prompt,
    /current evidence:\{"kind":"current_evidence","reference":"<exact current evidence reference>"\}/u);
  assert.match(prompt, /Memory:\{"kind":"memory","memoryId":"<exact memory fact id>"\}/u);
  assert.match(prompt,
    /Repository hint:\{"kind":"repository_hint","path":"<exact repository hint path>"\}/u);
  assert.match(prompt, /exactly two fields: kind plus its one semantic payload field/u);
  assert.match(prompt, /Never add path or memoryId to current_evidence/u);
  assert.match(prompt, /reference or path to memory/u);
  assert.match(prompt, /reference or memoryId to repository_hint/u);
  assert.match(prompt, /JSON-pointer\/location metadata/u);
  assert.match(prompt, /reference means the exact semantic evidence reference value/u);
  assert.match(prompt, /for example run\.status/u);
  assert.match(prompt, /never its JSON location/u);
  assert.match(prompt, /current\.diagnosis\.evidence\[0\]\.reference/u);
  assert.match(prompt, /no_action and human_required must not include actionId/u);
  assert.match(prompt, /select_action must include actionId/u);
});

test('runtime parser accepts all three valid proposal variants under the flat transport schema', () => {
  const proposals = [
    {
      version: 1, decision: 'no_action', reason: 'No action.',
      supportingReferences: [{ kind: 'current_evidence', reference: 'run.status' }],
    },
    {
      version: 1, decision: 'select_action', actionId: 'RETRY_REVIEW_OUTPUT',
      reason: 'Retry the current malformed review.',
      supportingReferences: [{ kind: 'current_evidence', reference: 'task:review.error' }],
    },
    {
      version: 1, decision: 'human_required', reason: 'Human judgment is required.',
      supportingReferences: [{ kind: 'repository_hint', path: 'tools/agent-orchestrator' }],
    },
  ];
  for (const proposal of proposals) assert.deepEqual(parseCoordinatorProposal(proposal), proposal);
});

test('runtime parser rejects semantic combinations intentionally representable by the flat schema', () => {
  const schema = CLAUDE_COORDINATOR_PROPOSAL_SCHEMA;
  assert.equal((schema.required as readonly string[]).includes('actionId'), false);
  assert.deepEqual(schema.properties.supportingReferences.items.required, ['kind']);
  assert.ok('path' in schema.properties.supportingReferences.items.properties);
  assert.ok('memoryId' in schema.properties.supportingReferences.items.properties);

  const base = { version: 1, reason: 'Transport-valid but semantically invalid.', supportingReferences: [] };
  for (const proposal of [
    { ...base, decision: 'no_action', actionId: 'RETRY_REVIEW_OUTPUT' },
    { ...base, decision: 'select_action' },
    { ...base, decision: 'no_action', supportingReferences: [{ kind: 'memory', path: 'wrong' }] },
    { ...base, decision: 'no_action', supportingReferences: [{
      kind: 'current_evidence',
      reference: 'run.status',
      path: 'current.diagnosis.evidence[0].reference',
    }] },
  ]) assert.throws(() => parseCoordinatorProposal(proposal));
});

test('valid success envelope returns structured_output rather than the provider envelope', async () => {
  const fixture = await createFixture();
  try {
    const proposal = validProposal();
    const returned = await reasoner(fixture, { FAKE_RESPONSE: JSON.stringify(proposal) }).propose(context);
    assert.deepEqual(returned, proposal);
    assert.equal(Object.prototype.hasOwnProperty.call(returned as object, 'type'), false);
  } finally { await fixture.dispose(); }
});

for (const behavior of ['malformed', 'missing', 'null', 'error'] as const) {
  test(`${behavior} provider envelope throws one bounded adapter error`, async () => {
    const fixture = await createFixture();
    try {
      const adapter = reasoner(fixture, { FAKE_BEHAVIOR: behavior });
      await assert.rejects(() => adapter.propose(context), (error: unknown) =>
        error instanceof ClaudeCoordinatorReasonerError
        && error.code === 'INVALID_PROVIDER_ENVELOPE'
        && !error.message.includes('provider-secret'));
      assert.equal((await recordsOf(fixture)).length, 1);
    } finally { await fixture.dispose(); }
  });
}

test('nonzero exit hides stderr and performs no retry', async () => {
  const fixture = await createFixture();
  try {
    const adapter = reasoner(fixture, { FAKE_BEHAVIOR: 'nonzero' });
    await assert.rejects(() => adapter.propose(context), (error: unknown) =>
      error instanceof ClaudeCoordinatorReasonerError
      && error.code === 'NONZERO_EXIT'
      && !error.message.includes('provider-secret'));
    assert.equal((await recordsOf(fixture)).length, 1);
  } finally { await fixture.dispose(); }
});

test('missing executable throws a bounded error', async () => {
  const adapter = new ClaudeCoordinatorReasoner({
    executable: join(tmpdir(), 'coordinator-provider-does-not-exist'),
    workingDirectory: tmpdir(),
    timeoutMs: 1_000,
  });
  await assert.rejects(() => adapter.propose(context), (error: unknown) =>
    error instanceof ClaudeCoordinatorReasonerError && error.code === 'EXECUTABLE_NOT_FOUND');
});

test('timeout terminates the process and throws without retry', async () => {
  const fixture = await createFixture();
  try {
    const adapter = reasoner(fixture, { FAKE_BEHAVIOR: 'timeout' }, { timeoutMs: 300, terminationGraceMs: 25 });
    await assert.rejects(() => adapter.propose(context), (error: unknown) =>
      error instanceof ClaudeCoordinatorReasonerError && error.code === 'TIMEOUT');
    assert.equal((await recordsOf(fixture)).length, 1);
  } finally { await fixture.dispose(); }
});

test('pre-aborted invocation spawns no process and throws a bounded error', async () => {
  const fixture = await createFixture();
  try {
    const controller = new AbortController();
    controller.abort();
    const adapter = reasoner(fixture, {}, { abortSignal: controller.signal });
    await assert.rejects(() => adapter.propose(context), (error: unknown) =>
      error instanceof ClaudeCoordinatorReasonerError && error.code === 'ABORTED');
    assert.equal((await recordsOf(fixture)).length, 0);
  } finally { await fixture.dispose(); }
});

for (const behavior of ['oversized_stdout', 'oversized_stderr'] as const) {
  test(`${behavior} is bounded and terminates without retry`, async () => {
    const fixture = await createFixture();
    try {
      const adapter = reasoner(fixture, { FAKE_BEHAVIOR: behavior }, {
        maxStdoutBytes: 1_024,
        maxStderrBytes: 1_024,
        terminationGraceMs: 25,
      });
      await assert.rejects(() => adapter.propose(context), (error: unknown) =>
        error instanceof ClaudeCoordinatorReasonerError && error.code === 'OUTPUT_LIMIT');
      assert.equal((await recordsOf(fixture)).length, 1);
    } finally { await fixture.dispose(); }
  });
}

test('schema-valid but currently unavailable action remains PROPOSAL_INVALID through Coordinator Core', async () => {
  const fixture = await createFixture();
  try {
    const invalid = {
      version: 1,
      decision: 'select_action',
      actionId: 'RETRY_REVIEW_OUTPUT',
      reason: 'Select an action that is not a current candidate.',
      supportingReferences: [],
    };
    const result = await coordinate(context, reasoner(fixture, { FAKE_RESPONSE: JSON.stringify(invalid) }));
    assert.deepEqual(result, {
      version: 1,
      status: 'reasoner_failed',
      scope: context.scope,
      code: 'PROPOSAL_INVALID',
    });
    assert.equal((await recordsOf(fixture)).length, 1);
  } finally { await fixture.dispose(); }
});

test('provider adapter has no legacy AgentRole, review, router, policy, or execution dependency', async () => {
  const root = resolve(__dirname, '../../../src/coordinator-providers');
  const sources = (await Promise.all(['bounded-process.ts', 'claude-coordinator-reasoner.ts']
    .map((file) => readFile(join(root, file), 'utf8')))).join('\n');
  const imports = sources.split('\n').filter((line) => line.startsWith('import ')).join('\n');
  assert.doesNotMatch(imports, /agents|review|router|policy|orchestrator/u);
  assert.doesNotMatch(sources, /AgentRole|AgentRequest|executeDecision|selectProvider|rankProfiles|retry\(/u);
});

function validProposal() {
  return {
    version: 1,
    decision: 'no_action',
    reason: 'No current failure is active.',
    supportingReferences: [{ kind: 'current_evidence', reference: 'run.status' }],
  };
}

function reasoner(
  fixture: Fixture,
  additions: NodeJS.ProcessEnv = {},
  options: Partial<ConstructorParameters<typeof ClaudeCoordinatorReasoner>[0]> = {},
): ClaudeCoordinatorReasoner {
  return new ClaudeCoordinatorReasoner({
    executable: fixture.executable,
    workingDirectory: fixture.directory,
    environment: { ...process.env, RECORD_PATH: fixture.recordPath, ...additions },
    timeoutMs: 2_000,
    ...options,
  });
}

async function createFixture(): Promise<Fixture> {
  const directory = await mkdtemp(join(tmpdir(), 'claude-coordinator-'));
  const executable = join(directory, 'fake-claude');
  const recordPath = join(directory, 'records.jsonl');
  await writeFile(join(directory, 'unread-secret.txt'), 'EXTERNAL_REPOSITORY_SECRET', 'utf8');
  await writeFile(executable, `#!/usr/bin/env node
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.appendFileSync(process.env.RECORD_PATH, JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), stdin }) + '\\n');
  const behavior = process.env.FAKE_BEHAVIOR || 'success';
  if (behavior === 'timeout') { setInterval(() => {}, 1000); return; }
  if (behavior === 'nonzero') { process.stderr.write('provider-secret raw stderr'); process.exit(17); }
  if (behavior === 'oversized_stdout') { process.stdout.write('x'.repeat(200000)); return; }
  if (behavior === 'oversized_stderr') { process.stderr.write('provider-secret'.repeat(20000)); setInterval(() => {}, 1000); return; }
  if (behavior === 'malformed') { process.stdout.write('{not-json'); return; }
  if (behavior === 'missing') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false })); return; }
  if (behavior === 'null') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: null })); return; }
  if (behavior === 'error') { process.stdout.write(JSON.stringify({ type: 'result', subtype: 'error', is_error: true, structured_output: { version: 1 } })); return; }
  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: JSON.parse(process.env.FAKE_RESPONSE) }));
});
`, 'utf8');
  await chmod(executable, 0o700);
  return { directory, executable, recordPath, dispose: () => rm(directory, { recursive: true, force: true }) };
}

async function recordsOf(fixture: Fixture): Promise<Array<{ args: string[]; cwd: string; stdin: string }>> {
  const source = await readFile(fixture.recordPath, 'utf8').catch(() => '');
  return source.trim() === '' ? [] : source.trim().split('\n').map((line) => JSON.parse(line));
}

function assertArgPair(args: readonly string[], flag: string, value: string): void {
  const index = args.indexOf(flag);
  assert.notEqual(index, -1, flag);
  assert.equal(args[index + 1], value);
}

function collectKeys(value: unknown, keys = new Set<string>()): ReadonlySet<string> {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, keys);
    return keys;
  }
  if (typeof value !== 'object' || value === null) return keys;
  for (const [key, child] of Object.entries(value)) {
    keys.add(key);
    collectKeys(child, keys);
  }
  return keys;
}
