import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isOrchestratorError } from '../../src/errors';
import { resolveAgentExecutable } from '../../src/agents/executable-resolution';

async function writeExecutable(path: string, contents = '#!/bin/sh\nexit 0\n'): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, contents);
  await chmod(path, 0o700);
}

async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix));
}

test('CODEX_EXECUTABLE override is used when set and executable', async () => {
  const directory = await tempDir('sv-exe-override-');
  const executable = join(directory, 'my-codex');
  await writeExecutable(executable);
  const resolution = await resolveAgentExecutable('codex', {
    CODEX_EXECUTABLE: executable,
    PATH: '',
  });
  assert.deepEqual(resolution, { path: executable, source: 'override' });
});

test('CLAUDE_EXECUTABLE override is used when set and executable', async () => {
  const directory = await tempDir('sv-exe-override-');
  const executable = join(directory, 'my-claude');
  await writeExecutable(executable);
  const resolution = await resolveAgentExecutable('claude', {
    CLAUDE_EXECUTABLE: executable,
    PATH: '',
  });
  assert.deepEqual(resolution, { path: executable, source: 'override' });
});

test('an invalid override fails loudly rather than silently falling back to PATH', async () => {
  const directory = await tempDir('sv-exe-fallback-');
  const onPath = join(directory, 'codex');
  await writeExecutable(onPath);
  await assert.rejects(
    resolveAgentExecutable('codex', {
      CODEX_EXECUTABLE: '/definitely/not/a/real/path/codex',
      PATH: directory,
    }),
    (error: unknown) => {
      assert.ok(isOrchestratorError(error, 'AGENT_NOT_FOUND'));
      return true;
    },
  );
});

test('a non-executable override candidate is rejected, not silently accepted', async () => {
  const directory = await tempDir('sv-exe-nonexec-');
  const notExecutable = join(directory, 'codex');
  await writeFile(notExecutable, '#!/bin/sh\nexit 0\n');
  await chmod(notExecutable, 0o600); // no execute bit
  await assert.rejects(
    resolveAgentExecutable('codex', { CODEX_EXECUTABLE: notExecutable, PATH: '' }),
    (error: unknown) => isOrchestratorError(error, 'AGENT_NOT_FOUND'),
  );
});

test('falls back to PATH when no override is set', async () => {
  const directory = await tempDir('sv-exe-path-');
  const executable = join(directory, 'claude');
  await writeExecutable(executable);
  const resolution = await resolveAgentExecutable('claude', { PATH: directory });
  assert.deepEqual(resolution, { path: executable, source: 'path' });
});

test('an empty-string override is treated as unset, not as an invalid path', async () => {
  const directory = await tempDir('sv-exe-empty-override-');
  const executable = join(directory, 'codex');
  await writeExecutable(executable);
  const resolution = await resolveAgentExecutable('codex', { CODEX_EXECUTABLE: '  ', PATH: directory });
  assert.deepEqual(resolution, { path: executable, source: 'path' });
});

test('resolves an executable whose containing directory has spaces', async () => {
  const directory = await tempDir('sv exe spaces ');
  const executable = join(directory, 'codex');
  await writeExecutable(executable);
  const resolution = await resolveAgentExecutable('codex', { PATH: directory });
  assert.deepEqual(resolution, { path: executable, source: 'path' });
});

test('reports null (not an error) when nothing is found anywhere', async () => {
  const resolution = await resolveAgentExecutable('claude', { PATH: '' });
  assert.equal(resolution, null);
});

test('VS Code extension fallback: single candidate is discovered when PATH has nothing', async () => {
  if (process.platform !== 'darwin') return; // discovery is macOS-only by design; skip elsewhere
  const home = await tempDir('sv-exe-vscode-home-');
  const platformDir = process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x64';
  const binPath = join(home, '.vscode', 'extensions', 'openai.chatgpt-0.9.0', 'bin', platformDir, 'codex');
  await writeExecutable(binPath);
  const resolution = await resolveAgentExecutable('codex', { HOME: home, PATH: '' });
  assert.deepEqual(resolution, { path: binPath, source: 'vscode-extension' });
});

test('VS Code extension fallback: prefers the most recently modified of multiple versions', async () => {
  if (process.platform !== 'darwin') return;
  const home = await tempDir('sv-exe-vscode-multi-');
  const platformDir = process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x64';
  const older = join(home, '.vscode', 'extensions', 'openai.chatgpt-0.9.0', 'bin', platformDir, 'codex');
  const newer = join(home, '.vscode', 'extensions', 'openai.chatgpt-0.10.0', 'bin', platformDir, 'codex');
  await writeExecutable(older);
  await new Promise((resolve) => setTimeout(resolve, 20)); // ensure a distinct, later mtime
  await writeExecutable(newer);
  const resolution = await resolveAgentExecutable('codex', { HOME: home, PATH: '' });
  assert.equal(resolution?.path, newer);
  assert.equal(resolution?.source, 'vscode-extension');
});

test('VS Code extension fallback: none found is null, not an error', async () => {
  if (process.platform !== 'darwin') return;
  const home = await tempDir('sv-exe-vscode-none-');
  await mkdir(join(home, '.vscode', 'extensions'), { recursive: true });
  const resolution = await resolveAgentExecutable('codex', { HOME: home, PATH: '' });
  assert.equal(resolution, null);
});

test('VS Code extension fallback: a malformed (non-executable) candidate is skipped, not accepted', async () => {
  if (process.platform !== 'darwin') return;
  const home = await tempDir('sv-exe-vscode-malformed-');
  const platformDir = process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x64';
  const badPath = join(home, '.vscode', 'extensions', 'openai.chatgpt-0.9.0', 'bin', platformDir, 'codex');
  await mkdir(join(badPath, '..'), { recursive: true });
  await writeFile(badPath, 'not actually executable');
  await chmod(badPath, 0o600);
  const resolution = await resolveAgentExecutable('codex', { HOME: home, PATH: '' });
  assert.equal(resolution, null);
});

test('VS Code extension fallback never applies to claude (codex-only)', async () => {
  if (process.platform !== 'darwin') return;
  const home = await tempDir('sv-exe-vscode-claude-');
  const platformDir = process.arch === 'arm64' ? 'macos-aarch64' : 'macos-x64';
  // Even a plausibly-named claude binary under the codex extension family
  // must not resolve — the fallback is scoped to codex only.
  const stray = join(home, '.vscode', 'extensions', 'openai.chatgpt-0.9.0', 'bin', platformDir, 'claude');
  await writeExecutable(stray);
  const resolution = await resolveAgentExecutable('claude', { HOME: home, PATH: '' });
  assert.equal(resolution, null);
});
