import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { AgentOrchestrator } from '../../src/orchestrator';
import { createTemporaryRepository } from '../git/helpers';

/**
 * The real bug: advanceAdaptiveScheduling() rebuilds `this.config` from
 * `runtimePhaseConfig(this.adaptiveConfig, adaptive)` — a FRESH config
 * derived purely from the immutable historical phase snapshot — and
 * assigns it directly, discarding whatever recovery-policy overlay
 * loadRunForContinuation had already applied. Since advanceAdaptiveScheduling
 * runs at the top of every execute() loop iteration for an adaptive run,
 * the effective config silently reverts to the historical one before
 * integration (or any later scheduling decision) ever sees the recovery
 * overlay. `AgentOrchestrator.config` is a public field specifically so
 * these tests can observe the effective config directly, without needing
 * to infer it indirectly through side effects.
 */

const INSTALL_COMMAND = `node -e "require('fs').writeFileSync('.installed', 'yes')"`;
const SHARED_BUILD_COMMAND = `node -e "require('fs').mkdirSync('packages/shared/dist', { recursive: true }); require('fs').writeFileSync('packages/shared/dist/index.js', 'module.exports = {};')"`;
const TYPECHECK_COMMAND = `node -e "if (!require('fs').existsSync('packages/shared/dist/index.js')) { console.error(\\"Cannot find module '@tripwith/shared'\\"); process.exit(1); }"`;
const API_BUILD_COMMAND = `node -e "require('fs').writeFileSync('api-build-marker.txt', 'built')"`;

class ImplementationAgent implements Agent {
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

function phaseYaml(baseBranch: string): string {
  return `mode: adaptive
phase: recovery-policy-overlay-refresh
name: Recovery policy overlay refresh
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
goal: Implement one task then integrate
constraints: [Use only canonical evidence]
policy:
  allowedConcerns: [implementation]
  allowedOwnership: ['**']
  allowedResources: []
  limits:
    maxConcurrentAgents: 2
    maxAgentInvocations: 5
    maxTotalWorkUnits: 5
    maxDecompositionDepth: 2
    maxFanOutPerWorkUnit: 3
    maxSynthesisInputs: 2
    maxWallClockMs: 3600000
  requireEvidenceForExpansion: true
  agingIntervalMs: 1000
  agingStep: 1
  humanApprovalRisks: []
initialCandidates:
  - role: implementation
    concern: implementation
    objective: Implement feature
    reason: Repository evidence identifies a concrete change
    evidence: [{ kind: file, reference: design.md, summary: design }]
    resourceClaims: [{ kind: repository_path, key: feature.txt, mode: write }]
    capabilities: [{ capability: typescript_backend_editing }]
    risk: low
    priority: 90
executors:
  - id: writer
    adapter: codex
    capabilities: [{ capability: typescript_backend_editing }]
    roles: [implementation]
    effort: high
agentRetries: 0
agentTimeoutMs: 60000
integration:
  prepare:
    - command: ${JSON.stringify(INSTALL_COMMAND)}
      required: true
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

  const codex = new ImplementationAgent('codex');
  const started = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository, runsRoot, agents: { codex, claude: new ImplementationAgent('claude') },
  });
  const runId = started.snapshot().runId;
  const blocked = await started.execute();
  assert.equal(blocked.status, 'BLOCKED');
  assert.equal(blocked.integration.status, 'BLOCKED');
  assert.equal(blocked.integration.error?.code, 'INTEGRATION_TEST_FAILED');
  assert.deepEqual(codex.invocations.map((r) => r.taskId), ['work-000001']);
  return { fixture, runsRoot, runId, blocked };
}

// --- H: no recovery policy — behavior unchanged ---

test('H: with no recovery policy authorized, the effective config is exactly the historical one after scheduling', async () => {
  const { fixture, runsRoot, runId } = await setUpBlockedIntegration();
  try {
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ImplementationAgent('codex'), claude: new ImplementationAgent('claude') },
    });
    assert.equal(retried.config.integration.prepare.length, 1);
    assert.equal(retried.config.integration.prepare[0]?.command, INSTALL_COMMAND);
    const stillBlocked = await retried.execute();
    // Still fails exactly as before — advanceAdaptiveScheduling ran (at
    // least once, to reach the integration gate again) and the effective
    // config is unchanged, since no policy was ever authorized.
    assert.equal(stillBlocked.status, 'BLOCKED');
    assert.equal(stillBlocked.integration.error?.code, 'INTEGRATION_TEST_FAILED');
    assert.equal(retried.config.integration.prepare.length, 1);
    assert.equal(retried.config.maxHandoffRepairAttempts, 2);
  } finally {
    await fixture.dispose();
  }
});

// --- B/C/D/E/F/G: the fix, end to end ---

test('B/C/D/E/F/G: the recovery overlay survives every adaptive scheduling pass, does not stack, and integration eventually succeeds', async () => {
  const { fixture, runsRoot, runId, blocked } = await setUpBlockedIntegration();
  try {
    const originalIntegratedCommits = blocked.integration.integratedTaskCommits;
    const originalHeadSha = blocked.integration.headSha;
    const taskCountBefore = Object.keys(blocked.tasks).length;
    const implementationTaskBefore = structuredClone(blocked.tasks['work-000001']);

    // Authorize salvage + handoffRepair + integrationRecovery all at once —
    // D proves salvage survives, integrationRecovery is the actual fix
    // under test, and handoffRepair.additionalAttempts is the stacking
    // canary (nothing in this scenario needs a real repair; we only
    // observe the persisted effective value).
    await AgentOrchestrator.authorizeRecoveryPolicy(runId, {
      salvage: { verify: ['node -e "process.exit(0)"'] },
      handoffRepair: { additionalAttempts: 1 },
      integrationRecovery: { prepare: [INSTALL_COMMAND, SHARED_BUILD_COMMAND] },
    }, { repositoryPath: fixture.repository, runsRoot, agents: { codex: new ImplementationAgent('codex'), claude: new ImplementationAgent('claude') } });

    // (A) loadRunForContinuation applies the overlay immediately.
    let orchestrator = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ImplementationAgent('codex'), claude: new ImplementationAgent('claude') },
    });
    assert.deepEqual(orchestrator.config.integration.prepare.map((c) => c.command), [INSTALL_COMMAND, SHARED_BUILD_COMMAND]);
    assert.equal(orchestrator.config.maxHandoffRepairAttempts, 3);
    assert.deepEqual(orchestrator.config.salvage.verify.map((c) => c.command), ['node -e "process.exit(0)"']);

    // (B) retryIntegrationGate + execute() drives advanceAdaptiveScheduling
    // at least once before integration runs again — this is exactly the
    // path that used to discard the overlay.
    orchestrator = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex: new ImplementationAgent('codex'), claude: new ImplementationAgent('claude') },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify(completed.errors));
    assert.equal(completed.integration.status, 'SUCCEEDED');

    // (F) the persisted preparation checkpoint corresponds to the TWO-command effective config, not the original one.
    const commands = completed.integration.preparation!.commands;
    assert.equal(commands.length, 2);
    assert.equal(commands[0]?.command, INSTALL_COMMAND);
    assert.equal(commands[1]?.command, SHARED_BUILD_COMMAND);
    assert.equal(commands[1]?.exitCode, 0);
    assert.equal(
      await readFile(join(completed.integration.worktreePath!, 'api-build-marker.txt'), 'utf8'),
      'built',
    );

    // (C) handoffRepair.additionalAttempts never stacked across the
    // multiple advanceAdaptiveScheduling passes this whole flow triggered.
    assert.equal(orchestrator.config.maxHandoffRepairAttempts, 3);
    // (D) salvage is still exactly what was authorized.
    assert.deepEqual(orchestrator.config.salvage.verify.map((c) => c.command), ['node -e "process.exit(0)"']);
    // (integrationRecovery) still both commands, in order.
    assert.deepEqual(orchestrator.config.integration.prepare.map((c) => c.command), [INSTALL_COMMAND, SHARED_BUILD_COMMAND]);

    // (G) no agent was re-invoked, no duplicate task/commit/work request.
    assert.deepEqual(completed.integration.integratedTaskCommits, originalIntegratedCommits);
    assert.equal(completed.integration.headSha, originalHeadSha);
    assert.deepEqual(completed.tasks['work-000001'], implementationTaskBefore);
    assert.equal(Object.keys(completed.tasks).length, taskCountBefore, 'no new task materialized merely by re-deriving config');
    assert.equal(completed.adaptive!.workRequests.length, blocked.adaptive!.workRequests.length, 'no duplicate work requests');
    assert.equal(completed.adaptive!.workUnits.length, blocked.adaptive!.workUnits.length, 'no duplicate work units');
  } finally {
    await fixture.dispose();
  }
});
