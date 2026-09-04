import { readFile } from 'node:fs/promises';

import { parseDocument } from 'yaml';

import { OrchestratorError } from './errors';
import { TaskGraph } from './tasks/scheduler';
import { parseTaskSpec, type TaskSpec } from './tasks/task-schema';

export interface IntegrationCommand {
  readonly command: string;
  readonly required: boolean;
  readonly timeoutMs?: number;
}

export interface IntegrationConfig {
  readonly prepare: readonly IntegrationCommand[];
  readonly commands: readonly IntegrationCommand[];
  readonly diagnostics: readonly IntegrationCommand[];
}

export interface AgentWorktreeConfig {
  readonly prepare: readonly IntegrationCommand[];
}

export interface PhaseConfig {
  readonly phase: number | string;
  readonly name: string;
  readonly baseBranch: string;
  readonly canonicalDesignDocument: string;
  readonly concurrency: number;
  readonly maxReviewRounds: number;
  readonly agentRetries: number;
  readonly agentTimeoutMs: number;
  readonly agentWorktree: AgentWorktreeConfig;
  readonly tasks: readonly TaskSpec[];
  readonly integration: IntegrationConfig;
  /** Generic recovery config: bounds how many bounded handoff-repair attempts (framing/deterministic/agent) recover-handoffs will make for a task before refusing further attempts. Applies to static and adaptive workflows alike — recover-handoffs is not adaptive-only. */
  readonly maxHandoffRepairAttempts: number;
}

const TOP_LEVEL_KEYS = new Set([
  'phase',
  'name',
  'baseBranch',
  'canonicalDesignDocument',
  'concurrency',
  'maxReviewRounds',
  'agentRetries',
  'agentTimeoutMs',
  'agentWorktree',
  'tasks',
  'integration',
  'maxHandoffRepairAttempts',
]);
const INTEGRATION_KEYS = new Set(['prepare', 'commands', 'diagnostics']);
const COMMAND_KEYS = new Set(['command', 'required', 'timeoutMs']);
const AGENT_WORKTREE_KEYS = new Set(['prepare']);

// Exported (not just used internally) so src/workflow/solver-verifier.ts can
// build a plain-object PhaseConfig shape with the same validation rules
// instead of duplicating them — the declarative solver_verifier workflow is
// a shorthand that expands into exactly this schema, not a parallel one.
export function invalid(path: string, message: string, cause?: unknown): never {
  throw new OrchestratorError('CONFIG_INVALID', `${path}: ${message}`, {
    ...(cause === undefined ? {} : { cause }),
    details: { path },
  });
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`${path}.${key}`, 'is not a supported field');
    }
  }
}

export function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    invalid(path, 'must be a non-empty string');
  }
  if (value.includes('\0')) {
    invalid(path, 'must not contain NUL');
  }
  return value.trim();
}

export function boundedInteger(
  value: unknown,
  path: string,
  minimum: number,
  maximum: number,
): number {
  if (
    typeof value !== 'number' ||
    !Number.isSafeInteger(value) ||
    value < minimum ||
    value > maximum
  ) {
    invalid(path, `must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

export function repositoryRelativePath(value: unknown, path: string): string {
  const result = nonEmptyString(value, path);
  if (
    result.startsWith('/') ||
    result.includes('\\') ||
    result.split('/').some((part) => part === '.' || part === '..')
  ) {
    invalid(path, 'must be a repository-relative POSIX path without traversal');
  }
  return result;
}

function parseCommand(
  value: unknown,
  path: string,
  defaultRequired: boolean,
): IntegrationCommand {
  if (typeof value === 'string') {
    return { command: nonEmptyString(value, path), required: defaultRequired };
  }
  if (!isRecord(value)) {
    invalid(path, 'must be a command string or object');
  }
  assertKnownKeys(value, COMMAND_KEYS, path);
  const command = nonEmptyString(value.command, `${path}.command`);
  const required = value.required ?? defaultRequired;
  if (typeof required !== 'boolean') {
    invalid(`${path}.required`, 'must be a boolean');
  }
  let timeoutMs: number | undefined;
  if (value.timeoutMs !== undefined) {
    timeoutMs = boundedInteger(
      value.timeoutMs,
      `${path}.timeoutMs`,
      1_000,
      24 * 60 * 60 * 1_000,
    );
  }
  return {
    command,
    required,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  };
}

function parseCommandList(
  value: unknown,
  path: string,
  defaultRequired: boolean,
): IntegrationCommand[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    invalid(path, 'must be an array');
  }
  return value.map((entry, index) =>
    parseCommand(entry, `${path}[${index}]`, defaultRequired),
  );
}

export function parseIntegration(value: unknown): IntegrationConfig {
  if (value === undefined) {
    return { prepare: [], commands: [], diagnostics: [] };
  }
  if (!isRecord(value)) {
    invalid('integration', 'must be an object');
  }
  assertKnownKeys(value, INTEGRATION_KEYS, 'integration');
  return {
    prepare: parseCommandList(value.prepare, 'integration.prepare', true),
    commands: parseCommandList(value.commands, 'integration.commands', true),
    diagnostics: parseCommandList(
      value.diagnostics,
      'integration.diagnostics',
      false,
    ),
  };
}

export function parseAgentWorktree(value: unknown): AgentWorktreeConfig {
  if (value === undefined) return { prepare: [] };
  if (!isRecord(value)) invalid('agentWorktree', 'must be an object');
  assertKnownKeys(value, AGENT_WORKTREE_KEYS, 'agentWorktree');
  return { prepare: parseCommandList(value.prepare, 'agentWorktree.prepare', true) };
}

/** Validate a decoded YAML/JSON value and apply conservative defaults. */
export function parsePhaseConfig(value: unknown): PhaseConfig {
  if (!isRecord(value)) {
    invalid('$', 'phase configuration must be an object');
  }
  assertKnownKeys(value, TOP_LEVEL_KEYS, '$');

  const phase = value.phase;
  if (
    !(
      (typeof phase === 'number' && Number.isSafeInteger(phase) && phase > 0) ||
      (typeof phase === 'string' && phase.trim() !== '')
    )
  ) {
    invalid('phase', 'must be a positive integer or non-empty string');
  }

  if (!Array.isArray(value.tasks) || value.tasks.length === 0) {
    invalid('tasks', 'must be a non-empty array');
  }
  if (value.tasks.length > 500) {
    invalid('tasks', 'must contain at most 500 tasks');
  }
  const tasks = value.tasks.map(parseTaskSpec);
  const ids = new Set<string>();
  for (const task of tasks) {
    if (ids.has(task.id)) {
      invalid('tasks', `duplicate task id ${task.id}`);
    }
    ids.add(task.id);
  }
  for (const task of tasks) {
    for (const dependency of task.dependsOn) {
      if (!ids.has(dependency)) {
        invalid(`tasks.${task.id}.dependsOn`, `unknown task ${dependency}`);
      }
    }
  }
  for (const task of tasks) {
    if (task.condition !== undefined && !ids.has(task.condition.reviewOf)) {
      invalid(`tasks.${task.id}.condition.reviewOf`, `unknown task ${task.condition.reviewOf}`);
    }
  }

  // Construction validates the full graph, including cycles.
  const graph = new TaskGraph(tasks);

  // A condition can only ever be evaluated once its referenced artifact
  // exists, which requires the referenced task to run (or be terminal)
  // strictly before this one — i.e. be a genuine ancestor. Not necessarily a
  // direct `dependsOn` entry: reverify's condition legitimately inspects
  // verify, two hops back, while its graph dependency (for worktree/commit
  // ordering) is fix.
  for (const task of tasks) {
    if (task.condition !== undefined && !graph.hasDependencyPath(task.id, task.condition.reviewOf)) {
      invalid(
        `tasks.${task.id}.condition.reviewOf`,
        `must be an ancestor of ${task.id} (reachable via dependsOn), so its review is guaranteed to exist before this task's condition is evaluated`,
      );
    }
  }

  const baseBranch = nonEmptyString(value.baseBranch, 'baseBranch');
  if (baseBranch.startsWith('-') || /[\u0000-\u001f\u007f]/.test(baseBranch)) {
    invalid('baseBranch', 'contains unsafe branch-name characters');
  }
  return {
    phase: typeof phase === 'string' ? phase.trim() : phase,
    name: nonEmptyString(value.name, 'name'),
    baseBranch,
    canonicalDesignDocument: repositoryRelativePath(
      value.canonicalDesignDocument ??
        'docs/superpowers/specs/2026-08-20-tripwith-phase-1-design.md',
      'canonicalDesignDocument',
    ),
    concurrency: boundedInteger(value.concurrency ?? 2, 'concurrency', 1, 16),
    maxReviewRounds: boundedInteger(
      value.maxReviewRounds ?? 2,
      'maxReviewRounds',
      1,
      5,
    ),
    agentRetries: boundedInteger(value.agentRetries ?? 1, 'agentRetries', 0, 5),
    agentTimeoutMs: boundedInteger(
      value.agentTimeoutMs ?? 60 * 60 * 1_000,
      'agentTimeoutMs',
      1_000,
      24 * 60 * 60 * 1_000,
    ),
    agentWorktree: parseAgentWorktree(value.agentWorktree),
    tasks,
    integration: parseIntegration(value.integration),
    maxHandoffRepairAttempts: boundedInteger(
      value.maxHandoffRepairAttempts ?? 2,
      'maxHandoffRepairAttempts',
      1,
      100,
    ),
  };
}

/** Parse strict YAML. Aliases are disabled to keep task files bounded and auditable. */
export function parsePhaseConfigYaml(source: string): PhaseConfig {
  let document;
  try {
    document = parseDocument(source, {
      prettyErrors: false,
      strict: true,
      uniqueKeys: true,
    });
  } catch (error) {
    invalid('$', 'could not parse YAML', error);
  }
  if (document.errors.length > 0) {
    invalid('$', document.errors.map((error) => error.message).join('; '));
  }
  try {
    return parsePhaseConfig(document.toJS({ maxAliasCount: 0 }));
  } catch (error) {
    if (error instanceof OrchestratorError) {
      throw error;
    }
    invalid('$', 'could not decode YAML', error);
  }
}

export async function loadPhaseConfig(path: string): Promise<PhaseConfig> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new OrchestratorError('CONFIG_INVALID', `Could not read phase file: ${path}`, {
      cause: error,
      details: { path },
    });
  }
  return parsePhaseConfigYaml(source);
}
