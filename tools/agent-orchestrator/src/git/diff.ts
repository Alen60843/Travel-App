import { GitClient, assertRevision, assertSha } from './git';

export interface FileDiffStat {
  readonly path: string;
  readonly additions: number | null;
  readonly deletions: number | null;
}

export interface GitDiffSummary {
  readonly base: string;
  readonly head: string;
  readonly files: readonly FileDiffStat[];
  readonly filesChanged: number;
  readonly additions: number;
  readonly deletions: number;
  readonly binaryFiles: number;
  readonly stat: string;
}

export async function changedFiles(
  git: GitClient,
  cwd: string,
  base: string,
  head = 'HEAD',
): Promise<readonly string[]> {
  assertRevision(base);
  assertRevision(head);
  const result = await git.run(cwd, [
    'diff',
    '--name-only',
    '-z',
    '--diff-filter=ACDMRTUXB',
    `${base}...${head}`,
  ]);
  return splitNul(result.stdout);
}

export async function diffSummary(
  git: GitClient,
  cwd: string,
  base: string,
  head = 'HEAD',
): Promise<GitDiffSummary> {
  assertRevision(base);
  assertRevision(head);
  const range = `${base}...${head}`;
  const [numstat, stat] = await Promise.all([
    git.run(cwd, ['diff', '--numstat', '-z', range]),
    git.run(cwd, ['diff', '--stat', '--summary', range]),
  ]);
  const files = parseNumstat(numstat.stdout);
  return {
    base,
    head,
    files,
    filesChanged: files.length,
    additions: files.reduce((sum, file) => sum + (file.additions ?? 0), 0),
    deletions: files.reduce((sum, file) => sum + (file.deletions ?? 0), 0),
    binaryFiles: files.filter((file) => file.additions === null || file.deletions === null).length,
    stat: stat.stdout.trim(),
  };
}

export interface TaskCommitInspection {
  readonly baseSha: string;
  readonly headSha: string;
  readonly commits: readonly string[];
  readonly changedFiles: readonly string[];
  readonly clean: boolean;
}

export async function inspectTaskCommits(
  git: GitClient,
  worktreePath: string,
  baseSha: string,
): Promise<TaskCommitInspection> {
  assertSha(baseSha);
  const headSha = await git.resolveCommit(worktreePath, 'HEAD');
  const ancestor = await git.run(
    worktreePath,
    ['merge-base', '--is-ancestor', baseSha, headSha],
    { allowFailure: true },
  );
  if (ancestor.exitCode !== 0) {
    throw new Error(`Task HEAD ${headSha} is not descended from immutable base ${baseSha}`);
  }
  const [commits, files, status] = await Promise.all([
    git.run(worktreePath, ['rev-list', '--reverse', `${baseSha}..${headSha}`]),
    changedFiles(git, worktreePath, baseSha, headSha),
    git.run(worktreePath, ['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  ]);
  return {
    baseSha,
    headSha,
    commits: commits.stdout.split(/\r?\n/).filter(Boolean),
    changedFiles: files,
    clean: status.stdout.length === 0,
  };
}

export interface EnsureTaskCommitOptions {
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly agent: string;
  readonly taskId: string;
  readonly summary: string;
  readonly allowEmpty?: boolean;
}

export interface EnsuredTaskCommit extends TaskCommitInspection {
  readonly created: boolean;
  readonly commitSha: string;
}

/**
 * Detect an agent-created task commit, or create a local commit from the exact
 * paths reported by porcelain status. No push, merge, reset, or history rewrite
 * is ever performed.
 */
export async function ensureTaskCommit(
  git: GitClient,
  options: EnsureTaskCommitOptions,
): Promise<EnsuredTaskCommit> {
  const before = await inspectTaskCommits(git, options.worktreePath, options.baseSha);
  if (before.clean) {
    if (before.commits.length === 0 && options.allowEmpty === true) {
      const message = taskCommitMessage(options.agent, options.taskId, options.summary);
      await git.run(options.worktreePath, ['commit', '--allow-empty', '-m', message]);
      const afterEmpty = await inspectTaskCommits(git, options.worktreePath, options.baseSha);
      if (!afterEmpty.clean || afterEmpty.commits.length !== 1) {
        throw new Error(`Task ${options.taskId} did not produce one empty audit commit`);
      }
      return { ...afterEmpty, created: true, commitSha: afterEmpty.headSha };
    }
    if (before.commits.length === 0) throw new Error(`Task ${options.taskId} produced no commit or changes`);
    if (before.commits.length !== 1) {
      throw new Error(
        `Task ${options.taskId} produced ${before.commits.length} commits; exactly one auditable task commit is required`,
      );
    }
    return { ...before, created: false, commitSha: before.headSha };
  }

  if (before.commits.length > 0) {
    throw new Error(
      `Task ${options.taskId} has committed and uncommitted changes; refusing to create an ambiguous integration commit`,
    );
  }

  const status = await git.run(options.worktreePath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  const paths = parsePorcelainPaths(status.stdout);
  if (paths.length === 0) throw new Error('Git reported a dirty task worktree without changed paths');
  await git.run(options.worktreePath, ['add', '-A', '--', ...paths]);

  const message = taskCommitMessage(options.agent, options.taskId, options.summary);
  await git.run(options.worktreePath, ['commit', '-m', message]);
  const after = await inspectTaskCommits(git, options.worktreePath, options.baseSha);
  if (!after.clean) throw new Error(`Task ${options.taskId} remained dirty after its task commit`);
  if (after.commits.length !== 1) {
    throw new Error(`Task ${options.taskId} did not produce exactly one task commit`);
  }
  return { ...after, created: true, commitSha: after.headSha };
}

export function taskCommitMessage(agent: string, taskId: string, summary: string): string {
  const normalizedAgent = normalizeCommitPart(agent, 'agent');
  const normalizedTask = normalizeCommitPart(taskId, 'task id');
  const normalizedSummary = summary.replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!normalizedSummary) throw new TypeError('Task commit summary must not be empty');
  return `agent(${normalizedAgent}): ${normalizedTask} ${normalizedSummary}`;
}

function parseNumstat(output: string): readonly FileDiffStat[] {
  const tokens = splitNul(output);
  const files: FileDiffStat[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] ?? '';
    const firstTab = token.indexOf('\t');
    const secondTab = token.indexOf('\t', firstTab + 1);
    if (firstTab < 0 || secondTab < 0) throw new Error('Malformed git --numstat output');
    const additionsText = token.slice(0, firstTab);
    const deletionsText = token.slice(firstTab + 1, secondTab);
    let path = token.slice(secondTab + 1);
    if (!path) {
      const oldPath = tokens[index + 1];
      const newPath = tokens[index + 2];
      if (oldPath === undefined || newPath === undefined) throw new Error('Malformed renamed numstat output');
      path = `${oldPath} -> ${newPath}`;
      index += 2;
    }
    files.push({
      path,
      additions: additionsText === '-' ? null : parseCount(additionsText),
      deletions: deletionsText === '-' ? null : parseCount(deletionsText),
    });
  }
  return files;
}

function parsePorcelainPaths(output: string): readonly string[] {
  const tokens = splitNul(output);
  const paths = new Set<string>();
  for (let index = 0; index < tokens.length; index += 1) {
    const record = tokens[index];
    if (record === undefined || record.length < 4 || record[2] !== ' ') {
      throw new Error('Malformed git porcelain output');
    }
    const status = record.slice(0, 2);
    if (status.includes('U') || status === 'AA' || status === 'DD') {
      throw new Error('Refusing to commit a task worktree with unresolved conflicts');
    }
    paths.add(record.slice(3));
    if (status.includes('R') || status.includes('C')) {
      const source = tokens[index + 1];
      if (source === undefined) throw new Error('Malformed rename/copy porcelain output');
      paths.add(source);
      index += 1;
    }
  }
  return [...paths];
}

function parseCount(value: string): number {
  if (!/^\d+$/.test(value)) throw new Error(`Malformed numstat count: ${value}`);
  return Number(value);
}

function splitNul(value: string): string[] {
  if (!value) return [];
  const values = value.split('\0');
  if (values.at(-1) === '') values.pop();
  return values;
}

function normalizeCommitPart(value: string, label: string): string {
  const normalized = value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(normalized)) {
    throw new TypeError(`Invalid task commit ${label}: ${value}`);
  }
  return normalized;
}
