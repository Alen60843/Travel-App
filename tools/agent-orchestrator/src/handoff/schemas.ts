import { OrchestratorError } from '../errors';
import { parseWorkRequestDraft, type WorkRequestDraft } from '../adaptive';

export const HANDOFF_STATUSES = ['complete', 'blocked', 'failed'] as const;
export type HandoffStatus = (typeof HANDOFF_STATUSES)[number];

export const TEST_RESULTS = ['pass', 'fail', 'not_run'] as const;
export type TestResult = (typeof TEST_RESULTS)[number];

export interface HandoffTest {
  readonly command: string;
  readonly result: TestResult;
  readonly details: string;
}

export const FINDING_DECISIONS = ['confirmed', 'rejected'] as const;
export type FindingDecision = (typeof FINDING_DECISIONS)[number];
export const FINDING_RESOLUTIONS = ['resolved', 'unresolved', 'not_applicable'] as const;
export type FindingResolution = (typeof FINDING_RESOLUTIONS)[number];

/**
 * A Fixer's verdict on exactly one Verifier finding. §5: the Fixer must not
 * apply findings blindly, so every finding it acts on (or declines to act on)
 * is recorded here with the evidence behind that decision — not just the
 * resulting diff.
 */
export interface FindingResponse {
  readonly findingId: string;
  /** Trusted assignment key is context-required for canonical-finding tasks. */
  readonly canonicalFindingKey?: string;
  readonly decision: FindingDecision;
  /** Required by canonical-finding tasks; optional for legacy/generic handoffs. */
  readonly resolution?: FindingResolution;
  readonly evidence: string;
  /** Populated when decision is "confirmed": what was changed. */
  readonly fix?: string;
  /** Populated when decision is "confirmed": how the fix was verified. */
  readonly verification?: string;
  /** Populated when decision is "rejected": why the finding does not hold. */
  readonly reason?: string;
}

export interface StructuredHandoff {
  readonly status: HandoffStatus;
  readonly summary: string;
  readonly filesChanged: readonly string[];
  readonly decisions: readonly string[];
  readonly tests: readonly HandoffTest[];
  readonly openQuestions: readonly string[];
  readonly reviewRequested: readonly string[];
  /**
   * Present on implementation/"Solver" tasks. Non-obvious constraints or
   * choices the task made that a downstream reviewer could not derive from
   * the diff alone — kept separate from `decisions` because these are
   * specifically things an adversarial Verifier should be told, not general
   * narration of what was done.
   */
  readonly assumptions?: readonly string[];
  /** Present on implementation/"Solver" tasks: known gaps or trade-offs, stated rather than discovered later. */
  readonly knownRisks?: readonly string[];
  /**
   * Present on implementation/"Solver" tasks: the Solver's own pointer to
   * where an adversarial Verifier is most likely to find a real defect —
   * boundary conditions, concurrency, error paths, trust boundaries. This is
   * a hint the Verifier is free to ignore; it is not a substitute for the
   * Verifier's own independent judgment.
   */
  readonly attackSurface?: readonly string[];
  /** Present on correction/"Fixer" tasks: see FindingResponse. */
  readonly findingResponses?: readonly FindingResponse[];
  readonly additionalWorkRequests?: readonly WorkRequestDraft[];
}

/** Exported so handoff/repair.ts can rename a malformed key to the exact bare form the validator below accepts, without duplicating this list. */
export const HANDOFF_KEYS = new Set([
  'status',
  'summary',
  'filesChanged',
  'decisions',
  'tests',
  'openQuestions',
  'reviewRequested',
  'assumptions',
  'knownRisks',
  'attackSurface',
  'findingResponses',
  'additionalWorkRequests',
]);
const TEST_KEYS = new Set(['command', 'result', 'details']);
/** Exported for the same reason as HANDOFF_KEYS above. */
export const FINDING_RESPONSE_KEYS = new Set([
  'findingId',
  'canonicalFindingKey',
  'decision',
  'resolution',
  'evidence',
  'fix',
  'verification',
  'reason',
]);

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

function optionalTextArray(value: unknown, path: string): string[] | undefined {
  return value === undefined ? undefined : textArray(value, path);
}

function parseFindingResponse(value: unknown, index: number): FindingResponse {
  const path = `handoff.findingResponses[${index}]`;
  const object = record(value, path);
  knownKeys(object, FINDING_RESPONSE_KEYS, path);
  const findingId = text(object.findingId, `${path}.findingId`);
  if (!/^F[0-9]{3,}$/.test(findingId)) {
    invalid(`${path}.findingId`, 'must match /^F[0-9]{3,}$/');
  }
  const decision = text(object.decision, `${path}.decision`);
  if (!(FINDING_DECISIONS as readonly string[]).includes(decision)) {
    invalid(`${path}.decision`, `must be one of ${FINDING_DECISIONS.join(', ')}`);
  }
  const resolution = object.resolution === undefined
    ? undefined
    : text(object.resolution, `${path}.resolution`);
  if (resolution !== undefined && !(FINDING_RESOLUTIONS as readonly string[]).includes(resolution)) {
    invalid(`${path}.resolution`, `must be one of ${FINDING_RESOLUTIONS.join(', ')}`);
  }
  return {
    findingId,
    ...(object.canonicalFindingKey === undefined
      ? {}
      : { canonicalFindingKey: text(object.canonicalFindingKey, `${path}.canonicalFindingKey`) }),
    decision: decision as FindingDecision,
    ...(resolution === undefined ? {} : { resolution: resolution as FindingResolution }),
    evidence: text(object.evidence, `${path}.evidence`),
    ...(object.fix === undefined ? {} : { fix: text(object.fix, `${path}.fix`) }),
    ...(object.verification === undefined
      ? {}
      : { verification: text(object.verification, `${path}.verification`) }),
    ...(object.reason === undefined ? {} : { reason: text(object.reason, `${path}.reason`) }),
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
  let findingResponses: FindingResponse[] | undefined;
  if (object.findingResponses !== undefined) {
    if (!Array.isArray(object.findingResponses)) {
      invalid('handoff.findingResponses', 'must be an array');
    }
    findingResponses = object.findingResponses.map(parseFindingResponse);
    const ids = findingResponses.map((response) => response.findingId);
    if (new Set(ids).size !== ids.length) {
      invalid('handoff.findingResponses', 'findingId must be unique per response');
    }
  }
  const assumptions = optionalTextArray(object.assumptions, 'handoff.assumptions');
  const knownRisks = optionalTextArray(object.knownRisks, 'handoff.knownRisks');
  const attackSurface = optionalTextArray(object.attackSurface, 'handoff.attackSurface');
  let additionalWorkRequests: WorkRequestDraft[] | undefined;
  if (object.additionalWorkRequests !== undefined) {
    if (!Array.isArray(object.additionalWorkRequests)) invalid('handoff.additionalWorkRequests', 'must be an array');
    try {
      additionalWorkRequests = object.additionalWorkRequests.map(parseWorkRequestDraft);
    } catch (error) {
      invalid('handoff.additionalWorkRequests', error instanceof Error ? error.message : String(error), error);
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
    ...(assumptions === undefined ? {} : { assumptions }),
    ...(knownRisks === undefined ? {} : { knownRisks }),
    ...(attackSurface === undefined ? {} : { attackSurface }),
    ...(findingResponses === undefined ? {} : { findingResponses }),
    ...(additionalWorkRequests === undefined ? {} : { additionalWorkRequests }),
  };
}
