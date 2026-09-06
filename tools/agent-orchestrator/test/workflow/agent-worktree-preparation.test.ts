import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { buildAgentPrompt, type Agent, type AgentRequest, type AgentResult } from '../../src/agents';
import { parsePhaseConfigYaml } from '../../src/config';
import { AgentOrchestrator } from '../../src/orchestrator';
import { createTemporaryRepository } from '../git/helpers';

class PreparedAgent implements Agent {
  readonly name = 'codex' as const;
  readonly invocations: AgentRequest[] = [];
  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    await request.onStarted?.(process.pid);
    assert.equal(await readFile(join(request.worktreePath, '.prepared'), 'utf8'), 'ready');
    await writeFile(join(request.worktreePath, 'feature.txt'), 'implemented\n', 'utf8');
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded',
      failureCode: null, exitCode: 0, signal: null,
      stdoutPath: join(request.artifactsDirectory, 'fake.stdout'), stderrPath: join(request.artifactsDirectory, 'fake.stderr'),
      structuredHandoff: {
        status: 'complete', summary: 'implemented after preparation', filesChanged: ['feature.txt'],
        decisions: [], tests: [{ command: 'test', result: 'pass', details: 'ok' }],
        openQuestions: [], reviewRequested: [],
      },
      changedFiles: ['feature.txt'], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: now, endedAt: now, durationMs: 1, timedOut: false, aborted: false, errorMessage: null,
    };
  }
}

function phase(baseBranch: string, command: string, withPreparation = true): string {
  return `phase: prepare-test
name: Agent preparation
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 1
maxReviewRounds: 1
agentRetries: 0
agentTimeoutMs: 60000
${withPreparation ? `agentWorktree:
  prepare:
    - command: ${command}
      required: true
      timeoutMs: 10000
` : ''}tasks:
  - id: implement
    title: Implement feature
    owner: codex
    effort: high
    mode: implementation
    files: [feature.txt]
    dependsOn: []
    writer: true
    instructions: bounded
integration:
  commands: []
`;
}

test('task worktree preparation runs before the agent, persists logs/timing, and the orchestrator commits', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, '.gitignore'), '.prepared\n', 'utf8');
    await writeFile(join(fixture.repository, 'design.md'), '# design\n', 'utf8');
    await writeFile(join(fixture.repository, 'feature.txt'), 'base\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', '.gitignore', 'design.md', 'feature.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'fixture']);
    const phaseFile = join(fixture.container, 'phase.yaml');
    await writeFile(phaseFile, phase(fixture.baseBranch, `node -e "require('fs').writeFileSync('.prepared','ready');process.stdout.write('prepared')"`), 'utf8');
    const agent = new PreparedAgent();
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot: join(fixture.container, 'runs'), agents: { codex: agent },
    });
    const completed = await orchestrator.execute();
    const task = completed.tasks.implement!;
    assert.equal(completed.status, 'COMPLETED');
    assert.equal(agent.invocations.length, 1);
    assert.equal(task.preparation?.status, 'SUCCEEDED');
    assert.equal(task.preparation?.commands.length, 1);
    assert.equal(task.preparation?.commands[0]?.exitCode, 0);
    assert.ok((task.preparation?.commands[0]?.durationMs ?? -1) >= 0);
    assert.ok(task.commit?.sha);
    assert.deepEqual(task.commit?.changedFiles, ['feature.txt']);
    await access(task.preparation!.commands[0]!.stdoutPath);
    assert.equal(await readFile(task.preparation!.commands[0]!.stdoutPath, 'utf8'), 'prepared');
    const events = (await readFile(orchestrator.stateStore.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { name: string });
    assert.ok(events.findIndex((event) => event.name === 'AGENT_WORKTREE_PREPARATION_STARTED') < events.findIndex((event) => event.name === 'AGENT_STARTED'));
    assert.match(buildAgentPrompt(agent.invocations[0]!), /Do not run git commit/);
    await orchestrator.cleanup();
  } finally { await fixture.dispose(); }
});

test('required preparation failure is distinct and prevents agent invocation', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# design\n', 'utf8');
    await writeFile(join(fixture.repository, 'feature.txt'), 'base\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'fixture']);
    const phaseFile = join(fixture.container, 'phase.yaml');
    await writeFile(phaseFile, phase(fixture.baseBranch, `node -e "process.stderr.write('failed prepare');process.exit(7)"`), 'utf8');
    const agent = new PreparedAgent();
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot: join(fixture.container, 'runs'), agents: { codex: agent },
    });
    const completed = await orchestrator.execute();
    assert.equal(agent.invocations.length, 0);
    assert.equal(completed.tasks.implement?.error?.code, 'AGENT_WORKTREE_PREPARATION_FAILED');
    assert.equal(completed.tasks.implement?.preparation?.commands[0]?.exitCode, 7);
    assert.match(await readFile(completed.tasks.implement!.preparation!.commands[0]!.stderrPath, 'utf8'), /failed prepare/);
    await orchestrator.cleanup();
  } finally { await fixture.dispose(); }
});

test('agent worktree preparation is optional and rejects invalid command timeouts', () => {
  const omitted = parsePhaseConfigYaml(phase('main', 'node --version', false));
  assert.deepEqual(omitted.agentWorktree.prepare, []);
  assert.throws(
    () => parsePhaseConfigYaml(phase('main', 'node --version').replace('timeoutMs: 10000', 'timeoutMs: 0')),
    /agentWorktree\.prepare\[0\]\.timeoutMs/,
  );
});
