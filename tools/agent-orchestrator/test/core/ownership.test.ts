import assert from 'node:assert/strict';
import test from 'node:test';

import { isOrchestratorError } from '../../src/errors';
import {
  assertChangedFileOwnership,
  assertNoParallelOwnershipOverlap,
  matchesOwnershipPattern,
  ownershipGlobsOverlap,
  validateChangedFileOwnership,
} from '../../src/tasks/ownership';
import type { TaskSpec } from '../../src/tasks/task-schema';

function writer(id: string, files: readonly string[], dependsOn: readonly string[] = []): TaskSpec {
  return {
    id,
    title: id,
    owner: 'codex',
    effort: 'high',
    mode: 'implementation',
    files,
    dependsOn,
    writer: true,
  };
}

test('ownership matcher applies segment and globstar semantics', () => {
  assert.equal(matchesOwnershipPattern('apps/api/src/explorer/a.ts', 'apps/api/src/explorer/**'), true);
  assert.equal(matchesOwnershipPattern('apps/api/src/x/a.ts', 'apps/api/src/*.ts'), false);
  assert.equal(ownershipGlobsOverlap('apps/api/**', 'apps/api/src/explorer/**'), true);
  assert.equal(ownershipGlobsOverlap('apps/api/*.ts', 'apps/api/nested/*.ts'), false);
  assert.equal(ownershipGlobsOverlap('apps/api/*.ts', 'apps/api/*.md'), false);
});

test('parallel writer overlaps are rejected but dependent correction overlap is allowed', () => {
  assert.throws(
    () =>
      assertNoParallelOwnershipOverlap([
        writer('one', ['apps/api/**']),
        writer('two', ['apps/api/src/explorer/**']),
      ]),
    (error: unknown) => isOrchestratorError(error, 'OWNERSHIP_OVERLAP'),
  );

  assert.doesNotThrow(() =>
    assertNoParallelOwnershipOverlap([
      writer('one', ['apps/api/src/explorer/**']),
      writer('correction', ['apps/api/src/explorer/**'], ['one']),
    ]),
  );
});

test('changed files outside declared ownership are reported and rejected', () => {
  const result = validateChangedFileOwnership(
    ['apps/api/src/explorer/a.ts', 'apps/api/src/app.module.ts'],
    ['apps/api/src/explorer/**'],
  );
  assert.deepEqual(result.violations, ['apps/api/src/app.module.ts']);
  assert.throws(
    () => assertChangedFileOwnership('query', result.changedFiles, ['apps/api/src/explorer/**']),
    (error: unknown) => isOrchestratorError(error, 'OWNERSHIP_VIOLATION'),
  );
  assert.throws(
    () => validateChangedFileOwnership(['../outside'], ['apps/**']),
    (error: unknown) => isOrchestratorError(error, 'OWNERSHIP_VIOLATION'),
  );
});
