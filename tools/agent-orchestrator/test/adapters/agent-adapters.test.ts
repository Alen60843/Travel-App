import assert from 'node:assert/strict';
import {
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, test } from 'node:test';

import {
  ClaudeAgent,
  CodexAgent,
  type AgentRequest,
  sanitizeText,
} from '../../src/agents';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((path) =>
      rm(path, { recursive: true, force: true }),
    ),
  );
});

test('Codex adapter runs in the assigned cwd, sends the prompt over stdin, and projects a handoff', async () => {
  const fixture = await createFixture();
  const marker = join(fixture.root, 'shell-interpolation-must-not-exist');
  const taskText = `Implement only the assigned files; $(touch ${marker}); semi;colon`;
  const request = makeRequest(fixture, {
    taskSpecification: taskText,
    requestedEffort: 'extra_high',
  });
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
  });

  const result = await agent.run(request);

  assert.equal(result.status, 'succeeded');
  assert.equal(result.exitCode, 0);
  assert.equal(result.failureCode, null);
  assert.deepEqual(result.changedFiles, ['apps/api/src/explorer/query.ts']);
  assert.deepEqual(result.testsReported, [
    { command: 'pnpm test', result: 'pass', details: 'all green' },
  ]);
  assert.deepEqual(result.unresolvedQuestions, []);
  assert.deepEqual(result.structuredHandoff, successfulHandoff());
  assert.equal(await pathExists(marker), false, 'prompt content was not interpreted by a shell');

  const record = await readRecord(fixture.recordPath);
  assert.equal(record.cwd, await realpath(fixture.worktree));
  assert.ok(record.args.includes('exec'));
  assert.ok(record.args.includes('--ephemeral'));
  assert.deepEqual(argumentValue(record.args, '-C'), fixture.worktree);
  assert.deepEqual(argumentValue(record.args, '-s'), 'workspace-write');
  assert.deepEqual(argumentValue(record.args, '-a'), 'never');
  assert.equal(record.args.includes(taskText), false, 'the prompt must not appear in argv');
  assert.match(record.stdin, /Allowed file ownership/);
  assert.match(record.stdin, /Never modify a path outside/);
  assert.match(record.stdin, /shell-interpolation-must-not-exist/);
  assert.equal((await stat(result.stdoutPath)).mode & 0o777, 0o600);
  assert.equal((await stat(result.stderrPath)).mode & 0o777, 0o600);
});

test('Codex review requests use the installed CLI read-only sandbox contract', async () => {
  const fixture = await createFixture();
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
  });

  const result = await agent.run(
    makeRequest(fixture, { role: 'review', access: 'read_only' }),
  );

  assert.equal(result.status, 'succeeded');
  const record = await readRecord(fixture.recordPath);
  assert.equal(argumentValue(record.args, '-s'), 'read-only');
  assert.match(record.stdin, /This is a read-only task/);
});

test('Claude adapter uses non-interactive safe mode, maps extra_high to xhigh, and restricts reviewer tools', async () => {
  const fixture = await createFixture();
  const request = makeRequest(fixture, {
    role: 'final_review',
    access: 'read_only',
    requestedEffort: 'extra_high',
  });
  const agent = new ClaudeAgent({
    executable: fixture.executable,
    environment: fixture.environment,
  });

  const result = await agent.run(request);

  assert.equal(result.status, 'succeeded');
  const record = await readRecord(fixture.recordPath);
  assert.equal(record.cwd, await realpath(fixture.worktree));
  assert.ok(record.args.includes('-p'));
  assert.ok(record.args.includes('--safe-mode'));
  assert.ok(record.args.includes('--no-session-persistence'));
  assert.equal(argumentValue(record.args, '--output-format'), 'text');
  assert.equal(argumentValue(record.args, '--effort'), 'xhigh');
  assert.equal(argumentValue(record.args, '--permission-mode'), 'plan');
  assert.equal(argumentValue(record.args, '--tools'), 'Read,Glob,Grep');
  assert.equal(record.args.some((arg) => arg.includes('Review the change')), false);
  assert.match(record.stdin, /final_review/);
});

test('Claude writer requests use acceptEdits without bypassing permissions', async () => {
  const fixture = await createFixture();
  const agent = new ClaudeAgent({
    executable: fixture.executable,
    environment: fixture.environment,
  });

  await agent.run(makeRequest(fixture, { role: 'implementation' }));

  const record = await readRecord(fixture.recordPath);
  assert.equal(argumentValue(record.args, '--permission-mode'), 'acceptEdits');
  assert.equal(argumentValue(record.args, '--tools'), 'default');
  assert.equal(record.args.includes('--dangerously-skip-permissions'), false);
});

test('adapter preserves a non-zero process exit status and output references', async () => {
  const fixture = await createFixture('failure');
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
  });

  const result = await agent.run(makeRequest(fixture));

  assert.equal(result.status, 'failed');
  assert.equal(result.failureCode, 'AGENT_FAILED');
  assert.equal(result.exitCode, 7);
  assert.equal(result.signal, null);
  assert.match(await readFile(result.stderrPath, 'utf8'), /intentional failure/);
});

test('adapter does not normalize fenced prose into a structured handoff', async () => {
  const fixture = await createFixture('fenced');
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
  });

  const result = await agent.run(makeRequest(fixture));

  assert.equal(result.status, 'succeeded');
  assert.equal(result.structuredHandoff, null);
});

test('missing executable is classified without throwing', async () => {
  const fixture = await createFixture();
  const agent = new CodexAgent({
    executable: join(fixture.root, 'definitely-does-not-exist'),
    environment: fixture.environment,
  });

  const result = await agent.run(makeRequest(fixture));

  assert.equal(result.status, 'not_found');
  assert.equal(result.failureCode, 'AGENT_NOT_FOUND');
  assert.equal(result.exitCode, -2);
  assert.match(result.errorMessage ?? '', /ENOENT|spawn/i);
});

test('timeout first requests graceful termination and then force-kills an uncooperative process group', async () => {
  const fixture = await createFixture('hang');
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
    terminationGraceMs: 40,
  });

  const result = await agent.run(makeRequest(fixture, { timeoutMs: 250 }));

  assert.equal(result.status, 'timed_out');
  assert.equal(result.failureCode, 'AGENT_TIMEOUT');
  assert.equal(result.timedOut, true);
  assert.equal(result.aborted, false);
  assert.ok(result.durationMs < 2_000);
  assert.equal(result.signal, 'SIGKILL');
});

test('AbortSignal terminates a running agent distinctly from timeout', async () => {
  const fixture = await createFixture('hang');
  const controller = new AbortController();
  const agent = new ClaudeAgent({
    executable: fixture.executable,
    environment: fixture.environment,
    terminationGraceMs: 40,
  });
  setTimeout(() => controller.abort(), 250);

  const result = await agent.run(
    makeRequest(fixture, { abortSignal: controller.signal, timeoutMs: 5_000 }),
  );

  assert.equal(result.status, 'aborted');
  assert.equal(result.failureCode, 'AGENT_ABORTED');
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.durationMs < 2_000);
});

test('abort is not lost while onStarted persists the child PID', async () => {
  const fixture = await createFixture('hang');
  const controller = new AbortController();
  let startedPid: number | undefined;
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
    terminationGraceMs: 40,
  });

  const result = await agent.run(
    makeRequest(fixture, {
      abortSignal: controller.signal,
      onStarted: async (pid) => {
        startedPid = pid;
        controller.abort();
        await new Promise((resolve) => setTimeout(resolve, 30));
      },
    }),
  );

  assert.ok(startedPid !== undefined && startedPid > 0);
  assert.equal(result.status, 'aborted');
  assert.equal(result.failureCode, 'AGENT_ABORTED');
  assert.equal(result.aborted, true);
});

test('agent timeout remains bounded when onStarted never settles', async () => {
  const fixture = await createFixture('hang');
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
    terminationGraceMs: 40,
  });

  const result = await agent.run(
    makeRequest(fixture, {
      timeoutMs: 100,
      onStarted: () => new Promise<void>(() => undefined),
    }),
  );

  assert.equal(result.status, 'timed_out');
  assert.equal(result.failureCode, 'AGENT_TIMEOUT');
  assert.ok(result.durationMs < 2_000);
});

test('timeout removes same-process-group descendants after a graceful leader exit', async () => {
  const fixture = await createFixture('orphan-child');
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
    terminationGraceMs: 100,
  });

  const result = await agent.run(makeRequest(fixture, { timeoutMs: 500 }));
  const descendantPid = Number(await readFile(fixture.childPidPath, 'utf8'));
  try {
    assert.equal(result.status, 'timed_out');
    assert.ok(Number.isSafeInteger(descendantPid) && descendantPid > 0);
    assert.equal(
      await waitForProcessDeath(descendantPid, 1_000),
      true,
      'the adapter returned while an agent descendant was still alive',
    );
  } finally {
    if (isProcessAlive(descendantPid)) {
      process.kill(descendantPid, 'SIGKILL');
    }
  }
});

test('already-aborted requests do not launch an executable', async () => {
  const fixture = await createFixture();
  const controller = new AbortController();
  controller.abort();
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
  });

  const result = await agent.run(
    makeRequest(fixture, { abortSignal: controller.signal }),
  );

  assert.equal(result.status, 'aborted');
  assert.equal(await pathExists(fixture.recordPath), false);
});

test('captured stdout and stderr redact environment secrets and common credential forms', async () => {
  const fixture = await createFixture('secrets');
  const secret = 'adapter-test-secret-value-12345';
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: {
      ...fixture.environment,
      TEST_AGENT_API_TOKEN: secret,
    },
  });

  const result = await agent.run(makeRequest(fixture));
  const stdout = await readFile(result.stdoutPath, 'utf8');
  const stderr = await readFile(result.stderrPath, 'utf8');

  assert.equal(result.status, 'succeeded');
  assert.doesNotMatch(stdout, new RegExp(secret));
  assert.doesNotMatch(stdout, /eyJhbGciOi/);
  assert.doesNotMatch(stdout, /PRIVATE KEY-----\nsecret-material/);
  assert.doesNotMatch(stderr, /hunter2/);
  assert.match(stdout, /\[REDACTED\]/);
  assert.match(stdout, /\[REDACTED PRIVATE KEY\]/);
  assert.match(stderr, /\[REDACTED\]/);
});

test('onStarted failures are sanitized and kill the just-spawned process', async () => {
  const fixture = await createFixture('hang');
  const secret = 'state-store-secret-987654';
  let pid: number | undefined;
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: { ...fixture.environment, STATE_STORE_TOKEN: secret },
  });

  const result = await agent.run(
    makeRequest(fixture, {
      onStarted: (startedPid) => {
        pid = startedPid;
        throw new Error(`state persistence failed: ${secret}`);
      },
    }),
  );

  assert.equal(result.status, 'spawn_error');
  assert.equal(result.failureCode, 'AGENT_SPAWN_ERROR');
  assert.doesNotMatch(result.errorMessage ?? '', new RegExp(secret));
  assert.match(result.errorMessage ?? '', /\[REDACTED\]/);
  assert.ok(pid !== undefined);
  assert.equal(isProcessAlive(pid), false);
});

test('log creation refuses a pre-existing symlink instead of truncating its target', async () => {
  const fixture = await createFixture();
  const victim = join(fixture.root, 'victim.txt');
  await mkdir(fixture.artifacts, { recursive: true });
  await writeFile(victim, 'must remain intact');
  await symlink(
    victim,
    join(fixture.artifacts, 'run-001.explorer-query.codex.attempt-1.stdout.log'),
  );
  const agent = new CodexAgent({
    executable: fixture.executable,
    environment: fixture.environment,
  });

  await assert.rejects(agent.run(makeRequest(fixture)), /symbolic link|ELOOP/i);
  assert.equal(await readFile(victim, 'utf8'), 'must remain intact');
  assert.equal(await pathExists(fixture.recordPath), false);
});

test('sanitizer handles direct values and common authorization text', () => {
  const result = sanitizeText(
    'TOKEN=s3cr3t Bearer abc.def.ghi client_secret="value"',
    ['s3cr3t'],
  );

  assert.equal(result.includes('s3cr3t'), false);
  assert.equal(result.includes('abc.def.ghi'), false);
  assert.equal(result.includes('value'), false);
});

interface Fixture {
  readonly root: string;
  readonly worktree: string;
  readonly artifacts: string;
  readonly executable: string;
  readonly recordPath: string;
  readonly childPidPath: string;
  readonly environment: NodeJS.ProcessEnv;
}

interface InvocationRecord {
  readonly args: readonly string[];
  readonly cwd: string;
  readonly stdin: string;
}

async function createFixture(mode = 'success'): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'tripwith-agent-adapter-'));
  temporaryDirectories.push(root);
  const worktree = join(root, 'assigned worktree');
  const artifacts = join(root, 'artifacts');
  const executable = join(root, 'fake agent cli.js');
  const recordPath = join(root, 'invocation.json');
  const childPidPath = join(root, 'descendant.pid');
  await mkdir(worktree, { recursive: true });
  await writeFile(executable, fakeExecutableSource(), { mode: 0o700 });
  await chmod(executable, 0o700);
  return {
    root,
    worktree,
    artifacts,
    executable,
    recordPath,
    childPidPath,
    environment: {
      ...process.env,
      FAKE_AGENT_MODE: mode,
      FAKE_AGENT_RECORD: recordPath,
      FAKE_AGENT_CHILD_PID: childPidPath,
    },
  };
}

function makeRequest(
  fixture: Fixture,
  overrides: Partial<AgentRequest> = {},
): AgentRequest {
  return {
    runId: 'run-001',
    taskId: 'explorer-query',
    role: 'implementation',
    worktreePath: fixture.worktree,
    baseSha: '1234567890abcdef1234567890abcdef12345678',
    taskSpecification: 'Review the change and implement the bounded task.',
    canonicalDesignDocumentPath: 'docs/superpowers/specs/design.md',
    allowedFileOwnership: ['apps/api/src/explorer/**'],
    dependencyHandoffs: [],
    previousReviewFindings: [],
    requestedEffort: 'high',
    timeoutMs: 5_000,
    artifactsDirectory: fixture.artifacts,
    ...overrides,
  };
}

function successfulHandoff(): Record<string, unknown> {
  return {
    status: 'complete',
    summary: 'fake success',
    filesChanged: ['apps/api/src/explorer/query.ts'],
    decisions: [],
    tests: [{ command: 'pnpm test', result: 'pass', details: 'all green' }],
    openQuestions: [],
    reviewRequested: [],
  };
}

function fakeExecutableSource(): string {
  const handoff = JSON.stringify(successfulHandoff());
  return `#!/usr/bin/env node
'use strict';
const fs = require('node:fs');
let stdin = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdin += chunk; });
process.stdin.on('end', () => {
  fs.writeFileSync(process.env.FAKE_AGENT_RECORD, JSON.stringify({
    args: process.argv.slice(2),
    cwd: process.cwd(),
    stdin,
  }));
  const mode = process.env.FAKE_AGENT_MODE;
  if (mode === 'failure') {
    process.stderr.write('intentional failure\\n');
    process.exit(7);
  }
  if (mode === 'hang') {
    process.on('SIGTERM', () => {});
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'orphan-child') {
    const { spawn } = require('node:child_process');
    const descendant = spawn(process.execPath, ['-e',
      "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);"
    ], { stdio: 'ignore' });
    fs.writeFileSync(process.env.FAKE_AGENT_CHILD_PID, String(descendant.pid));
    process.on('SIGTERM', () => process.exit(0));
    setInterval(() => {}, 1000);
    return;
  }
  if (mode === 'secrets') {
    process.stdout.write(process.env.TEST_AGENT_API_TOKEN + '\\n');
    process.stdout.write('Authorization: Bearer eyJhbGciOi.fake.signature\\n');
    process.stdout.write('-----BEGIN PRIVATE KEY-----\\nsecret-material\\n-----END PRIVATE KEY-----\\n');
    process.stderr.write('password=hunter2\\n');
    return;
  }
  if (mode === 'fenced') {
    const fence = String.fromCharCode(96, 96, 96);
    process.stdout.write(fence + 'json\\n' + ${JSON.stringify(handoff)} + '\\n' + fence + '\\n');
    return;
  }
  process.stdout.write(${JSON.stringify(handoff)} + '\\n');
});
`;
}

async function readRecord(path: string): Promise<InvocationRecord> {
  return JSON.parse(await readFile(path, 'utf8')) as InvocationRecord;
}

function argumentValue(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    throw error;
  }
}

async function waitForProcessDeath(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return !isProcessAlive(pid);
}
