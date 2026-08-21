import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { GitCommandError } from '../../src/git/git';
import {
  WorktreeManager,
  WorktreeSafetyError,
} from '../../src/git/worktree-manager';
import { createTemporaryRepository, type TemporaryRepository } from './helpers';

const repositories: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.dispose()));
});

test('creates task and integration worktrees from the immutable SHA and cleans only registered paths', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });

  const task = await manager.createTaskWorktree({
    runId: 'run-001',
    taskId: 'explorer-query',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });
  const integration = await manager.createIntegrationWorktree({
    runId: 'run-001',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });

  assert.equal(await repository.git.resolveCommit(task.path, 'HEAD'), repository.baseSha);
  assert.equal(await repository.git.resolveCommit(integration.path, 'HEAD'), repository.baseSha);
  assert.deepEqual(
    (await manager.listOwned()).map((entry) => [entry.kind, entry.branch]),
    [
      ['task', 'agent/run-001/explorer-query'],
      ['integration', 'agent/run-001/integration'],
    ],
  );

  assert.equal((await manager.cleanup(task.path)).alreadyMissing, false);
  await assert.rejects(access(task.path));
  assert.equal((await manager.listOwned()).length, 1);
  await manager.cleanup(integration.path);
  assert.equal((await manager.listOwned()).length, 0);
});

test('refuses unknown Git worktrees even when they are beneath the owned root', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });
  const humanPath = join(manager.ownedRoot, 'human-worktree');
  await repository.git.run(repository.repository, [
    'worktree',
    'add',
    '-b',
    'human/manual',
    humanPath,
    repository.baseSha,
  ]);

  await assert.rejects(manager.cleanup(humanPath), (error: unknown) => {
    assert.ok(error instanceof WorktreeSafetyError);
    assert.equal(error.code, 'WORKTREE_UNKNOWN');
    return true;
  });
  await access(humanPath);
  assert.ok((await manager.listGitWorktrees()).some((worktree) => worktree.path === humanPath));
});

test('does not force-remove a dirty registered worktree', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });
  const task = await manager.createTaskWorktree({
    runId: 'run-dirty',
    taskId: 'writer',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });
  await writeFile(join(task.path, 'uncommitted.txt'), 'preserve me\n', 'utf8');

  await assert.rejects(manager.cleanup(task.path), GitCommandError);
  await access(join(task.path, 'uncommitted.txt'));
  assert.equal((await manager.listOwned()).length, 1);
});

test('refuses traversal identifiers and worktree paths outside the owned root', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });

  await assert.rejects(
    manager.createTaskWorktree({
      runId: '../escape',
      taskId: 'writer',
      baseBranch: repository.baseBranch,
      baseSha: repository.baseSha,
    }),
    (error: unknown) => error instanceof WorktreeSafetyError && error.code === 'INVALID_WORKTREE_IDENTIFIER',
  );
  await assert.rejects(
    manager.cleanup(repository.repository),
    (error: unknown) => error instanceof WorktreeSafetyError && error.code === 'WORKTREE_PATH_ESCAPE',
  );
});

test('serializes the shared ownership registry across manager instances', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const [leftManager, rightManager] = await Promise.all([
    WorktreeManager.create({ repositoryPath: repository.repository }),
    WorktreeManager.create({ repositoryPath: repository.repository }),
  ]);

  await Promise.all([
    leftManager.createTaskWorktree({
      runId: 'run-left',
      taskId: 'writer',
      baseBranch: repository.baseBranch,
      baseSha: repository.baseSha,
    }),
    rightManager.createTaskWorktree({
      runId: 'run-right',
      taskId: 'writer',
      baseBranch: repository.baseBranch,
      baseSha: repository.baseSha,
    }),
  ]);

  assert.deepEqual(
    (await leftManager.listOwned()).map(({ runId }) => runId).sort(),
    ['run-left', 'run-right'],
  );
  await Promise.all([
    leftManager.cleanupRun('run-left'),
    rightManager.cleanupRun('run-right'),
  ]);
});
