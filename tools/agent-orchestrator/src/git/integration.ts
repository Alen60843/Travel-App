import { OrchestratorError } from '../errors';
import { GitClient, assertSha } from './git';

export interface IntegrationCommit {
  readonly taskId: string;
  readonly commitSha: string;
}

export interface IntegrationSuccess {
  readonly status: 'succeeded';
  readonly applied: readonly IntegrationCommit[];
  readonly headSha: string;
}

export interface IntegrationConflict {
  readonly status: 'conflict';
  readonly code: 'INTEGRATION_CONFLICT';
  readonly applied: readonly IntegrationCommit[];
  readonly failed: IntegrationCommit;
  readonly conflictFiles: readonly string[];
  readonly stderr: string;
}

export type IntegrationResult = IntegrationSuccess | IntegrationConflict;

/**
 * Cherry-picks exactly the supplied task commits, in supplied dependency order.
 * A conflict is left intact for human/Lead inspection; this function never
 * resolves, aborts, skips, merges, pushes, or rewrites history.
 */
export async function integrateTaskCommits(
  git: GitClient,
  integrationWorktreePath: string,
  commits: readonly IntegrationCommit[],
): Promise<IntegrationResult> {
  const status = await git.run(integrationWorktreePath, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
  ]);
  if (status.stdout.length !== 0) throw new Error('Integration worktree must be clean before cherry-pick');
  const inProgress = await git.run(
    integrationWorktreePath,
    ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'],
    { allowFailure: true },
  );
  if (inProgress.exitCode === 0) throw new Error('Integration worktree already has a cherry-pick in progress');

  const unique = new Set<string>();
  for (const commit of commits) {
    assertTaskId(commit.taskId);
    assertSha(commit.commitSha);
    if (unique.has(commit.commitSha)) throw new TypeError(`Duplicate integration commit: ${commit.commitSha}`);
    unique.add(commit.commitSha);
    await git.resolveCommit(integrationWorktreePath, commit.commitSha);
  }

  const applied: IntegrationCommit[] = [];
  for (const commit of commits) {
    const result = await git.run(
      integrationWorktreePath,
      ['cherry-pick', '--allow-empty', '--no-edit', '-x', commit.commitSha],
      { allowFailure: true },
    );
    if (result.exitCode === 0) {
      applied.push(commit);
      continue;
    }

    const conflictFilesResult = await git.run(
      integrationWorktreePath,
      ['diff', '--name-only', '-z', '--diff-filter=U'],
      { allowFailure: true },
    );
    const conflictFiles = splitNul(conflictFilesResult.stdout);
    if (conflictFiles.length === 0) {
      throw new Error(
        `Cherry-pick of ${commit.taskId} (${commit.commitSha}) failed without merge conflicts: ${result.stderr.trim()}`,
      );
    }

    return {
      status: 'conflict',
      code: 'INTEGRATION_CONFLICT',
      applied,
      failed: commit,
      conflictFiles,
      stderr: result.stderr,
    };
  }

  return {
    status: 'succeeded',
    applied,
    headSha: await git.resolveCommit(integrationWorktreePath, 'HEAD'),
  };
}

export function integrationConflictError(conflict: IntegrationConflict): OrchestratorError {
  return new OrchestratorError(
    'INTEGRATION_CONFLICT',
    `Integration conflict while cherry-picking task ${conflict.failed.taskId}`,
    {
      details: {
        failedTaskId: conflict.failed.taskId,
        failedCommitSha: conflict.failed.commitSha,
        appliedCommitShas: conflict.applied.map((commit) => commit.commitSha),
        conflictFiles: conflict.conflictFiles,
      },
    },
  );
}

function assertTaskId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(value)) {
    throw new TypeError(`Invalid integration task id: ${value}`);
  }
}

function splitNul(value: string): readonly string[] {
  if (!value) return [];
  const result = value.split('\0');
  if (result.at(-1) === '') result.pop();
  return result;
}
