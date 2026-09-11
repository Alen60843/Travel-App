import { constants } from 'node:fs';
import { createHash } from 'node:crypto';
import { lstat, open, realpath, readlink } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';
import { GitClient, inspectTaskCommits, type TaskCommitInspection, type IntegrationCommit } from '../git';
import type { StateStore, TaskRunState } from '../state';
import { parseHandoff } from '../handoff';
import { replanHash, refuse, type ReplanProposal } from './model';
import { assertChangedFileOwnership, normalizeRepositoryPath } from '../tasks/ownership';

export async function readReplanHandoff(store: StateStore, task: TaskRunState) {
  const path = task.handoffPath;
  if (path === undefined || resolve(path) !== path || basename(path) !== `${task.id}.json`) refuse('source artifact path does not match its own persisted handoff path');
  const actual = await realpath(path);
  if (actual !== join(await realpath(store.runDirectory), 'handoffs', `${task.id}.json`)) refuse('handoff resolves outside its owned artifact directory');
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink() || before.size > 2 * 1024 * 1024) refuse('handoff must be a bounded regular file');
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (metadata.dev !== before.dev || metadata.ino !== before.ino) refuse('handoff changed while opening');
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.size !== metadata.size || after.mtimeMs !== metadata.mtimeMs || after.ctimeMs !== metadata.ctimeMs) refuse('handoff changed while reading');
    return { path, sha256: createHash('sha256').update(bytes).digest('hex'), handoff: parseHandoff(bytes.toString('utf8')) };
  } finally { await handle.close(); }
}

const paths = (output: string) => output.split('\0').filter(Boolean);
export async function changedCandidatePaths(git: GitClient, cwd: string, parent: string): Promise<string[]> {
  const tracked = await git.run(cwd, ['diff', '--name-only', '--no-renames', '-z', parent]);
  const staged = await git.run(cwd, ['diff', '--cached', '--name-only', '--no-renames', '-z', parent]);
  const untracked = await git.run(cwd, ['ls-files', '--others', '--exclude-standard', '-z']);
  return [...new Set([...paths(tracked.stdout), ...paths(staged.stdout), ...paths(untracked.stdout)])].sort();
}

/** Full Git tree manifest; stable across git add/commit, including new files, modes and deletions. */
export async function treeFingerprint(git: GitClient, cwd: string, revision: string, dirty = false): Promise<string> {
  const entries = paths((await git.run(cwd, ['ls-tree', '-r', '-z', revision])).stdout);
  const tree = new Map(entries.map((entry) => {
    const tab = entry.indexOf('\t');
    return [entry.slice(tab + 1), entry.slice(0, tab)] as const;
  }));
  if (dirty) for (const path of await changedCandidatePaths(git, cwd, revision)) {
    normalizeRepositoryPath(path);
    const absolute = join(cwd, path);
    const metadata = await lstat(absolute).catch((error: NodeJS.ErrnoException) => { if (error.code === 'ENOENT') return undefined; throw error; });
    if (metadata === undefined) { tree.delete(path); continue; }
    if (!metadata.isFile() && !metadata.isSymbolicLink()) refuse('checkpoint contains unsupported file kind');
    // Never follow a directory symlink out of the registered worktree.
    if (!(await realpath(resolve(absolute, '..'))).startsWith(`${await realpath(cwd)}${sep}`)
      && await realpath(resolve(absolute, '..')) !== await realpath(cwd)) refuse('checkpoint path escapes worktree');
    const blob = metadata.isSymbolicLink()
      ? (await git.run(cwd, ['hash-object', '--stdin'], { input: await readlink(absolute) })).stdout.trim()
      : (await git.run(cwd, ['hash-object', `--path=${path}`, '--', path])).stdout.trim();
    const mode = metadata.isSymbolicLink() ? '120000' : (metadata.mode & 0o111) !== 0 ? '100755' : '100644';
    tree.set(path, `${mode} blob ${blob}`);
  }
  return replanHash([...tree].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export async function inspectCheckpoint(git: GitClient, cwd: string, proposal: ReplanProposal, ownership: readonly string[]): Promise<TaskCommitInspection> {
  const inspection = await inspectTaskCommits(git, cwd, proposal.preparedHeadSha);
  if (!inspection.clean || inspection.commits.length !== 1) refuse('checkpoint has dirty work or foreign commits');
  const parents = (await git.run(cwd, ['show', '-s', '--format=%P', 'HEAD'])).stdout.trim();
  const trailers = (await git.run(cwd, ['show', '-s', '--format=%(trailers:key=Replan-Checkpoint,valueonly)', 'HEAD'])).stdout.trim();
  if (parents !== proposal.preparedHeadSha || trailers !== proposal.id
    || await treeFingerprint(git, cwd, 'HEAD') !== proposal.treeFingerprint) refuse('checkpoint parent, trailer or tree differs from persisted intent');
  assertChangedFileOwnership(proposal.sourceTaskId, inspection.changedFiles, ownership);
  return inspection;
}

export async function assertCodeInputHistory(git: GitClient, cwd: string, base: string, preparedHead: string, inputs: readonly IntegrationCommit[]): Promise<void> {
  await git.run(cwd, ['merge-base', '--is-ancestor', base, preparedHead]);
  const commits = (await git.run(cwd, ['rev-list', '--reverse', `${base}..${preparedHead}`])).stdout.trim().split(/\r?\n/).filter(Boolean);
  if (commits.length !== inputs.length || (commits.length === 0 && preparedHead !== base)) refuse('prepared code input history differs');
  for (const [index, sha] of commits.entries()) {
    const original = inputs[index]!.commitSha;
    const message = (await git.run(cwd, ['show', '-s', '--format=%B', sha])).stdout;
    const patch = async (commit: string) => (await git.run(cwd, ['diff', '--binary', '--full-index', '--no-ext-diff', '--no-textconv', '--no-renames', `${commit}^`, commit])).stdout;
    if (!message.includes(`(cherry picked from commit ${original})`) || await patch(sha) !== await patch(original)) refuse('prepared code input patch differs');
  }
}
