import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  changedFiles,
  computeTrackedDiffFingerprint,
  diffSummary,
  ensureTaskCommit,
  inspectTaskCommits,
} from '../../src/git/diff';
import { WorktreeManager } from '../../src/git/worktree-manager';
import { createTemporaryRepository, type TemporaryRepository } from './helpers';

const repositories: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.dispose()));
});

test('creates a local task commit, detects it on resume, and reports its diff', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });
  const task = await manager.createTaskWorktree({
    runId: 'run-commit',
    taskId: 'git-wrapper',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });
  await writeFile(join(task.path, 'shared.txt'), 'base\nchanged\n', 'utf8');
  await writeFile(join(task.path, 'new file.txt'), 'one\ntwo\n', 'utf8');

  const created = await ensureTaskCommit(repository.git, {
    worktreePath: task.path,
    baseSha: repository.baseSha,
    agent: 'codex',
    taskId: 'git-wrapper',
    summary: 'add safe Git operations',
  });
  assert.equal(created.created, true);
  assert.equal(created.clean, true);
  assert.equal(created.commits.length, 1);
  assert.deepEqual(await changedFiles(repository.git, task.path, repository.baseSha), [
    'new file.txt',
    'shared.txt',
  ]);

  const summary = await diffSummary(repository.git, task.path, repository.baseSha);
  assert.equal(summary.filesChanged, 2);
  assert.equal(summary.additions, 3);
  assert.equal(summary.deletions, 0);
  assert.equal(summary.binaryFiles, 0);
  assert.match(summary.stat, /2 files changed/);

  const resumed = await ensureTaskCommit(repository.git, {
    worktreePath: task.path,
    baseSha: repository.baseSha,
    agent: 'codex',
    taskId: 'git-wrapper',
    summary: 'must not create another commit',
  });
  assert.equal(resumed.created, false);
  assert.equal(resumed.commitSha, created.commitSha);
  assert.equal((await inspectTaskCommits(repository.git, task.path, repository.baseSha)).commits.length, 1);
});

test('rejects task commit creation when there is no work', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });
  const task = await manager.createTaskWorktree({
    runId: 'run-empty',
    taskId: 'empty',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });
  await assert.rejects(
    ensureTaskCommit(repository.git, {
      worktreePath: task.path,
      baseSha: repository.baseSha,
      agent: 'codex',
      taskId: 'empty',
      summary: 'nothing',
    }),
    /no commit or changes/,
  );

  const correctionAudit = await ensureTaskCommit(repository.git, {
    worktreePath: task.path,
    baseSha: repository.baseSha,
    agent: 'codex',
    taskId: 'empty',
    summary: 'reject unsupported review findings with evidence',
    allowEmpty: true,
  });
  assert.equal(correctionAudit.created, true);
  assert.deepEqual(correctionAudit.changedFiles, []);
  assert.equal(correctionAudit.commits.length, 1);
});

test('rejects multiple agent commits so integration cannot omit earlier work', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const manager = await WorktreeManager.create({ repositoryPath: repository.repository });
  const task = await manager.createTaskWorktree({
    runId: 'run-multiple',
    taskId: 'multiple',
    baseBranch: repository.baseBranch,
    baseSha: repository.baseSha,
  });
  await writeFile(join(task.path, 'one.txt'), 'one\n', 'utf8');
  await repository.git.run(task.path, ['add', '--', 'one.txt']);
  await repository.git.run(task.path, ['commit', '-m', 'first task fragment']);
  await writeFile(join(task.path, 'two.txt'), 'two\n', 'utf8');
  await repository.git.run(task.path, ['add', '--', 'two.txt']);
  await repository.git.run(task.path, ['commit', '-m', 'second task fragment']);

  await assert.rejects(
    ensureTaskCommit(repository.git, {
      worktreePath: task.path,
      baseSha: repository.baseSha,
      agent: 'codex',
      taskId: 'multiple',
      summary: 'ambiguous task history',
    }),
    /exactly one auditable task commit/,
  );
});

test('computeTrackedDiffFingerprint is stable for identical tracked content and changes when tracked content changes', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  await writeFile(join(repository.repository, 'shared.txt'), 'changed once\n', 'utf8');
  const first = await computeTrackedDiffFingerprint(repository.git, repository.repository, repository.baseSha);
  const firstAgain = await computeTrackedDiffFingerprint(repository.git, repository.repository, repository.baseSha);
  assert.equal(first, firstAgain);

  await writeFile(join(repository.repository, 'shared.txt'), 'changed twice\n', 'utf8');
  const second = await computeTrackedDiffFingerprint(repository.git, repository.repository, repository.baseSha);
  assert.notEqual(first, second);
});

test('computeTrackedDiffFingerprint ignores untracked files', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);
  const before = await computeTrackedDiffFingerprint(repository.git, repository.repository, repository.baseSha);
  await writeFile(join(repository.repository, 'untracked.txt'), 'new untracked file\n', 'utf8');
  const after = await computeTrackedDiffFingerprint(repository.git, repository.repository, repository.baseSha);
  assert.equal(before, after);
});
