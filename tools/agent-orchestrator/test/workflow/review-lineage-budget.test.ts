import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import { completedReviewRounds } from '../../src/review/lineage';
import type { RunEvent, RunState } from '../../src/state';
import { TaskGraph, type TaskCondition, type TaskMode } from '../../src/tasks';
import { createTemporaryRepository } from '../git/helpers';

interface Task {
  id: string;
  mode: TaskMode;
  dependsOn: string[];
  files: string[];
  condition?: TaskCondition;
}

function task(id: string, mode: TaskMode, dependsOn: string[], files: string[] = [], reviewOf?: string): Task {
  return { id, mode, dependsOn, files, ...(reviewOf === undefined ? {} : {
    condition: { reviewOf, skipIfStatus: ['approved'] },
  }) };
}

function workstream(prefix: string, dependencies: string[] = []): Task[] {
  return [
    task(`${prefix}-impl`, 'implementation', dependencies, [`${prefix}.txt`]),
    task(`${prefix}-review`, 'review', [`${prefix}-impl`]),
    task(`${prefix}-fix`, 'correction', [`${prefix}-review`], [`${prefix}.txt`], `${prefix}-review`),
    task(`${prefix}-final-review`, 'final_review', [`${prefix}-fix`], [], `${prefix}-review`),
  ];
}

class ReviewAgent implements Agent {
  readonly invocations: string[] = [];
  constructor(readonly name: AgentName, private tasks: Task[], private approved: readonly string[]) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request.taskId);
    await request.onStarted?.(process.pid);
    const spec = this.tasks.find((entry) => entry.id === request.taskId)!;
    let output: unknown;
    if (spec.files.length > 0) {
      for (const file of spec.files) await writeFile(join(request.worktreePath, file), spec.id, 'utf8');
      output = {
        status: 'complete', summary: spec.id, filesChanged: spec.files, decisions: [],
        tests: [], openQuestions: [], reviewRequested: [],
      };
    } else {
      output = spec.mode === 'final_review' || spec.mode === 'synthesis' || this.approved.includes(spec.id)
        ? { status: 'approved', findings: [] }
        : { status: 'changes_requested', findings: [{
          id: 'F001', severity: 'low', category: 'testing', file: 'README.md', location: '',
          problem: 'Missing example.', evidence: 'The example is absent.', impact: 'Harder to verify.',
          suggestedFix: 'Add the example.', verificationRequired: 'Inspect the example.',
        }] };
    }
    const timestamp = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: spec.id, status: 'succeeded', failureCode: null,
      exitCode: 0, signal: null, stdoutPath: join(request.artifactsDirectory, `${spec.id}.stdout.log`),
      stderrPath: join(request.artifactsDirectory, `${spec.id}.stderr.log`), structuredHandoff: output,
      changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: timestamp, endedAt: timestamp, durationMs: 0, timedOut: false, aborted: false, errorMessage: null,
    };
  }
}

async function runWorkflow(
  tasks: Task[],
  options: { maxReviewRounds?: number; concurrency?: number; approved?: string[] },
  check: (result: {
    state: RunState; events: RunEvent[]; invocations: string[];
    orchestrator: AgentOrchestrator;
    repositoryPath: string; runsRoot: string; agents: { codex: ReviewAgent; claude: ReviewAgent };
  }) => Promise<void> | void,
): Promise<void> {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# Design\n');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'design']);
    const phaseFile = join(fixture.container, 'phase.yaml');
    await writeFile(phaseFile, JSON.stringify({
      phase: 'lineage', name: 'Review lineage regression', baseBranch: fixture.baseBranch,
      canonicalDesignDocument: 'design.md', maxReviewRounds: options.maxReviewRounds ?? 2,
      concurrency: options.concurrency ?? 1,
      tasks: tasks.map((entry) => ({ ...entry, title: entry.id, owner: entry.files.length ? 'codex' : 'claude' })),
      integration: { commands: ['node -e "process.exit(0)"'] },
    }));
    const agents = {
      codex: new ReviewAgent('codex', tasks, options.approved ?? []),
      claude: new ReviewAgent('claude', tasks, options.approved ?? []),
    };
    const runsRoot = join(fixture.container, 'runs');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot, agents,
    });
    const state = await orchestrator.execute();
    assert.deepEqual(JSON.parse(await readFile(join(orchestrator.stateStore.runDirectory, 'run.json'), 'utf8')), state);
    const events = (await readFile(join(orchestrator.stateStore.runDirectory, 'events.jsonl'), 'utf8'))
      .trim().split('\n').map((line) => JSON.parse(line) as RunEvent);
    await check({ state, events, orchestrator, invocations: [...agents.codex.invocations, ...agents.claude.invocations],
      repositoryPath: fixture.repository, runsRoot, agents });
  } finally {
    await fixture.dispose();
  }
}

function assertRound(state: RunState, events: RunEvent[], id: string, round: number): void {
  assert.equal(state.tasks[id]?.status, 'SUCCEEDED', id);
  assert.equal(state.tasks[id]?.agentAttempts.length, 1, id);
  assert.equal(state.tasks[id]?.reviewRounds, 1, 'persisted reviewRounds is per task');
  assert.deepEqual(events.filter((event) => event.name === 'REVIEW_STARTED' && event.taskId === id)
    .map((event) => event.data?.round), [round], id);
}

const sequential = () => [...workstream('core'), ...workstream('realtime', ['core-final-review'])];

test('sequential core and realtime workstreams each invoke initial and final reviewers as rounds 1 and 2', async () => {
  await runWorkflow(sequential(), {}, ({ state, events, invocations }) => {
    assert.equal(state.status, 'COMPLETED');
    for (const prefix of ['core', 'realtime']) {
      assertRound(state, events, `${prefix}-review`, 1);
      assertRound(state, events, `${prefix}-final-review`, 2);
      assert.ok(invocations.includes(`${prefix}-fix`));
    }
  });
});

test('a third review linked to the same initial review is blocked after two rounds and cannot use existing recovery primitives', async () => {
  const third = task('third', 'review', ['realtime-final-review'], [], 'realtime-review');
  await runWorkflow([...sequential(), third], {}, async ({ state, events, invocations, ...options }) => {
    assertRound(state, events, 'realtime-review', 1);
    assertRound(state, events, 'realtime-final-review', 2);
    assert.equal(state.tasks.third?.error?.code, 'BLOCKED_FOR_HUMAN_REVIEW');
    assert.deepEqual(state.tasks.third?.error?.details, { completedRounds: 2, maxReviewRounds: 2 });
    assert.equal(state.tasks.third?.agentAttempts.length, 0);
    assert.equal(state.tasks.third?.reviewRounds, 0);
    assert.ok(!invocations.includes('third'));
    assert.ok(!events.some((event) => event.name === 'REVIEW_STARTED' && event.taskId === 'third'));
    // Only this temporary run is touched. A terminal pre-invocation guard
    // failure is deliberately outside the existing recovery contracts.
    await assert.rejects(AgentOrchestrator.retryAgentFailure(state.runId, 'third', options),
      (error) => isOrchestratorError(error, 'TASK_STATE_INVALID'));
    const recovered = await AgentOrchestrator.recoverHandoffFailures(state.runId, options);
    assert.deepEqual(recovered.recovered, []);
    const resumed = await AgentOrchestrator.resume(state.runId, options);
    assert.equal(resumed.snapshot().tasks.third?.status, state.tasks.third?.status);
    assert.equal(resumed.snapshot().tasks.third?.agentAttempts.length, 0);
  });
});

test('parallel workstreams after a shared reviewed ancestor each receive an independent two-round budget', async () => {
  await runWorkflow([
    ...workstream('shared'), ...workstream('left', ['shared-final-review']), ...workstream('right', ['shared-final-review']),
  ], { concurrency: 2 }, ({ state, events, invocations }) => {
    assert.equal(state.status, 'COMPLETED');
    for (const prefix of ['shared', 'left', 'right']) {
      assertRound(state, events, `${prefix}-review`, 1);
      assertRound(state, events, `${prefix}-final-review`, 2);
      assert.ok(invocations.includes(`${prefix}-fix`));
    }
  });
});

test('unconditioned reviews in legacy chains now start fresh explicit budget lineages', async () => {
  await runWorkflow([
    task('oak', 'implementation', [], ['one.txt']), task('birch', 'review', ['oak']),
    task('elm', 'correction', ['birch'], ['one.txt']), task('ash', 'final_review', ['elm']),
    task('maple', 'implementation', ['ash'], ['two.txt']), task('pine', 'review', ['maple']),
    task('yew', 'correction', ['pine'], ['two.txt']), task('fir', 'final_review', ['yew']),
    task('cedar', 'review', ['fir']),
  ], {}, ({ state, events }) => {
    assertRound(state, events, 'birch', 1);
    assertRound(state, events, 'ash', 1);
    assertRound(state, events, 'pine', 1);
    assertRound(state, events, 'fir', 1);
    assertRound(state, events, 'cedar', 1);
    assert.equal(state.status, 'COMPLETED');
  });
});

test('skipped correction and final review consume no round, including a subsequent review in the same lineage', async () => {
  await runWorkflow([
    ...workstream('core'), task('audit', 'final_review', ['core-final-review']),
    ...workstream('realtime', ['audit']),
  ], { approved: ['core-review'] }, ({ state, events, invocations }) => {
    assert.equal(state.status, 'COMPLETED');
    for (const id of ['core-fix', 'core-final-review']) {
      assert.equal(state.tasks[id]?.status, 'SKIPPED');
      assert.equal(state.tasks[id]?.reviewRounds, 0);
      assert.equal(state.tasks[id]?.agentAttempts.length, 0);
      assert.ok(!invocations.includes(id));
    }
    assertRound(state, events, 'core-review', 1);
    assertRound(state, events, 'audit', 1);
    assertRound(state, events, 'realtime-review', 1);
    assertRound(state, events, 'realtime-final-review', 2);
  });
});

test('maxReviewRounds of one blocks a final review on its own initial review', async () => {
  await runWorkflow(workstream('single'), { maxReviewRounds: 1 }, ({ state, events }) => {
    assertRound(state, events, 'single-review', 1);
    assert.equal(state.tasks['single-final-review']?.error?.code, 'BLOCKED_FOR_HUMAN_REVIEW');
    assert.deepEqual(state.tasks['single-final-review']?.error?.details, { completedRounds: 1, maxReviewRounds: 1 });
    assert.equal(state.tasks['single-final-review']?.agentAttempts.length, 0);
  });
});

test('an explicit reviewOf selects its own lineage when another reviewed workstream is also an ancestor', async () => {
  const tasks = [...workstream('first'), ...workstream('second', ['first-final-review'])];
  tasks.find((entry) => entry.id === 'second-final-review')!.dependsOn.push('first-final-review');
  await runWorkflow(tasks, {}, ({ state, events }) => {
    assert.equal(state.status, 'COMPLETED');
    assertRound(state, events, 'second-final-review', 2);
  });
});

test('an unconditioned synthesis after a join starts a fresh review budget', async () => {
  await runWorkflow([
    task('seed', 'implementation', [], ['seed.txt']),
    task('one', 'review', ['seed']), task('two', 'review', ['seed']),
    task('combined', 'synthesis', ['one', 'two']),
  ], { concurrency: 2 }, ({ state, events }) => {
    assertRound(state, events, 'one', 1);
    assertRound(state, events, 'two', 1);
    assertRound(state, events, 'combined', 1);
    assert.equal(state.status, 'COMPLETED');
  });
});

test('four reviewed workstreams joined by testing do not consume a new unconditioned final review budget', async () => {
  const tasks = ['a', 'b', 'c', 'd'].flatMap((prefix) => [
    task(`${prefix}-impl`, 'implementation', [], [`${prefix}.txt`]),
    task(`${prefix}-review`, 'review', [`${prefix}-impl`]),
  ]);
  tasks.push(task('composed', 'testing', ['a-review', 'b-review', 'c-review', 'd-review'], ['composed.txt']));
  tasks.push(task('phase-final', 'final_review', ['composed']));
  await runWorkflow(tasks, { concurrency: 4 }, ({ state, events, agents, orchestrator }) => {
    assert.equal(state.status, 'COMPLETED');
    const spec = orchestrator.config.tasks.find((entry) => entry.id === 'phase-final')!;
    assert.equal(completedReviewRounds(spec, new TaskGraph(orchestrator.config.tasks), (id) => state.tasks[id]?.status === 'SUCCEEDED'), 0);
    assertRound(state, events, 'phase-final', 1);
    assert.equal(agents.claude.invocations.filter((id) => id === 'phase-final').length, 1);
  });
});

test('an explicit reviewOf after a multi-lineage join counts only the selected lineage', async () => {
  await runWorkflow([
    task('a-impl', 'implementation', [], ['a.txt']), task('a-review', 'review', ['a-impl']),
    task('b-impl', 'implementation', [], ['b.txt']), task('b-review', 'review', ['b-impl']),
    task('composed', 'testing', ['a-review', 'b-review'], ['composed.txt']),
    task('phase-final', 'final_review', ['composed'], [], 'a-review'),
  ], {}, ({ state, events }) => {
    assert.equal(state.status, 'COMPLETED');
    assertRound(state, events, 'phase-final', 2);
  });
});

test('intermediate correction, testing, and synthesis do not erase an explicitly selected lineage', async () => {
  await runWorkflow([
    task('impl', 'implementation', [], ['shared.txt']), task('initial', 'review', ['impl']),
    task('fix', 'correction', ['initial'], ['shared.txt'], 'initial'),
    task('test', 'testing', ['fix'], ['test.txt']), task('summary', 'synthesis', ['test']),
    task('final', 'final_review', ['summary'], [], 'initial'),
  ], {}, ({ state, events }) => {
    assert.equal(state.status, 'COMPLETED');
    assertRound(state, events, 'initial', 1);
    assertRound(state, events, 'summary', 1);
    assertRound(state, events, 'final', 2);
  });
});

test('a review directly depending on another review without reviewOf starts a fresh lineage', async () => {
  await runWorkflow([
    task('impl', 'implementation', [], ['shared.txt']), task('first', 'review', ['impl']), task('second', 'final_review', ['first']),
  ], {}, ({ state, events }) => {
    assert.equal(state.status, 'COMPLETED');
    assertRound(state, events, 'first', 1);
    assertRound(state, events, 'second', 1);
  });
});
