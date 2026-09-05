import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import { CodexAgent, type AgentRequest } from '../../src/agents';
import { resolveAgentExecutable } from '../../src/agents/executable-resolution';

/**
 * Exposes the protected `buildInvocation()` CodexAgent already implements, so
 * these tests exercise the exact production argv construction rather than a
 * hand-copied duplicate that could silently drift from it.
 */
class ExposedCodexAgent extends CodexAgent {
  buildArgs(request: AgentRequest): readonly string[] {
    return this.buildInvocation(request).args;
  }
}

function makeRequest(overrides: Partial<AgentRequest> = {}): AgentRequest {
  return {
    runId: 'run-cli-check',
    taskId: 'invocation-check',
    role: 'implementation',
    worktreePath: '/tmp/does-not-need-to-exist-for-argv-construction',
    baseSha: '1234567890abcdef1234567890abcdef12345678',
    taskSpecification: 'n/a — argv construction only',
    canonicalDesignDocumentPath: 'docs/superpowers/specs/design.md',
    allowedFileOwnership: [],
    dependencyHandoffs: [],
    previousReviewFindings: [],
    requestedEffort: 'high',
    timeoutMs: 5_000,
    artifactsDirectory: '/tmp/does-not-need-to-exist-for-argv-construction',
    ...overrides,
  };
}

/**
 * Real Codex `-a, --ask-for-approval` is a TOP-LEVEL option only — confirmed
 * absent from `codex exec --help`'s own option list (verified against
 * codex-cli 0.149.0-alpha.4.1). `exec` therefore cannot express "never ask
 * for approval" itself; the only valid way is `codex -a never exec ...`,
 * which is why `-C`/`-s`/`-a` are built before the `exec` keyword while
 * `-m`/`--ephemeral`/`--color` (all genuinely exec-scoped too) are built
 * after it. This is a hard CLI constraint, not an arbitrary style choice.
 */
test('CodexAgent builds the canonical argv: -C/-s/-a before exec (required — exec has no -a), model/ephemeral/color after exec, stdin marker last', () => {
  const agent = new ExposedCodexAgent();

  assert.deepEqual(
    agent.buildArgs(makeRequest({ access: 'writer' })),
    [
      '-C', '/tmp/does-not-need-to-exist-for-argv-construction',
      '-s', 'workspace-write',
      '-a', 'never',
      'exec',
      '--ephemeral',
      '--color', 'never',
      '-',
    ],
  );

  assert.deepEqual(
    agent.buildArgs(makeRequest({ access: 'read_only' })),
    [
      '-C', '/tmp/does-not-need-to-exist-for-argv-construction',
      '-s', 'read-only',
      '-a', 'never',
      'exec',
      '--ephemeral',
      '--color', 'never',
      '-',
    ],
  );

  assert.deepEqual(
    agent.buildArgs(makeRequest({ access: 'writer', requestedModel: 'gpt-5-codex-example' })),
    [
      '-C', '/tmp/does-not-need-to-exist-for-argv-construction',
      '-s', 'workspace-write',
      '-a', 'never',
      'exec',
      '--ephemeral',
      '--color', 'never',
      '-m', 'gpt-5-codex-example',
      '-',
    ],
  );
});

/**
 * Optional real, no-network, no-paid parser-level smoke check. Normal test
 * runs never invoke a provider CLI; a human must explicitly opt in with
 * ORCHESTRATOR_REAL_CLI_SMOKE=1, after which this still runs only when a real
 * Codex binary is resolvable. It proves the
 * production argv is genuinely ACCEPTED by the installed CLI's argument
 * parser, not merely internally self-consistent: the trailing stdin marker
 * `-` is replaced with `--help`, which clap only reaches — and only prints
 * `codex exec`'s own help text for — once every preceding flag has parsed
 * successfully. No model task starts and no network call is made.
 */
test('the real installed Codex CLI parser accepts the exact constructed argv (no network, no paid call)', async () => {
  if (process.env.ORCHESTRATOR_REAL_CLI_SMOKE !== '1') {
    return;
  }
  const resolution = await resolveAgentExecutable('codex');
  if (resolution === null) {
    return; // no real Codex binary on this machine; the unit test above still covers argv shape.
  }

  const agent = new ExposedCodexAgent();
  const args = agent.buildArgs(makeRequest({ access: 'writer', requestedModel: 'gpt-5-codex-example' }));
  assert.equal(args.at(-1), '-', 'test assumes the stdin marker is the final argv element');
  const helpArgs = [...args.slice(0, -1), '--help'];

  const result = spawnSync(resolution.path, helpArgs, { encoding: 'utf8', shell: false });

  assert.equal(result.status, 0, `expected the real CLI to accept argv ${JSON.stringify(helpArgs)}; stderr: ${result.stderr}`);
  assert.match(result.stdout, /Run Codex non-interactively/, 'expected codex exec\'s own --help text, proving the exec subcommand was reached');

  // Negative control: this proves the accepted case above has real teeth —
  // --help does not unconditionally succeed regardless of the preceding
  // flags, so acceptance of the real argv is actually meaningful evidence.
  const brokenArgs = [...helpArgs];
  const sandboxIndex = brokenArgs.indexOf('-s');
  brokenArgs[sandboxIndex + 1] = 'not-a-real-sandbox-mode';
  const brokenResult = spawnSync(resolution.path, brokenArgs, { encoding: 'utf8', shell: false });
  assert.notEqual(brokenResult.status, 0, 'an invalid --sandbox value must be rejected, not silently accepted');
  assert.match(brokenResult.stderr, /invalid value/i);
});
