import { spawn } from 'node:child_process';
import { constants as fsConstants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';

import { OrchestratorError } from '../errors';

export interface GitCommandResult {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface GitRunOptions {
  readonly allowFailure?: boolean;
  readonly input?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

export class GitCommandError extends Error {
  readonly result: GitCommandResult;

  constructor(result: GitCommandResult) {
    const diagnostic = result.stderr.trim() || result.stdout.trim() || 'no diagnostic output';
    super(`git ${result.args.join(' ')} failed with exit code ${String(result.exitCode)}: ${diagnostic}`);
    this.name = 'GitCommandError';
    this.result = result;
  }
}

/**
 * A deliberately small Git process boundary. Every invocation receives an
 * argument array and an explicit working directory; no command is interpreted
 * by a shell.
 */
export class GitClient {
  readonly executable: string;

  constructor(executable = 'git') {
    if (!executable || executable.includes('\0')) {
      throw new TypeError('Git executable must be a non-empty string without NUL bytes');
    }
    this.executable = executable;
  }

  async run(
    cwd: string,
    args: readonly string[],
    options: GitRunOptions = {},
  ): Promise<GitCommandResult> {
    const checkedCwd = await validateCwd(cwd);
    validateArgs(args);
    if (options.input?.includes('\0')) {
      throw new TypeError('Git standard input must not contain NUL bytes');
    }
    if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs <= 0)) {
      throw new TypeError('Git timeout must be a positive integer');
    }

    const child = spawn(this.executable, [...args], {
      cwd: checkedCwd,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM ?? '1',
      },
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
    // A process that exits before consuming stdin may close the pipe while we
    // are ending it. The process outcome remains the authoritative failure.
    child.stdin.on('error', () => undefined);

    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let forcedKill: NodeJS.Timeout | undefined;
    let abortListener: (() => void) | undefined;

    const terminate = (): void => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill('SIGTERM');
      forcedKill = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      }, 1_000);
      forcedKill.unref();
    };

    if (options.timeoutMs !== undefined) {
      timeout = setTimeout(() => {
        timedOut = true;
        terminate();
      }, options.timeoutMs);
      timeout.unref();
    }
    if (options.signal !== undefined) {
      abortListener = terminate;
      if (options.signal.aborted) terminate();
      else options.signal.addEventListener('abort', abortListener, { once: true });
    }

    if (options.input === undefined) child.stdin.end();
    else child.stdin.end(options.input, 'utf8');

    const outcome = await new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (fulfill, reject) => {
        child.once('error', reject);
        child.once('close', (exitCode, signal) => fulfill({ exitCode, signal }));
      },
    ).finally(() => {
      if (timeout !== undefined) clearTimeout(timeout);
      if (forcedKill !== undefined) clearTimeout(forcedKill);
      if (abortListener !== undefined) options.signal?.removeEventListener('abort', abortListener);
    });

    const result: GitCommandResult = {
      args: [...args],
      cwd: checkedCwd,
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      stdout: Buffer.concat(stdout).toString('utf8'),
      stderr: Buffer.concat(stderr).toString('utf8'),
    };

    if (timedOut) {
      throw new GitCommandError({
        ...result,
        stderr: `${result.stderr}${result.stderr ? '\n' : ''}git command timed out`,
      });
    }
    if (result.exitCode !== 0 && !options.allowFailure) throw new GitCommandError(result);
    return result;
  }

  async repositoryRoot(cwd: string): Promise<string> {
    const result = await this.run(cwd, ['rev-parse', '--show-toplevel']);
    return realpath(result.stdout.trim());
  }

  async commonDirectory(cwd: string): Promise<string> {
    const root = await this.repositoryRoot(cwd);
    const result = await this.run(root, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
    return realpath(result.stdout.trim());
  }

  async resolveCommit(cwd: string, revision: string): Promise<string> {
    assertRevision(revision);
    const result = await this.run(cwd, ['rev-parse', '--verify', `${revision}^{commit}`]);
    const sha = result.stdout.trim();
    assertSha(sha);
    return sha;
  }
}

export async function resolveBaseSha(
  git: GitClient,
  repositoryPath: string,
  baseBranch: string,
): Promise<string> {
  assertBranchName(baseBranch);
  const check = await git.run(repositoryPath, ['check-ref-format', '--branch', baseBranch], {
    allowFailure: true,
  });
  if (check.exitCode !== 0) throw new TypeError(`Invalid base branch: ${baseBranch}`);
  return git.resolveCommit(repositoryPath, `refs/heads/${baseBranch}`);
}

export async function assertBaseBranchUnmoved(
  git: GitClient,
  repositoryPath: string,
  baseBranch: string,
  expectedBaseSha: string,
): Promise<void> {
  assertSha(expectedBaseSha);
  let actualBaseSha: string;
  try {
    actualBaseSha = await resolveBaseSha(git, repositoryPath, baseBranch);
  } catch (error) {
    throw new OrchestratorError(
      'BASE_BRANCH_MOVED',
      `Base branch ${baseBranch} no longer resolves to its captured commit ${expectedBaseSha}`,
      {
        cause: error,
        details: { baseBranch, expectedBaseSha, actualBaseSha: null },
      },
    );
  }
  if (actualBaseSha !== expectedBaseSha) {
    throw new OrchestratorError(
      'BASE_BRANCH_MOVED',
      `Base branch ${baseBranch} moved from ${expectedBaseSha} to ${actualBaseSha}`,
      { details: { baseBranch, expectedBaseSha, actualBaseSha } },
    );
  }
}

export function assertSha(value: string): void {
  if (!/^[0-9a-f]{40,64}$/i.test(value)) throw new TypeError(`Invalid full commit SHA: ${value}`);
}

export function assertRevision(value: string): void {
  if (!value || value.startsWith('-') || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new TypeError(`Invalid Git revision: ${value}`);
  }
}

export function assertBranchName(value: string): void {
  if (!value || value.startsWith('-') || value.includes('\0') || /[\r\n]/.test(value)) {
    throw new TypeError(`Invalid Git branch: ${value}`);
  }
}

async function validateCwd(cwd: string): Promise<string> {
  if (!isAbsolute(cwd) || cwd.includes('\0')) {
    throw new TypeError('Git cwd must be an absolute path without NUL bytes');
  }
  const normalized = resolve(cwd);
  await access(normalized, fsConstants.R_OK);
  const details = await stat(normalized);
  if (!details.isDirectory()) throw new TypeError(`Git cwd is not a directory: ${normalized}`);
  return normalized;
}

function validateArgs(args: readonly string[]): void {
  if (args.length === 0) throw new TypeError('Git requires at least one argument');
  for (const arg of args) {
    if (typeof arg !== 'string' || arg.includes('\0')) {
      throw new TypeError('Git arguments must be strings without NUL bytes');
    }
  }
}
