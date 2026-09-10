import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { HANDOFF_KEYS, FINDING_RESPONSE_KEYS } from '../../src/handoff';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import { FINDING_KEYS, REVIEW_KEYS } from '../../src/review/findings';
import type { RunState } from '../../src/state';
import { WorktreeManager } from '../../src/git';
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
// -> Fixer/Re-Verifier/Judge are SKIPPED, not invoked as no-ops. This is the
// post-correction-pass behavior: conditional execution is actually
// conditional, not "always run and report nothing to do."
test('scenario 1: clean solution SKIPS Fixer, Re-Verifier, and Judge entirely', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
      // No `fix` behavior registered at all: if the engine invoked it despite
      // verify approving, ScenarioAgent would throw "no behavior for task
      // fix" and this test would fail loudly rather than silently.
    });
    const claude = new ScenarioAgent('claude', { verify: () => approvedReview() });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks.fix?.status, 'SKIPPED');
    assert.equal(completed.tasks.reverify?.status, 'SKIPPED');
    assert.equal(completed.tasks.judge?.status, 'SKIPPED');
    assert.match(completed.tasks.fix?.skipReason ?? '', /verify review status is approved/);
    assert.match(
      completed.tasks.judge?.skipReason ?? '',
      /reverify produced no review artifact/,
    );
    // No worktree, no agent invocation, no commit for any skipped task.
    assert.equal(completed.tasks.fix?.worktreePath, undefined);
    assert.equal(completed.tasks.fix?.commit, undefined);
    assert.deepEqual(codex.invocations, ['solve']);
    assert.deepEqual(claude.invocations, ['verify']);
    assert.deepEqual(
      Object.keys(completed.tasks).sort(),
      ['fix', 'judge', 'reverify', 'solve', 'verify'],
    );
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
      // reverify does NOT approve here (unlike scenario 1's clean path), so
      // judge's condition is satisfied and it actually runs — deliberately,
      // so this test can assert its access default rather than merely
      // asserting on the generated TaskSpec (already covered separately in
      // solver-verifier-config.test.ts).
      reverify: (request) => {
        assert.equal(request.access, 'read_only');
        return changesRequestedReview();
      },
      judge: (request) => {
        assert.equal(request.access, 'read_only');
        sawJudgeReadOnlyAccess = true;
        return completeHandoff({ decisions: ['Resolved: the remaining finding is minor, not blocking.'] });
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

// 5 (resume, clean path). Interrupt after Verifier APPROVED, before the
// crashed process could persist fix's skip decision. Resume must retry fix
// from scratch (via the existing RETRY_PROCESS_LOSS reconciliation path — no
// new resume logic was needed for this) and reach the SAME correct answer:
// SKIPPED, never actually invoked.
test('resume (clean path): a crash before the skip decision persists still resumes to SKIPPED, not RUNNING', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const runsRoot = join(fixture.container, 'runs');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      // Never actually invoked in this test: the crash is simulated by
      // hand-constructing the intermediate state below, before any real
      // agent for solve/verify/fix runs.
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const before = started.snapshot();

    // Write the review artifact a real `verify` task would have produced.
    const reviewsDir = join(started.stateStore.runDirectory, 'reviews');
    await mkdir(reviewsDir, { recursive: true });
    const verifyReviewPath = join(reviewsDir, 'verify.json');
    await writeFile(verifyReviewPath, JSON.stringify(approvedReview()), 'utf8');

    // Hand-construct the moment of the crash: solve/verify already
    // succeeded; fix was claimed RUNNING by a process that then died before
    // creating a worktree (worktreePath undefined) or persisting any
    // decision — the exact ambiguous state reconcile()'s fallback branch is
    // built to resolve safely.
    const interrupted: RunState = {
      ...before,
      status: 'RUNNING',
      tasks: {
        ...before.tasks,
        solve: { ...before.tasks.solve!, status: 'SUCCEEDED', finishedAt: before.createdAt },
        verify: {
          ...before.tasks.verify!,
          status: 'SUCCEEDED',
          reviewPaths: [verifyReviewPath],
          finishedAt: before.createdAt,
        },
        fix: {
          ...before.tasks.fix!,
          status: 'RUNNING',
          startedAt: before.createdAt,
          agentAttempts: [{ attempt: 1, agent: 'codex', startedAt: before.createdAt, pid: 2_147_483_647 }],
        },
      },
    };
    await started.stateStore.save(interrupted);

    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: {
        // Registers no `fix`/`reverify`/`judge` behavior at all: if the
        // engine tried to actually run any of them post-resume rather than
        // skip, ScenarioAgent throws and the test fails loudly.
        codex: new ScenarioAgent('codex', {}),
        claude: new ScenarioAgent('claude', {}),
      },
    });
    // reconcile() itself, run inside resume(), must already have moved the
    // ambiguous RUNNING task back to READY rather than leaving it stuck.
    assert.equal(resumed.snapshot().tasks.fix?.status, 'READY');

    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks.fix?.status, 'SKIPPED');
    assert.equal(completed.tasks.reverify?.status, 'SKIPPED');
    assert.equal(completed.tasks.judge?.status, 'SKIPPED');
  } finally {
    await fixture.dispose();
  }
});

// 6 (resume, escalation path). Interrupt after Re-Verifier requests
// escalation (reverify already SUCCEEDED with a non-approved, high-severity
// review), before judge started. Resume must run judge exactly once.
test('resume (escalation path): a crash before Judge starts resumes to exactly one Judge invocation', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const runsRoot = join(fixture.container, 'runs');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const before = started.snapshot();

    const reviewsDir = join(started.stateStore.runDirectory, 'reviews');
    await mkdir(reviewsDir, { recursive: true });
    const verifyReviewPath = join(reviewsDir, 'verify.json');
    await writeFile(verifyReviewPath, JSON.stringify(changesRequestedReview()), 'utf8');
    const reverifyReviewPath = join(reviewsDir, 'reverify.json');
    await writeFile(reverifyReviewPath, JSON.stringify(changesRequestedReview('F002')), 'utf8');

    const interrupted: RunState = {
      ...before,
      status: 'RUNNING',
      tasks: {
        ...before.tasks,
        solve: { ...before.tasks.solve!, status: 'SUCCEEDED', finishedAt: before.createdAt },
        verify: {
          ...before.tasks.verify!,
          status: 'SUCCEEDED',
          reviewPaths: [verifyReviewPath],
          finishedAt: before.createdAt,
        },
        fix: { ...before.tasks.fix!, status: 'SUCCEEDED', finishedAt: before.createdAt },
        reverify: {
          ...before.tasks.reverify!,
          status: 'SUCCEEDED',
          reviewPaths: [reverifyReviewPath],
          finishedAt: before.createdAt,
        },
        judge: {
          ...before.tasks.judge!,
          status: 'RUNNING',
          startedAt: before.createdAt,
          agentAttempts: [{ attempt: 1, agent: 'claude', startedAt: before.createdAt, pid: 2_147_483_647 }],
        },
      },
    };
    await started.stateStore.save(interrupted);

    let judgeInvocations = 0;
    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: {
        codex: new ScenarioAgent('codex', {}),
        claude: new ScenarioAgent('claude', {
          judge: () => {
            judgeInvocations += 1;
            return completeHandoff({ decisions: ['Resolved after resume.'] });
          },
        }),
      },
    });
    assert.equal(resumed.snapshot().tasks.judge?.status, 'READY');

    const completed = await resumed.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks.judge?.status, 'SUCCEEDED');
    assert.equal(judgeInvocations, 1);
  } finally {
    await fixture.dispose();
  }
});

/**
 * §13 (real Phase 5 dogfood recovery, run-20260822094645-5b090308): the
 * scenarios below cover Fix A (exact response-schema keys, never a
 * description baked into a key), Fix B (bounded handoff repair — deterministic
 * first, one read-only agent call as a fallback, fail closed otherwise), and
 * Fix C (explicit recovery of a persisted FAILED/HANDOFF_INVALID task, and
 * the downstream unblock it requires). All still use FAKE agents only.
 */

// 11. Fix A: the exact prompt-facing schema for implementation/correction and
// review/final_review tasks must use the real validator's own bare keys.
test('scenario 11: implementation and review response schemas use exact keys, never a description-annotated one', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    let solveSchema: Record<string, unknown> | undefined;
    let verifySchema: Record<string, unknown> | undefined;
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        const spec = request.taskSpecification as { responseSchema: Record<string, unknown> };
        solveSchema = spec.responseSchema;
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
    });
    const claude = new ScenarioAgent('claude', {
      verify: (request) => {
        const spec = request.taskSpecification as { responseSchema: Record<string, unknown> };
        verifySchema = spec.responseSchema;
        return approvedReview();
      },
    });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    await orchestrator.execute();

    assert.ok(solveSchema);
    assert.ok(verifySchema);
    const solveKeys = Object.keys(solveSchema!);
    assert.deepEqual(solveKeys.sort(), [...HANDOFF_KEYS].sort());
    for (const key of solveKeys) {
      assert.doesNotMatch(key, /[()]/, `handoff schema key "${key}" must not carry an annotation`);
    }
    const findingResponseEntry = (solveSchema!.findingResponses as unknown[])[0] as Record<string, unknown>;
    const findingResponseKeys = Object.keys(findingResponseEntry);
    assert.deepEqual(findingResponseKeys.sort(), [...FINDING_RESPONSE_KEYS].sort());
    for (const key of findingResponseKeys) {
      assert.doesNotMatch(key, /[()]/);
    }

    const reviewKeys = Object.keys(verifySchema!);
    assert.deepEqual(reviewKeys.sort(), [...REVIEW_KEYS].sort());
    const findingEntry = (verifySchema!.findings as unknown[])[0] as Record<string, unknown>;
    const findingKeys = Object.keys(findingEntry);
    assert.deepEqual(findingKeys.sort(), [...FINDING_KEYS].sort());
    for (const key of findingKeys) {
      assert.doesNotMatch(key, /[()]/);
    }
  } finally {
    await fixture.dispose();
  }
});

// 12. Fix B: the exact real-world failure mode (a description-annotated
// optional key) is repaired deterministically, with zero repair-agent
// invocation and zero Solver re-invocation.
test('scenario 12: a description-annotated handoff key is repaired deterministically, without re-invoking the Solver', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        // The exact real defect: a schema description baked into the key
        // instead of the bare 'assumptions'. No 'solve-handoff-repair'
        // behavior is registered: if the engine fell through to an
        // agent-based repair, ScenarioAgent would throw and fail this test.
        return completeHandoff({
          'assumptions (optional; implementation tasks)': ['a real assumption'],
        });
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
    assert.equal(completed.tasks.solve?.status, 'SUCCEEDED');
    assert.equal(completed.tasks.solve?.handoffOutcome, 'valid');
    assert.equal(completed.tasks.solve?.handoffRepairAttempts.length > 0, true);
    assert.equal(completed.tasks.solve?.handoffRepairAttempts.at(-1)?.succeeded, true);
    assert.deepEqual(codex.invocations, ['solve']);
  } finally {
    await fixture.dispose();
  }
});

// 13. Fix B: a handoff that neither deterministic repair nor one bounded
// agent-repair attempt can fix fails closed with the ORIGINAL error, and the
// Solver is never rerun.
test('scenario 13: a handoff repair-agent failure fails closed without rerunning the Solver', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return {
          status: 'complete',
          summary: 'ok',
          filesChanged: [],
          decisions: [],
          tests: [],
          openQuestions: [],
          reviewRequested: [],
          somethingGenuinelyUnknown: true,
        };
      },
      'solve-handoff-repair': () => ({
        status: 'complete',
        summary: 'still bad',
        filesChanged: [],
        decisions: [],
        tests: [],
        openQuestions: [],
        reviewRequested: [],
        stillUnknown: true,
      }),
    });
    const claude = new ScenarioAgent('claude', {});
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.tasks.solve?.status, 'FAILED');
    assert.equal(completed.tasks.solve?.error?.code, 'HANDOFF_INVALID');
    assert.match(completed.tasks.solve?.error?.message ?? '', /somethingGenuinelyUnknown/);
    assert.equal(completed.tasks.solve?.handoffOutcome, 'invalid');
    assert.equal(completed.tasks.solve?.handoffRepairAttempts.length > 0, true);
    assert.equal(completed.tasks.solve?.handoffRepairAttempts.at(-1)?.succeeded, false);
    // The Solver ran once; the repair agent ran once; neither looped or reran.
    assert.deepEqual(codex.invocations, ['solve', 'solve-handoff-repair']);
  } finally {
    await fixture.dispose();
  }
});

// 14. A real agent-process failure (nonzero exit) never triggers handoff
// repair at all — repair only ever concerns structured-output validity.
test('scenario 14: a real agent process failure never triggers handoff repair', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const invocations: string[] = [];
    const failingCodex: Agent = {
      name: 'codex',
      async run(request) {
        invocations.push(request.taskId);
        const timestamp = new Date().toISOString();
        return {
          agent: 'codex',
          runId: request.runId,
          taskId: request.taskId,
          status: 'failed',
          failureCode: 'AGENT_FAILED',
          exitCode: 7,
          signal: null,
          stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout.log`),
          stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr.log`),
          structuredHandoff: null,
          changedFiles: [],
          gitDiffSummary: null,
          testsReported: [],
          unresolvedQuestions: [],
          startedAt: timestamp,
          endedAt: timestamp,
          durationMs: 0,
          timedOut: false,
          aborted: false,
          errorMessage: 'intentional failure',
        };
      },
    };
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex: failingCodex, claude: new ScenarioAgent('claude', {}) },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.tasks.solve?.status, 'FAILED');
    assert.equal(completed.tasks.solve?.error?.code, 'AGENT_FAILED');
    assert.equal(completed.tasks.solve?.handoffOutcome ?? null, null);
    assert.equal(completed.tasks.solve?.handoffRepairAttempts.length, 0);
    assert.deepEqual(invocations, ['solve']);
  } finally {
    await fixture.dispose();
  }
});

// 15. An ownership violation still blocks the task exactly as before; the
// handoff-repair refactor did not weaken or bypass it.
test('scenario 15: an ownership violation still blocks the task; unaffected by handoff repair', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'outside-ownership.txt'), 'oops', 'utf8');
        return completeHandoff({ filesChanged: ['outside-ownership.txt'] });
      },
    });
    const claude = new ScenarioAgent('claude', {});
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.tasks.solve?.status, 'FAILED');
    assert.equal(completed.tasks.solve?.error?.code, 'OWNERSHIP_VIOLATION');
    // The handoff itself was perfectly valid; nothing here needed repair.
    assert.equal(completed.tasks.solve?.handoffOutcome, 'valid');
    assert.equal(completed.tasks.solve?.handoffRepairAttempts.length, 0);
  } finally {
    await fixture.dispose();
  }
});

// 16. Fix C: a persisted FAILED/HANDOFF_INVALID task with a succeeded agent
// attempt and a genuinely preserved worktree is recoverable via
// AgentOrchestrator.recoverHandoffFailures — WITHOUT re-invoking the Solver —
// and the resulting run correctly unblocks its dependents and proceeds to
// the next real step (the Verifier), exactly like the real dogfood recovery.
test('scenario 16: a persisted FAILED/HANDOFF_INVALID task recovers via recoverHandoffFailures without rerunning the Solver, and unblocks its dependents', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const runsRoot = join(fixture.container, 'runs');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const before = started.snapshot();

    // Build a real worktree exactly like prepareTask() would, with real
    // preserved uncommitted implementation work — mirroring the actual
    // dogfood failure (no task commit was ever created).
    const worktrees = await WorktreeManager.create({ repositoryPath: fixture.repository });
    const worktree = await worktrees.createTaskWorktree({
      runId,
      taskId: 'solve',
      baseBranch: fixture.baseBranch,
      baseSha: before.baseSha,
    });
    await writeFile(join(worktree.path, 'feature.txt'), 'implemented', 'utf8');

    // The exact real defect, written to the preserved stdout log a real
    // Codex process would have produced.
    const logsDir = join(started.stateStore.runDirectory, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, `${runId}.solve.codex.attempt-1.stdout.log`),
      JSON.stringify({
        ...(completeHandoff() as Record<string, unknown>),
        'assumptions (optional; implementation tasks)': ['a real assumption'],
      }),
      'utf8',
    );

    const dependencyFailedError = {
      code: 'TASK_DEPENDENCY_FAILED' as const,
      message: 'A task dependency did not succeed',
      at: before.createdAt,
    };
    const failed: RunState = {
      ...before,
      status: 'FAILED',
      tasks: {
        ...before.tasks,
        solve: {
          ...before.tasks.solve!,
          status: 'FAILED',
          worktreePath: worktree.path,
          branch: worktree.branch,
          preparedHeadSha: before.baseSha,
          startedAt: before.createdAt,
          finishedAt: before.createdAt,
          agentAttempts: [{
            attempt: 1,
            agent: 'codex',
            startedAt: before.createdAt,
            finishedAt: before.createdAt,
            outcome: 'succeeded',
          }],
          error: {
            code: 'HANDOFF_INVALID',
            message: 'handoff.assumptions (optional; implementation tasks): is not a supported field',
            at: before.createdAt,
          },
        },
        verify: { ...before.tasks.verify!, status: 'BLOCKED', finishedAt: before.createdAt, error: dependencyFailedError },
        fix: { ...before.tasks.fix!, status: 'BLOCKED', finishedAt: before.createdAt, error: dependencyFailedError },
        reverify: { ...before.tasks.reverify!, status: 'BLOCKED', finishedAt: before.createdAt, error: dependencyFailedError },
        judge: { ...before.tasks.judge!, status: 'BLOCKED', finishedAt: before.createdAt, error: dependencyFailedError },
      },
    };
    await started.stateStore.save(failed);

    // Recovery agents register NO 'solve' or 'solve-handoff-repair' behavior
    // at all: if the engine re-invoked the Solver or fell through to an
    // agent-based repair, ScenarioAgent throws and this test fails loudly.
    const recoveryCodex = new ScenarioAgent('codex', {});
    const recoveryClaude = new ScenarioAgent('claude', { verify: () => approvedReview() });
    const { orchestrator, recovered, skipped } = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: recoveryCodex, claude: recoveryClaude },
    });
    assert.deepEqual(recovered, ['solve']);
    assert.deepEqual(skipped, []);
    const afterRecovery = orchestrator.snapshot();
    assert.equal(afterRecovery.tasks.solve?.status, 'SUCCEEDED');
    assert.equal(afterRecovery.tasks.solve?.handoffOutcome, 'valid');
    assert.equal(afterRecovery.tasks.solve?.handoffRepairAttempts.length > 0, true);
    assert.equal(afterRecovery.tasks.solve?.handoffRepairAttempts.at(-1)?.succeeded, true);
    assert.ok(afterRecovery.tasks.solve?.commit?.sha, 'a real task commit must have been created');
    // Downstream, dependency-only BLOCKED tasks are unblocked to PENDING —
    // not jumped straight to READY (verify's own dependency check runs it).
    assert.equal(afterRecovery.tasks.verify?.status, 'PENDING');
    assert.equal(afterRecovery.status, 'RUNNING');
    assert.deepEqual(recoveryCodex.invocations, []);

    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.deepEqual(recoveryCodex.invocations, [], 'the Solver must never be re-invoked');
    assert.deepEqual(recoveryClaude.invocations, ['verify']);
    assert.equal(completed.tasks.fix?.status, 'SKIPPED');
  } finally {
    await fixture.dispose();
  }
});

// 16b. A task whose handoff-repair attempt budget is already exhausted (by
// prior recorded attempts, native or migrated-legacy) must never reach
// repair dispatch again — recover-handoffs fails fast with a stable
// reasonCode, and the repair agent is never invoked a second time.
test('scenario 16b: recover-handoffs refuses a task whose handoff repair attempt budget is already exhausted', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const runsRoot = join(fixture.container, 'runs');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const before = started.snapshot();

    const worktrees = await WorktreeManager.create({ repositoryPath: fixture.repository });
    const worktree = await worktrees.createTaskWorktree({
      runId,
      taskId: 'solve',
      baseBranch: fixture.baseBranch,
      baseSha: before.baseSha,
    });
    await writeFile(join(worktree.path, 'feature.txt'), 'implemented', 'utf8');

    const logsDir = join(started.stateStore.runDirectory, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, `${runId}.solve.codex.attempt-1.stdout.log`),
      JSON.stringify({
        ...(completeHandoff() as Record<string, unknown>),
        'assumptions (optional; implementation tasks)': ['a real assumption'],
      }),
      'utf8',
    );

    const dependencyFailedError = {
      code: 'TASK_DEPENDENCY_FAILED' as const,
      message: 'A task dependency did not succeed',
      at: before.createdAt,
    };
    const failed: RunState = {
      ...before,
      status: 'FAILED',
      tasks: {
        ...before.tasks,
        solve: {
          ...before.tasks.solve!,
          status: 'FAILED',
          worktreePath: worktree.path,
          branch: worktree.branch,
          preparedHeadSha: before.baseSha,
          startedAt: before.createdAt,
          finishedAt: before.createdAt,
          agentAttempts: [{
            attempt: 1,
            agent: 'codex',
            startedAt: before.createdAt,
            finishedAt: before.createdAt,
            outcome: 'succeeded',
          }],
          error: {
            code: 'HANDOFF_INVALID',
            message: 'handoff.assumptions (optional; implementation tasks): is not a supported field',
            at: before.createdAt,
          },
          // Two prior attempts already recorded — the default
          // maxHandoffRepairAttempts (2) is exhausted before this
          // recover-handoffs call is even made.
          handoffRepairAttempts: [
            { method: 'agent' as const, succeeded: false, failureReason: 'agent_invocation_failed' as const, timestamp: before.createdAt },
            { method: 'agent' as const, succeeded: false, failureReason: 'evidence_insufficient' as const, timestamp: before.createdAt },
          ],
        },
        verify: { ...before.tasks.verify!, status: 'BLOCKED', finishedAt: before.createdAt, error: dependencyFailedError },
        fix: { ...before.tasks.fix!, status: 'BLOCKED', finishedAt: before.createdAt, error: dependencyFailedError },
        reverify: { ...before.tasks.reverify!, status: 'BLOCKED', finishedAt: before.createdAt, error: dependencyFailedError },
        judge: { ...before.tasks.judge!, status: 'BLOCKED', finishedAt: before.createdAt, error: dependencyFailedError },
      },
    };
    await started.stateStore.save(failed);

    const recoveryCodex = new ScenarioAgent('codex', {});
    const recoveryClaude = new ScenarioAgent('claude', {});
    await assert.rejects(
      () => AgentOrchestrator.recoverHandoffFailures(runId, {
        repositoryPath: fixture.repository,
        runsRoot,
        agents: { codex: recoveryCodex, claude: recoveryClaude },
      }),
      (error: unknown) => {
        if (!isOrchestratorError(error, 'TASK_STATE_INVALID')) {
          throw error;
        }
        const details = error.details as unknown as { ineligible: Array<{ taskId: string; reasonCode?: string }> };
        assert.equal(details.ineligible.length, 1);
        assert.equal(details.ineligible[0]?.taskId, 'solve');
        assert.equal(details.ineligible[0]?.reasonCode, 'HANDOFF_REPAIR_BUDGET_EXHAUSTED');
        return true;
      },
    );
    assert.deepEqual(recoveryCodex.invocations, [], 'a repair agent must never be invoked once the budget is exhausted');
  } finally {
    await fixture.dispose();
  }
});

// 17. An arbitrary FAILED task (a real implementation failure, not a handoff
// problem) is never treated as an automatic recovery candidate.
test('scenario 17: a FAILED task with AGENT_FAILED is not an automatic recovery candidate', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const runsRoot = join(fixture.container, 'runs');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const before = started.snapshot();
    const failed: RunState = {
      ...before,
      status: 'FAILED',
      tasks: {
        ...before.tasks,
        solve: {
          ...before.tasks.solve!,
          status: 'FAILED',
          finishedAt: before.createdAt,
          agentAttempts: [{ attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'failed' }],
          error: { code: 'AGENT_FAILED', message: 'intentional failure', at: before.createdAt },
        },
      },
    };
    await started.stateStore.save(failed);

    const result = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    assert.deepEqual(result.recovered, []);
    assert.equal(result.orchestrator.snapshot().status, 'FAILED');
    assert.equal(result.orchestrator.snapshot().tasks.solve?.status, 'FAILED');
    assert.equal(result.orchestrator.snapshot().tasks.solve?.error?.code, 'AGENT_FAILED');
  } finally {
    await fixture.dispose();
  }
});

// 18. All-or-nothing: a HANDOFF_INVALID task that fails ONE eligibility
// invariant (its last agent attempt did not actually succeed) refuses the
// ENTIRE recovery call rather than partially recovering other tasks.
test('scenario 18: an eligibility invariant failure refuses recovery entirely (all-or-nothing)', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const runsRoot = join(fixture.container, 'runs');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const before = started.snapshot();
    const failed: RunState = {
      ...before,
      status: 'FAILED',
      tasks: {
        ...before.tasks,
        solve: {
          ...before.tasks.solve!,
          status: 'FAILED',
          finishedAt: before.createdAt,
          // No worktreePath/preparedHeadSha at all, and the recorded attempt
          // did not actually succeed -- an invariant violation, not the real
          // dogfood shape.
          agentAttempts: [{ attempt: 1, agent: 'codex', startedAt: before.createdAt, finishedAt: before.createdAt, outcome: 'failed' }],
          error: { code: 'HANDOFF_INVALID', message: 'handoff is not valid JSON', at: before.createdAt },
        },
      },
    };
    await started.stateStore.save(failed);

    await assert.rejects(
      AgentOrchestrator.recoverHandoffFailures(runId, {
        repositoryPath: fixture.repository,
        runsRoot,
        agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
      }),
      (error: unknown) => {
        assert.match((error as Error).message, /eligibility invariant/);
        return true;
      },
    );
    // Nothing was mutated: reloading the persisted state must still show FAILED.
    const stillFailed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    assert.equal(stillFailed.snapshot().tasks.solve?.status, 'FAILED');
  } finally {
    await fixture.dispose();
  }
});

// 19. A crash while a bounded handoff-repair attempt is in flight must never
// cause resume to re-invoke the Solver: the original attempt already
// succeeded and left real uncommitted work in the worktree, so reconcile()
// must not treat this as "process disappeared, safe to retry from scratch."
test('scenario 19: a crash during handoff repair does not duplicate the Solver invocation on resume', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const runsRoot = join(fixture.container, 'runs');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const before = started.snapshot();

    const logsDir = join(started.stateStore.runDirectory, 'logs');
    await mkdir(logsDir, { recursive: true });
    await writeFile(
      join(logsDir, `${runId}.solve.codex.attempt-1.stdout.log`),
      JSON.stringify({ ...(completeHandoff() as Record<string, unknown>), 'assumptions (optional; implementation tasks)': ['x'] }),
      'utf8',
    );
    const worktrees = await WorktreeManager.create({ repositoryPath: fixture.repository });
    const worktree = await worktrees.createTaskWorktree({
      runId,
      taskId: 'solve',
      baseBranch: fixture.baseBranch,
      baseSha: before.baseSha,
    });
    await writeFile(join(worktree.path, 'feature.txt'), 'implemented', 'utf8');

    const interrupted: RunState = {
      ...before,
      status: 'RUNNING',
      tasks: {
        ...before.tasks,
        solve: {
          ...before.tasks.solve!,
          status: 'RUNNING',
          worktreePath: worktree.path,
          branch: worktree.branch,
          preparedHeadSha: before.baseSha,
          startedAt: before.createdAt,
          // The ORIGINAL attempt already finished successfully by the time a
          // crash could occur mid-repair -- runTrackedAgent() always persists
          // this before finishHandoff() (and therefore any repair) begins.
          agentAttempts: [{
            attempt: 1,
            agent: 'codex',
            startedAt: before.createdAt,
            finishedAt: before.createdAt,
            outcome: 'succeeded',
            pid: 2_147_483_647,
          }],
        },
      },
    };
    await started.stateStore.save(interrupted);

    const resumeCodex = new ScenarioAgent('codex', {});
    const resumed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: resumeCodex, claude: new ScenarioAgent('claude', {}) },
    });
    assert.notEqual(resumed.snapshot().tasks.solve?.status, 'READY');
    assert.deepEqual(resumeCodex.invocations, []);

    await resumed.execute().catch(() => undefined);
    assert.deepEqual(resumeCodex.invocations, [], 'the Solver must never be re-invoked after a crash mid-repair');
    assert.equal(resumed.snapshot().tasks.solve!.agentAttempts.length, 1);
  } finally {
    await fixture.dispose();
  }
});

/**
 * §10-§13 (real Phase 5 dogfood recovery, SECOND finding,
 * run-20260822094645-5b090308, explorer-final-review): Claude's real
 * response was `"...prose explaining the contract...\n{"status":"approved","findings":[]}"`
 * — semantically valid, but whole-text JSON.parse failed on the prose. These
 * scenarios exercise the resulting framing-extraction layer end to end
 * through the real orchestrator, still with fake agents only.
 */

function agentReturning(name: AgentName, structuredHandoff: unknown, rawStdout: string): Agent {
  return {
    name,
    async run(request) {
      const timestamp = new Date().toISOString();
      return {
        agent: name,
        runId: request.runId,
        taskId: request.taskId,
        status: 'succeeded',
        failureCode: null,
        exitCode: 0,
        signal: null,
        stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout.log`),
        stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr.log`),
        structuredHandoff,
        rawStdout,
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
    },
  };
}

// 20. Live path: a review response prefaced with prose (the exact real
// Claude failure mode) is recovered via framing, without any repair-agent
// invocation (review recovery is framing-only, by design).
test('scenario 20: a review response prefaced with prose is recovered via framing on the live path', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
    });
    // Whole-text JSON.parse of this fails (there is prose before the JSON),
    // exactly like the real Claude output; structuredHandoff is therefore
    // null, mirroring what process-agent.ts would actually have produced.
    const claudeStdout = [
      'All on-disk files match the diff exactly. This completes my verification.',
      '',
      'Note: this task requires a single JSON verdict object; providing it directly.',
      '',
      JSON.stringify(approvedReview()),
    ].join('\n');
    const claude = agentReturning('claude', null, claudeStdout);
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks.verify?.status, 'SUCCEEDED');
    assert.equal(completed.tasks.verify?.handoffOutcome, 'valid');
    assert.equal(completed.tasks.verify?.handoffRepairAttempts.length > 0, true);
    assert.equal(completed.tasks.verify?.handoffRepairAttempts.at(-1)?.succeeded, true);
    assert.equal(completed.tasks.fix?.status, 'SKIPPED');
  } finally {
    await fixture.dispose();
  }
});

// 21. Persisted FAILED recovery for a review-mode task (REVIEW_BLOCKED),
// mirroring the exact real dogfood shape: final_review recovered from its
// preserved stdout, Claude NOT re-invoked, and Judge correctly SKIPPED
// afterward because the recovered review approved.
test('scenario 21: a persisted FAILED/REVIEW_BLOCKED final_review recovers via framing, Claude is not re-invoked, and Judge is SKIPPED', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const runsRoot = join(fixture.container, 'runs');
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const before = started.snapshot();

    const worktrees = await WorktreeManager.create({ repositoryPath: fixture.repository });
    const worktree = await worktrees.createTaskWorktree({
      runId,
      taskId: 'reverify',
      baseBranch: fixture.baseBranch,
      baseSha: before.baseSha,
    });
    // Read-only task: worktree stays exactly at the prepared SHA, no changes.

    const logsDir = join(started.stateStore.runDirectory, 'logs');
    await mkdir(logsDir, { recursive: true });
    const claudeStdout = [
      'All on-disk files match the diff exactly. This completes my verification.',
      '',
      'Note: this task requires a single JSON verdict object; providing it directly.',
      '',
      JSON.stringify(approvedReview()),
    ].join('\n');
    await writeFile(
      join(logsDir, `${runId}.reverify.claude.attempt-1.stdout.log`),
      claudeStdout,
      'utf8',
    );

    const dependencyFailedError = {
      code: 'TASK_DEPENDENCY_FAILED' as const,
      message: 'A task dependency did not succeed',
      at: before.createdAt,
    };
    const failed: RunState = {
      ...before,
      status: 'FAILED',
      tasks: {
        ...before.tasks,
        solve: { ...before.tasks.solve!, status: 'SUCCEEDED', finishedAt: before.createdAt },
        verify: {
          ...before.tasks.verify!,
          status: 'SUCCEEDED',
          reviewPaths: [],
          finishedAt: before.createdAt,
        },
        fix: { ...before.tasks.fix!, status: 'SUCCEEDED', finishedAt: before.createdAt },
        reverify: {
          ...before.tasks.reverify!,
          status: 'FAILED',
          worktreePath: worktree.path,
          branch: worktree.branch,
          preparedHeadSha: before.baseSha,
          startedAt: before.createdAt,
          finishedAt: before.createdAt,
          agentAttempts: [{
            attempt: 1,
            agent: 'claude',
            startedAt: before.createdAt,
            finishedAt: before.createdAt,
            outcome: 'succeeded',
          }],
          error: { code: 'REVIEW_BLOCKED', message: 'review: must be an object', at: before.createdAt },
        },
        judge: { ...before.tasks.judge!, status: 'BLOCKED', finishedAt: before.createdAt, error: dependencyFailedError },
      },
    };
    await started.stateStore.save(failed);

    // No 'reverify' or 'judge' behavior registered: if the engine re-invoked
    // Claude for either, ScenarioAgent throws and this test fails loudly.
    const recoveryClaude = new ScenarioAgent('claude', {});
    const { orchestrator, recovered, skipped } = await AgentOrchestrator.recoverHandoffFailures(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: new ScenarioAgent('codex', {}), claude: recoveryClaude },
    });
    assert.deepEqual(recovered, ['reverify']);
    assert.deepEqual(skipped, []);
    const afterRecovery = orchestrator.snapshot();
    assert.equal(afterRecovery.tasks.reverify?.status, 'SUCCEEDED');
    assert.equal(afterRecovery.tasks.reverify?.handoffOutcome, 'valid');
    assert.equal(afterRecovery.tasks.reverify?.handoffRepairAttempts.length > 0, true);
    assert.equal(afterRecovery.tasks.reverify?.handoffRepairAttempts.at(-1)?.succeeded, true);
    // Read-only task: no commit, ever.
    assert.equal(afterRecovery.tasks.reverify?.commit, undefined);
    assert.equal(afterRecovery.tasks.judge?.status, 'PENDING');
    assert.equal(afterRecovery.status, 'RUNNING');
    assert.deepEqual(recoveryClaude.invocations, []);

    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    // The whole point of the condition: an approved recovered review must
    // SKIP the Judge, never invoke Opus after the fact.
    assert.equal(completed.tasks.judge?.status, 'SKIPPED');
    assert.deepEqual(recoveryClaude.invocations, [], 'Claude must never be re-invoked for either task');
  } finally {
    await fixture.dispose();
  }
});

// 22. Uniform coverage across roles: an implementation handoff prefaced with
// prose is ALSO recovered via framing on the live path (proves this isn't a
// review-only hack — the same mechanism applies to the handoff schema too).
test('scenario 22: an implementation handoff prefaced with prose is recovered via framing on the live path', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 1, escalation: true });
    const solveHandoff = completeHandoff() as Record<string, unknown>;
    const codexStdout = [
      'I have completed the implementation and verified it against the spec.',
      '',
      JSON.stringify(solveHandoff),
    ].join('\n');
    const codex: Agent = {
      name: 'codex',
      async run(request) {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        const inner = agentReturning('codex', null, codexStdout);
        return inner.run(request);
      },
    };
    const claude = new ScenarioAgent('claude', { verify: () => approvedReview() });
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.tasks.solve?.status, 'SUCCEEDED');
    assert.equal(completed.tasks.solve?.handoffOutcome, 'valid');
    assert.equal(completed.tasks.solve?.handoffRepairAttempts.length > 0, true);
    assert.equal(completed.tasks.solve?.handoffRepairAttempts.at(-1)?.succeeded, true);
    assert.ok(completed.tasks.solve?.commit?.sha);
  } finally {
    await fixture.dispose();
  }
});

/**
 * §7 (real Phase 5 dogfood recovery, THIRD finding, integration gate
 * command-order defect): AgentOrchestrator.retryIntegrationGate retries
 * ONLY the deterministic gate for a run BLOCKED specifically with
 * INTEGRATION_TEST_FAILED, reusing the exact same integration worktree and
 * headSha checkpoint (integrateAndVerify() already re-validates that before
 * re-running the gate) — no task is touched, no agent is invoked.
 */
test('retryIntegrationGate: retries only the gate after a fix, reusing the same checkpoint, without re-invoking any agent', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);

    const runsRoot = join(fixture.container, 'runs');
    const phaseFile = join(fixture.container, 'phase.yaml');
    const failingGateYaml = `
phase: retry-gate-test
name: Retry gate scenario
baseBranch: ${fixture.baseBranch}
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
  commands:
    - node -e "process.exit(1)"
`;
    await writeFile(phaseFile, failingGateYaml, 'utf8');

    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
    });
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex, claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const failed = await started.execute();
    assert.equal(failed.status, 'BLOCKED');
    assert.equal(failed.integration.status, 'BLOCKED');
    assert.equal(failed.integration.error?.code, 'INTEGRATION_TEST_FAILED');
    const originalIntegratedCommits = failed.integration.integratedTaskCommits;
    const originalHeadSha = failed.integration.headSha;
    assert.deepEqual(codex.invocations, ['solve']);

    // Simulate the real fix: correct the phase file's OWN persisted
    // snapshot (mirroring editing phase5.real.yaml between attempts).
    const snapshotPath = join(started.stateStore.runDirectory, 'phase.yaml');
    await writeFile(snapshotPath, failingGateYaml.replace('process.exit(1)', 'process.exit(0)'), 'utf8');

    // No 'solve' behavior registered: if the engine re-invoked the Solver
    // for a gate-only retry, ScenarioAgent throws and this fails loudly.
    const retryCodex = new ScenarioAgent('codex', {});
    const retried = await AgentOrchestrator.retryIntegrationGate(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: retryCodex, claude: new ScenarioAgent('claude', {}) },
    });
    assert.equal(retried.snapshot().status, 'RUNNING');
    assert.equal(retried.snapshot().integrationAttempts?.length, 1);
    assert.equal(retried.snapshot().integrationAttempts?.[0]?.error?.code, 'INTEGRATION_TEST_FAILED');

    // The archived log directory preserves the ORIGINAL failing output —
    // never overwritten in place by the retry.
    const archivedLogDir = join(started.stateStore.runDirectory, 'logs', 'integration-attempt-1');
    const archivedFiles = await readdir(archivedLogDir);
    assert.ok(archivedFiles.length > 0, 'the original failed attempt\'s logs must be preserved');

    const completed = await retried.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.integration.status, 'SUCCEEDED');
    // Same worktree/checkpoint reused verbatim: no re-cherry-pick.
    assert.deepEqual(completed.integration.integratedTaskCommits, originalIntegratedCommits);
    assert.equal(completed.integration.headSha, originalHeadSha);
    assert.deepEqual(retryCodex.invocations, [], 'no agent may be re-invoked for a gate-only retry');
  } finally {
    await fixture.dispose();
  }
});

test('retryIntegrationGate refuses when the run is not BLOCKED, and refuses when blocked for a different reason', async () => {
  const { fixture, write } = await setUp();
  try {
    const phaseFile = await write({ maxCorrectionRounds: 0 });
    const runsRoot = join(fixture.container, 'runs');
    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
    });
    const claude = new ScenarioAgent('claude', { verify: () => approvedReview() });
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex, claude },
    });
    const runId = started.snapshot().runId;
    const completed = await started.execute();
    assert.equal(completed.status, 'COMPLETED');

    // Not BLOCKED at all (it's COMPLETED) -- must refuse.
    await assert.rejects(
      AgentOrchestrator.retryIntegrationGate(runId, { repositoryPath: fixture.repository, runsRoot }),
      /not BLOCKED/,
    );

    // Now hand-construct a run BLOCKED for an unrelated reason (an
    // INTEGRATION_CONFLICT, which needs real human conflict resolution, not
    // an automatic gate-only retry).
    const before = started.snapshot();
    const wrongReason: RunState = {
      ...before,
      status: 'BLOCKED',
      integration: {
        ...before.integration,
        status: 'BLOCKED',
        error: { code: 'INTEGRATION_CONFLICT', message: 'conflict', at: before.createdAt },
      },
    };
    await started.stateStore.save(wrongReason);
    await assert.rejects(
      AgentOrchestrator.retryIntegrationGate(runId, { repositoryPath: fixture.repository, runsRoot }),
      /not INTEGRATION_TEST_FAILED/,
    );
  } finally {
    await fixture.dispose();
  }
});

/**
 * §8 (real Phase 5 dogfood recovery, THIRD structural finding): the
 * integrated source itself sometimes needs a small, auditable correction
 * after a real INTEGRATION_TEST_FAILED — applyIntegrationFix commits an
 * ALREADY-MADE, uncommitted edit in the existing integration worktree as one
 * new commit on top of the existing head, enforcing the same ownership gate
 * every task commit already goes through, and rejecting a smuggled
 * migration/package.json/lockfile change regardless of ownership.
 */
test('applyIntegrationFix: commits a narrow source correction on top of the existing integration head, then the retried gate passes', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);

    const runsRoot = join(fixture.container, 'runs');
    const phaseFile = join(fixture.container, 'phase.yaml');
    const gateYaml = `
phase: fix-gate-test
name: Integration fix scenario
baseBranch: ${fixture.baseBranch}
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
  commands:
    - node -e "process.exit(require('fs').readFileSync('feature.txt','utf8').trim()==='implemented-fixed'?0:1)"
`;
    await writeFile(phaseFile, gateYaml, 'utf8');

    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
    });
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex, claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const failed = await started.execute();
    assert.equal(failed.status, 'BLOCKED');
    assert.equal(failed.integration.error?.code, 'INTEGRATION_TEST_FAILED');
    const integrationWorktree = failed.integration.worktreePath!;
    assert.deepEqual(codex.invocations, ['solve']);

    // The actual "fix": a human/Codex edits the already-integrated source
    // directly in the existing integration worktree (uncommitted so far).
    await writeFile(join(integrationWorktree, 'feature.txt'), 'implemented-fixed', 'utf8');

    const fixed = await AgentOrchestrator.applyIntegrationFix(
      runId,
      { repositoryPath: fixture.repository, runsRoot },
      { summary: 'Fix feature.txt content for the gate check.', ownership: ['feature.txt'] },
    );
    assert.equal(fixed.snapshot().status, 'RUNNING');
    assert.equal(fixed.snapshot().integrationAttempts?.length, 1);
    assert.equal(fixed.snapshot().integration.integrationFixCommits?.length, 1);
    const fixCommit = fixed.snapshot().integration.integrationFixCommits![0]!;
    assert.notEqual(fixCommit, failed.integration.headSha);

    const retryCodex = new ScenarioAgent('codex', {});
    const completed = await AgentOrchestrator.resume(runId, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex: retryCodex, claude: new ScenarioAgent('claude', {}) },
    }).then((orchestrator) => orchestrator.execute());
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(completed.integration.headSha, fixCommit);
    assert.deepEqual(retryCodex.invocations, [], 'no agent may be re-invoked for an integration-fix retry');
  } finally {
    await fixture.dispose();
  }
});

test('applyIntegrationFix refuses a change outside the given ownership, and refuses a smuggled package.json change', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);

    const runsRoot = join(fixture.container, 'runs');
    const phaseFile = join(fixture.container, 'phase.yaml');
    await writeFile(
      phaseFile,
      `
phase: fix-gate-ownership-test
name: Integration fix ownership scenario
baseBranch: ${fixture.baseBranch}
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
  commands:
    - node -e "process.exit(1)"
`,
      'utf8',
    );

    const codex = new ScenarioAgent('codex', {
      solve: async (request) => {
        await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented', 'utf8');
        return completeHandoff();
      },
    });
    const started = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot,
      agents: { codex, claude: new ScenarioAgent('claude', {}) },
    });
    const runId = started.snapshot().runId;
    const failed = await started.execute();
    const integrationWorktree = failed.integration.worktreePath!;

    // Edit a file outside the declared ownership. ensureTaskCommit commits
    // BEFORE the ownership check runs (the same pre-existing pattern
    // finishParsedHandoff already uses, so the rejected attempt stays
    // forensically inspectable) -- so a real commit lands on the worktree
    // even though this call rejects; hard-reset back to the pre-attempt
    // head to test the next scenario from a clean starting point.
    await writeFile(join(integrationWorktree, 'other.txt'), 'sneaky', 'utf8');
    await assert.rejects(
      AgentOrchestrator.applyIntegrationFix(
        runId,
        { repositoryPath: fixture.repository, runsRoot },
        { summary: 'attempted fix', ownership: ['feature.txt'] },
      ),
    );
    await fixture.git.run(integrationWorktree, ['reset', '--hard', failed.integration.headSha!]);
    await fixture.git.run(integrationWorktree, ['clean', '-fd']);

    // Edit package.json -- forbidden regardless of declared ownership.
    await writeFile(join(integrationWorktree, 'package.json'), '{"name":"sneaky"}', 'utf8');
    await assert.rejects(
      AgentOrchestrator.applyIntegrationFix(
        runId,
        { repositoryPath: fixture.repository, runsRoot },
        { summary: 'attempted fix', ownership: ['package.json'] },
      ),
      /forbidden migration\/schema\/dependency file/,
    );
  } finally {
    await fixture.dispose();
  }
});
