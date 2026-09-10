import { randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';

import {
  GitClient,
  assertBaseBranchUnmoved,
  assertBranchName,
  assertSha,
} from './git';

export type OwnedWorktreeKind = 'task' | 'integration';
export type OwnedWorktreeStatus = 'creating' | 'active';

export interface OwnedWorktree {
  readonly runId: string;
  readonly taskId: string | null;
  readonly kind: OwnedWorktreeKind;
  readonly path: string;
  readonly branch: string;
  readonly baseBranch: string;
  readonly baseSha: string;
  readonly status: OwnedWorktreeStatus;
  readonly createdAt: string;
}

interface WorktreeRegistry {
  readonly version: 1;
  readonly repositoryCommonDirectory: string;
  readonly entries: readonly OwnedWorktree[];
}

export interface CreateTaskWorktreeOptions {
  readonly runId: string;
  readonly taskId: string;
  readonly baseBranch: string;
  readonly baseSha: string;
}

export interface CreateIntegrationWorktreeOptions {
  readonly runId: string;
  readonly baseBranch: string;
  readonly baseSha: string;
}

export interface CleanupResult {
  readonly entry: OwnedWorktree;
  readonly alreadyMissing: boolean;
}

export interface ListedGitWorktree {
  readonly path: string;
  readonly head: string | null;
  readonly branch: string | null;
  readonly bare: boolean;
  readonly detached: boolean;
}

export class WorktreeSafetyError extends Error {
  readonly code:
    | 'INVALID_WORKTREE_IDENTIFIER'
    | 'WORKTREE_PATH_ESCAPE'
    | 'WORKTREE_ROOT_UNSAFE'
    | 'WORKTREE_UNKNOWN'
    | 'WORKTREE_REGISTRY_CORRUPT'
    | 'WORKTREE_REGISTRY_MISMATCH'
    | 'WORKTREE_ALREADY_EXISTS';

  constructor(code: WorktreeSafetyError['code'], message: string) {
    super(message);
    this.name = 'WorktreeSafetyError';
    this.code = code;
  }
}

/** Owns only worktrees recorded in its repository-specific registry. */
export class WorktreeManager {
  readonly repositoryRoot: string;
  readonly repositoryCommonDirectory: string;
  readonly ownedRoot: string;
  readonly registryPath: string;
  readonly registryLockPath: string;
  readonly git: GitClient;

  private mutationQueue: Promise<void> = Promise.resolve();

  private constructor(options: {
    repositoryRoot: string;
    repositoryCommonDirectory: string;
    ownedRoot: string;
    git: GitClient;
  }) {
    this.repositoryRoot = options.repositoryRoot;
    this.repositoryCommonDirectory = options.repositoryCommonDirectory;
    this.ownedRoot = options.ownedRoot;
    this.registryPath = join(options.ownedRoot, 'registry.json');
    this.registryLockPath = join(options.ownedRoot, 'registry.lock');
    this.git = options.git;
  }

  static async create(options: {
    readonly repositoryPath: string;
    readonly ownedRoot?: string;
    readonly git?: GitClient;
  }): Promise<WorktreeManager> {
    const git = options.git ?? new GitClient();
    const repositoryRoot = await git.repositoryRoot(options.repositoryPath);
    const repositoryCommonDirectory = await git.commonDirectory(repositoryRoot);
    const requestedOwnedRoot = resolve(options.ownedRoot ?? join(repositoryRoot, '.agent-worktrees'));
    assertContained(repositoryRoot, requestedOwnedRoot, false);

    await mkdir(requestedOwnedRoot, { recursive: true, mode: 0o700 });
    const rootDetails = await lstat(requestedOwnedRoot);
    if (!rootDetails.isDirectory() || rootDetails.isSymbolicLink()) {
      throw new WorktreeSafetyError(
        'WORKTREE_ROOT_UNSAFE',
        `Owned worktree root must be a real directory, not a symlink: ${requestedOwnedRoot}`,
      );
    }
    const ownedRoot = await realpath(requestedOwnedRoot);
    assertContained(repositoryRoot, ownedRoot, false);

    const manager = new WorktreeManager({
      repositoryRoot,
      repositoryCommonDirectory,
      ownedRoot,
      git,
    });
    await manager.withRegistryFileLock(() => manager.initializeRegistry());
    return manager;
  }

  async createTaskWorktree(options: CreateTaskWorktreeOptions): Promise<OwnedWorktree> {
    validateIdentifier(options.runId, 'run id');
    validateIdentifier(options.taskId, 'task id');
    return this.createOwnedWorktree({
      ...options,
      kind: 'task',
      branch: `agent/${options.runId}/${options.taskId}`,
      directoryName: `${options.runId}-task-${options.taskId}`,
    });
  }

  async createIntegrationWorktree(options: CreateIntegrationWorktreeOptions): Promise<OwnedWorktree> {
    validateIdentifier(options.runId, 'run id');
    return this.createOwnedWorktree({
      ...options,
      taskId: null,
      kind: 'integration',
      branch: `agent/${options.runId}/integration`,
      directoryName: `${options.runId}-integration`,
    });
  }

  async listOwned(): Promise<readonly OwnedWorktree[]> {
    return (await this.readRegistry()).entries;
  }

  async listGitWorktrees(): Promise<readonly ListedGitWorktree[]> {
    const result = await this.git.run(this.repositoryRoot, ['worktree', 'list', '--porcelain', '-z']);
    return parseWorktreeList(result.stdout);
  }

  async assertRegistered(worktreePath: string): Promise<OwnedWorktree> {
    const candidate = resolve(worktreePath);
    assertContained(this.ownedRoot, candidate, false);
    const entry = (await this.readRegistry()).entries.find((item) => item.path === candidate);
    if (entry === undefined) {
      throw new WorktreeSafetyError(
        'WORKTREE_UNKNOWN',
        `Refusing operation on an unregistered worktree: ${candidate}`,
      );
    }
    return entry;
  }

  async cleanup(worktreePath: string, options: { readonly allowUntrackedPreparationArtifacts?: boolean } = {}): Promise<CleanupResult> {
    return this.exclusive(async () => {
      const candidate = resolve(worktreePath);
      assertContained(this.ownedRoot, candidate, false);
      const registry = await this.readRegistry();
      const entry = registry.entries.find((item) => item.path === candidate);
      if (entry === undefined) {
        throw new WorktreeSafetyError(
          'WORKTREE_UNKNOWN',
          `Refusing to remove unknown or non-orchestrator worktree: ${candidate}`,
        );
      }

      const actual = (await this.listGitWorktrees()).find((item) => item.path === candidate);
      if (actual === undefined) {
        if (await pathExists(candidate)) {
          throw new WorktreeSafetyError(
            'WORKTREE_REGISTRY_MISMATCH',
            `Registered path exists but Git does not recognize it as a worktree: ${candidate}`,
          );
        }
        await this.writeRegistry(withoutEntry(registry, candidate));
        return { entry, alreadyMissing: true };
      }

      const candidateDetails = await lstat(candidate);
      if (!candidateDetails.isDirectory() || candidateDetails.isSymbolicLink()) {
        throw new WorktreeSafetyError(
          'WORKTREE_REGISTRY_MISMATCH',
          `Registered Git worktree path is no longer a real directory: ${candidate}`,
        );
      }

      const expectedRef = `refs/heads/${entry.branch}`;
      if (actual.branch !== expectedRef) {
        throw new WorktreeSafetyError(
          'WORKTREE_REGISTRY_MISMATCH',
          `Registered worktree branch mismatch at ${candidate}: expected ${expectedRef}, found ${String(actual.branch)}`,
        );
      }

      if (options.allowUntrackedPreparationArtifacts) {
        if (entry.kind !== 'integration') {
          throw new WorktreeSafetyError('WORKTREE_REGISTRY_MISMATCH', 'Only integration worktrees may remove preparation artifacts');
        }
        const tracked = (await this.git.run(candidate, ['status', '--porcelain', '--untracked-files=no'])).stdout.trim();
        if (tracked !== '') {
          throw new WorktreeSafetyError('WORKTREE_REGISTRY_MISMATCH', `Integration worktree has tracked modifications: ${candidate}`);
        }
      }
      // Force is narrowly allowed only for an integration worktree whose
      // tracked source was proven clean; it removes configured preparation
      // artifacts such as node_modules without weakening task-worktree safety.
      await this.git.run(this.repositoryRoot, [
        'worktree', 'remove', ...(options.allowUntrackedPreparationArtifacts ? ['--force'] : []), candidate,
      ]);
      await this.writeRegistry(withoutEntry(registry, candidate));
      return { entry, alreadyMissing: false };
    });
  }

  async cleanupRun(runId: string): Promise<readonly CleanupResult[]> {
    validateIdentifier(runId, 'run id');
    const entries = (await this.listOwned()).filter((entry) => entry.runId === runId);
    const results: CleanupResult[] = [];
    for (const entry of entries) results.push(await this.cleanup(entry.path));
    return results;
  }

  private async createOwnedWorktree(options: {
    readonly runId: string;
    readonly taskId: string | null;
    readonly kind: OwnedWorktreeKind;
    readonly baseBranch: string;
    readonly baseSha: string;
    readonly branch: string;
    readonly directoryName: string;
  }): Promise<OwnedWorktree> {
    return this.exclusive(async () => {
      assertBranchName(options.baseBranch);
      assertBranchName(options.branch);
      assertSha(options.baseSha);
      const branchCheck = await this.git.run(
        this.repositoryRoot,
        ['check-ref-format', '--branch', options.branch],
        { allowFailure: true },
      );
      if (branchCheck.exitCode !== 0) throw new TypeError(`Invalid task branch: ${options.branch}`);
      await assertBaseBranchUnmoved(
        this.git,
        this.repositoryRoot,
        options.baseBranch,
        options.baseSha,
      );

      const worktreePath = resolve(this.ownedRoot, options.directoryName);
      assertContained(this.ownedRoot, worktreePath, false);
      const registry = await this.readRegistry();
      if (
        registry.entries.some((entry) => entry.path === worktreePath || entry.branch === options.branch) ||
        (await pathExists(worktreePath))
      ) {
        throw new WorktreeSafetyError(
          'WORKTREE_ALREADY_EXISTS',
          `Owned task worktree or branch registration already exists: ${worktreePath}`,
        );
      }
      const branchExists = await this.git.run(
        this.repositoryRoot,
        ['show-ref', '--verify', '--quiet', `refs/heads/${options.branch}`],
        { allowFailure: true },
      );
      if (branchExists.exitCode === 0) {
        throw new WorktreeSafetyError(
          'WORKTREE_ALREADY_EXISTS',
          `Task branch already exists and will not be reused automatically: ${options.branch}`,
        );
      }

      const creating: OwnedWorktree = {
        runId: options.runId,
        taskId: options.taskId,
        kind: options.kind,
        path: worktreePath,
        branch: options.branch,
        baseBranch: options.baseBranch,
        baseSha: options.baseSha,
        status: 'creating',
        createdAt: new Date().toISOString(),
      };
      await this.writeRegistry({ ...registry, entries: [...registry.entries, creating] });

      let worktreeAdded = false;
      try {
        await this.git.run(this.repositoryRoot, [
          'worktree',
          'add',
          '-b',
          options.branch,
          worktreePath,
          options.baseSha,
        ]);
        worktreeAdded = true;
        const active: OwnedWorktree = { ...creating, status: 'active' };
        const current = await this.readRegistry();
        await this.writeRegistry({
          ...current,
          entries: current.entries.map((entry) => (entry.path === worktreePath ? active : entry)),
        });
        return active;
      } catch (error) {
        // Once Git has created the worktree, retain the `creating` registry
        // entry if activation persistence fails. It remains recognizable and
        // recoverable after a crash instead of becoming an unknown worktree.
        if (!worktreeAdded) {
          const current = await this.readRegistry();
          await this.writeRegistry(withoutEntry(current, worktreePath));
        }
        throw error;
      }
    });
  }

  private async initializeRegistry(): Promise<void> {
    if (await pathExists(this.registryPath)) {
      await this.readRegistry();
      return;
    }
    await this.writeRegistry({
      version: 1,
      repositoryCommonDirectory: this.repositoryCommonDirectory,
      entries: [],
    });
  }

  private async readRegistry(): Promise<WorktreeRegistry> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(this.registryPath, 'utf8')) as unknown;
    } catch (error) {
      throw new WorktreeSafetyError(
        'WORKTREE_REGISTRY_CORRUPT',
        `Cannot read orchestrator worktree registry: ${String(error)}`,
      );
    }
    if (!isRegistry(parsed)) {
      throw new WorktreeSafetyError('WORKTREE_REGISTRY_CORRUPT', 'Invalid worktree registry structure');
    }
    if (parsed.repositoryCommonDirectory !== this.repositoryCommonDirectory) {
      throw new WorktreeSafetyError(
        'WORKTREE_REGISTRY_MISMATCH',
        'Worktree registry belongs to a different Git repository',
      );
    }
    for (const entry of parsed.entries) assertRegistryEntry(entry, this.ownedRoot);
    return parsed;
  }

  private async writeRegistry(registry: WorktreeRegistry): Promise<void> {
    const temporaryPath = join(this.ownedRoot, `.registry-${process.pid}-${randomUUID()}.tmp`);
    let handle;
    try {
      handle = await open(temporaryPath, 'wx', 0o600);
      await handle.writeFile(`${JSON.stringify(registry, null, 2)}\n`, 'utf8');
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temporaryPath, this.registryPath);
      const directory = await open(this.ownedRoot, 'r').catch(() => undefined);
      if (directory !== undefined) {
        await directory.sync().catch(() => undefined);
        await directory.close().catch(() => undefined);
      }
    } finally {
      if (handle !== undefined) await handle.close().catch(() => undefined);
      await unlink(temporaryPath).catch(() => undefined);
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const guarded = (): Promise<T> => this.withRegistryFileLock(operation);
    const pending = this.mutationQueue.then(guarded, guarded);
    this.mutationQueue = pending.then(
      () => undefined,
      () => undefined,
    );
    return pending;
  }

  /** Serialize registry mutations across independent orchestrator processes. */
  private async withRegistryFileLock<T>(operation: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + 10_000;
    let lockHandle;
    while (lockHandle === undefined) {
      try {
        lockHandle = await open(this.registryLockPath, 'wx', 0o600);
        await lockHandle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
        await lockHandle.sync();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
          if (lockHandle !== undefined) {
            await lockHandle.close().catch(() => undefined);
            lockHandle = undefined;
            await unlink(this.registryLockPath).catch(() => undefined);
          }
          throw error;
        }
        await this.removeDeadRegistryLock();
        if (Date.now() >= deadline) {
          throw new WorktreeSafetyError(
            'WORKTREE_REGISTRY_MISMATCH',
            'Timed out waiting for another orchestrator process to release the worktree registry',
          );
        }
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
      }
    }
    try {
      return await operation();
    } finally {
      await lockHandle.close().catch(() => undefined);
      await unlink(this.registryLockPath).catch(() => undefined);
    }
  }

  private async removeDeadRegistryLock(): Promise<void> {
    let pid: number | undefined;
    try {
      const value = JSON.parse(await readFile(this.registryLockPath, 'utf8')) as unknown;
      if (typeof value === 'object' && value !== null) {
        const candidate = (value as { pid?: unknown }).pid;
        if (typeof candidate === 'number' && Number.isSafeInteger(candidate) && candidate > 0) {
          pid = candidate;
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      return;
    }
    if (pid !== undefined) {
      if (!processIsAlive(pid)) await unlink(this.registryLockPath).catch(() => undefined);
      return;
    }
    try {
      const details = await lstat(this.registryLockPath);
      if (Date.now() - details.mtimeMs > 30_000) {
        await unlink(this.registryLockPath).catch(() => undefined);
      }
    } catch {
      // A concurrent owner may already have replaced or removed the lock.
    }
  }
}

export function parseWorktreeList(output: string): readonly ListedGitWorktree[] {
  const records = output.split('\0\0').filter(Boolean);
  return records.map((record) => {
    const fields = record.split('\0').filter(Boolean);
    const worktree = fields.find((field) => field.startsWith('worktree '));
    if (worktree === undefined) throw new Error('Malformed git worktree list output');
    const head = fields.find((field) => field.startsWith('HEAD '));
    const branch = fields.find((field) => field.startsWith('branch '));
    return {
      path: worktree.slice('worktree '.length),
      head: head?.slice('HEAD '.length) ?? null,
      branch: branch?.slice('branch '.length) ?? null,
      bare: fields.includes('bare'),
      detached: fields.includes('detached'),
    };
  });
}

function withoutEntry(registry: WorktreeRegistry, path: string): WorktreeRegistry {
  return { ...registry, entries: registry.entries.filter((entry) => entry.path !== path) };
}

function assertRegistryEntry(entry: unknown, ownedRoot: string): asserts entry is OwnedWorktree {
  if (typeof entry !== 'object' || entry === null) {
    throw new WorktreeSafetyError('WORKTREE_REGISTRY_CORRUPT', 'Invalid worktree registry entry');
  }
  const candidate = entry as Partial<OwnedWorktree>;
  if (
    typeof candidate.runId !== 'string' ||
    (candidate.taskId !== null && typeof candidate.taskId !== 'string') ||
    typeof candidate.path !== 'string' ||
    typeof candidate.branch !== 'string' ||
    typeof candidate.baseBranch !== 'string' ||
    typeof candidate.baseSha !== 'string' ||
    typeof candidate.createdAt !== 'string'
  ) {
    throw new WorktreeSafetyError('WORKTREE_REGISTRY_CORRUPT', 'Invalid worktree registry entry');
  }
  const typed = candidate as OwnedWorktree;
  validateIdentifier(typed.runId, 'registered run id');
  if (typed.taskId !== null) validateIdentifier(typed.taskId, 'registered task id');
  assertContained(ownedRoot, typed.path, false);
  assertBranchName(typed.branch);
  assertBranchName(typed.baseBranch);
  assertSha(typed.baseSha);
  if (!['task', 'integration'].includes(typed.kind) || !['creating', 'active'].includes(typed.status)) {
    throw new WorktreeSafetyError('WORKTREE_REGISTRY_CORRUPT', 'Invalid worktree registry entry');
  }
  const expectedTaskId = typed.kind === 'task' ? typed.taskId : null;
  if ((typed.kind === 'task' && expectedTaskId === null) || (typed.kind === 'integration' && typed.taskId !== null)) {
    throw new WorktreeSafetyError('WORKTREE_REGISTRY_CORRUPT', 'Worktree kind/task id mismatch');
  }
  const expectedBranch =
    typed.kind === 'task'
      ? `agent/${typed.runId}/${String(typed.taskId)}`
      : `agent/${typed.runId}/integration`;
  const expectedPath = resolve(
    ownedRoot,
    typed.kind === 'task'
      ? `${typed.runId}-task-${String(typed.taskId)}`
      : `${typed.runId}-integration`,
  );
  if (typed.branch !== expectedBranch || typed.path !== expectedPath) {
    throw new WorktreeSafetyError(
      'WORKTREE_REGISTRY_CORRUPT',
      'Registered worktree path or branch is not the deterministic orchestrator-owned value',
    );
  }
}

function isRegistry(value: unknown): value is WorktreeRegistry {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as Partial<WorktreeRegistry>;
  return (
    candidate.version === 1 &&
    typeof candidate.repositoryCommonDirectory === 'string' &&
    Array.isArray(candidate.entries)
  );
}

function validateIdentifier(value: string, label: string): void {
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value) ||
    value.includes('..') ||
    value.endsWith('.lock')
  ) {
    throw new WorktreeSafetyError(
      'INVALID_WORKTREE_IDENTIFIER',
      `Invalid ${label} for a worktree/branch: ${value}`,
    );
  }
}

function assertContained(root: string, candidate: string, allowEqual: boolean): void {
  if (!isAbsolute(root) || !isAbsolute(candidate)) {
    throw new WorktreeSafetyError('WORKTREE_PATH_ESCAPE', 'Worktree paths must be absolute');
  }
  const relation = relative(resolve(root), resolve(candidate));
  if ((!allowEqual && relation === '') || relation === '..' || relation.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || isAbsolute(relation)) {
    throw new WorktreeSafetyError(
      'WORKTREE_PATH_ESCAPE',
      `Path is outside the orchestrator-owned worktree root: ${candidate}`,
    );
  }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}
