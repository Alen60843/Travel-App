import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, rm, lstat, unlink, readdir, rmdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { OrchestratorError } from '../errors';
import {
  assertSafeRunId,
  validateRunState,
  type RunEvent,
  type RunState,
} from './run-state';

const SENSITIVE_KEY = /(api.?key|authorization|credential|oauth|password|private.?key|secret|token)/i;

function redact(value: unknown, seen = new WeakSet<object>()): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => redact(entry, seen));
  }
  if (typeof value === 'object' && value !== null) {
    if (seen.has(value)) {
      return '[CIRCULAR]';
    }
    seen.add(value);
    const result: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : redact(child, seen);
    }
    seen.delete(value);
    return result;
  }
  if (typeof value === 'bigint') {
    return value.toString();
  }
  if (typeof value === 'string') {
    return value
      .replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[REDACTED PRIVATE KEY]')
      .replace(/\bBearer\s+[^\s"']+/gi, 'Bearer [REDACTED]')
      .replace(
        /\b(api[_-]?key|authorization|client[_-]?secret|password|private[_-]?key|token)\s*[:=]\s*[^\s,;]+/gi,
        '$1=[REDACTED]',
      );
  }
  return value;
}

/** Filesystem persistence boundary for one run. */
export class StateStore {
  readonly runDirectory: string;
  readonly statePath: string;
  readonly eventsPath: string;
  private writeQueue: Promise<void> = Promise.resolve();
  private eventQueue: Promise<void> = Promise.resolve();

  constructor(runsRoot: string, readonly runId: string) {
    assertSafeRunId(runId);
    this.runDirectory = join(runsRoot, runId);
    this.statePath = join(this.runDirectory, 'run.json');
    this.eventsPath = join(this.runDirectory, 'events.jsonl');
  }

  async initialize(state: RunState): Promise<void> {
    if (state.runId !== this.runId) {
      throw new OrchestratorError('STATE_CORRUPT', 'State runId does not match store runId');
    }
    await Promise.all(
      ['tasks', 'logs', 'handoffs', 'reviews'].map((directory) =>
        mkdir(join(this.runDirectory, directory), { recursive: true, mode: 0o700 }),
      ),
    );
    await this.save(state);
  }

  async load(): Promise<RunState> {
    let source: string;
    try {
      source = await readFile(this.statePath, 'utf8');
    } catch (error) {
      throw new OrchestratorError('STATE_CORRUPT', 'Could not read run state', {
        cause: error,
        details: { runId: this.runId },
      });
    }
    try {
      return validateRunState(JSON.parse(source) as unknown);
    } catch (error) {
      if (error instanceof OrchestratorError) {
        throw error;
      }
      throw new OrchestratorError('STATE_CORRUPT', 'Run state is not valid JSON', {
        cause: error,
        details: { runId: this.runId },
      });
    }
  }

  /** Shared by host mutation commands and held throughout execution/integration.
   * Keep the historical path so preflight callers also participate in exclusion.
   */
  async withRunMutationLock<T>(operation: () => Promise<T>): Promise<T> {
    return this.withPreflightRetryLock(operation);
  }

  /** Serialize run mutations, including independent CLI processes. */
  async withPreflightRetryLock<T>(operation: () => Promise<T>): Promise<T> {
    const path = join(this.runDirectory, 'retry-preflight.lock');
    let acquired = false;
    for (let attempt = 0; attempt < 2 && !acquired; attempt += 1) {
      try {
        await mkdir(path, { mode: 0o700 });
        acquired = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        try {
          const details = await lstat(path);
          if (!details.isDirectory() || details.isSymbolicLink()) {
            throw new OrchestratorError('TASK_STATE_INVALID', 'Preflight lock path is not a real directory');
          }
          const owners = await readdir(path);
          const owner = owners[0];
          let alive = true;
          if (owners.length === 1 && owner !== undefined && /^[1-9][0-9]*$/.test(owner)) {
            const pid = Number(owner);
            try { process.kill(pid, 0); } catch (error) {
              alive = (error as NodeJS.ErrnoException).code !== 'ESRCH';
            }
          } else if (owners.length === 0) {
            // A crash between directory creation and owner-file creation leaves
            // an empty lock. A grace period protects an owner still starting.
            alive = Date.now() - details.mtimeMs < 30_000;
          } else {
            throw new OrchestratorError('TASK_STATE_INVALID', 'Preflight lock directory has unexpected contents');
          }
          if (alive) throw new OrchestratorError('TASK_STATE_INVALID', 'Another preflight retry holds the run lock');
          const assertSameDirectory = async (): Promise<void> => {
            const current = await lstat(path);
            if (current.dev !== details.dev || current.ino !== details.ino || current.birthtimeMs !== details.birthtimeMs) {
              throw new OrchestratorError('TASK_STATE_INVALID', 'Preflight lock was replaced during stale-owner cleanup');
            }
          };
          // Only the contender that removes this dead PID's specific file may
          // retire the directory. A missing file must STOP cleanup, never fall
          // through to removing a directory another contender may have acquired.
          await assertSameDirectory();
          if (owner !== undefined) await unlink(join(path, owner));
          await assertSameDirectory();
          await rmdir(path);
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
          // Another contender won retirement or installed a replacement. Do
          // not retry cleanup against the replacement; report typed contention.
          throw new OrchestratorError('TASK_STATE_INVALID', 'Preflight lock changed during stale-owner cleanup', { cause: error });
        }
      }
    }
    if (!acquired) throw new OrchestratorError('TASK_STATE_INVALID', 'Could not acquire preflight retry lock');
    const ownerPath = join(path, String(process.pid));
    try {
      const owner = await open(ownerPath, 'wx', 0o600);
      try { await owner.sync(); } finally { await owner.close(); }
      return await operation();
    } finally {
      await unlink(ownerPath).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
      await rmdir(path);
    }
  }

  /** Serializes callers and atomically replaces run.json from the same directory. */
  async save(state: RunState): Promise<void> {
    const validated = validateRunState(state);
    if (validated.runId !== this.runId) {
      throw new OrchestratorError('STATE_CORRUPT', 'State runId does not match store runId');
    }
    const operation = this.writeQueue.then(async () => {
      await mkdir(this.runDirectory, { recursive: true, mode: 0o700 });
      await atomicJsonWrite(this.statePath, validated);
    });
    this.writeQueue = operation.catch(() => undefined);
    return operation;
  }

  /** Appends one redacted event as one JSONL record; calls are ordered per store. */
  async appendEvent(event: RunEvent): Promise<void> {
    if (event.runId !== this.runId) {
      throw new OrchestratorError('STATE_CORRUPT', 'Event runId does not match store runId');
    }
    const safeEvent = redact(event);
    const line = `${JSON.stringify(safeEvent)}\n`;
    const operation = this.eventQueue.then(async () => {
      await mkdir(this.runDirectory, { recursive: true, mode: 0o700 });
      let handle;
      try {
        handle = await open(this.eventsPath, 'a', 0o600);
        await handle.writeFile(line, 'utf8');
        await handle.sync();
        await handle.close();
      } catch (error) {
        if (handle !== undefined) {
          await handle.close().catch(() => undefined);
        }
        throw new OrchestratorError('STATE_IO_FAILED', 'Could not append run event', {
          cause: error,
          details: { runId: this.runId },
        });
      }
    });
    this.eventQueue = operation.catch(() => undefined);
    return operation;
  }
}

async function atomicJsonWrite(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`;
  let handle;
  try {
    handle = await open(temporary, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporary, path);
    // Persist the directory entry on filesystems that support directory fsync.
    const directory = await open(dirname(path), 'r').catch(() => undefined);
    if (directory !== undefined) {
      await directory.sync().catch(() => undefined);
      await directory.close().catch(() => undefined);
    }
  } catch (error) {
    if (handle !== undefined) {
      await handle.close().catch(() => undefined);
    }
    await rm(temporary, { force: true }).catch(() => undefined);
    throw new OrchestratorError('STATE_IO_FAILED', 'Atomic state write failed', {
      cause: error,
    });
  }
}
