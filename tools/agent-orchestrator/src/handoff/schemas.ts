import { OrchestratorError } from '../errors';

export const HANDOFF_STATUSES = ['complete', 'blocked', 'failed'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const TEST_RESULTS = ['pass', 'fail', 'not_run'] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

export interface HandoffTest {
  readonly command: string;
  readonly result: TestResult;
  readonly details: string;
}

export interface StructuredHandoff {
  readonly status: HandoffStatus;
  readonly summary: string;
  readonly filesChanged: readonly string[];
  readonly decisions: readonly string[];
  readonly tests: readonly HandoffTest[];
  readonly openQuestions: readonly string[];
  readonly reviewRequested: readonly string[];
}

const HANDOFF_KEYS = new Set([
  'status',
  'summary',
  'filesChanged',
  'decisions',
  'tests',
  'openQuestions',
  'reviewRequested',
]);
const TEST_KEYS = new Set(['command', 'result', 'details']);

function invalid(path: string, message: string, cause?: unknown): never {
  throw new OrchestratorError('HANDOFF_INVALID', `${path}: ${message}`, {
    ...(cause === undefined ? {} : { cause }),
    details: { path },
  });
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function knownKeys(
  value: Record<string, unknown>,
  keys: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!keys.has(key)) {
      invalid(`${path}.${key}`, 'is not a supported field');
    }
  }
}

function text(value: unknown, path: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.trim() === '') ||
    value.includes('\0')
  ) {
    invalid(path, allowEmpty ? 'must be a string without NUL' : 'must be a non-empty string');
  }
  return value;
}

function textArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    invalid(path, 'must be an array');
  }
  return value.map((entry, index) => text(entry, `${path}[${index}]`));
}

function parseTest(value: unknown, index: number): HandoffTest {
  const path = `handoff.tests[${index}]`;
  const object = record(value, path);
  knownKeys(object, TEST_KEYS, path);
  const result = text(object.result, `${path}.result`);
  if (!(TEST_RESULTS as readonly string[]).includes(result)) {
    invalid(`${path}.result`, `must be one of ${TEST_RESULTS.join(', ')}`);
  }
  return {
    command: text(object.command, `${path}.command`),
    result: result as TestResult,
    details: text(object.details, `${path}.details`, true),
  };
}

export function validateHandoff(value: unknown): StructuredHandoff {
  const object = record(value, 'handoff');
  knownKeys(object, HANDOFF_KEYS, 'handoff');
  const status = text(object.status, 'handoff.status');
  if (!(HANDOFF_STATUSES as readonly string[]).includes(status)) {
    invalid('handoff.status', `must be one of ${HANDOFF_STATUSES.join(', ')}`);
  }
  if (!Array.isArray(object.tests)) {
    invalid('handoff.tests', 'must be an array');
  }
  const filesChanged = textArray(object.filesChanged, 'handoff.filesChanged');
  for (const [index, path] of filesChanged.entries()) {
    if (
      path.startsWith('/') ||
      path.includes('\\') ||
      path.split('/').some((part) => part === '' || part === '.' || part === '..')
    ) {
      invalid(`handoff.filesChanged[${index}]`, 'must be a safe repository-relative path');
    }
  }
  return {
    status: status as HandoffStatus,
    summary: text(object.summary, 'handoff.summary'),
    filesChanged,
    decisions: textArray(object.decisions, 'handoff.decisions'),
    tests: object.tests.map(parseTest),
    openQuestions: textArray(object.openQuestions, 'handoff.openQuestions'),
    reviewRequested: textArray(object.reviewRequested, 'handoff.reviewRequested'),
  };
}
