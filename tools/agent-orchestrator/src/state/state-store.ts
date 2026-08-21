import { randomUUID } from 'node:crypto';
import { open, mkdir, readFile, rename, rm } from 'node:fs/promises';
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
