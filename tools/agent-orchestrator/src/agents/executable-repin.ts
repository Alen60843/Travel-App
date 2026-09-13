import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { access, lstat, open } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { promisify } from 'node:util';

import { OrchestratorError } from '../errors';
import type { RunState } from '../state/run-state';
import type { AgentName } from '../tasks/task-schema';

const execFileAsync = promisify(execFile);

export type UnusableExecutableState = 'missing' | 'not_regular' | 'not_executable';

export interface AgentExecutableIdentity {
  readonly path: string;
  readonly sha256: string;
  readonly device: string;
  readonly inode: string;
  readonly mode: number;
  readonly size: number;
  readonly version: string;
}

export interface AgentExecutableRepinIdentity {
  readonly version: 1;
  readonly runId: string;
  readonly agent: AgentName;
  readonly oldExecutablePath: string;
  readonly oldExecutableState: UnusableExecutableState;
  readonly replacement: AgentExecutableIdentity;
  readonly sourceFailure: {
    readonly taskId: string;
    readonly attempt: number;
    readonly errorCode: 'AGENT_FAILED';
    readonly errorMessage: string;
  };
}

export interface AgentExecutableRepin extends AgentExecutableRepinIdentity {
  readonly id: string;
  readonly authorizedBy: 'human';
  readonly authorizedAt: string;
}

export function canonicalExecutableRepinHash(value: unknown): string {
  const canonical = (entry: unknown): unknown => Array.isArray(entry)
    ? entry.map(canonical)
    : entry !== null && typeof entry === 'object'
      ? Object.fromEntries(Object.entries(entry).filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, canonical(child)]))
      : entry;
  return createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
}

export function executableRepinId(identity: AgentExecutableRepinIdentity): string {
  return canonicalExecutableRepinHash(identity);
}

function corrupt(message: string): never {
  throw new OrchestratorError('STATE_CORRUPT', `Agent executable repin: ${message}`);
}

function record(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) corrupt(`${path} has invalid fields`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) corrupt(`${path} must be non-empty text`);
  return value;
}

function digest(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[a-f0-9]{64}$/.test(result)) corrupt(`${path} must be a SHA-256 digest`);
  return result;
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) corrupt(`${path} must be a non-negative integer`);
  return Number(value);
}

export function parseAgentExecutableRepins(value: unknown): AgentExecutableRepin[] {
  if (!Array.isArray(value)) corrupt('history must be an array');
  const entries = value.map((raw, index): AgentExecutableRepin => {
    const path = `agentExecutableRepins[${index}]`;
    const item = record(raw, [
      'id', 'version', 'runId', 'agent', 'oldExecutablePath', 'oldExecutableState', 'replacement',
      'sourceFailure', 'authorizedBy', 'authorizedAt',
    ], path);
    if (item.version !== 1 || item.authorizedBy !== 'human') corrupt(`${path} version/provenance is invalid`);
    const agent = text(item.agent, `${path}.agent`);
    if (agent !== 'codex' && agent !== 'claude') corrupt(`${path}.agent is invalid`);
    const oldExecutableState = text(item.oldExecutableState, `${path}.oldExecutableState`);
    if (!['missing', 'not_regular', 'not_executable'].includes(oldExecutableState)) corrupt(`${path}.oldExecutableState is invalid`);
    const replacementRaw = record(item.replacement,
      ['path', 'sha256', 'device', 'inode', 'mode', 'size', 'version'], `${path}.replacement`);
    const replacement: AgentExecutableIdentity = {
      path: text(replacementRaw.path, `${path}.replacement.path`),
      sha256: digest(replacementRaw.sha256, `${path}.replacement.sha256`),
      device: text(replacementRaw.device, `${path}.replacement.device`),
      inode: text(replacementRaw.inode, `${path}.replacement.inode`),
      mode: integer(replacementRaw.mode, `${path}.replacement.mode`),
      size: integer(replacementRaw.size, `${path}.replacement.size`),
      version: text(replacementRaw.version, `${path}.replacement.version`),
    };
    if (!isAbsolute(replacement.path) || resolve(replacement.path) !== replacement.path) corrupt(`${path}.replacement.path must be absolute`);
    const failureRaw = record(item.sourceFailure,
      ['taskId', 'attempt', 'errorCode', 'errorMessage'], `${path}.sourceFailure`);
    if (failureRaw.errorCode !== 'AGENT_FAILED') corrupt(`${path}.sourceFailure.errorCode is invalid`);
    const identity: AgentExecutableRepinIdentity = {
      version: 1,
      runId: text(item.runId, `${path}.runId`),
      agent,
      oldExecutablePath: text(item.oldExecutablePath, `${path}.oldExecutablePath`),
      oldExecutableState: oldExecutableState as UnusableExecutableState,
      replacement,
      sourceFailure: {
        taskId: text(failureRaw.taskId, `${path}.sourceFailure.taskId`),
        attempt: integer(failureRaw.attempt, `${path}.sourceFailure.attempt`),
        errorCode: 'AGENT_FAILED',
        errorMessage: text(failureRaw.errorMessage, `${path}.sourceFailure.errorMessage`),
      },
    };
    const id = digest(item.id, `${path}.id`);
    if (id !== executableRepinId(identity)) corrupt(`${path}.id does not match its content`);
    const authorizedAt = text(item.authorizedAt, `${path}.authorizedAt`);
    if (!Number.isFinite(Date.parse(authorizedAt))) corrupt(`${path}.authorizedAt is invalid`);
    return { id, ...identity, authorizedBy: 'human', authorizedAt };
  });
  if (new Set(entries.map((entry) => entry.id)).size !== entries.length) corrupt('history contains a duplicate migration');
  return entries;
}

export function effectiveAgentExecutables(state: Pick<RunState, 'runId' | 'agentExecutables' | 'agentExecutableRepins'>): Partial<Record<AgentName, string>> {
  const effective = { ...(state.agentExecutables ?? {}) };
  for (const repin of state.agentExecutableRepins ?? []) {
    if (repin.runId !== state.runId) corrupt('run identity mismatch');
    if (effective[repin.agent] !== repin.oldExecutablePath) corrupt('history is not a contiguous executable chain');
    effective[repin.agent] = repin.replacement.path;
  }
  return effective;
}

export async function unusableExecutableState(path: string): Promise<UnusableExecutableState | null> {
  try {
    const details = await lstat(path);
    if (!details.isFile() || details.isSymbolicLink()) return 'not_regular';
    try {
      await access(path, constants.X_OK);
      return null;
    } catch {
      return 'not_executable';
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
    throw error;
  }
}

async function inspectExecutableFile(path: string): Promise<Omit<AgentExecutableIdentity, 'version'>> {
  if (!isAbsolute(path) || resolve(path) !== path) throw new OrchestratorError('TASK_STATE_INVALID', 'Replacement executable path must be absolute');
  const before = await lstat(path).catch((error: NodeJS.ErrnoException) => {
    throw new OrchestratorError('TASK_STATE_INVALID', `Replacement executable is unavailable: ${error.code ?? error.message}`);
  });
  if (!before.isFile() || before.isSymbolicLink()) throw new OrchestratorError('TASK_STATE_INVALID', 'Replacement executable must be a regular non-symlink file');
  try { await access(path, constants.X_OK); } catch { throw new OrchestratorError('TASK_STATE_INVALID', 'Replacement file is not executable'); }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== before.dev || opened.ino !== before.ino) {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Replacement executable changed while opening');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs) {
      throw new OrchestratorError('TASK_STATE_INVALID', 'Replacement executable changed while hashing');
    }
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), device: String(opened.dev),
      inode: String(opened.ino), mode: opened.mode, size: opened.size };
  } finally {
    await handle.close();
  }
}

export async function inspectAgentExecutable(path: string, agent: AgentName): Promise<AgentExecutableIdentity> {
  const inspected = await inspectExecutableFile(path);
  let stdout = '';
  let stderr = '';
  try {
    const result = await execFileAsync(path, ['--version'], { timeout: 5_000, maxBuffer: 64 * 1024,
      env: { PATH: process.env.PATH ?? '' } });
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    throw new OrchestratorError('TASK_STATE_INVALID', `Replacement executable version check failed: ${(error as Error).message}`);
  }
  const version = `${stdout}\n${stderr}`.trim().split(/\r?\n/, 1)[0]?.trim() ?? '';
  const expected = agent === 'codex' ? /\bcodex(?:-cli)?\b/i : /\bclaude\b/i;
  if (version === '' || !expected.test(version)) {
    throw new OrchestratorError('TASK_STATE_INVALID', `Replacement executable does not identify as ${agent}`);
  }
  const rechecked = await inspectExecutableFile(path);
  if (canonicalExecutableRepinHash(rechecked) !== canonicalExecutableRepinHash(inspected)) {
    throw new OrchestratorError('TASK_STATE_INVALID', 'Replacement executable changed during version validation');
  }
  return { ...inspected, version };
}

export async function assertAuthorizedAgentExecutables(state: Pick<RunState, 'runId' | 'agentExecutables' | 'agentExecutableRepins'>): Promise<void> {
  effectiveAgentExecutables(state);
  const latest = new Map<AgentName, AgentExecutableRepin>();
  for (const repin of state.agentExecutableRepins ?? []) latest.set(repin.agent, repin);
  for (const repin of latest.values()) {
    let inspected: Omit<AgentExecutableIdentity, 'version'>;
    try { inspected = await inspectExecutableFile(repin.replacement.path); }
    catch (error) { throw new OrchestratorError('TASK_STATE_INVALID', `Authorized ${repin.agent} executable is unavailable or unsafe`, { cause: error }); }
    if (inspected.sha256 !== repin.replacement.sha256) {
      throw new OrchestratorError('TASK_STATE_INVALID', `Authorized ${repin.agent} executable SHA-256 changed`);
    }
  }
}
