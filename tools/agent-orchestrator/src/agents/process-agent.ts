import { spawn, type ChildProcess } from 'node:child_process';
import { constants, createReadStream, type WriteStream } from 'node:fs';
import { mkdir, open } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, type TransformCallback } from 'node:stream';
import { finished } from 'node:stream/promises';
import {
  buildAgentPrompt,
  type Agent,
  type AgentFailureCode,
  type AgentName,
  type AgentRequest,
  type AgentResult,
  type AgentRunStatus,
  type AgentTestReport,
} from './agent';

const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_HANDOFF_BYTES = 2 * 1024 * 1024;
const MIN_REDACTION_CARRY = 8 * 1024;

export interface ProcessAgentOptions {
  readonly executable?: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly terminationGraceMs?: number;
}

export interface AgentInvocation {
  readonly args: readonly string[];
  readonly prompt: string;
}

interface ProcessCompletion {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly spawnError: NodeJS.ErrnoException | null;
}

export abstract class ProcessAgent implements Agent {
  abstract readonly name: AgentName;

  private readonly executableOverride: string | undefined;
  private readonly environment: NodeJS.ProcessEnv;
  private readonly terminationGraceMs: number;

  protected constructor(options: ProcessAgentOptions = {}) {
    this.executableOverride = options.executable;
    this.environment = options.environment ?? process.env;
    this.terminationGraceMs =
      options.terminationGraceMs ?? DEFAULT_TERMINATION_GRACE_MS;

    if (!Number.isFinite(this.terminationGraceMs) || this.terminationGraceMs < 0) {
      throw new TypeError('terminationGraceMs must be a non-negative finite number');
    }
  }

  protected abstract readonly defaultExecutable: string;

  protected abstract buildInvocation(request: AgentRequest): AgentInvocation;

  async run(request: AgentRequest): Promise<AgentResult> {
    validateRequest(request);

    const startedAtMs = Date.now();
    const startedAt = new Date(startedAtMs).toISOString();
    const attempt = request.attempt ?? 1;
    const artifactPrefix = [
      safeArtifactSegment(request.runId),
      safeArtifactSegment(request.taskId),
      this.name,
      `attempt-${attempt}`,
    ].join('.');

    await mkdir(request.artifactsDirectory, { recursive: true, mode: 0o700 });
    const stdoutPath = join(request.artifactsDirectory, `${artifactPrefix}.stdout.log`);
    const stderrPath = join(request.artifactsDirectory, `${artifactPrefix}.stderr.log`);
    const stdoutFile = await createSecureLogFile(stdoutPath);
    let stderrFile: WriteStream;
    try {
      stderrFile = await createSecureLogFile(stderrPath);
    } catch (error) {
      stdoutFile.end();
      await finished(stdoutFile);
      throw error;
    }

    if (isAborted(request.abortSignal)) {
      stdoutFile.end();
      stderrFile.end();
      await Promise.all([finished(stdoutFile), finished(stderrFile)]);
      return this.resultForNoProcess(
        request,
        stdoutPath,
        stderrPath,
        startedAt,
        startedAtMs,
        'aborted',
        'AGENT_ABORTED',
        'Agent invocation was aborted before it started',
      );
    }

    const invocation = this.buildInvocation(request);
    const executable = this.executableOverride ?? this.defaultExecutable;
    const redactionSecrets = collectRedactionSecrets(this.environment);
    const stdoutSanitizer = new SanitizingTransform(redactionSecrets);
    const stderrSanitizer = new SanitizingTransform(redactionSecrets);

    let child: ChildProcess;
    try {
      child = spawn(executable, [...invocation.args], {
        cwd: request.worktreePath,
        env: this.environment,
        shell: false,
        detached: process.platform !== 'win32',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      stdoutFile.end();
      stderrFile.end(sanitizeText(errorMessage(error), redactionSecrets));
      await Promise.all([finished(stdoutFile), finished(stderrFile)]);
      return this.resultForSpawnFailure(
        request,
        stdoutPath,
        stderrPath,
        startedAt,
        startedAtMs,
        error,
        redactionSecrets,
      );
    }

    const completion = waitForProcess(child);
    child.stdout?.pipe(stdoutSanitizer).pipe(stdoutFile);
    child.stderr?.pipe(stderrSanitizer).pipe(stderrFile);

    let terminationCause: 'timeout' | 'abort' | null = null;
    let forceKillTimer: NodeJS.Timeout | undefined;
    let signalTerminationStarted: () => void = () => undefined;
    const terminationStarted = new Promise<void>((resolve) => {
      signalTerminationStarted = resolve;
    });

    const terminate = (cause: 'timeout' | 'abort'): void => {
      if (terminationCause !== null) {
        return;
      }
      terminationCause = cause;
      signalTerminationStarted();
      killProcessTree(child, 'SIGTERM');
      forceKillTimer = setTimeout(() => {
        killProcessTree(child, 'SIGKILL');
      }, this.terminationGraceMs);
      forceKillTimer.unref();
    };

    const timeout = setTimeout(() => terminate('timeout'), request.timeoutMs);
    timeout.unref();
    const onAbort = (): void => terminate('abort');
    request.abortSignal?.addEventListener('abort', onAbort, { once: true });
    // The signal can change between the pre-spawn check and listener registration,
    // especially while a PID is being durably persisted.
    if (isAborted(request.abortSignal)) {
      terminate('abort');
    }

    if (child.pid !== undefined) {
      const started = invokeOnStarted(request, child.pid);
      const startedOutcome = await Promise.race([
        started,
        terminationStarted.then(() => ({ status: 'terminated' as const })),
      ]);
      if (startedOutcome.status === 'failed') {
        clearTimeout(timeout);
        if (forceKillTimer !== undefined) {
          clearTimeout(forceKillTimer);
        }
        request.abortSignal?.removeEventListener('abort', onAbort);
        killProcessTree(child, 'SIGKILL');
        await completion;
        await Promise.all([finished(stdoutFile), finished(stderrFile)]);
        return this.resultForSpawnFailure(
          request,
          stdoutPath,
          stderrPath,
          startedAt,
          startedAtMs,
          startedOutcome.error,
          redactionSecrets,
        );
      }
    }

    child.stdin?.on('error', () => {
      // EPIPE is expected if an executable exits before consuming its prompt.
    });
    if (terminationCause === null) {
      child.stdin?.end(invocation.prompt, 'utf8');
    } else {
      child.stdin?.end();
    }

    const processResult = await completion;
    clearTimeout(timeout);
    // `close` only proves that the leader and its connected stdio settled. A
    // descendant can ignore SIGTERM and close/redirect its pipes, so enforce
    // that no member of the dedicated POSIX process group survives the result.
    if (terminationCause !== null) {
      killProcessTree(child, 'SIGKILL');
    }
    if (forceKillTimer !== undefined) {
      clearTimeout(forceKillTimer);
    }
    request.abortSignal?.removeEventListener('abort', onAbort);

    await Promise.all([finished(stdoutFile), finished(stderrFile)]);

    const classification = classifyCompletion(processResult, terminationCause);
    const rawStdout = await readBoundedStdoutText(stdoutPath);
    const structuredHandoff = parseJsonOrNull(rawStdout);
    const projected = projectHandoff(structuredHandoff);
    const endedAtMs = Date.now();

    return {
      agent: this.name,
      runId: request.runId,
      taskId: request.taskId,
      status: classification.status,
      failureCode: classification.failureCode,
      exitCode: processResult.code,
      signal: processResult.signal,
      stdoutPath,
      stderrPath,
      structuredHandoff,
      rawStdout,
      changedFiles: projected.changedFiles,
      gitDiffSummary: projected.gitDiffSummary,
      testsReported: projected.testsReported,
      unresolvedQuestions: projected.unresolvedQuestions,
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - startedAtMs,
      timedOut: terminationCause === 'timeout',
      aborted: terminationCause === 'abort',
      errorMessage:
        processResult.spawnError === null
          ? null
          : sanitizeText(errorMessage(processResult.spawnError), redactionSecrets),
    };
  }

  private resultForNoProcess(
    request: AgentRequest,
    stdoutPath: string,
    stderrPath: string,
    startedAt: string,
    startedAtMs: number,
    status: AgentRunStatus,
    failureCode: AgentFailureCode,
    message: string,
  ): AgentResult {
    const endedAtMs = Date.now();
    return {
      agent: this.name,
      runId: request.runId,
      taskId: request.taskId,
      status,
      failureCode,
      exitCode: null,
      signal: null,
      stdoutPath,
      stderrPath,
      structuredHandoff: null,
      rawStdout: null,
      changedFiles: [],
      gitDiffSummary: null,
      testsReported: [],
      unresolvedQuestions: [],
      startedAt,
      endedAt: new Date(endedAtMs).toISOString(),
      durationMs: endedAtMs - startedAtMs,
      timedOut: status === 'timed_out',
      aborted: status === 'aborted',
      errorMessage: message,
    };
  }

  private resultForSpawnFailure(
    request: AgentRequest,
    stdoutPath: string,
    stderrPath: string,
    startedAt: string,
    startedAtMs: number,
    error: unknown,
    redactionSecrets: readonly string[],
  ): AgentResult {
    const nodeError = error as NodeJS.ErrnoException;
    const notFound = nodeError.code === 'ENOENT';
    return this.resultForNoProcess(
      request,
      stdoutPath,
      stderrPath,
      startedAt,
      startedAtMs,
      notFound ? 'not_found' : 'spawn_error',
      notFound ? 'AGENT_NOT_FOUND' : 'AGENT_SPAWN_ERROR',
      sanitizeText(errorMessage(error), redactionSecrets),
    );
  }
}

function validateRequest(request: AgentRequest): void {
  if (!Number.isFinite(request.timeoutMs) || request.timeoutMs <= 0) {
    throw new TypeError('Agent timeoutMs must be a positive finite number');
  }
  if (request.runId.length === 0 || request.taskId.length === 0) {
    throw new TypeError('Agent runId and taskId must not be empty');
  }
  if (request.worktreePath.length === 0 || request.artifactsDirectory.length === 0) {
    throw new TypeError('Agent worktree and artifacts directories must not be empty');
  }
  if (request.allowedFileOwnership.length === 0 && request.access !== 'read_only') {
    throw new TypeError('Writer agents require at least one allowed ownership path');
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function invokeOnStarted(
  request: AgentRequest,
  pid: number,
): Promise<
  | { readonly status: 'started' }
  | { readonly status: 'failed'; readonly error: unknown }
> {
  return Promise.resolve()
    .then(() => request.onStarted?.(pid))
    .then(
      () => ({ status: 'started' as const }),
      (error: unknown) => ({ status: 'failed' as const, error }),
    );
}

function safeArtifactSegment(value: string): string {
  const safe = value.replace(/[^a-zA-Z0-9._-]/g, '_').replace(/^\.+/, '');
  return safe.length > 0 ? safe.slice(0, 100) : 'unknown';
}

async function createSecureLogFile(path: string): Promise<WriteStream> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await open(
    path,
    constants.O_CREAT | constants.O_WRONLY | constants.O_TRUNC | noFollow,
    0o600,
  );
  try {
    await handle.chmod(0o600);
    return handle.createWriteStream({ autoClose: true });
  } catch (error) {
    await handle.close().catch(() => undefined);
    throw error;
  }
}

function waitForProcess(child: ChildProcess): Promise<ProcessCompletion> {
  return new Promise((resolve) => {
    let spawnError: NodeJS.ErrnoException | null = null;
    child.once('error', (error: NodeJS.ErrnoException) => {
      spawnError = error;
    });
    child.once('close', (code, signal) => {
      resolve({ code, signal, spawnError });
    });
  });
}

function killProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) {
    return;
  }

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

function classifyCompletion(
  completion: ProcessCompletion,
  terminationCause: 'timeout' | 'abort' | null,
): { status: AgentRunStatus; failureCode: AgentFailureCode | null } {
  if (terminationCause === 'timeout') {
    return { status: 'timed_out', failureCode: 'AGENT_TIMEOUT' };
  }
  if (terminationCause === 'abort') {
    return { status: 'aborted', failureCode: 'AGENT_ABORTED' };
  }
  if (completion.spawnError !== null) {
    if (completion.spawnError.code === 'ENOENT') {
      return { status: 'not_found', failureCode: 'AGENT_NOT_FOUND' };
    }
    return { status: 'spawn_error', failureCode: 'AGENT_SPAWN_ERROR' };
  }
  if (completion.code === 0) {
    return { status: 'succeeded', failureCode: null };
  }
  return { status: 'failed', failureCode: 'AGENT_FAILED' };
}

class SanitizingTransform extends Transform {
  private carry = '';
  private readonly retainCharacters: number;

  constructor(private readonly secrets: readonly string[]) {
    super();
    const longestSecret = secrets.reduce(
      (longest, secret) => Math.max(longest, secret.length),
      0,
    );
    this.retainCharacters = Math.max(MIN_REDACTION_CARRY, longestSecret + 256);
  }

  override _transform(
    chunk: Buffer | string,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    const text = this.carry + (Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk);
    const sanitized = sanitizeText(text, this.secrets);
    if (sanitized.length <= this.retainCharacters) {
      this.carry = sanitized;
      callback();
      return;
    }

    const boundary = sanitized.length - this.retainCharacters;
    this.push(sanitized.slice(0, boundary));
    this.carry = sanitized.slice(boundary);
    callback();
  }

  override _flush(callback: TransformCallback): void {
    this.push(sanitizeText(this.carry, this.secrets));
    this.carry = '';
    callback();
  }
}

export function sanitizeText(text: string, secrets: readonly string[] = []): string {
  let sanitized = text;
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    sanitized = sanitized.split(secret).join('[REDACTED]');
  }

  return sanitized
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      '[REDACTED PRIVATE KEY]',
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, 'Bearer [REDACTED]')
    .replace(
      /((?:api[_-]?key|access[_-]?token|auth[_-]?token|password|client[_-]?secret)\s*["']?\s*[:=]\s*["']?)([^\s"',;}]+)/gi,
      '$1[REDACTED]',
    );
}

export function collectRedactionSecrets(environment: NodeJS.ProcessEnv): readonly string[] {
  const secretName = /(key|token|secret|password|credential|authorization|cookie|session|dsn|url)/i;
  return Object.entries(environment)
    .filter(([name, value]) => secretName.test(name) && (value?.length ?? 0) >= 6)
    .map(([, value]) => value)
    .filter((value): value is string => value !== undefined);
}

/**
 * Reads the bounded, already-redacted stdout an agent produced (the same
 * size cap as before: oversized output is treated as absent, not truncated
 * and guessed at). Exported so both the live agent path above and a
 * handoff/review-recovery path (orchestrator.ts) can get the exact same raw
 * text a preserved stdout log would have produced — the framing-extraction
 * layer (src/protocol/structured-output.ts) needs this raw text, not just
 * the whole-text-parsed-or-null value parseStructuredHandoff produces.
 */
export async function readBoundedStdoutText(path: string): Promise<string | null> {
  const stream = createReadStream(path, {
    encoding: 'utf8',
    start: 0,
    end: MAX_HANDOFF_BYTES,
  });
  let text = '';
  for await (const chunk of stream) {
    text += chunk;
  }

  if (Buffer.byteLength(text, 'utf8') > MAX_HANDOFF_BYTES) {
    return null;
  }

  const trimmed = text.trim();
  return trimmed.length === 0 ? null : trimmed;
}

/** Parses `text` as one whole JSON value, or null if it isn't valid JSON at all. */
export function parseJsonOrNull(text: string | null): unknown | null {
  if (text === null) {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** Exported so a handoff-recovery path (orchestrator.ts) can reconstruct the exact same raw structured value from a preserved stdout log that the live run itself would have produced. */
export async function parseStructuredHandoff(path: string): Promise<unknown | null> {
  return parseJsonOrNull(await readBoundedStdoutText(path));
}

function projectHandoff(handoff: unknown): {
  readonly changedFiles: readonly string[];
  readonly gitDiffSummary: string | null;
  readonly testsReported: readonly AgentTestReport[];
  readonly unresolvedQuestions: readonly string[];
} {
  if (!isRecord(handoff)) {
    return emptyProjection();
  }

  const changedFiles = stringArray(handoff.filesChanged);
  const unresolvedQuestions = stringArray(handoff.openQuestions);
  const gitDiffSummary =
    typeof handoff.gitDiffSummary === 'string' ? handoff.gitDiffSummary : null;
  const testsReported = Array.isArray(handoff.tests)
    ? handoff.tests.filter(isAgentTestReport)
    : [];

  return { changedFiles, gitDiffSummary, testsReported, unresolvedQuestions };
}

function emptyProjection(): {
  readonly changedFiles: readonly string[];
  readonly gitDiffSummary: string | null;
  readonly testsReported: readonly AgentTestReport[];
  readonly unresolvedQuestions: readonly string[];
} {
  return {
    changedFiles: [],
    gitDiffSummary: null,
    testsReported: [],
    unresolvedQuestions: [],
  };
}

function isAgentTestReport(value: unknown): value is AgentTestReport {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value.command === 'string' &&
    (value.result === 'pass' || value.result === 'fail' || value.result === 'not_run') &&
    typeof value.details === 'string'
  );
}

function stringArray(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
