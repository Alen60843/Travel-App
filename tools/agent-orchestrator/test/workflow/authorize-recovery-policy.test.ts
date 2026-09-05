import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import { hashRecoveryPolicy } from '../../src/recovery/policy';
import { createTemporaryRepository, type TemporaryRepository } from '../git/helpers';

class NeverAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(readonly name: 'codex' | 'claude') {}
  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    throw new Error(`unexpected agent invocation for role ${request.role}`);
  }
}

function phaseYaml(baseBranch: string): string {
  return `
phase: authorize-recovery-policy-test
name: Authorize recovery policy
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
concurrency: 2
tasks:
  - id: solo-task
    title: Solo task
    owner: codex
    mode: implementation
    effort: medium
    files: [feature.txt]
`;
}

interface Scenario {
  readonly fixture: TemporaryRepository;
  readonly runsRoot: string;
  readonly runId: string;
  readonly codex: NeverAgent;
  readonly claude: NeverAgent;
  readonly orchestrator: AgentOrchestrator;
}

async function createScenario(): Promise<Scenario> {
  const fixture = await createTemporaryRepository();
  await writeFile(join(fixture.repository, 'design.md'), '# Design\n', 'utf8');
  await writeFile(join(fixture.repository, 'feature.txt'), 'base\n', 'utf8');
  await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt']);
  await fixture.git.run(fixture.repository, ['commit', '-m', 'baseline']);
  const runsRoot = join(fixture.container, 'runs');
  const phaseFile = join(fixture.container, 'phase.yaml');
  await writeFile(phaseFile, phaseYaml(fixture.baseBranch), 'utf8');
  const codex = new NeverAgent('codex');
  const claude = new NeverAgent('claude');
  const orchestrator = await AgentOrchestrator.start(phaseFile, {
    repositoryPath: fixture.repository, runsRoot, agents: { codex, claude },
  });
  const runId = orchestrator.snapshot().runId;
  return { fixture, runsRoot, runId, codex, claude, orchestrator };
}

function agents(scenario: Scenario): { readonly codex: NeverAgent; readonly claude: NeverAgent } {
  return { codex: scenario.codex, claude: scenario.claude };
}

test('authorizing a valid overlay persists exactly one snapshot with the correct hash, invokes no agent, and leaves task state untouched', async () => {
  const scenario = await createScenario();
  try {
    const tasksBefore = structuredClone(scenario.orchestrator.snapshot().tasks);
    const rawPolicy = { salvage: { verify: [{ command: 'true', required: true }] } };
    const result = await AgentOrchestrator.authorizeRecoveryPolicy(scenario.runId, rawPolicy, {
      repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot, agents: agents(scenario),
    });
    const expectedHash = hashRecoveryPolicy({ salvage: { verify: [{ command: 'true', required: true }] } });
    assert.equal(result.policyHash, expectedHash);
    const after = result.orchestrator.snapshot();
    assert.equal(after.recoveryPolicyHistory?.length, 1);
    assert.equal(after.recoveryPolicyHistory?.[0]?.policyHash, expectedHash);
    assert.deepEqual(after.recoveryPolicyHistory?.[0]?.policy, { salvage: { verify: [{ command: 'true', required: true }] } });
    assert.match(after.recoveryPolicyHistory?.[0]?.authorizedAt ?? '', /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(scenario.codex.invocations.length, 0);
    assert.equal(scenario.claude.invocations.length, 0);
    assert.deepEqual(after.tasks, tasksBefore, 'authorization must not touch any task state');
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a second authorization appends a second snapshot; the first entry is untouched', async () => {
  const scenario = await createScenario();
  try {
    const first = await AgentOrchestrator.authorizeRecoveryPolicy(
      scenario.runId, { salvage: { verify: [{ command: 'true', required: true }] } },
      { repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot, agents: agents(scenario) },
    );
    const firstSnapshotBefore = structuredClone(first.orchestrator.snapshot().recoveryPolicyHistory?.[0]);
    const second = await AgentOrchestrator.authorizeRecoveryPolicy(
      scenario.runId,
      { salvage: { verify: [{ command: 'true', required: true }, { command: 'echo more', required: true }] } },
      { repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot, agents: agents(scenario) },
    );
    const after = second.orchestrator.snapshot();
    assert.equal(after.recoveryPolicyHistory?.length, 2);
    assert.deepEqual(after.recoveryPolicyHistory?.[0], firstSnapshotBefore);
    assert.equal(after.recoveryPolicyHistory?.[1]?.policyHash, second.policyHash);
    assert.notEqual(first.policyHash, second.policyHash);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('an invalid overlay is rejected and does not append anything to recoveryPolicyHistory', async () => {
  const scenario = await createScenario();
  try {
    await assert.rejects(
      () => AgentOrchestrator.authorizeRecoveryPolicy(
        scenario.runId,
        { ownership: ['**'] },
        { repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot, agents: agents(scenario) },
      ),
      (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
    );
    const state = await scenario.orchestrator.stateStore.load();
    assert.equal(state.recoveryPolicyHistory, undefined);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('authorization persists across a fresh reload of the run', async () => {
  const scenario = await createScenario();
  try {
    await AgentOrchestrator.authorizeRecoveryPolicy(
      scenario.runId, { salvage: { verify: [{ command: 'true', required: true }] } },
      { repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot, agents: agents(scenario) },
    );
    const reloaded = await scenario.orchestrator.stateStore.load();
    assert.equal(reloaded.recoveryPolicyHistory?.length, 1);
  } finally {
    await scenario.fixture.dispose();
  }
});
