import { ACTION_IDS, type ActionId } from '../action-mapping/types';
import type { CoordinatorProposal, CoordinatorReference } from './types';
import {
  MAX_COORDINATOR_REASON_BYTES,
  MAX_COORDINATOR_REFERENCES,
  MAX_COORDINATOR_REFERENCE_BYTES,
} from './types';

const BASE_KEYS = ['version', 'decision', 'reason', 'supportingReferences'] as const;
const REFERENCE_KEYS = {
  current_evidence: ['kind', 'reference'],
  memory: ['kind', 'memoryId'],
  repository_hint: ['kind', 'path'],
} as const;

class CoordinatorProposalValidationError extends Error {
  constructor(message: string) {
    super(`Coordinator proposal: ${message}`);
    this.name = 'CoordinatorProposalValidationError';
  }
}

function invalid(message: string): never {
  throw new CoordinatorProposalValidationError(message);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(`${path} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    invalid(`${path} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function strictKeys(value: Record<string, unknown>, allowed: readonly string[], path: string): void {
  const extra = Reflect.ownKeys(value).filter((key) => typeof key !== 'string' || !allowed.includes(key));
  if (extra.length > 0) invalid(`${path} has unsupported fields: ${extra.map(String).sort().join(', ')}`);
}

function required(value: Record<string, unknown>, key: string, path: string): unknown {
  if (!Object.prototype.hasOwnProperty.call(value, key)) invalid(`${path}.${key} is required`);
  return value[key];
}

function boundedText(value: unknown, path: string, maximumBytes: number): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    invalid(`${path} must be a non-empty string without NUL`);
  }
  if (new TextEncoder().encode(value).byteLength > maximumBytes) {
    invalid(`${path} exceeds ${maximumBytes} UTF-8 bytes`);
  }
  return value;
}

function parseReference(value: unknown, index: number): CoordinatorReference {
  const path = `supportingReferences[${index}]`;
  const input = record(value, path);
  const rawKind = required(input, 'kind', path);
  if (typeof rawKind !== 'string'
    || !Object.prototype.hasOwnProperty.call(REFERENCE_KEYS, rawKind)) {
    invalid(`${path}.kind is unsupported`);
  }
  const kind = rawKind as keyof typeof REFERENCE_KEYS;
  strictKeys(input, REFERENCE_KEYS[kind], path);
  if (kind === 'current_evidence') {
    return { kind, reference: boundedText(required(input, 'reference', path), `${path}.reference`, MAX_COORDINATOR_REFERENCE_BYTES) };
  }
  if (kind === 'memory') {
    return { kind, memoryId: boundedText(required(input, 'memoryId', path), `${path}.memoryId`, MAX_COORDINATOR_REFERENCE_BYTES) };
  }
  return { kind, path: boundedText(required(input, 'path', path), `${path}.path`, MAX_COORDINATOR_REFERENCE_BYTES) };
}

function referenceKey(reference: CoordinatorReference): string {
  if (reference.kind === 'current_evidence') return `${reference.kind}:${reference.reference}`;
  if (reference.kind === 'memory') return `${reference.kind}:${reference.memoryId}`;
  return `${reference.kind}:${reference.path}`;
}

function parseReferences(value: unknown): readonly CoordinatorReference[] {
  if (!Array.isArray(value)) invalid('supportingReferences must be an array');
  if (value.length > MAX_COORDINATOR_REFERENCES) {
    invalid(`supportingReferences exceeds ${MAX_COORDINATOR_REFERENCES} entries`);
  }
  const references = Array.from(value, (entry, index) => parseReference(entry, index));
  const keys = references.map(referenceKey);
  if (new Set(keys).size !== keys.length) invalid('supportingReferences must not contain duplicates');
  return references;
}

/** Strict runtime parser for untrusted provider-neutral Coordinator proposals. */
export function parseCoordinatorProposal(value: unknown): CoordinatorProposal {
  const input = record(value, 'proposal');
  if (required(input, 'version', 'proposal') !== 1) invalid('version must be 1');
  const rawDecision = required(input, 'decision', 'proposal');
  if (typeof rawDecision !== 'string'
    || !['no_action', 'select_action', 'human_required'].includes(rawDecision)) {
    invalid('decision is unsupported');
  }
  const decision = rawDecision as CoordinatorProposal['decision'];
  strictKeys(input, decision === 'select_action' ? [...BASE_KEYS, 'actionId'] : BASE_KEYS, 'proposal');
  const reason = boundedText(required(input, 'reason', 'proposal'), 'reason', MAX_COORDINATOR_REASON_BYTES);
  const supportingReferences = parseReferences(required(input, 'supportingReferences', 'proposal'));
  if (decision === 'select_action') {
    const actionId = required(input, 'actionId', 'proposal');
    if (typeof actionId !== 'string' || !(ACTION_IDS as readonly string[]).includes(actionId)) {
      invalid('actionId is unsupported');
    }
    return { version: 1, decision, actionId: actionId as ActionId, reason, supportingReferences };
  }
  return { version: 1, decision, reason, supportingReferences };
}
