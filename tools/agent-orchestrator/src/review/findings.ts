import { OrchestratorError } from '../errors';

export const REVIEW_STATUSES = ['approved', 'changes_requested', 'blocked'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const FINDING_SEVERITIES = ['critical', 'high', 'medium', 'low'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_CATEGORIES = [
  'correctness',
  'security',
  'performance',
  'concurrency',
  'architecture',
  'testing',
  'maintainability',
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export interface ReviewFinding {
  readonly id: string;
  readonly severity: FindingSeverity;
  readonly category: FindingCategory;
  readonly file: string;
  readonly location: string;
  /** The claim: what is wrong. (Named `problem` for backward compatibility with existing generic review usage.) */
  readonly problem: string;
  readonly evidence: string;
  readonly impact: string;
  readonly suggestedFix: string;
  readonly verificationRequired: string;
  /**
   * Adversarial-verification fields (§4). All optional so plain `review`/
   * `final_review` usage is unaffected — a Verifier task is instructed
   * (prompts/adversarial-verifier.md) to prefer supplying these over a bare
   * claim, but the schema does not hard-require them: enforcing that only for
   * solver_verifier-mode reviews would need mode-conditional validation this
   * MVP does not implement. A finding lacking them is weaker evidence, not an
   * invalid one — the Fixer's CONFIRMED/REJECTED response and the subsequent
   * re-Verify are what actually catch an unsubstantiated finding.
   */
  readonly counterexample?: string;
  readonly reproduction?: string;
  readonly expectedBehavior?: string;
  readonly violatingBehavior?: string;
}

export interface StructuredReview {
  readonly status: ReviewStatus;
  readonly findings: readonly ReviewFinding[];
}

const REVIEW_KEYS = new Set(['status', 'findings']);
const FINDING_KEYS = new Set([
  'id',
  'severity',
  'category',
  'file',
  'location',
  'problem',
  'evidence',
  'impact',
  'suggestedFix',
  'verificationRequired',
  'counterexample',
  'reproduction',
  'expectedBehavior',
  'violatingBehavior',
]);

function invalid(path: string, message: string, cause?: unknown): never {
  throw new OrchestratorError('REVIEW_BLOCKED', `${path}: ${message}`, {
    ...(cause === undefined ? {} : { cause }),
    details: { path },
  });
}

function object(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    invalid(path, 'must be an object');
  }
  return value as Record<string, unknown>;
}

function assertKeys(
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

function parseFinding(value: unknown, index: number): ReviewFinding {
  const path = `review.findings[${index}]`;
  const candidate = object(value, path);
  assertKeys(candidate, FINDING_KEYS, path);
  const id = text(candidate.id, `${path}.id`);
  if (!/^F[0-9]{3,}$/.test(id)) {
    invalid(`${path}.id`, 'must match /^F[0-9]{3,}$/');
  }
  const severity = text(candidate.severity, `${path}.severity`);
  if (!(FINDING_SEVERITIES as readonly string[]).includes(severity)) {
    invalid(`${path}.severity`, `must be one of ${FINDING_SEVERITIES.join(', ')}`);
  }
  const category = text(candidate.category, `${path}.category`);
  if (!(FINDING_CATEGORIES as readonly string[]).includes(category)) {
    invalid(`${path}.category`, `must be one of ${FINDING_CATEGORIES.join(', ')}`);
  }
  const file = text(candidate.file, `${path}.file`);
  if (
    file.startsWith('/') ||
    file.includes('\\') ||
    file.split('/').some((part) => part === '' || part === '.' || part === '..')
  ) {
    invalid(`${path}.file`, 'must be a safe repository-relative path');
  }
  const counterexample =
    candidate.counterexample === undefined
      ? undefined
      : text(candidate.counterexample, `${path}.counterexample`, true);
  const reproduction =
    candidate.reproduction === undefined
      ? undefined
      : text(candidate.reproduction, `${path}.reproduction`, true);
  const expectedBehavior =
    candidate.expectedBehavior === undefined
      ? undefined
      : text(candidate.expectedBehavior, `${path}.expectedBehavior`, true);
  const violatingBehavior =
    candidate.violatingBehavior === undefined
      ? undefined
      : text(candidate.violatingBehavior, `${path}.violatingBehavior`, true);
  return {
    id,
    severity: severity as FindingSeverity,
    category: category as FindingCategory,
    file,
    location: text(candidate.location, `${path}.location`, true),
    problem: text(candidate.problem, `${path}.problem`),
    evidence: text(candidate.evidence, `${path}.evidence`),
    impact: text(candidate.impact, `${path}.impact`),
    suggestedFix: text(candidate.suggestedFix, `${path}.suggestedFix`),
    verificationRequired: text(
      candidate.verificationRequired,
      `${path}.verificationRequired`,
    ),
    ...(counterexample === undefined ? {} : { counterexample }),
    ...(reproduction === undefined ? {} : { reproduction }),
    ...(expectedBehavior === undefined ? {} : { expectedBehavior }),
    ...(violatingBehavior === undefined ? {} : { violatingBehavior }),
  };
}

export function validateReview(value: unknown): StructuredReview {
  const candidate = object(value, 'review');
  assertKeys(candidate, REVIEW_KEYS, 'review');
  const status = text(candidate.status, 'review.status');
  if (!(REVIEW_STATUSES as readonly string[]).includes(status)) {
    invalid('review.status', `must be one of ${REVIEW_STATUSES.join(', ')}`);
  }
  if (!Array.isArray(candidate.findings)) {
    invalid('review.findings', 'must be an array');
  }
  const findings = candidate.findings.map(parseFinding);
  const ids = findings.map((finding) => finding.id);
  if (new Set(ids).size !== ids.length) {
    invalid('review.findings', 'finding ids must be unique');
  }
  if (status === 'changes_requested' && findings.length === 0) {
    invalid('review.findings', 'changes_requested requires at least one finding');
  }
  if (
    status === 'approved' &&
    findings.some((finding) => finding.severity !== 'low')
  ) {
    invalid('review.status', 'approved may contain only non-blocking low findings');
  }
  return { status: status as ReviewStatus, findings };
}

/** Parse exactly one JSON review object; freeform prose is intentionally rejected. */
export function parseReview(input: string | unknown): StructuredReview {
  if (typeof input !== 'string') {
    return validateReview(input);
  }
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch (error) {
    invalid('review', 'is not valid JSON', error);
  }
  return validateReview(value);
}
