import { canonicalHash, canonicalJson } from '../canonical-json';
import { ACTION_IDS } from '../action-mapping/types';
import { FAILURE_CLASSIFICATIONS, FAILURE_VARIANTS } from '../failure-intelligence/types';
import { OrchestratorError } from '../errors';
import { MEMORY_KINDS, type JsonValue, type MemoryEntry, type MemoryEntryBody,
  type MemoryProvenance, type MemorySubject } from './types';

export const MAX_MEMORY_ENTRY_BYTES = 64 * 1024;
const MAX_REFERENCES = 256;
const MAX_TEXT = 4_096;
const DIGEST = /^[a-f0-9]{64}$/;

function corrupt(message: string): never {
  throw new OrchestratorError('STATE_CORRUPT', `Memory entry: ${message}`);
}

function object(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) corrupt(`${path} has invalid fields`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_TEXT || value.includes('\0')) {
    corrupt(`${path} must be bounded non-empty text`);
  }
  return value;
}

function digest(value: unknown, path: string): string {
  const result = text(value, path);
  if (!DIGEST.test(result)) corrupt(`${path} must be a sha256 digest`);
  return result;
}

function parseSubject(value: unknown): MemorySubject {
  const subject = object(value, ['kind', 'taskId'], 'subject');
  if (subject.kind === 'task') return { kind: 'task', taskId: text(subject.taskId, 'subject.taskId') };
  if ((subject.kind === 'run' || subject.kind === 'integration') && subject.taskId === undefined) {
    return { kind: subject.kind };
  }
  return corrupt('subject is not supported');
}

function references(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) corrupt('provenance.references is not bounded');
  return value.map((entry, index) => text(entry, `provenance.references[${index}]`));
}

function parseProvenance(value: unknown): MemoryProvenance {
  const provenance = object(value, ['sourceKind', 'producerVersion', 'runId', 'taskId', 'references'], 'provenance');
  if (!['failure_diagnosis', 'action_mapping', 'outcome', 'trusted_decision', 'trusted_invariant'].includes(String(provenance.sourceKind))) {
    corrupt('provenance.sourceKind is not supported');
  }
  if (provenance.producerVersion !== 1) corrupt('provenance.producerVersion is not supported');
  return {
    sourceKind: provenance.sourceKind as MemoryProvenance['sourceKind'],
    producerVersion: 1,
    ...(provenance.runId === undefined ? {} : { runId: text(provenance.runId, 'provenance.runId') }),
    ...(provenance.taskId === undefined ? {} : { taskId: text(provenance.taskId, 'provenance.taskId') }),
    references: references(provenance.references),
  };
}

function jsonValue(value: unknown, path: string, depth = 0): JsonValue {
  if (depth > 16) corrupt(`${path} exceeds maximum depth`);
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) {
    if (value.length > 256) corrupt(`${path} is too large`);
    if (Object.getPrototypeOf(value) !== Array.prototype) corrupt(`${path} must be a plain JSON array`);
    const ownKeys = Reflect.ownKeys(value);
    if (ownKeys.length !== value.length + 1 || ownKeys.some((key) =>
      key !== 'length' && (typeof key !== 'string' || !/^(0|[1-9][0-9]*)$/.test(key)
        || Number(key) >= value.length))) corrupt(`${path} must be a dense plain JSON array`);
    return Array.from({ length: value.length }, (_, index) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
      if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
        corrupt(`${path}[${index}] must be an enumerable data property`);
      }
      return jsonValue(descriptor.value, `${path}[${index}]`, depth + 1);
    });
  }
  if (typeof value !== 'object' || value === null) corrupt(`${path} is not JSON-compatible`);
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) corrupt(`${path} must be a plain JSON object`);
  const keys = Reflect.ownKeys(value);
  if (keys.length > 256) corrupt(`${path} is too large`);
  return Object.fromEntries(keys.map((key) => {
    if (typeof key !== 'string') corrupt(`${path} must not contain symbol keys`);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined || !descriptor.enumerable || !('value' in descriptor)) {
      corrupt(`${path}.${key} must be an enumerable data property`);
    }
    return [text(key, `${path} key`), jsonValue(descriptor.value, `${path}.${key}`, depth + 1)];
  }));
}

function parseData(kind: MemoryEntryBody['kind'], value: unknown): MemoryEntryBody['data'] {
  if (kind === 'FAILURE') {
    const data = object(value, ['diagnosisVersion', 'classification', 'variant', 'agent'], 'data');
    if (data.diagnosisVersion !== 1 || !FAILURE_CLASSIFICATIONS.includes(data.classification as never)
      || data.variant !== undefined && !FAILURE_VARIANTS.includes(data.variant as never)
      || data.agent !== undefined && data.agent !== 'codex' && data.agent !== 'claude') corrupt('FAILURE data is invalid');
    return { diagnosisVersion: 1, classification: data.classification as never,
      ...(data.variant === undefined ? {} : { variant: data.variant as never }),
      ...(data.agent === undefined ? {} : { agent: data.agent as 'codex' | 'claude' }) };
  }
  if (kind === 'ACTION_CANDIDATE') {
    const data = object(value, ['actionVersion', 'actionId', 'mutatesState', 'execution', 'authority',
      'basisClassification', 'sourceFailureMemoryId'], 'data');
    const authority = object(data.authority, ['kind', 'required'], 'data.authority');
    if (data.actionVersion !== 1 || !ACTION_IDS.includes(data.actionId as never)
      || typeof data.mutatesState !== 'boolean' || data.execution !== 'manual'
      || authority.kind !== 'human' || typeof authority.required !== 'boolean'
      || !FAILURE_CLASSIFICATIONS.includes(data.basisClassification as never)) corrupt('ACTION_CANDIDATE data is invalid');
    return { actionVersion: 1, actionId: data.actionId as never, mutatesState: data.mutatesState,
      execution: 'manual', authority: { kind: 'human', required: authority.required },
      basisClassification: data.basisClassification as never,
      sourceFailureMemoryId: digest(data.sourceFailureMemoryId, 'data.sourceFailureMemoryId') };
  }
  if (kind === 'OUTCOME') {
    const data = object(value, ['sourceActionMemoryId', 'status', 'resultCode'], 'data');
    if (!['succeeded', 'failed', 'blocked', 'cancelled'].includes(String(data.status))) corrupt('OUTCOME status is invalid');
    return { sourceActionMemoryId: digest(data.sourceActionMemoryId, 'data.sourceActionMemoryId'),
      status: data.status as 'succeeded' | 'failed' | 'blocked' | 'cancelled',
      ...(data.resultCode === undefined ? {} : { resultCode: text(data.resultCode, 'data.resultCode') }) };
  }
  if (kind === 'DECISION') {
    const data = object(value, ['key', 'value', 'rationale'], 'data');
    return { key: text(data.key, 'data.key'), value: jsonValue(data.value, 'data.value'),
      rationale: text(data.rationale, 'data.rationale') };
  }
  const data = object(value, ['key', 'rule', 'rationale'], 'data');
  return { key: text(data.key, 'data.key'), rule: jsonValue(data.rule, 'data.rule'),
    ...(data.rationale === undefined ? {} : { rationale: text(data.rationale, 'data.rationale') }) };
}

export function memoryEntryId(body: MemoryEntryBody): string {
  return canonicalHash(body);
}

export function createMemoryEntry(body: MemoryEntryBody): MemoryEntry {
  return parseMemoryEntry({ ...body, id: memoryEntryId(body) });
}

export function parseMemoryEntry(value: unknown): MemoryEntry {
  const entry = object(value, ['version', 'id', 'kind', 'subject', 'data', 'provenance'], '$');
  if (entry.version !== 1) corrupt('version is not supported');
  if (!MEMORY_KINDS.includes(entry.kind as never)) corrupt('kind is not supported');
  const kind = entry.kind as MemoryEntryBody['kind'];
  const body = {
    version: 1 as const,
    kind,
    subject: parseSubject(entry.subject),
    data: parseData(kind, entry.data),
    provenance: parseProvenance(entry.provenance),
  } as MemoryEntryBody;
  const expectedSource: Record<MemoryEntryBody['kind'], MemoryProvenance['sourceKind']> = {
    FAILURE: 'failure_diagnosis',
    ACTION_CANDIDATE: 'action_mapping',
    OUTCOME: 'outcome',
    DECISION: 'trusted_decision',
    INVARIANT: 'trusted_invariant',
  };
  if (body.provenance.sourceKind !== expectedSource[body.kind]) corrupt('kind and provenance sourceKind disagree');
  if (body.subject.kind === 'task') {
    if (body.provenance.taskId !== body.subject.taskId) corrupt('task subject and provenance disagree');
  } else if (body.provenance.taskId !== undefined) corrupt('non-task subject cannot carry task provenance');
  if (body.kind === 'ACTION_CANDIDATE'
    && body.data.authority.required !== body.data.mutatesState) corrupt('action mutation and authority disagree');
  const id = digest(entry.id, 'id');
  if (memoryEntryId(body) !== id) corrupt('id does not match canonical body');
  return { ...body, id } as MemoryEntry;
}

export function serializeMemoryEntry(entry: MemoryEntry): string {
  const parsed = parseMemoryEntry(entry);
  const text = `${canonicalJson(parsed)}\n`;
  if (Buffer.byteLength(text, 'utf8') > MAX_MEMORY_ENTRY_BYTES) corrupt('exceeds maximum encoded size');
  return text;
}
