import assert from 'node:assert/strict';
import { access, mkdir, mkdtemp, readFile, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { IntegrationGate, canReuseIntegrationPreparation, parseCommand } from '../../src/integration/integration-gate';

test('parses quoted arguments without invoking a shell', () => {
  assert.deepEqual(parseCommand(`node -e "console.log('safe value')"`), [
    'node',
    '-e',
    "console.log('safe value')",
  ]);
  assert.throws(() => parseCommand('echo ok; touch nope'), /Unsafe/);
  assert.throws(() => parseCommand('echo $(whoami)'), /Unsafe/);
});

test('stops after a required command failure and captures evidence', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tripwith-integration-gate-'));
  const result = await new IntegrationGate().run({
    cwd: directory,
    logsDirectory: join(directory, 'logs'),
    commands: [
      `node -e "process.stdout.write('first')"`,
      `node -e "process.stderr.write('failed'); process.exit(3)"`,
      `node -e "process.stdout.write('must-not-run')"`,
    ],
  });
  assert.equal(result.passed, false);
  assert.equal(result.commands.length, 2);
  assert.equal(result.commands[1]?.exitCode, 3);
  assert.equal(await readFile(result.commands[0]!.stdoutPath, 'utf8'), 'first');
  assert.equal(await readFile(result.commands[1]!.stderrPath, 'utf8'), 'failed');
});

test('runs non-blocking diagnostics after required commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tripwith-integration-diagnostic-'));
  const result = await new IntegrationGate().run({
    cwd: directory,
    logsDirectory: join(directory, 'logs'),
    commands: [`node -e "process.exit(0)"`],
    diagnostics: [`node -e "process.exit(7)"`],
  });
  assert.equal(result.passed, true);
  assert.equal(result.commands[1]?.required, false);
  assert.equal(result.commands[1]?.exitCode, 7);
});

test('redacts secret URL values from integration logs', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tripwith-integration-redaction-'));
  const variable = 'ORCHESTRATOR_TEST_DATABASE_URL';
  const previous = process.env[variable];
  const secret = 'postgresql://user:do-not-log@localhost/private';
  process.env[variable] = secret;
  try {
    const result = await new IntegrationGate().run({
      cwd: directory,
      logsDirectory: join(directory, 'logs'),
      commands: [`node -e "process.stdout.write(process.env.${variable})"`],
    });
    const stdout = await readFile(result.commands[0]!.stdoutPath, 'utf8');
    assert.equal(stdout.includes(secret), false);
    assert.match(stdout, /\[REDACTED\]/);
  } finally {
    if (previous === undefined) delete process.env[variable];
    else process.env[variable] = previous;
  }
});

test('refuses a pre-existing integration-log symlink', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tripwith-integration-symlink-'));
  const logs = join(directory, 'logs');
  const victim = join(directory, 'victim.txt');
  await mkdir(logs);
  await writeFile(victim, 'preserve');
  await symlink(victim, join(logs, '01-node.stdout.log'));

  await assert.rejects(
    new IntegrationGate().run({
      cwd: directory,
      logsDirectory: logs,
      commands: [`node -e "process.stdout.write('replace')"`],
    }),
    /symbolic link|ELOOP/i,
  );
  assert.equal(await readFile(victim, 'utf8'), 'preserve');
});

test('enforces a per-command timeout, preserves output, and stops later required commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tripwith-integration-timeout-'));
  const result = await new IntegrationGate().run({
    cwd: directory,
    logsDirectory: join(directory, 'logs'),
    defaultTimeoutMs: 5_000,
    terminationGraceMs: 100,
    commands: [
      {
        command: `node -e "process.stdout.write('before-timeout'); process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"`,
        timeoutMs: 100,
      },
      `node -e "process.stdout.write('must-not-run')"`,
    ],
  });

  assert.equal(result.passed, false);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0]?.timedOut, true);
  assert.equal(result.commands[0]?.termination, 'timeout');
  assert.equal(result.commands[0]?.timeoutMs, 100);
  assert.equal(await readFile(result.commands[0]!.stdoutPath, 'utf8'), 'before-timeout');
});

test(
  'timeout terminates the spawned process group so descendants cannot outlive the gate',
  { skip: process.platform === 'win32' ? 'POSIX process groups are not available' : false },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tripwith-integration-process-group-'));
    const childScript = join(directory, 'child.js');
    const parentScript = join(directory, 'parent.js');
    const orphanMarker = join(directory, 'orphan-marker');
    await writeFile(
      childScript,
      `const fs=require('node:fs');setTimeout(()=>fs.writeFileSync(${JSON.stringify(orphanMarker)},'orphan'),700);setInterval(()=>{},1000);`,
      'utf8',
    );
    await writeFile(
      parentScript,
      `const {spawn}=require('node:child_process');spawn(process.execPath,[${JSON.stringify(childScript)}],{stdio:'ignore'});process.stdout.write('spawned');process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`,
      'utf8',
    );

    const result = await new IntegrationGate().run({
      cwd: directory,
      logsDirectory: join(directory, 'logs'),
      commands: [{ command: `node ${parentScript}`, timeoutMs: 100 }],
      terminationGraceMs: 100,
    });
    assert.equal(result.commands[0]?.timedOut, true);
    assert.equal(await readFile(result.commands[0]!.stdoutPath, 'utf8'), 'spawned');
    await new Promise((resolve) => setTimeout(resolve, 850));
    await assert.rejects(access(orphanMarker));
  },
);

test('rejects unbounded or invalid timeout configuration before running commands', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tripwith-integration-invalid-timeout-'));
  await assert.rejects(
    new IntegrationGate().run({
      cwd: directory,
      logsDirectory: join(directory, 'logs'),
      commands: [{ command: 'node --version', timeoutMs: Number.MAX_SAFE_INTEGER }],
    }),
    /timeoutMs must be an integer/,
  );
});

test('preparation reuse is bound to the exact successful worktree and integration head', () => {
  const preparation = { status: 'SUCCEEDED', worktreePath: '/worktree/one', headSha: 'a'.repeat(40) };
  assert.equal(canReuseIntegrationPreparation(preparation, '/worktree/one', 'a'.repeat(40), 1), true);
  assert.equal(canReuseIntegrationPreparation(preparation, '/worktree/recreated', 'a'.repeat(40), 1), false);
  assert.equal(canReuseIntegrationPreparation(preparation, '/worktree/one', 'b'.repeat(40), 1), false);
  assert.equal(canReuseIntegrationPreparation(undefined, '/worktree/recreated', 'a'.repeat(40), 0), true);
});
