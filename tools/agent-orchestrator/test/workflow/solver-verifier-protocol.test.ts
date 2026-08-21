import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { AgentOrchestrator } from '../../src/orchestrator';
import { createTemporaryRepository } from '../git/helpers';

/**
 * §12: the Solver/Verifier MVP protocol, exercised end to end through the
 * REAL YAML `workflow: solver_verifier` shorthand (not by constructing task
 * lists by hand), with fake Codex/Claude executables. No paid or
 * network-dependent agent is invoked.
 *
 * Every scenario shares one fixture pattern: write a solver_verifier phase
 * file, drive it with a ScenarioAgent whose behavior is keyed by the
 * GENERATED task id (solve/verify/fix/reverify/judge — see
 * src/workflow/solver-verifier.ts), and assert on the resulting RunState.
 */

type Behavior = (request: AgentRequest) => Promise<unknown> | unknown;

class ScenarioAgent implements Agent {
  readonly invocations: string[] = [];
  constructor(
    readonly name: AgentName,
    private readonly behaviors: Readonly<Record<string, Behavior>>,
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request.taskId);
    await request.onStarted?.(process.pid);
    const behavior = this.behaviors[request.taskId];
    if (behavior === undefined) {
      throw new Error(`ScenarioAgent(${this.name}) has no behavior for task ${request.taskId}`);
    }
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

function completeHandoff(overrides: Record<string, unknown> = {}): unknown {
  return {
    status: 'complete',
    summary: 'ok',
    filesChanged: ['feature.txt'],
    decisions: [],
    tests: [{ command: 'fake-test', result: 'pass', details: 'fake evidence' }],
    openQuestions: [],
    reviewRequested: [],
    ...overrides,
  };
}

function blockedHandoff(summary: string): unknown {
  return {
    status: 'blocked',
    summary,
    filesChanged: [],
    decisions: [],
    tests: [],
    openQuestions: [],
    reviewRequested: [],
  };
}

function approvedReview(): unknown {
  return { status: 'approved', findings: [] };
}

function changesRequestedReview(id = 'F001'): unknown {
  return {
    status: 'changes_requested',
    findings: [
      {
        id,
        severity: 'high',
        category: 'correctness',
        file: 'feature.txt',
        location: 'content',
        problem: 'The implementation is missing the corrected state.',
        evidence: 'feature.txt contains only the initial write.',
        impact: 'The intended behavior is absent.',
        suggestedFix: 'Append the corrected state.',
        verificationRequired: 'Confirm the integrated file contains both states.',
        counterexample: 'reading feature.txt returns "implemented" with no " corrected" suffix',
        reproduction: 'cat feature.txt',
      },
    ],
  };
}

interface ScenarioOptions {
  readonly maxCorrectionRounds: 0 | 1;
  readonly escalation?: boolean;
}

function phaseYaml(baseBranch: string, options: ScenarioOptions): string {
  return `
phase: sv-protocol
name: Solver/Verifier protocol scenario
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 1
agentTimeoutMs: 60000
workflow:
  mode: solver_verifier
  files: [feature.txt]
  solver: { agent: codex, effort: high }
  verifier: { agent: claude, effort: high }
  correction: { agent: codex, effort: high }
  maxCorrectionRounds: ${options.maxCorrectionRounds}
  ${options.escalation === true ? 'escalation: { enabled: true, agent: claude, effort: extra_high }' : ''}
deterministicGate:
  commands:
    - node -e "process.exit(0)"
`;
}

async function setUp(): Promise<{
  readonly fixture: Awaited<ReturnType<typeof createTemporaryRepository>>;
  readonly write: (options: ScenarioOptions) => Promise<string>;
}> {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);
  return {
    fixture,
    write: async (options: ScenarioOptions) => {
      const path = join(fixture.container, 'phase.yaml');
      await writeFile(path, phaseYaml(fixture.baseBranch, options), 'utf8');
      return path;
    },
  };
}

// 1. Clean solution: Solver -> Verifier finds nothing -> gate passes -> APPROVED
test('scenario 1: clean solution reaches approval with a no-op correction round', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1 });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
      // fix always runs structurally once verify succeeds (see the
      // "DELIBERATE SIMPLIFICATION" note in src/workflow/solver-verifier.ts)
      // — with nothing to correct, the real Fixer contract is to make an
      // empty, honest completion rather than invent a change.
      fix: () => completeHandoff({ findingResponses: [] }),
    });
    const claude = new ScenarioAgent('claude', {
      verify: () => approvedReview(),
      reverify: () => approvedReview(),
    });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.deepEqual(Object.keys(completed.tasks).sort(), ['fix', 'reverify', 'solve', 'verify']);
    assert.deepEqual(codex.invocations, ['solve', 'fix']);
    assert.deepEqual(claude.invocations, ['verify', 'reverify']);
  } finally {
    await fixture.dispose();
  }
});

// 2. Real defect: Solver -> HIGH finding -> Fixer CONFIRMS -> fixes -> reverify -> gate -> APPROVED
test('scenario 2: a confirmed finding is fixed and the corrected diff is approved', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1 });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
      fix: async (request) => {
        assert.equal(request.previousReviewFindings.length, 1);
        const current = await readFile(join(request.worktreePath, 'feature.txt'), 'utf8');
        await writeFile(join(request.worktreePath, 'feature.txt'), `${current} corrected`, 'utf8');
        return completeHandoff({
          findingResponses: [
            { findingId: 'F001', decision: 'confirmed', evidence: 'reproduced', fix: 'appended corrected state', verification: 'cat feature.txt' },
          ],
        });
      },
    });
    const claude = new ScenarioAgent('claude', {
      verify: () => changesRequestedReview(),
      reverify: async (request) => {
        const content = await readFile(join(request.worktreePath, 'feature.txt'), 'utf8');
        assert.equal(content, 'implemented corrected');
        return approvedReview();
      },
    });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.integration.status, 'SUCCEEDED');
    const fixHandoff = JSON.parse(
      await readFile(completed.tasks.fix!.handoffPath!, 'utf8'),
    ) as { findingResponses?: Array<{ decision: string }> };
    assert.equal(fixHandoff.findingResponses?.[0]?.decision, 'confirmed');
  } finally {
    await fixture.dispose();
  }
});

// 3. False positive: Verifier finding -> Fixer REJECTS with evidence -> reverify accepts -> APPROVED
test('scenario 3: a rejected finding still reaches approval without a code change', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1 });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
      fix: () =>
        completeHandoff({
          findingResponses: [
            {
              findingId: 'F001',
              decision: 'rejected',
              evidence: 'The file intentionally has only one state; the finding misreads the spec.',
              reason: 'Finding assumed a requirement that does not exist in the task specification.',
            },
          ],
        }),
    });
    const claude = new ScenarioAgent('claude', {
      verify: () => changesRequestedReview(),
      reverify: () => approvedReview(),
    });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    const fixHandoff = JSON.parse(
      await readFile(completed.tasks.fix!.handoffPath!, 'utf8'),
    ) as { findingResponses?: Array<{ decision: string }> };
    assert.equal(fixHandoff.findingResponses?.[0]?.decision, 'rejected');
  } finally {
    await fixture.dispose();
  }
});

// 4. Unresolved disagreement: Verifier HIGH -> Fixer rejects -> Verifier maintains -> ESCALATION
test('scenario 4: unresolved disagreement after correction routes to the Judge', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
      fix: () =>
        completeHandoff({
          findingResponses: [
            { findingId: 'F001', decision: 'rejected', evidence: 'disagree', reason: 'not a real defect' },
          ],
        }),
    });
    const claude = new ScenarioAgent('claude', {
      verify: () => changesRequestedReview(),
      reverify: () => changesRequestedReview(), // Verifier maintains its position
      judge: () => completeHandoff({ decisions: ['RESOLVED: the Verifier finding is confirmed as a real, minor gap; not blocking.'] }),
    });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    // The reverify task itself SUCCEEDS (not BLOCKED) precisely because an
    // escalation dependent exists — this is the routing behavior under test.
    assert.equal(completed.tasks.reverify?.status, 'SUCCEEDED');
    assert.equal(completed.tasks.judge?.status, 'SUCCEEDED');
    assert.deepEqual(claude.invocations, ['verify', 'reverify', 'judge']);
    assert.equal(completed.status, 'COMPLETED');
  } finally {
    await fixture.dispose();
  }
});

// 5. Judge cannot resolve -> BLOCKED_FOR_HUMAN_REVIEW
test('scenario 5: an unresolved Judge verdict stops the run for a human, not a loop', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
      fix: () =>
        completeHandoff({
          findingResponses: [
            { findingId: 'F001', decision: 'rejected', evidence: 'disagree', reason: 'not a real defect' },
          ],
        }),
    });
    const claude = new ScenarioAgent('claude', {
      verify: () => changesRequestedReview(),
      reverify: () => changesRequestedReview(),
      judge: () => blockedHandoff('The disagreement concerns a genuine ambiguity in the spec; a human must decide.'),
    });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'BLOCKED');
    assert.equal(completed.tasks.judge?.status, 'BLOCKED');
    assert.equal(completed.tasks.judge?.error?.code, 'BLOCKED_FOR_HUMAN_REVIEW');
    // No loop: judge ran exactly once.
    assert.deepEqual(
      claude.invocations.filter((id) => id === 'judge'),
      ['judge'],
    );
    // Nothing was merged or integrated.
    assert.equal(completed.integration.status, 'PENDING');
  } finally {
    await fixture.dispose();
  }
});

// 6. Deterministic failure: Verifier approves -> tests fail -> NOT APPROVED
test('scenario 6: an approved review does not override a failing deterministic gate', async () => {
  const { fixture, write } = await setUp();
  try {
    const path = join(fixture.container, 'phase.yaml');
    await writeFile(
      path,
      phaseYaml(fixture.baseBranch, { maxCorrectionRounds: 0 }).replace(
        'node -e "process.exit(0)"',
        'node -e "process.exit(1)"',
      ),
      'utf8',
    );
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
    });
    const claude = new ScenarioAgent('claude', { verify: () => approvedReview() });
    const orchestrator = await AgentOrchestrator.start(path, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.tasks.solve?.status, 'SUCCEEDED');
    assert.equal(completed.tasks.verify?.status, 'SUCCEEDED');
    assert.equal(completed.status, 'BLOCKED');
    assert.equal(completed.integration.status, 'BLOCKED');
    assert.equal(completed.integration.error?.code, 'INTEGRATION_TEST_FAILED');
  } finally {
    await fixture.dispose();
  }
});

// 7. Resume after each stage
test('scenario 7: resume recovers a solver_verifier run past a crashed correction task', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1 });
    const runsRoot = join(fixture.container, 'runs');
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
      fix: async (request) => {
        const current = await readFile(join(request.worktreePath, 'feature.txt'), 'utf8');
        await writeFile(join(request.worktreePath, 'feature.txt'), `${current} corrected`, 'utf8');
        return completeHandoff({
          findingResponses: [{ findingId: 'F001', decision: 'confirmed', evidence: 'e', fix: 'f', verification: 'v' }],
        });
      },
    });
    const claude = new ScenarioAgent('claude', {
      verify: () => changesRequestedReview(),
      reverify: () => approvedReview(),
    });
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex, claude },
    });
    const runId = started.snapshot().runId;

    // Run to completion in one process first (the crash-mid-task path is
    // already covered by the existing generic smoke suite; this scenario's
    // job is to prove resume is a no-op / safe once a solver_verifier run has
    // already finished — reconcile() must not disturb a COMPLETED run).
    await started.execute();

    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: {
        codex: new ScenarioAgent('codex', {}),
        claude: new ScenarioAgent('claude', {}),
      },
    });
    const state = resumed.snapshot();
    assert.equal(state.status, 'COMPLETED');
    assert.equal(state.tasks.fix?.status, 'SUCCEEDED');
    assert.equal(state.tasks.reverify?.status, 'SUCCEEDED');
  } finally {
    await fixture.dispose();
  }
});

// 8. Malformed artifacts fail closed
test('scenario 8: a malformed judge response fails closed rather than being interpreted loosely', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
      fix: () =>
        completeHandoff({
          findingResponses: [
            { findingId: 'F001', decision: 'rejected', evidence: 'e', reason: 'r' },
          ],
        }),
    });
    const claude = new ScenarioAgent('claude', {
      verify: () => changesRequestedReview(),
      reverify: () => changesRequestedReview(),
      // Not JSON matching the handoff schema at all.
      judge: () => 'the disagreement is resolved, trust me',
    });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.tasks.judge?.status, 'FAILED');
    assert.equal(completed.tasks.judge?.error?.code, 'HANDOFF_INVALID');
    assert.notEqual(completed.status, 'COMPLETED');
  } finally {
    await fixture.dispose();
  }
});

// 9. Verifier remains read-only
test('scenario 9: verify/reverify/judge run read-only and any mutation fails the task', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
      fix: () =>
        completeHandoff({
          findingResponses: [{ findingId: 'F001', decision: 'confirmed', evidence: 'e', fix: 'f', verification: 'v' }],
        }),
    });
    let sawReadOnlyAccess = false;
    let sawJudgeReadOnlyAccess = false;
    const claude = new ScenarioAgent('claude', {
      verify: (request) => {
        assert.equal(request.access, 'read_only');
        sawReadOnlyAccess = true;
        return changesRequestedReview();
      },
      reverify: (request) => {
        assert.equal(request.access, 'read_only');
        return approvedReview();
      },
      // judge runs structurally even though reverify approved (see the
      // "DELIBERATE SIMPLIFICATION" note) — asserting its access here is
      // what actually proves the JUDGE role defaults to read-only, same as
      // review/final_review.
      judge: (request) => {
        assert.equal(request.access, 'read_only');
        sawJudgeReadOnlyAccess = true;
        return completeHandoff({ decisions: ['Nothing to arbitrate: the re-review already approved.'] });
      },
    });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.ok(sawReadOnlyAccess);
    assert.ok(sawJudgeReadOnlyAccess);
    assert.equal(completed.status, 'COMPLETED');
  } finally {
    await fixture.dispose();
  }
});

// 10. No automatic push/merge
test('scenario 10: a completed run requires human approval and pushes/merges nothing', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 0 });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
    });
    const claude = new ScenarioAgent('claude', { verify: () => approvedReview() });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    // The base branch itself never received the feature file: only the
    // orchestrator-owned integration worktree/branch did.
    await assert.rejects(readFile(join(fixture.repository, 'feature.txt'), 'utf8'));
    const branches = (await fixture.git.run(fixture.repository, ['branch', '--list'])).stdout;
    assert.ok(!branches.includes(`* ${fixture.baseBranch}`) || completed.integration.branch !== fixture.baseBranch);
    assert.notEqual(completed.integration.branch, fixture.baseBranch);
  } finally {
    await fixture.dispose();
  }
});
