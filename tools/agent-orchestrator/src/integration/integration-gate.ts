import { constants } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';

import { collectRedactionSecrets, sanitizeText } from '../agents/process-agent';

export const DEFAULT_INTEGRATION_COMMAND_TIMEOUT_MS = 30 * 60 * 1_000;
export const MAX_INTEGRATION_COMMAND_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const DEFAULT_INTEGRATION_TERMINATION_GRACE_MS = 2_000;
export const MAX_INTEGRATION_TERMINATION_GRACE_MS = 60_000;

export interface IntegrationCommandSpec {
  readonly command: string;
  readonly required?: boolean;
  readonly timeoutMs?: number;
}

export type IntegrationCommandInput = string | IntegrationCommandSpec;

export interface IntegrationCommandResult {
  readonly command: string;
  readonly required: boolean;
  readonly timeoutMs: number;
  readonly termination: 'timeout' | 'aborted' | null;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly durationMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface IntegrationGateResult {
  readonly passed: boolean;
  readonly commands: readonly IntegrationCommandResult[];
}

export interface IntegrationGateOptions {
  readonly cwd: string;
  readonly logsDirectory: string;
  readonly commands: readonly IntegrationCommandInput[];
  readonly diagnostics?: readonly IntegrationCommandInput[];
  readonly defaultTimeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly signal?: AbortSignal;
}

/**
 * Parse the deliberately narrow command syntax accepted in trusted phase
 * files. Commands execute directly, never through a shell. Quotes and
 * backslash escaping are supported; shell operators and interpolation are not.
 */
export function parseCommand(command: string): readonly string[] {
  if (!command.trim() || /[\n\r\0]/.test(command)) {
    throw new Error(`Unsafe or empty integration command: ${command}`);
  }

  const result: string[] = [];
  let token = '';
  let quote: 'single' | 'double' | null = null;
  let escaped = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index]!;
    if (escaped) {
      token += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== 'single') {
      escaped = true;
      continue;
    }
    if (char === "'" && quote !== 'double') {
      quote = quote === 'single' ? null : 'single';
      continue;
    }
    if (char === '"' && quote !== 'single') {
      quote = quote === 'double' ? null : 'double';
      continue;
    }
    if (quote === null && (';&|<>`'.includes(char)
      || (char === '$' && ['(', '{'].includes(command[index + 1] ?? '')))) {
      throw new Error(`Unsafe integration command syntax: ${command}`);
    }
    if (/\s/.test(char) && quote === null) {
      if (token) result.push(token);
      token = '';
      continue;
    }
    token += char;
  }
  if (escaped || quote !== null) throw new Error(`Unterminated integration command: ${command}`);
  if (token) result.push(token);
  if (result.length === 0) throw new Error(`Empty integration command: ${command}`);
  return result;
}

export class IntegrationGate {
  async run(options: IntegrationGateOptions): Promise<IntegrationGateResult> {
    const defaultTimeoutMs = boundedDuration(
      options.defaultTimeoutMs ?? DEFAULT_INTEGRATION_COMMAND_TIMEOUT_MS,
      'defaultTimeoutMs',
      MAX_INTEGRATION_COMMAND_TIMEOUT_MS,
    );
    const terminationGraceMs = boundedDuration(
      options.terminationGraceMs ?? DEFAULT_INTEGRATION_TERMINATION_GRACE_MS,
      'terminationGraceMs',
      MAX_INTEGRATION_TERMINATION_GRACE_MS,
    );
    await mkdir(options.logsDirectory, { recursive: true, mode: 0o700 });
    const results: IntegrationCommandResult[] = [];

    for (const [index, input] of options.commands.entries()) {
      const command = normalizeCommand(input, true, defaultTimeoutMs, true);
      const result = await this.runOne(command, index, options, terminationGraceMs);
      results.push(result);
      if (result.required && commandFailed(result)) return { passed: false, commands: results };
    }

    for (const [index, input] of (options.diagnostics ?? []).entries()) {
      const command = normalizeCommand(input, false, defaultTimeoutMs, false);
      results.push(
        await this.runOne(command, options.commands.length + index, options, terminationGraceMs),
      );
    }

    return { passed: true, commands: results };
  }

  private async runOne(
    spec: NormalizedIntegrationCommand,
    index: number,
    options: Pick<IntegrationGateOptions, 'cwd' | 'logsDirectory' | 'signal'>,
    terminationGraceMs: number,
  ): Promise<IntegrationCommandResult> {
    const [executable, ...args] = parseCommand(spec.command);
    if (!executable) throw new Error('Integration command has no executable');
    const stem = `${String(index + 1).padStart(2, '0')}-${basename(executable)}`;
    const stdoutPath = join(options.logsDirectory, `${stem}.stdout.log`);
    const stderrPath = join(options.logsDirectory, `${stem}.stderr.log`);
    const started = Date.now();

    if (options.signal?.aborted === true) {
      await Promise.all([secureWrite(stdoutPath, ''), secureWrite(stderrPath, '')]);
      return {
        command: spec.command,
        required: spec.required,
        timeoutMs: spec.timeoutMs,
        termination: 'aborted',
        timedOut: false,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - started,
        stdoutPath,
        stderrPath,
      };
    }

    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: process.env,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));

    let spawnError: NodeJS.ErrnoException | null = null;
    const completion = new Promise<{ exitCode: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => {
        child.once('error', (error: NodeJS.ErrnoException) => {
          spawnError = error;
        });
        child.once('close', (exitCode, signal) => resolve({ exitCode, signal }));
      },
    );

    let termination: 'timeout' | 'aborted' | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;
    const terminate = (cause: 'timeout' | 'aborted'): void => {
      if (termination !== null) return;
      termination = cause;
      killProcessTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), terminationGraceMs);
      forceKillTimer.unref();
    };
    const timeout = setTimeout(() => terminate('timeout'), spec.timeoutMs);
    timeout.unref();
    const onAbort = (): void => terminate('aborted');
    options.signal?.addEventListener('abort', onAbort, { once: true });

    const outcome = await completion;
    clearTimeout(timeout);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
    options.signal?.removeEventListener('abort', onAbort);
    if (spawnError !== null) {
      const message = (spawnError as NodeJS.ErrnoException).message;
      stderr.push(Buffer.from(`${stderr.length > 0 ? '\n' : ''}${message}`, 'utf8'));
    }
    const redactionSecrets = collectRedactionSecrets(process.env);
    await Promise.all([
      secureWrite(
        stdoutPath,
        sanitizeText(Buffer.concat(stdout).toString('utf8'), redactionSecrets),
      ),
      secureWrite(
        stderrPath,
        sanitizeText(Buffer.concat(stderr).toString('utf8'), redactionSecrets),
      ),
    ]);
    return {
      command: spec.command,
      required: spec.required,
      timeoutMs: spec.timeoutMs,
      termination,
      timedOut: termination === 'timeout',
      exitCode: outcome.exitCode,
      signal: outcome.signal,
      durationMs: Date.now() - started,
      stdoutPath,
      stderrPath,
    };
  }
}

interface NormalizedIntegrationCommand {
  readonly command: string;
  readonly required: boolean;
  readonly timeoutMs: number;
}

function normalizeCommand(
  input: IntegrationCommandInput,
  defaultRequired: boolean,
  defaultTimeoutMs: number,
  allowRequiredOverride: boolean,
): NormalizedIntegrationCommand {
  const spec = typeof input === 'string' ? { command: input } : input;
  if (typeof spec !== 'object' || spec === null || typeof spec.command !== 'string') {
    throw new TypeError('Integration command must be a string or command specification');
  }
  return {
    command: spec.command,
    required: allowRequiredOverride ? (spec.required ?? defaultRequired) : defaultRequired,
    timeoutMs: boundedDuration(
      spec.timeoutMs ?? defaultTimeoutMs,
      'command timeoutMs',
      MAX_INTEGRATION_COMMAND_TIMEOUT_MS,
    ),
  };
}

function boundedDuration(value: number, label: string, maximum: number): number {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be an integer from 1 to ${maximum}`);
  }
  return value;
}

function commandFailed(result: IntegrationCommandResult): boolean {
  return result.termination !== null || result.exitCode !== 0;
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        child.kill(signal);
        return;
      }
    }
  }
  child.kill(signal);
}

async function secureWrite(path: string, value: string): Promise<void> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | noFollow,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
}
