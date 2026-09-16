import { spawn, type ChildProcess } from 'node:child_process';

export const DEFAULT_COORDINATOR_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
export const DEFAULT_COORDINATOR_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;

export type BoundedProcessFailureCode =
  | 'EXECUTABLE_NOT_FOUND'
  | 'SPAWN_FAILED'
  | 'TIMEOUT'
  | 'ABORTED'
  | 'NONZERO_EXIT'
  | 'OUTPUT_LIMIT';

export class BoundedProcessError extends Error {
  constructor(readonly code: BoundedProcessFailureCode) {
    super(messageFor(code));
    this.name = 'BoundedProcessError';
  }
}

export interface BoundedProcessOptions {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly terminationGraceMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly abortSignal?: AbortSignal;
}

interface ProcessCompletion {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: NodeJS.ErrnoException | null;
}

/** Runs one non-shell process with bounded in-memory output and process-tree termination. */
export async function runBoundedProcess(options: BoundedProcessOptions): Promise<string> {
  const terminationGraceMs = boundedNumber(options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS,
    'terminationGraceMs', true);
  const timeoutMs = boundedNumber(options.timeoutMs, 'timeoutMs', false);
  const maxStdoutBytes = boundedInteger(options.maxStdoutBytes ?? DEFAULT_COORDINATOR_MAX_STDOUT_BYTES,
    'maxStdoutBytes');
  const maxStderrBytes = boundedInteger(options.maxStderrBytes ?? DEFAULT_COORDINATOR_MAX_STDERR_BYTES,
    'maxStderrBytes');
  if (options.executable.trim() === '' || options.cwd.trim() === '') {
    throw new TypeError('executable and cwd must not be empty');
  }
  if (isAborted(options.abortSignal)) throw new BoundedProcessError('ABORTED');

  let child: ChildProcess;
  try {
    child = spawn(options.executable, [...options.args], {
      cwd: options.cwd,
      env: options.environment,
      shell: false,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch {
    throw new BoundedProcessError('SPAWN_FAILED');
  }

  const completion = waitForProcess(child);
  const stdout: Buffer[] = [];
  let stdoutBytes = 0;
  let stderrBytes = 0;
  let terminationCause: 'TIMEOUT' | 'ABORTED' | 'OUTPUT_LIMIT' | null = null;
  let forceKillTimer: NodeJS.Timeout | undefined;

  const terminate = (cause: NonNullable<typeof terminationCause>): void => {
    if (terminationCause !== null) return;
    terminationCause = cause;
    killProcessTree(child, 'SIGTERM');
    forceKillTimer = setTimeout(() => killProcessTree(child, 'SIGKILL'), terminationGraceMs);
    forceKillTimer.unref();
  };

  child.stdout?.on('data', (chunk: Buffer | string) => {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    stdoutBytes += bytes.byteLength;
    if (stdoutBytes > maxStdoutBytes) terminate('OUTPUT_LIMIT');
    else stdout.push(bytes);
  });
  child.stderr?.on('data', (chunk: Buffer | string) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > maxStderrBytes) terminate('OUTPUT_LIMIT');
  });
  child.stdin?.on('error', () => {
    // EPIPE is expected when a process exits before consuming the prompt.
  });

  const timeout = setTimeout(() => terminate('TIMEOUT'), timeoutMs);
  timeout.unref();
  const onAbort = (): void => terminate('ABORTED');
  options.abortSignal?.addEventListener('abort', onAbort, { once: true });
  if (isAborted(options.abortSignal)) terminate('ABORTED');
  if (terminationCause === null) child.stdin?.end(options.stdin, 'utf8');
  else child.stdin?.end();

  const result = await completion;
  clearTimeout(timeout);
  options.abortSignal?.removeEventListener('abort', onAbort);
  if (terminationCause !== null) killProcessTree(child, 'SIGKILL');
  if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);

  if (terminationCause !== null) throw new BoundedProcessError(terminationCause);
  if (result.spawnError !== null) {
    throw new BoundedProcessError(result.spawnError.code === 'ENOENT'
      ? 'EXECUTABLE_NOT_FOUND' : 'SPAWN_FAILED');
  }
  if (result.code !== 0) throw new BoundedProcessError('NONZERO_EXIT');
  return Buffer.concat(stdout, stdoutBytes).toString('utf8').trim();
}

function boundedNumber(value: number, name: string, allowZero: boolean): number {
  if (!Number.isFinite(value) || (allowZero ? value < 0 : value <= 0)) {
    throw new TypeError(`${name} must be a ${allowZero ? 'non-negative' : 'positive'} finite number`);
  }
  return value;
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function boundedInteger(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

function waitForProcess(child: ChildProcess): Promise<ProcessCompletion> {
  return new Promise((resolve) => {
    let spawnError: NodeJS.ErrnoException | null = null;
    child.once('error', (error: NodeJS.ErrnoException) => { spawnError = error; });
    child.once('close', (code, signal) => resolve({ code, signal, spawnError }));
  });
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

function messageFor(code: BoundedProcessFailureCode): string {
  const messages: Readonly<Record<BoundedProcessFailureCode, string>> = {
    EXECUTABLE_NOT_FOUND: 'Coordinator provider executable was not found',
    SPAWN_FAILED: 'Coordinator provider process could not be started',
    TIMEOUT: 'Coordinator provider process timed out',
    ABORTED: 'Coordinator provider process was aborted',
    NONZERO_EXIT: 'Coordinator provider process exited unsuccessfully',
    OUTPUT_LIMIT: 'Coordinator provider process exceeded its output limit',
  };
  return messages[code];
}
