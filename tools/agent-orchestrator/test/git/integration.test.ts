import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { ensureTaskCommit } from '../../src/git/diff';
import {
  integrateTaskCommits,
  integrationConflictError,
  type IntegrationCommit,
} from '../../src/git/integration';
import { WorktreeManager } from '../../src/git/worktree-manager';
import { createTemporaryRepository, type TemporaryRepository } from './helpers';

const repositories: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.dispose()));
});

test('integrates known task commits in the supplied dependency order', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });
  const first = await makeTask(manager, repository, 'run-ok', 'first', 'first.txt', 'first\n');
  const second = await makeTask(manager, repository, 'run-ok', 'second', 'second.txt', 'second\n');
  const integration = await manager.createIntegrationWorktree({
    runId: 'run-ok',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });

  const result = await integrateTaskCommits(repository.git, integration.path, [first, second]);
  assert.equal(result.status, 'succeeded');
  assert.deepEqual(result.applied, [first, second]);
  const subjects = await repository.git.run(integration.path, [
    'log',
    '--format=%s',
    '--reverse',
    `${repository.baseSha}..HEAD`,
  ]);
  assert.deepEqual(subjects.stdout.trim().split('\n'), [
    'agent(codex): first implement first',
    'agent(codex): second implement second',
  ]);
});

test('stops at an integration conflict and reports it without resolving or aborting', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });
  const first = await makeTask(manager, repository, 'run-conflict', 'first', 'shared.txt', 'first\n');
  const second = await makeTask(manager, repository, 'run-conflict', 'second', 'shared.txt', 'second\n');
  const integration = await manager.createIntegrationWorktree({
    runId: 'run-conflict',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });

  const result = await integrateTaskCommits(repository.git, integration.path, [first, second]);
  assert.equal(result.status, 'conflict');
  if (result.status !== 'conflict') return;
  assert.equal(result.code, 'INTEGRATION_CONFLICT');
  assert.deepEqual(result.applied, [first]);
  assert.deepEqual(result.failed, second);
  assert.deepEqual(result.conflictFiles, ['shared.txt']);
  assert.equal(
    (await repository.git.run(integration.path, ['rev-parse', '--verify', '--quiet', 'CHERRY_PICK_HEAD'], {
      allowFailure: true,
    })).exitCode,
    0,
  );
  assert.deepEqual(
    (await repository.git.run(integration.path, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim(),
    'shared.txt',
  );
  const error = integrationConflictError(result);
  assert.equal(error.code, 'INTEGRATION_CONFLICT');
  assert.deepEqual(error.details.conflictFiles, ['shared.txt']);
});

test('integrates an empty correction audit commit', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });
  const task = await manager.createTaskWorktree({
    runId: 'run-empty-correction',
    taskId: 'correction',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });
  const correction = await ensureTaskCommit(repository.git, {
    worktreePath: task.path,
    baseSha: repository.baseSha,
    agent: 'codex',
    taskId: 'correction',
    summary: 'reject findings with evidence',
    allowEmpty: true,
  });
  const integration = await manager.createIntegrationWorktree({
    runId: 'run-empty-correction',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });

  const result = await integrateTaskCommits(repository.git, integration.path, [{
    taskId: 'correction',
    commitSha: correction.commitSha,
  }]);
  assert.equal(result.status, 'succeeded');
  assert.equal(
    (await repository.git.run(integration.path, ['rev-list', '--count', `${repository.baseSha}..HEAD`])).stdout.trim(),
    '1',
  );
});

async function makeTask(
  manager: WorktreeManager,
  repository: TemporaryRepository,
  runId: string,
  taskId: string,
  file: string,
  contents: string,
): Promise<IntegrationCommit> {
  const task = await manager.createTaskWorktree({
    runId,
    taskId,
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });
  await writeFile(join(task.path, file), contents, 'utf8');
  const commit = await ensureTaskCommit(repository.git, {
    worktreePath: task.path,
    baseSha: repository.baseSha,
    agent: 'codex',
    taskId,
    summary: `implement ${taskId}`,
  });
  return { taskId, commitSha: commit.commitSha };
}
