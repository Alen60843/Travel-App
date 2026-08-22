import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { computeRunMetrics } from '../../src/metrics/compute-metrics';
import { AgentOrchestrator } from '../../src/orchestrator';
import { loadAnyPhaseConfig } from '../../src/workflow/solver-verifier';
import { createTemporaryRepository } from '../git/helpers';

class FixedAgent implements Agent {
  constructor(
    readonly name: AgentName,
    private readonly behaviors: Readonly<Record<string, (request: AgentRequest) => unknown>>,
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    await request.onStarted?.(process.pid);
    const behavior = this.behaviors[request.taskId];
    if (behavior === undefined) throw new Error(`no behavior for ${request.taskId}`);
    const structuredHandoff = await behavior(request);
    const timestamp = new Date().toISOString();
    return {
      agent: this.name,
      runId: request.runId,
      taskId: request.taskId,
      status: 'succeeded',
      failureCode: null,
      exitCode: 0,
      signal: null,
      stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout.log`),
      stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr.log`),
      structuredHandoff,
      changedFiles: [],
      gitDiffSummary: null,
      testsReported: [],
      unresolvedQuestions: [],
      startedAt: timestamp,
      endedAt: timestamp,
      durationMs: 0,
      timedOut: false,
      aborted: false,
      errorMessage: null,
    };
  }
}

function completeHandoff(): unknown {
  return {
    status: 'complete',
    summary: 'ok',
    filesChanged: ['feature.txt'],
    decisions: [],
    tests: [],
    openQuestions: [],
    reviewRequested: [],
  };
}

test('metrics: skipped tasks are reported as not-executed and excluded from escalation', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);

    const phaseFile = join(fixture.container, 'phase.yaml');
    await writeFile(
      phaseFile,
      `
phase: sv-metrics
name: Metrics scenario
baseBranch: ${fixture.baseBranch}
canonicalDesignDocument: design.md
concurrency: 1
workflow:
  mode: solver_verifier
  files: [feature.txt]
  solver: { agent: codex, effort: high }
  verifier: { agent: claude, effort: high }
  correction: { agent: codex, effort: high }
  maxCorrectionRounds: 1
  escalation: { enabled: true, agent: claude, effort: extra_high }
deterministicGate:
  commands:
    - node -e "process.exit(0)"
`,
      'utf8',
    );

    const codex = new FixedAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
    });
    const claude = new FixedAgent('claude', { verify: () => ({ status: 'approved', findings: [] }) });

    const runsRoot = join(fixture.container, 'runs');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');

    const config = await loadAnyPhaseConfig(join(orchestrator.stateStore.runDirectory, 'phase.yaml'));
    const metrics = await computeRunMetrics(orchestrator.stateStore.runDirectory, completed, config);

    assert.equal(metrics.roleExecution.solverExecuted, true);
    assert.equal(metrics.roleExecution.verifierExecuted, true);
    assert.equal(metrics.roleExecution.fixerExecuted, false);
    assert.equal(metrics.roleExecution.judgeExecuted, false);

    const fixMetric = metrics.tasks.find((task) => task.taskId === 'fix');
    assert.equal(fixMetric?.executed, false);
    assert.match(fixMetric?.skipReason ?? '', /verify review status is approved/);

    // The whole point of §9: a skipped Judge is not an escalation.
    assert.equal(metrics.escalationOccurred, false);
    assert.equal(metrics.escalationResolved, null);

    // tokensUsed/costUsd are honestly null, never fabricated.
    for (const task of metrics.tasks) {
      assert.equal(task.tokensUsed, null);
      assert.equal(task.costUsd, null);
    }
  } finally {
    await fixture.dispose();
  }
});
