import type { AgentRole } from '../agents/agent';

/** Canonical v1 ordering for every capability-bearing value and result. */
export const CAPABILITY_IDS = Object.freeze([
  'structured_reasoning',
  'structured_output',
  'repository_read',
  'code_edit',
  'code_review',
  'test_execution',
] as const);

export type CapabilityId = (typeof CAPABILITY_IDS)[number];
export type RoleId = AgentRole | 'coordinator';

export interface CapabilityProfile {
  readonly version: 1;
  readonly capabilities: readonly CapabilityId[];
}

export interface CapabilityMatch {
  readonly version: 1;
  readonly role: RoleId;
  readonly status: 'satisfied' | 'missing_capabilities';
  readonly required: readonly CapabilityId[];
  readonly available: readonly CapabilityId[];
  readonly missing: readonly CapabilityId[];
}

function requirement<const T extends readonly CapabilityId[]>(...capabilities: T): T {
  return Object.freeze(capabilities);
}

/**
 * Immutable minimum role requirements. Capability fit describes ability only;
 * it never grants access, ownership, authorization, or execution authority.
 *
 * `satisfies Record<RoleId, ...>` is the compile-time compatibility guard: a
 * new legacy AgentRole makes this module fail compilation until represented.
 */
export const ROLE_CAPABILITY_REQUIREMENTS = Object.freeze({
  coordinator: requirement('structured_reasoning', 'structured_output'),
  implementation: requirement('structured_reasoning', 'structured_output', 'repository_read', 'code_edit'),
  review: requirement('structured_reasoning', 'structured_output', 'repository_read', 'code_review'),
  correction: requirement('structured_reasoning', 'structured_output', 'repository_read', 'code_edit'),
  testing: requirement('structured_reasoning', 'structured_output', 'repository_read', 'test_execution'),
  synthesis: requirement('structured_reasoning', 'structured_output'),
  final_review: requirement('structured_reasoning', 'structured_output', 'repository_read', 'code_review'),
  escalation: requirement('structured_reasoning', 'structured_output'),
  integration: requirement('structured_reasoning', 'structured_output', 'repository_read', 'code_edit'),
  debate: requirement('structured_reasoning', 'structured_output'),
  handoff_repair: requirement('structured_reasoning', 'structured_output'),
} satisfies Readonly<Record<RoleId, readonly CapabilityId[]>>);

/** Canonical role order, derived from the exhaustive immutable registry. */
export const ROLE_IDS = Object.freeze(Object.keys(ROLE_CAPABILITY_REQUIREMENTS) as RoleId[]);

const CAPABILITY_SET: ReadonlySet<string> = new Set(CAPABILITY_IDS);
const ROLE_SET: ReadonlySet<string> = new Set(ROLE_IDS);

function invalid(message: string): never {
  throw new TypeError(`Capability profile: ${message}`);
}

function isPlainDataObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function requiredDataProperty(value: Record<string, unknown>, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
    invalid(`${key} must be an enumerable data property`);
  }
  return descriptor.value;
}

function assertExactObjectKeys(value: Record<string, unknown>): void {
  const allowed = new Set(['version', 'capabilities']);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowed.has(key)) {
      invalid(`unsupported field ${String(key)}`);
    }
  }
}

function parseCapabilityArray(value: unknown): readonly CapabilityId[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype) {
    invalid('capabilities must be a standard array');
  }
  const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
  if (lengthDescriptor === undefined || !('value' in lengthDescriptor)
    || !Number.isSafeInteger(lengthDescriptor.value) || lengthDescriptor.value < 0) {
    invalid('capabilities length must be a data property');
  }
  const length = lengthDescriptor.value as number;
  if (length > CAPABILITY_IDS.length) invalid('capabilities contains too many entries');

  const allowedKeys = new Set<string>(['length']);
  const seen = new Set<CapabilityId>();
  for (let index = 0; index < length; index += 1) {
    const key = String(index);
    allowedKeys.add(key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      invalid(`capabilities[${index}] must be an enumerable data property`);
    }
    const capability = descriptor.value;
    if (typeof capability !== 'string' || !CAPABILITY_SET.has(capability)) {
      invalid(`capabilities[${index}] is unknown`);
    }
    const capabilityId = capability as CapabilityId;
    if (seen.has(capabilityId)) invalid(`capabilities contains duplicate ${capabilityId}`);
    seen.add(capabilityId);
  }
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !allowedKeys.has(key)) {
      invalid(`capabilities has unsupported field ${String(key)}`);
    }
  }
  return Object.freeze(CAPABILITY_IDS.filter((capability) => seen.has(capability)));
}

/** Strictly validates trusted adapter/configuration metadata and canonicalizes its ordering. */
export function parseCapabilityProfile(value: unknown): CapabilityProfile {
  if (!isPlainDataObject(value)) invalid('must be a plain data object');
  assertExactObjectKeys(value);
  if (requiredDataProperty(value, 'version') !== 1) invalid('version must be 1');
  const capabilities = parseCapabilityArray(requiredDataProperty(value, 'capabilities'));
  return Object.freeze({ version: 1, capabilities });
}

export function requiredCapabilitiesForRole(role: RoleId): readonly CapabilityId[] {
  if (!ROLE_SET.has(role)) invalid(`unknown role ${String(role)}`);
  return ROLE_CAPABILITY_REQUIREMENTS[role];
}

/** Pure subset match. This does not select, rank, authorize, route, or execute anything. */
export function matchCapabilities(role: RoleId, profile: unknown): CapabilityMatch {
  const required = requiredCapabilitiesForRole(role);
  const parsed = parseCapabilityProfile(profile);
  const availableSet = new Set(parsed.capabilities);
  const missing = required.filter((capability) => !availableSet.has(capability));
  return Object.freeze({
    version: 1,
    role,
    status: missing.length === 0 ? 'satisfied' : 'missing_capabilities',
    required: Object.freeze([...required]),
    available: Object.freeze([...parsed.capabilities]),
    missing: Object.freeze(missing),
  });
}
