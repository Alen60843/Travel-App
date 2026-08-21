import { OrchestratorError } from '../errors';

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
]);

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
  };
}
