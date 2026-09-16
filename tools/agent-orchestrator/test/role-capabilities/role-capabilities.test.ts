import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import test from 'node:test';

import { defaultAccessForRole, type AgentRole } from '../../src/agents';
import {
  CAPABILITY_IDS,
  ROLE_CAPABILITY_REQUIREMENTS,
  ROLE_IDS,
  matchCapabilities,
  parseCapabilityProfile,
  requiredCapabilitiesForRole,
  type CapabilityId,
  type CapabilityProfile,
  type RoleId,
} from '../../src/role-capabilities';

const BASELINE = ['structured_reasoning', 'structured_output'] as const;
const LEGACY_ROLES: readonly AgentRole[] = [
  'implementation', 'review', 'correction', 'testing', 'synthesis',
  'final_review', 'escalation', 'integration', 'debate', 'handoff_repair',
];

function profile(...capabilities: CapabilityId[]): CapabilityProfile {
  return { version: 1, capabilities };
}

test('capability and role vocabularies are closed, canonical, and unique', () => {
  assert.deepEqual(CAPABILITY_IDS, [
    'structured_reasoning', 'structured_output', 'repository_read',
    'code_edit', 'code_review', 'test_execution',
  ]);
  assert.equal(new Set(CAPABILITY_IDS).size, CAPABILITY_IDS.length);
  assert.deepEqual(ROLE_IDS, [
    'coordinator', 'implementation', 'review', 'correction', 'testing',
    'synthesis', 'final_review', 'escalation', 'integration', 'debate', 'handoff_repair',
  ]);
  assert.equal(new Set(ROLE_IDS).size, ROLE_IDS.length);
});

test('registry exhaustively represents legacy AgentRole plus coordinator', () => {
  for (const role of LEGACY_ROLES) assert.ok(ROLE_IDS.includes(role), role);
  assert.deepEqual(ROLE_IDS.filter((role) => !LEGACY_ROLES.includes(role as AgentRole)), ['coordinator']);
  assert.deepEqual(Object.keys(ROLE_CAPABILITY_REQUIREMENTS), ROLE_IDS);
});

test('every role has exact minimum capabilities in canonical order', () => {
  const expected: Readonly<Record<RoleId, readonly CapabilityId[]>> = {
    coordinator: BASELINE,
    implementation: [...BASELINE, 'repository_read', 'code_edit'],
    review: [...BASELINE, 'repository_read', 'code_review'],
    correction: [...BASELINE, 'repository_read', 'code_edit'],
    testing: [...BASELINE, 'repository_read', 'test_execution'],
    synthesis: BASELINE,
    final_review: [...BASELINE, 'repository_read', 'code_review'],
    escalation: BASELINE,
    integration: [...BASELINE, 'repository_read', 'code_edit'],
    debate: BASELINE,
    handoff_repair: BASELINE,
  };
  for (const role of ROLE_IDS) {
    assert.deepEqual(requiredCapabilitiesForRole(role), expected[role], role);
    const positions = requiredCapabilitiesForRole(role).map((capability) => CAPABILITY_IDS.indexOf(capability));
    assert.deepEqual(positions, [...positions].sort((left, right) => left - right), role);
  }
});

test('minimal reasoning profile satisfies only roles with baseline requirements', () => {
  const reasoning = profile(...BASELINE);
  for (const role of ['coordinator', 'synthesis', 'escalation', 'debate', 'handoff_repair'] as const) {
    assert.equal(matchCapabilities(role, reasoning).status, 'satisfied', role);
  }
  for (const role of ['implementation', 'review', 'testing', 'integration'] as const) {
    assert.equal(matchCapabilities(role, reasoning).status, 'missing_capabilities', role);
  }
});

test('code profile satisfies implementation, correction, and integration but not review', () => {
  const code = profile(...BASELINE, 'repository_read', 'code_edit');
  for (const role of ['implementation', 'correction', 'integration'] as const) {
    assert.equal(matchCapabilities(role, code).status, 'satisfied', role);
  }
  assert.deepEqual(matchCapabilities('review', code).missing, ['code_review']);
});

test('review profile satisfies review and final_review but not implementation', () => {
  const review = profile(...BASELINE, 'repository_read', 'code_review');
  assert.equal(matchCapabilities('review', review).status, 'satisfied');
  assert.equal(matchCapabilities('final_review', review).status, 'satisfied');
  assert.deepEqual(matchCapabilities('implementation', review).missing, ['code_edit']);
});

test('testing profile satisfies testing', () => {
  const testing = profile(...BASELINE, 'repository_read', 'test_execution');
  assert.equal(matchCapabilities('testing', testing).status, 'satisfied');
});

test('all-capability superset satisfies every v1 role', () => {
  const all = profile(...CAPABILITY_IDS);
  for (const role of ROLE_IDS) assert.equal(matchCapabilities(role, all).status, 'satisfied', role);
});

test('missing and available lists are exact and canonically ordered', () => {
  const result = matchCapabilities('testing', profile('test_execution', 'structured_output'));
  assert.deepEqual(result, {
    version: 1,
    role: 'testing',
    status: 'missing_capabilities',
    required: ['structured_reasoning', 'structured_output', 'repository_read', 'test_execution'],
    available: ['structured_output', 'test_execution'],
    missing: ['structured_reasoning', 'repository_read'],
  });
});

test('available input ordering does not affect results or mutate caller arrays', () => {
  const first: CapabilityId[] = ['code_edit', 'structured_output', 'repository_read', 'structured_reasoning'];
  const second: CapabilityId[] = [...first].reverse();
  const firstBefore = [...first];
  const secondBefore = [...second];
  assert.deepEqual(matchCapabilities('implementation', { version: 1, capabilities: first }),
    matchCapabilities('implementation', { version: 1, capabilities: second }));
  assert.deepEqual(first, firstBefore);
  assert.deepEqual(second, secondBefore);
});

test('profile parsing rejects duplicate, unknown, missing, extra, and wrong-version input', () => {
  const invalidProfiles: unknown[] = [
    { version: 1, capabilities: ['structured_output', 'structured_output'] },
    { version: 1, capabilities: ['future_capability'] },
    { capabilities: [] },
    { version: 1, capabilities: [], extra: true },
    { version: 2, capabilities: [] },
  ];
  for (const invalid of invalidProfiles) assert.throws(() => parseCapabilityProfile(invalid), TypeError);
});

test('profile parsing rejects hostile object descriptors without invoking getters', () => {
  let calls = 0;
  const accessor = { version: 1 } as Record<string, unknown>;
  Object.defineProperty(accessor, 'capabilities', { enumerable: true, get: () => {
    calls += 1;
    return [];
  } });
  const nonEnumerable = { capabilities: [] } as Record<string, unknown>;
  Object.defineProperty(nonEnumerable, 'version', { enumerable: false, value: 1 });
  const symbol = { version: 1, capabilities: [], [Symbol('extra')]: true };
  for (const invalid of [accessor, nonEnumerable, symbol]) {
    assert.throws(() => parseCapabilityProfile(invalid), TypeError);
  }
  assert.equal(calls, 0);
});

test('profile parsing rejects hostile arrays without invoking index getters', () => {
  let calls = 0;
  const accessor: unknown[] = [];
  Object.defineProperty(accessor, '0', { enumerable: true, get: () => {
    calls += 1;
    return 'structured_reasoning';
  } });
  const sparse = new Array(1);
  const extra: unknown[] = [];
  Object.defineProperty(extra, 'extra', { enumerable: true, value: true });
  const nonstandard: unknown[] = [];
  Object.setPrototypeOf(nonstandard, null);
  for (const capabilities of [accessor, sparse, extra, nonstandard]) {
    assert.throws(() => parseCapabilityProfile({ version: 1, capabilities }), TypeError);
  }
  assert.equal(calls, 0);
});

test('normal JSON and null-prototype data profiles remain valid', () => {
  const json = JSON.parse('{"version":1,"capabilities":["code_review","structured_reasoning"]}') as unknown;
  assert.deepEqual(parseCapabilityProfile(json), {
    version: 1,
    capabilities: ['structured_reasoning', 'code_review'],
  });
  const nullPrototype = Object.assign(Object.create(null) as Record<string, unknown>, {
    version: 1,
    capabilities: [],
  });
  assert.deepEqual(parseCapabilityProfile(nullPrototype), { version: 1, capabilities: [] });
});

test('registry and matcher outputs are immutable', () => {
  const result = matchCapabilities('coordinator', profile(...BASELINE));
  assert.equal(Object.isFrozen(CAPABILITY_IDS), true);
  assert.equal(Object.isFrozen(ROLE_IDS), true);
  assert.equal(Object.isFrozen(ROLE_CAPABILITY_REQUIREMENTS), true);
  assert.equal(Object.isFrozen(requiredCapabilitiesForRole('coordinator')), true);
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.available), true);
});

test('capability fit cannot change legacy access authority', () => {
  const all = profile(...CAPABILITY_IDS);
  assert.equal(matchCapabilities('review', all).status, 'satisfied');
  assert.equal(defaultAccessForRole('review'), 'read_only');
  assert.equal(matchCapabilities('implementation', all).status, 'satisfied');
  assert.equal(defaultAccessForRole('implementation'), 'writer');
});

test('production registry has no vendor mapping, provider invocation, routing, or Coordinator wiring', async () => {
  const registryRoot = resolve(__dirname, '../../../src/role-capabilities');
  const registry = (await Promise.all(['registry.ts', 'index.ts']
    .map((file) => readFile(resolve(registryRoot, file), 'utf8')))).join('\n');
  assert.doesNotMatch(registry, /claude|codex|openai|gemini|requestedModel|provider\s*:/iu);
  assert.doesNotMatch(registry, /selectProvider|selectModel|rankProfiles|scoreProfiles|\.run\(|\.propose\(/u);
  const coordinator = await readFile(resolve(__dirname, '../../../src/coordinator-core/coordinator.ts'), 'utf8');
  assert.doesNotMatch(coordinator, /role-capabilities/u);
});
