import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import { isOrchestratorError } from '../../src/errors';
import { assertBaseBranchUnmoved, resolveBaseSha } from '../../src/git/git';
import { createTemporaryRepository, type TemporaryRepository } from './helpers';

const repositories: TemporaryRepository[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map((repository) => repository.dispose()));
});

test('resolves the exact local base branch commit and detects later movement', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);

  assert.equal(
    await resolveBaseSha(repository.git, repository.repository, repository.baseBranch),
    repository.baseSha,
  );
  await assertBaseBranchUnmoved(
    repository.git,
    repository.repository,
    repository.baseBranch,
    repository.baseSha,
  );

  await writeFile(join(repository.repository, 'base-moved.txt'), 'later\n', 'utf8');
  await repository.git.run(repository.repository, ['add', '--', 'base-moved.txt']);
  await repository.git.run(repository.repository, ['commit', '-m', 'move base']);

  await assert.rejects(
    assertBaseBranchUnmoved(
      repository.git,
      repository.repository,
      repository.baseBranch,
      repository.baseSha,
    ),
    (error: unknown) => {
      assert.ok(isOrchestratorError(error, 'BASE_BRANCH_MOVED'));
      assert.equal(error.details.expectedBaseSha, repository.baseSha);
      assert.equal(error.details.baseBranch, repository.baseBranch);
      return true;
    },
  );
});

test('Git process boundary rejects relative cwd and option-like revisions', async () => {
  const repository = await createTemporaryRepository();
  repositories.push(repository);

  await assert.rejects(repository.git.run('.', ['status']), /absolute path/);
  await assert.rejects(repository.git.resolveCommit(repository.repository, '--upload-pack=bad'), /revision/);
});
