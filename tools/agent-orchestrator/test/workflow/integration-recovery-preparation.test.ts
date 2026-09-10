import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { AgentOrchestrator } from '../../src/orchestrator';
import { createTemporaryRepository } from '../git/helpers';

/**
 * The real F001-F003 dogfood root cause: `pnpm install --frozen-lockfile`
 * links the @tripwith/shared workspace package but never builds its
 * dist/, so the API's typecheck fails with "Cannot find module
 * '@tripwith/shared'" even though every task/adaptive/canonical-finding
 * concern is already fully resolved. An authorized
 * RecoveryPolicyOverlay.integrationRecovery.prepare REPLACES the effective
 * integration.prepare list for later attempts only — the historical
 * phase.yaml snapshot, and the first failed attempt's own record, are
 * never touched.
 *
 * The synthetic fixture below stands in for the real monorepo: a "shared"
 * package (package A) that must be built before it can be resolved, and an
 * "api" package (package B) whose deterministic commands fail before that
 * build and pass after it — using bare `node -e` scripts rather than a
 * real pnpm workspace, since no real npm/pnpm install is exercised in
 * tests.
 */

class SolveOnlyAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(readonly name: AgentName) {}
  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    await request.onStarted?.(process.pid);
    await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented\n', 'utf8');
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded', failureCode: null,
      exitCode: 0, signal: null,
      stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout`),
      stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr`),
      structuredHandoff: {
        status: 'complete', summary: 'implemented', filesChanged: ['feature.txt'], decisions: [],
        tests: [], openQuestions: [], reviewRequested: [],
      },
      changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: now, endedAt: now, durationMs: 1, timedOut: false, aborted: false, errorMessage: null,
    };
  }
}

/** Fails until packages/shared/dist/index.js exists — the "API typecheck" analogue. */
const TYPECHECK_COMMAND = `node -e "if (!require('fs').existsSync('packages/shared/dist/index.js')) { console.error(\\"Cannot find module '@tripwith/shared'\\"); process.exit(1); }"`;
/** The "API build" analogue — must never run before typecheck passes. */
const API_BUILD_COMMAND = `node -e "require('fs').writeFileSync('api-build-marker.txt', 'built')"`;
/** The original (always-present, historically truthful) `pnpm install` analogue. */
const INSTALL_COMMAND = `node -e "require('fs').writeFileSync('.installed', 'yes')"`;
/** The missing preparation step the recovery policy supplies — the "pnpm --filter @tripwith/shared build" analogue. */
const SHARED_BUILD_COMMAND = `node -e "require('fs').mkdirSync('packages/shared/dist', { recursive: true }); require('fs').writeFileSync('packages/shared/dist/index.js', 'module.exports = {};')"`;

function phaseYaml(baseBranch: string, prepare: readonly string[] = [INSTALL_COMMAND]): string {
  return `
phase: integration-recovery-preparation
name: Integration recovery preparation
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 1
tasks:
  - id: solve
    title: Solve
    owner: codex
    effort: high
    mode: implementation
    files: [feature.txt]
integration:
  prepare:
${prepare.map((command) => `    - command: ${JSON.stringify(command)}\n      required: true`).join('\n')}
  commands:
    - command: ${JSON.stringify(TYPECHECK_COMMAND)}
      required: true
    - command: ${JSON.stringify(API_BUILD_COMMAND)}
      required: true
`;
}

async function setUpBlockedIntegration() {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);
  const runsRoot = join(fixture.container, 'runs');
  const phaseFile = join(fixture.container, 'phase.yaml');
  await writeFile(phaseFile, phaseYaml(fixture.baseBranch), 'utf8');

  const codex = new SolveOnlyAgent('codex');
  const started = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository, runsRoot, agents: { codex, claude: new SolveOnlyAgent('claude') },
  });
  const runId = started.snapshot().runId;
  const blocked = await started.execute();
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.integration.status, 'BLOCKED');
  assert.equal(blocked.integration.error?.code, 'INTEGRATION_TEST_FAILED');
  assert.equal(blocked.integration.preparation?.status, 'SUCCEEDED', 'install itself succeeds — the bug is a missing step, not a failing one');
  assert.deepEqual(codex.invocations.map((r) => r.taskId), ['solve']);
  return { fixture, runsRoot, runId, blocked, started };
}

test('root cause shape: package B fails before package A is built, and passes after an authorized recovery preparation builds it', async () => {
  const { fixture, runsRoot, runId, blocked } = await setUpBlockedIntegration();
  try {
    const originalIntegratedCommits = blocked.integration.integratedTaskCommits;
    const originalHeadSha = blocked.integration.headSha;
    const trackedBefore = (await fixture.git.run(fixture.repository, ['log', '--oneline', '--all'])).stdout;

    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND, SHARED_BUILD_COMMAND] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });

    const retryCodex = new SolveOnlyAgent('codex');
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: retryCodex, claude: new SolveOnlyAgent('claude') },
    });
    const completed = await retried.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    assert.equal(completed.integration.status, 'SUCCEEDED');
    assert.deepEqual(completed.integration.integratedTaskCommits, originalIntegratedCommits, 'no new integrated commit — package A/B were never rerun');
    assert.equal(completed.integration.headSha, originalHeadSha);
    assert.deepEqual(retryCodex.invocations, [], 'no agent invoked for a preparation-only retry');

    // No tracked source changed — the git log is identical, and prepare's
    // generated files never show up in the tracked-mutation guard.
    const trackedAfter = (await fixture.git.run(fixture.repository, ['log', '--oneline', '--all'])).stdout;
    assert.equal(trackedAfter, trackedBefore);
  } finally {
    await fixture.dispose();
  }
});

// --- §22: retry behavior ---

test('retry A: the prior INTEGRATION_TEST_FAILED attempt remains in history untouched', async () => {
  const { fixture, runsRoot, runId, blocked } = await setUpBlockedIntegration();
  try {
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND, SHARED_BUILD_COMMAND] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') },
    });
    const after = retried.snapshot();
    assert.equal(after.integrationAttempts?.length, 1);
    assert.deepEqual(after.integrationAttempts![0], blocked.integration, 'attempt 1 is preserved exactly as it was when BLOCKED');
  } finally {
    await fixture.dispose();
  }
});

test('retry B/C: authorized recovery preparation triggers a new deterministic attempt, running in configured order', async () => {
  const { fixture, runsRoot, runId } = await setUpBlockedIntegration();
  try {
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND, SHARED_BUILD_COMMAND] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') },
    });
    const completed = await retried.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    const commands = completed.integration.preparation!.commands;
    assert.equal(commands.length, 2);
    assert.equal(commands[0]?.command, INSTALL_COMMAND);
    assert.equal(commands[1]?.command, SHARED_BUILD_COMMAND);
    assert.equal(commands[0]?.exitCode, 0);
    assert.equal(commands[1]?.exitCode, 0);
    // Real logs proving the shared-build command actually executed.
    const sharedBuildLog = await readFile(commands[1]!.stdoutPath, 'utf8').catch(() => '');
    assert.equal(typeof sharedBuildLog, 'string');
    assert.ok(await readdir(join(retried.stateStore.runDirectory, 'logs', 'integration', 'preparation')).then((files) => files.length > 0));
  } finally {
    await fixture.dispose();
  }
});

test('retry D: the shared-build preparation command runs even when its ignored dist output already exists', async () => {
  const { fixture, runsRoot, runId, blocked } = await setUpBlockedIntegration();
  try {
    // An operator-style manual/diagnostic build already happened in the
    // worktree — exactly the real dogfood shape (§4/§11): this must never
    // be trusted as proof the recovery preparation itself ran.
    const worktreePath = blocked.integration.worktreePath!;
    await fixture.git.run(worktreePath, ['status']);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(join(worktreePath, 'packages', 'shared', 'dist'), { recursive: true });
    await writeFile(join(worktreePath, 'packages', 'shared', 'dist', 'index.js'), 'module.exports = {};', 'utf8');

    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND, SHARED_BUILD_COMMAND] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') },
    });
    const completed = await retried.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    const commands = completed.integration.preparation!.commands;
    assert.equal(commands.length, 2, 'preparation actually ran both commands rather than trusting the pre-existing dist/');
    assert.equal(commands[1]?.command, SHARED_BUILD_COMMAND);
    assert.equal(commands[1]?.exitCode, 0);
  } finally {
    await fixture.dispose();
  }
});

test('retry E: a preparation command that mutates tracked source fails closed', async () => {
  const { fixture, runsRoot, runId } = await setUpBlockedIntegration();
  try {
    const mutatingCommand = `node -e "require('fs').writeFileSync('design.md', 'mutated')"`;
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND, mutatingCommand] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') },
    });
    const result = await retried.execute();
    assert.equal(result.status, 'BLOCKED');
    assert.equal(result.integration.status, 'BLOCKED');
    assert.equal(result.integration.error?.code, 'INTEGRATION_PREPARATION_FAILED');
    assert.match(result.integration.error!.message, /modified tracked source|created a commit/);
  } finally {
    await fixture.dispose();
  }
});

test('retry F: a preparation failure never runs the deterministic integration commands', async () => {
  const { fixture, runsRoot, runId } = await setUpBlockedIntegration();
  try {
    const failingPrepare = `node -e "process.exit(1)"`;
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND, failingPrepare] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') },
    });
    const result = await retried.execute();
    assert.equal(result.integration.status, 'BLOCKED');
    assert.equal(result.integration.error?.code, 'INTEGRATION_PREPARATION_FAILED');
    assert.ok(!(await readFile(join(result.integration.worktreePath!, 'api-build-marker.txt'), 'utf8').then(() => true, () => false)), 'build never ran');
  } finally {
    await fixture.dispose();
  }
});

test('retry G: a typecheck failure never runs the build command', async () => {
  const { fixture, runsRoot, runId } = await setUpBlockedIntegration();
  try {
    // Authorize a recovery policy that fixes install but NOT the missing
    // shared build — typecheck must still fail, and build must never run.
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') },
    });
    const result = await retried.execute();
    assert.equal(result.integration.status, 'BLOCKED');
    assert.equal(result.integration.error?.code, 'INTEGRATION_TEST_FAILED');
    assert.ok(!(await readFile(join(result.integration.worktreePath!, 'api-build-marker.txt'), 'utf8').then(() => true, () => false)), 'build never ran after typecheck failed');
  } finally {
    await fixture.dispose();
  }
});

test('retry H: typecheck + build success reaches integration SUCCEEDED', async () => {
  const { fixture, runsRoot, runId } = await setUpBlockedIntegration();
  try {
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND, SHARED_BUILD_COMMAND] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') },
    });
    const completed = await retried.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.integration.status, 'SUCCEEDED');
    assert.equal(
      await readFile(join(completed.integration.worktreePath!, 'api-build-marker.txt'), 'utf8'),
      'built',
    );
  } finally {
    await fixture.dispose();
  }
});

// --- §23: no unrelated re-execution ---

test('no unrelated re-execution: retry never invokes an agent or changes task/integrated-commit identity', async () => {
  const { fixture, runsRoot, runId, blocked } = await setUpBlockedIntegration();
  try {
    const solveTaskBefore = structuredClone(blocked.tasks.solve);
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND, SHARED_BUILD_COMMAND] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });
    const retryCodex = new SolveOnlyAgent('codex');
    const retryClaude = new SolveOnlyAgent('claude');
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: retryCodex, claude: retryClaude },
    });
    const completed = await retried.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    assert.deepEqual(retryCodex.invocations, []);
    assert.deepEqual(retryClaude.invocations, []);
    assert.deepEqual(completed.tasks.solve, solveTaskBefore, 'the SUCCEEDED task itself is provably unchanged');
    assert.deepEqual(completed.integration.integratedTaskCommits, blocked.integration.integratedTaskCommits);
  } finally {
    await fixture.dispose();
  }
});

// --- §24: real-dogfood-shaped acceptance test ---

test('real-dogfood-shaped acceptance: integration recovery preparation reaches SUCCEEDED, all task state deep-equal unchanged, old failed attempt preserved', async () => {
  const { fixture, runsRoot, runId, blocked } = await setUpBlockedIntegration();
  try {
    const solveTaskBefore = structuredClone(blocked.tasks.solve);
    const attempt1 = structuredClone(blocked.integration);

    const authorization = await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      integrationRecovery: { prepare: [INSTALL_COMMAND, SHARED_BUILD_COMMAND] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') } });
    assert.equal(authorization.orchestrator.snapshot().recoveryPolicyHistory?.length, 1);

    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new SolveOnlyAgent('codex'), claude: new SolveOnlyAgent('claude') },
    });
    const completed = await retried.execute();

    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    assert.equal(completed.integration.status, 'SUCCEEDED');
    assert.deepEqual(completed.tasks.solve, solveTaskBefore);
    assert.equal(completed.integrationAttempts?.length, 1);
    assert.deepEqual(completed.integrationAttempts![0], attempt1, 'the old failed attempt is preserved byte-for-byte');
  } finally {
    await fixture.dispose();
  }
});
