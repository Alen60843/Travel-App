import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import {
  buildAgentPrompt,
  defaultAccessForRole,
  type Agent,
  type AgentName,
  type AgentRequest,
  type AgentResult,
  type AgentRole,
} from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { renderStatus } from '../../src/cli';
import { AgentOrchestrator } from '../../src/orchestrator';
import { parseTaskSpec } from '../../src/tasks/task-schema';
import { createTemporaryRepository } from '../git/helpers';

const BOUNDED_REVIEW_RULES = [
  'Start from taskSpecification.actualDependencyDiff and the explicit task invariants.',
  'Inspect extra repository files only to prove or disprove a concrete suspicion',
  'Do not perform broad speculative repository exploration',
  'rediscover or redesign the complete architecture',
  'review unrelated modules',
  'mentally re-implement the task',
  'Prefer evidence from changed files, directly referenced schema/contracts, and immediately relevant existing code.',
  'Report only material findings supported by concrete evidence and impact',
  'Finish within the allocated execution budget.',
] as const;

test('review prompt is read-only, starts from the actual diff, and contains every bounded-review rule', () => {
  assert.equal(defaultAccessForRole('review'), 'read_only');
  const prompt = buildAgentPrompt(makeRequest('review'));
  assert.match(prompt, /This is a read-only task\. Do not modify files/);
  assert.match(prompt, /DIFF_MARKER: changed implementation/);
  assert.match(prompt, /Approve when no material defect is found/);
  for (const rule of BOUNDED_REVIEW_RULES) assert.ok(prompt.includes(rule), rule);
});

test('final_review uses the equivalent bounded rules and retains correction-focused evidence', () => {
  assert.equal(defaultAccessForRole('final_review'), 'read_only');
  const prompt = buildAgentPrompt(makeRequest('final_review'));
  for (const rule of BOUNDED_REVIEW_RULES) assert.ok(prompt.includes(rule), rule);
  assert.match(prompt, /prior findings, correction responses, and tests/);
  assert.match(prompt, /Approve when no material defect remains/);
});

test('escalation remains a bounded read-only arbitration rather than a new repository review', () => {
  assert.equal(defaultAccessForRole('escalation'), 'read_only');
  const prompt = buildAgentPrompt(makeRequest('escalation'));
  for (const rule of BOUNDED_REVIEW_RULES) assert.ok(prompt.includes(rule), rule);
  assert.match(prompt, /single bounded arbitration, not a new review round/);
  assert.match(prompt, /use "blocked" only for a concrete unresolved dispute/);
});

test('implementation role is not incorrectly constrained by reviewer-only exploration rules', () => {
  assert.equal(defaultAccessForRole('implementation'), 'writer');
  const prompt = buildAgentPrompt(makeRequest('implementation'));
  assert.match(prompt, /Implement the smallest complete change/);
  for (const rule of BOUNDED_REVIEW_RULES) assert.equal(prompt.includes(rule), false, rule);
  assert.doesNotMatch(prompt, /This is a read-only task/);
  assert.doesNotMatch(prompt, /propose additionalWorkRequests/);
});

test('adaptive tasks may propose work but are explicitly denied grant or launch authority', () => {
  const prompt = buildAgentPrompt({ ...makeRequest('review'), adaptive: true });
  assert.match(prompt, /only propose additionalWorkRequests in the structured response/);
  assert.match(prompt, /cannot grant or directly launch another agent/);
});

test('synthesis defaults to read-only and is bounded to supplied structured findings', () => {
  assert.equal(defaultAccessForRole('synthesis'), 'read_only');
  const prompt = buildAgentPrompt({ ...makeRequest('synthesis'), adaptive: true });
  assert.match(prompt, /Synthesize only the supplied structured findings/);
  assert.match(prompt, /Do not restart repository exploration/);
});

test('actualDependencyDiff and exact response-schema protocol remain in the generated prompt', () => {
  const prompt = buildAgentPrompt(makeRequest('review'));
  assert.match(prompt, /"actualDependencyDiff": "DIFF_MARKER: changed implementation"/);
  assert.match(prompt, /final response must be exactly one JSON object/);
  assert.match(prompt, /precisely the property names shown/);
  assert.match(prompt, /Do not wrap the JSON in Markdown fences or add any text before or after it/);
});

test('task timeout overrides the phase timeout while an omitted task timeout uses the phase default', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'add design']);
    const phaseFile = join(fixture.container, 'timeouts.yaml');
    await writeFile(phaseFile, `
phase: timeout-contract
name: Timeout contract
baseBranch: ${fixture.baseBranch}
canonicalDesignDocument: design.md
agentTimeoutMs: 54321
concurrency: 2
tasks:
  - id: override-review
    title: Override review
    owner: claude
    mode: review
    effort: high
    timeoutMs: 12345
  - id: default-review
    title: Default review
    owner: claude
    mode: review
    effort: high
integration:
  commands:
    - node -e "process.exit(0)"
`, 'utf8');
    const claude = new CapturingAgent('claude');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository,
      runsRoot: join(fixture.container, 'runs'),
      agents: { claude, codex: new CapturingAgent('codex') },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(claude.requests.find((request) => request.taskId === 'override-review')?.timeoutMs, 12_345);
    assert.equal(claude.requests.find((request) => request.taskId === 'default-review')?.timeoutMs, 54_321);
    assert.equal(completed.tasks['override-review']?.agentAttempts[0]?.timeoutMs, 12_345);
    assert.equal(completed.tasks['default-review']?.agentAttempts[0]?.timeoutMs, 54_321);
    assert.equal(completed.tasks['override-review']?.agentAttempts[0]?.durationMs, 0);
    assert.match(renderStatus(completed), /"configuredTimeoutMs": 12345/);
    assert.match(renderStatus(completed), /"lastPersistedLifecycleEvent": "TASK_SUCCEEDED"/);
    assert.ok(claude.requests.every((request) =>
      Object.hasOwn(request.taskSpecification as object, 'actualDependencyDiff')));
    assert.equal((await orchestrator.cleanup()).length, 3);
  } finally {
    await fixture.dispose();
  }
});

test('invalid task timeout values fail strict task validation', () => {
  for (const timeoutMs of [999, 86_400_001, 1_000.5, '1000']) {
    assert.throws(
      () => parseTaskSpec({
        id: 'review',
        title: 'Review',
        owner: 'claude',
        mode: 'review',
        effort: 'high',
        timeoutMs,
      }, 0),
      (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
    );
  }
});

class CapturingAgent implements Agent {
  readonly requests: AgentRequest[] = [];

  constructor(readonly name: AgentName) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.requests.push(request);
    await request.onStarted?.(process.pid);
    return successfulResult(this.name, request, { status: 'approved', findings: [] });
  }
}

function makeRequest(role: AgentRole): AgentRequest {
  return {
    runId: 'run-role-contract',
    taskId: `${role}-task`,
    role,
    worktreePath: '/tmp/read-only-worktree',
    baseSha: 'a'.repeat(40),
    taskSpecification: {
      actualDependencyDiff: 'DIFF_MARKER: changed implementation',
      explicitInvariant: 'authorization remains owner-scoped',
      responseSchema: { status: 'approved | changes_requested', findings: [] },
    },
    canonicalDesignDocumentPath: '/tmp/design.md',
    allowedFileOwnership: [],
    dependencyHandoffs: [],
    previousReviewFindings: [],
    requestedEffort: 'high',
    timeoutMs: 60_000,
    artifactsDirectory: '/tmp/artifacts',
  };
}

function successfulResult(
  agent: AgentName,
  request: AgentRequest,
  structuredHandoff: unknown,
): AgentResult {
  const timestamp = new Date().toISOString();
  return {
    agent,
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
