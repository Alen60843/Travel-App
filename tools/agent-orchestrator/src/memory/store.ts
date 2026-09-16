import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, opendir, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';

import { canonicalJson } from '../canonical-json';
import { OrchestratorError } from '../errors';
import { MAX_MEMORY_ENTRY_BYTES, parseMemoryEntry, serializeMemoryEntry } from './entry';
import type { MemoryEntry, MemoryQuery } from './types';

export const MAX_MEMORY_SCAN_ENTRIES = 256;
const MEMORY_ID = /^[a-f0-9]{64}$/;

export interface PutMemoryResult {
  readonly status: 'created' | 'already_present';
  readonly entry: MemoryEntry;
}

function corrupt(message: string, cause?: unknown): never {
  throw new OrchestratorError('STATE_CORRUPT', `Memory store: ${message}`,
    cause === undefined ? {} : { cause });
}

function ioFailure(message: string, cause: unknown): never {
  throw new OrchestratorError('STATE_IO_FAILED', `Memory store: ${message}`, { cause });
}

export class MemoryStore {
  readonly memoryRoot: string;
  readonly entriesRoot: string;
  private readonly orchestratorRoot: string;

  constructor(repositoryRoot: string) {
    const root = resolve(repositoryRoot);
    this.orchestratorRoot = join(root, 'tools', 'agent-orchestrator');
    this.memoryRoot = join(this.orchestratorRoot, 'memory');
    this.entriesRoot = join(this.memoryRoot, 'entries');
  }

  async putMemory(entry: MemoryEntry): Promise<PutMemoryResult> {
    const parsed = parseMemoryEntry(entry);
    const bytes = serializeMemoryEntry(parsed);
    await this.ensureWritableRoot();
    const finalPath = this.entryPath(parsed.id);
    const temporary = join(this.entriesRoot, `.${parsed.id}.tmp-${process.pid}-${randomUUID()}`);
    let handle;
    try {
      handle = await open(temporary, 'wx', 0o600);
      await handle.writeFile(bytes, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      try {
        await link(temporary, finalPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const existing = await this.getMemory(parsed.id);
        if (existing === undefined || serializeMemoryEntry(existing) !== bytes) {
          corrupt(`entry ${parsed.id} conflicts with immutable content`);
        }
        return { status: 'already_present', entry: existing };
      }
      const directory = await open(this.entriesRoot, 'r').catch(() => undefined);
      if (directory !== undefined) {
        await directory.sync().catch(() => undefined);
        await directory.close().catch(() => undefined);
      }
      return { status: 'created', entry: parsed };
    } catch (error) {
      if (error instanceof OrchestratorError) throw error;
      return ioFailure(`could not persist entry ${parsed.id}`, error);
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error;
      });
    }
  }

  async getMemory(id: string): Promise<MemoryEntry | undefined> {
    const path = this.entryPath(id);
    if (!await this.readableRoot()) return undefined;
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      return corrupt(`could not safely open entry ${id}`, error);
    }
    try {
      const details = await handle.stat();
      if (!details.isFile() || details.size > MAX_MEMORY_ENTRY_BYTES) corrupt(`entry ${id} is not a bounded regular file`);
      const source = await handle.readFile('utf8');
      if (Buffer.byteLength(source, 'utf8') > MAX_MEMORY_ENTRY_BYTES) corrupt(`entry ${id} is oversized`);
      let value: unknown;
      try { value = JSON.parse(source); } catch (error) { corrupt(`entry ${id} is not valid JSON`, error); }
      const entry = parseMemoryEntry(value);
      if (entry.id !== id || serializeMemoryEntry(entry) !== source) corrupt(`entry ${id} is not canonical immutable content`);
      return entry;
    } finally {
      await handle.close().catch(() => undefined);
    }
  }

  async listMemory(query: MemoryQuery = {}): Promise<readonly MemoryEntry[]> {
    if (!await this.readableRoot()) return [];
    const names: string[] = [];
    const directory = await opendir(this.entriesRoot);
    try {
      for await (const item of directory) {
        if (names.length >= MAX_MEMORY_SCAN_ENTRIES) corrupt('entry directory exceeds bounded scan limit');
        names.push(item.name);
      }
    } finally {
      await directory.close().catch(() => undefined);
    }
    const entryNames = names.filter((name) => !/^\.[a-f0-9]{64}\.tmp-/.test(name));
    if (entryNames.some((name) => !/^[a-f0-9]{64}\.json$/.test(name))) corrupt('entry directory contains an unexpected path');
    const entries: MemoryEntry[] = [];
    for (const name of entryNames.sort()) {
      const entry = await this.getMemory(name.slice(0, -5));
      if (entry === undefined) corrupt(`entry ${name} disappeared during scan`);
      if (matches(entry, query)) entries.push(entry);
    }
    return entries;
  }

  private entryPath(id: string): string {
    if (!MEMORY_ID.test(id)) corrupt('memory id is invalid');
    return join(this.entriesRoot, `${id}.json`);
  }

  private async ensureWritableRoot(): Promise<void> {
    try {
      await mkdir(this.orchestratorRoot, { recursive: true, mode: 0o700 });
      await ensureRealDirectory(this.orchestratorRoot, true);
      await ensureRealDirectory(this.memoryRoot, true);
      await ensureRealDirectory(this.entriesRoot, true);
    } catch (error) {
      if (error instanceof OrchestratorError) throw error;
      ioFailure('could not initialize repository memory root', error);
    }
  }

  private async readableRoot(): Promise<boolean> {
    const memory = await ensureRealDirectory(this.memoryRoot, false);
    if (!memory) return false;
    return ensureRealDirectory(this.entriesRoot, false);
  }
}

async function ensureRealDirectory(path: string, create: boolean): Promise<boolean> {
  if (create) {
    try { await mkdir(path, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  let details;
  try { details = await lstat(path); } catch (error) {
    if (!create && (error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  if (!details.isDirectory() || details.isSymbolicLink()) corrupt(`${path} is not a real directory`);
  return true;
}

function matches(entry: MemoryEntry, query: MemoryQuery): boolean {
  return (query.kind === undefined || entry.kind === query.kind)
    && (query.subject === undefined || canonicalJson(entry.subject) === canonicalJson(query.subject))
    && (query.runId === undefined || entry.provenance.runId === query.runId)
    && (query.taskId === undefined || entry.provenance.taskId === query.taskId);
}
