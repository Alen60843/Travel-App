import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { findExecutable } from '../src/executable';

test('findExecutable finds executable files without invoking them', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tripwith-executable-'));
  const executable = join(directory, 'fake-agent');
  await writeFile(executable, '#!/bin/sh\nexit 0\n');
  await chmod(executable, 0o700);
  assert.equal(await findExecutable('fake-agent', { PATH: directory }), executable);
});

test('findExecutable reports a missing agent', async () => {
  assert.equal(await findExecutable('not-present', { PATH: '' }), null);
});
