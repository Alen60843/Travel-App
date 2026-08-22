import assert from 'node:assert/strict';
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { AgentOrchestrator, planPhase } from '../../src/orchestrator';
import { createTemporaryRepository } from '../git/helpers';

/**
 * §13, proven empirically rather than by code inspection: a task whose owner
 * is NOT injected (a real `ClaudeAgent`/`CodexAgent` gets constructed) must
 * actually spawn the SAME executable `planPhase` resolved and reported. If
 * `AgentOrchestrator.start()` silently fell back to the bare command name
 * `claude` (as it did before this correction pass), this test's fake
 * executable — reachable ONLY via CLAUDE_EXECUTABLE, deliberately absent from
 * PATH — would never run, and the task would fail with AGENT_NOT_FOUND
 * instead of succeeding.
 *
 * `resolveAgentExecutable`/`planPhase` read `process.env` directly (their
 * `environment` parameter defaults to it), so this test scopes real env var
 * mutation to its own try/finally rather than passing a local object nobody
 * would consult.
 */
test('a real (non-injected) agent spawns the exact executable planPhase resolved', async () => {
  const scriptsDir = await mkdtemp(join(tmpdir(), 'sv-plan-runtime-'));
  const fakeClaude = join(scriptsDir, 'fake-claude');
  // Ignores every CLI flag ClaudeAgent passes; consumes the piped prompt from
  // stdin (as the real CLI would) and returns one valid, minimal REVIEW
  // (this test's task is `mode: review`, which is validated against the
  // review schema — {status, findings} — not the handoff schema).
  await writeFile(
    fakeClaude,
    [
      '#!/bin/sh',
      'cat > /dev/null',
      "cat <<'JSON'",
      '{"status":"approved","findings":[]}',
      'JSON',
      'exit 0',
      '',
    ].join('\n'),
  );
  await chmod(fakeClaude, 0o700);

  const fixture = await createTemporaryRepository();
  const previousOverride = process.env.CLAUDE_EXECUTABLE;
  const previousPath = process.env.PATH;
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);

    const phaseFile = join(fixture.container, 'phase.yaml');
    await writeFile(
      phaseFile,
      `
phase: plan-runtime-agreement
name: Plan/runtime agreement check
baseBranch: ${fixture.baseBranch}
canonicalDesignDocument: design.md
concurrency: 1
tasks:
  - id: standalone-review
    title: Standalone read-only review
    owner: claude
    mode: review
    effort: high
    files: []
`,
      'utf8',
    );

    // PATH deliberately does not contain a real `claude` at all — the ONLY
    // way this task can succeed is via CLAUDE_EXECUTABLE actually being
    // threaded through to the runtime adapter's spawn call.
    process.env.CLAUDE_EXECUTABLE = fakeClaude;
    process.env.PATH = '/usr/bin:/bin';

    const plan = await planPhase(phaseFile, { repositoryPath: fixture.repository });
    assert.equal(plan.agentExecutables.claude, fakeClaude);
    assert.equal(plan.agentExecutableSources.claude, 'override');
    assert.equal(plan.resolvedAgentExecutables.claude, fakeClaude);

    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      // No `agents` override: this is the real ClaudeAgent, constructed from
      // whatever AgentOrchestrator.start() actually threads through.
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks['standalone-review']?.status, 'SUCCEEDED');

    // §13's other half: resume must use the SAME persisted path, not
    // re-resolve. Prove it by changing the override to something invalid and
    // confirming resume still succeeds, using the path persisted at start().
    process.env.CLAUDE_EXECUTABLE = '/definitely/not/a/real/path';
    const resumed = await AgentOrchestrator.resume(orchestrator.snapshot().runId, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
    });
    assert.equal(resumed.snapshot().status, 'COMPLETED');
  } finally {
    if (previousOverride === undefined) delete process.env.CLAUDE_EXECUTABLE;
    else process.env.CLAUDE_EXECUTABLE = previousOverride;
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await fixture.dispose();
  }
});
