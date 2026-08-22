import { OrchestratorError } from '../errors';
import { FINDING_SEVERITIES, REVIEW_STATUSES, type FindingSeverity, type ReviewStatus } from '../review/findings';

export const AGENT_NAMES = ['codex', 'claude'] as const;
export type AgentName = (typeof AGENT_NAMES)[number];

export const TASK_MODES = [
  'implementation',
  'review',
  'correction',
  'final_review',
  'escalation',
  'integration',
  'debate',
] as const;
export type TaskMode = (typeof TASK_MODES)[number];

export const EFFORT_LEVELS = ['medium', 'high', 'extra_high'] as const;
export type EffortLevel = (typeof EFFORT_LEVELS)[number];

/**
 * Gates a task's readiness on a validated, already-persisted review artifact
 * belonging to an ANCESTOR task (not necessarily a direct `dependsOn` entry —
 * see the solver_verifier expansion, where `reverify`'s condition inspects
 * `verify`, two hops back, while its graph dependency for worktree/commit
 * ordering purposes is `fix`).
 *
 * Deliberately reads only the two things §5 asks for — review status and
 * finding severity — from the SAME validated StructuredReview the Verifier
 * already produced. Never free-form text.
 *
 * The engine has no other conditional-execution primitive: task readiness is
 * "dependencies satisfied" AND (if a condition is present) "condition
 * satisfied" — evaluated once, by AgentOrchestrator, before a worktree is
 * created or an agent is invoked (see orchestrator.ts's executeTask). This is
 * intentionally the smallest mechanism that satisfies the requirement, not a
 * general expression language.
 */
export interface TaskCondition {
  /** The ancestor task whose most recent persisted review this condition inspects. */
  readonly reviewOf: string;
  /** Skip (do not run) when that review's status is one of these. */
  readonly skipIfStatus: readonly ReviewStatus[];
  /**
   * Additionally require at least one finding (present in that review's own
   * `findings`) at or above this severity. Absent means no severity
   * requirement — any non-skipped status is sufficient, which is the
   * correction path's rule ("if findings exist -> FIX", any severity).
   * Present is the escalation path's rule (§5 MVP default: 'high') — medium
   * or low findings alone must not trigger the expensive Judge.
   */
  readonly minimumSeverity?: FindingSeverity;
}

export interface TaskSpec {
  readonly id: string;
  readonly title: string;
  readonly owner: AgentName;
  readonly effort: EffortLevel;
  /**
   * Explicit model selection, independent of effort. Optional: most tasks
   * should let the agent's own default apply. Only wired through to an
   * adapter that has verified CLI support for a model flag — see
   * agents/claude-agent.ts and agents/codex-agent.ts for what each adapter
   * actually does with it. An unsupported adapter accepts the field (so a
   * phase file stays portable across agents) but does not fabricate a flag.
   */
  readonly model?: string;
  readonly mode: TaskMode;
  readonly files: readonly string[];
  readonly dependsOn: readonly string[];
  readonly writer: boolean;
  readonly timeoutMs?: number;
  readonly instructions?: string;
  readonly condition?: TaskCondition;
}

const TASK_KEYS = new Set([
  'id',
  'title',
  'owner',
  'effort',
  'model',
  'mode',
  'files',
  'dependsOn',
  'writer',
  'timeoutMs',
  'instructions',
  'condition',
]);
const CONDITION_KEYS = new Set(['reviewOf', 'skipIfStatus', 'minimumSeverity']);

/** critical > high > medium > low. Total order, so "at least" comparisons are unambiguous. */
const SEVERITY_RANK: Readonly<Record<FindingSeverity, number>> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

export function severityAtLeast(actual: FindingSeverity, minimum: FindingSeverity): boolean {
  return SEVERITY_RANK[actual] >= SEVERITY_RANK[minimum];
}

function invalid(path: string, message: string): never {
  throw new OrchestratorError('CONFIG_INVALID', `${path}: ${message}`, {
    details: { path },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(path, 'must be a non-empty string');
  }
  return value.trim();
}

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    invalid(path, 'must be an array');
  }
  return value.map((item, index) => stringValue(item, `${path}[${index}]`));
}

function assertSafeOwnershipPattern(pattern: string, path: string): void {
  if (
    pattern.startsWith('/') ||
    pattern.includes('\\') ||
    pattern.split('/').some((part) => part === '..' || part === '.')
  ) {
    invalid(path, 'must be a repository-relative POSIX glob without traversal');
  }
  if (pattern.includes('\0') || pattern.startsWith('!')) {
    invalid(path, 'contains an unsupported or unsafe glob construct');
  }
  if (/[\u0000-\u001f\u007f\[\]{}]/.test(pattern)) {
    invalid(path, 'contains control characters or unsupported glob syntax');
  }
}

function parseCondition(value: unknown, path: string): TaskCondition {
  if (!isRecord(value)) {
    invalid(path, 'must be an object');
  }
  for (const key of Object.keys(value)) {
    if (!CONDITION_KEYS.has(key)) {
      invalid(`${path}.${key}`, 'is not a supported condition field');
    }
  }
  const reviewOf = stringValue(value.reviewOf, `${path}.reviewOf`);
  if (!Array.isArray(value.skipIfStatus) || value.skipIfStatus.length === 0) {
    invalid(`${path}.skipIfStatus`, 'must be a non-empty array');
  }
  const skipIfStatus = value.skipIfStatus.map((entry, entryIndex) => {
    const status = stringValue(entry, `${path}.skipIfStatus[${entryIndex}]`);
    if (!(REVIEW_STATUSES as readonly string[]).includes(status)) {
      invalid(
        `${path}.skipIfStatus[${entryIndex}]`,
        `must be one of ${REVIEW_STATUSES.join(', ')}`,
      );
    }
    return status as ReviewStatus;
  });
  let minimumSeverity: FindingSeverity | undefined;
  if (value.minimumSeverity !== undefined) {
    const severity = stringValue(value.minimumSeverity, `${path}.minimumSeverity`);
    if (!(FINDING_SEVERITIES as readonly string[]).includes(severity)) {
      invalid(`${path}.minimumSeverity`, `must be one of ${FINDING_SEVERITIES.join(', ')}`);
    }
    minimumSeverity = severity as FindingSeverity;
  }
  return {
    reviewOf,
    skipIfStatus,
    ...(minimumSeverity === undefined ? {} : { minimumSeverity }),
  };
}

export function parseTaskSpec(value: unknown, index: number): TaskSpec {
  const path = `tasks[${index}]`;
  if (!isRecord(value)) {
    invalid(path, 'must be an object');
  }

  for (const key of Object.keys(value)) {
    if (!TASK_KEYS.has(key)) {
      invalid(`${path}.${key}`, 'is not a supported task field');
    }
  }

  const id = stringValue(value.id, `${path}.id`);
  if (!/^[a-z][a-z0-9-]{0,63}$/.test(id)) {
    invalid(`${path}.id`, 'must match /^[a-z][a-z0-9-]{0,63}$/');
  }
  const title = stringValue(value.title, `${path}.title`);
  const owner = stringValue(value.owner, `${path}.owner`);
  if (!(AGENT_NAMES as readonly string[]).includes(owner)) {
    invalid(`${path}.owner`, `must be one of ${AGENT_NAMES.join(', ')}`);
  }
  const effort = stringValue(value.effort ?? 'high', `${path}.effort`);
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    invalid(`${path}.effort`, `must be one of ${EFFORT_LEVELS.join(', ')}`);
  }
  let model: string | undefined;
  if (value.model !== undefined) {
    model = stringValue(value.model, `${path}.model`);
  }
  const mode = stringValue(value.mode, `${path}.mode`);
  if (!(TASK_MODES as readonly string[]).includes(mode)) {
    invalid(`${path}.mode`, `must be one of ${TASK_MODES.join(', ')}`);
  }

  const files = value.files === undefined ? [] : stringArray(value.files, `${path}.files`);
  files.forEach((file, fileIndex) =>
    assertSafeOwnershipPattern(file, `${path}.files[${fileIndex}]`),
  );
  if (new Set(files).size !== files.length) {
    invalid(`${path}.files`, 'must not contain duplicate patterns');
  }

  const dependsOn =
    value.dependsOn === undefined
      ? []
      : stringArray(value.dependsOn, `${path}.dependsOn`);
  if (new Set(dependsOn).size !== dependsOn.length) {
    invalid(`${path}.dependsOn`, 'must not contain duplicate task ids');
  }
  if (dependsOn.includes(id)) {
    invalid(`${path}.dependsOn`, 'a task cannot depend on itself');
  }

  // Escalation (JUDGE) defaults to read-only, matching review/final_review:
  // its job is to arbitrate a disagreement and record a decision, not to
  // change code itself. A phase that genuinely wants the Judge to also patch
  // something can still set writer: true explicitly with ownership globs.
  const defaultWriter = ['implementation', 'correction', 'integration'].includes(mode);
  const writer = value.writer ?? defaultWriter;
  if (typeof writer !== 'boolean') {
    invalid(`${path}.writer`, 'must be a boolean');
  }
  if (writer && files.length === 0) {
    invalid(`${path}.files`, 'a writer task must declare at least one ownership glob');
  }
  if (mode === 'debate' && writer) {
    invalid(`${path}.writer`, 'debate agents share one worktree and must remain read-only');
  }

  let timeoutMs: number | undefined;
  if (value.timeoutMs !== undefined) {
    if (
      typeof value.timeoutMs !== 'number' ||
      !Number.isSafeInteger(value.timeoutMs) ||
      value.timeoutMs < 1_000 ||
      value.timeoutMs > 24 * 60 * 60 * 1_000
    ) {
      invalid(`${path}.timeoutMs`, 'must be an integer from 1000 to 86400000');
    }
    timeoutMs = value.timeoutMs;
  }

  let instructions: string | undefined;
  if (value.instructions !== undefined) {
    instructions = stringValue(value.instructions, `${path}.instructions`);
  }

  let condition: TaskCondition | undefined;
  if (value.condition !== undefined) {
    condition = parseCondition(value.condition, `${path}.condition`);
    if (condition.reviewOf === id) {
      invalid(`${path}.condition.reviewOf`, 'a task cannot condition on its own review');
    }
  }

  return {
    id,
    title,
    owner: owner as AgentName,
    effort: effort as EffortLevel,
    ...(model === undefined ? {} : { model }),
    mode: mode as TaskMode,
    files,
    dependsOn,
    writer,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(instructions === undefined ? {} : { instructions }),
    ...(condition === undefined ? {} : { condition }),
  };
}
