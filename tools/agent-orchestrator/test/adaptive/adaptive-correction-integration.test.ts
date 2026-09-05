import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentRequest, AgentResult } from '../../src/agents';
import { AgentOrchestrator } from '../../src/orchestrator';
import { createTemporaryRepository } from '../git/helpers';

class CorrectionLifecycleAgent implements Agent {
  readonly invocations: AgentRequest[] = [];
  constructor(
    readonly name: 'codex' | 'claude',
    private readonly rejectReverification = false,
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    this.invocations.push(request);
    await request.onStarted?.(process.pid);
    let structuredHandoff: unknown;
    if (request.role === 'final_review') {
      structuredHandoff = {
        status: 'changes_requested',
        findings: [{
          id: 'F001', severity: 'medium', category: 'correctness', file: 'feature.txt', location: 'line 1',
          problem: 'feature remains buggy', evidence: 'the persisted implementation contains buggy',
          impact: 'incorrect result', suggestedFix: 'replace buggy with fixed', verificationRequired: 'read the corrected file',
        }],
        additionalWorkRequests: [{
          role: 'correction', concern: 'review', objective: 'agent child must remain denied',
          reason: 'finding proposal', dependencies: [], capabilities: [{ capability: 'typescript_backend_editing' }],
          resourceClaims: [{ kind: 'repository_path', key: 'feature.txt', mode: 'write' }],
          evidence: [{ kind: 'finding', reference: 'F001', summary: 'untrusted child proposal' }],
          risk: 'medium', priority: 80,
        }],
      };
    } else if (request.role === 'correction') {
      await writeFile(join(request.worktreePath, 'feature.txt'), 'fixed\n', 'utf8');
      const canonicalFindingKey = (request.taskSpecification as {
        requiredCanonicalFindings: Array<{ canonicalFindingKey: string }>;
      }).requiredCanonicalFindings[0]!.canonicalFindingKey;
      structuredHandoff = {
        status: 'complete', summary: 'corrected F001', filesChanged: ['feature.txt'], decisions: [], tests: [],
        openQuestions: [], reviewRequested: ['targeted F001 re-review'],
        findingResponses: [{ findingId: 'F001', canonicalFindingKey, decision: 'confirmed', resolution: 'resolved', evidence: 'bug reproduced', fix: 'replaced value', verification: 'file checked' }],
      };
    } else {
      structuredHandoff = this.rejectReverification ? {
        status: 'changes_requested', findings: [{
          id: 'F001', severity: 'medium', category: 'correctness', file: 'feature.txt', location: 'line 1',
          problem: 'finding remains unresolved', evidence: 'targeted check still fails', impact: 'incorrect result',
          suggestedFix: 'correct the remaining defect', verificationRequired: 'repeat targeted check',
        }],
      } : { status: 'approved', findings: [] };
    }
    const now = new Date().toISOString();
    return {
      agent: this.name, runId: request.runId, taskId: request.taskId, status: 'succeeded', exitCode: 0, signal: null,
      stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout`),
      stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr`),
      structuredHandoff, changedFiles: [], gitDiffSummary: null, testsReported: [], unresolvedQuestions: [],
      startedAt: now, endedAt: now, durationMs: 0, timedOut: false, aborted: false,
      failureCode: null, errorMessage: null,
    };
  }
}

function phase(baseBranch: string, prepareCommand = `node -e "require('fs').writeFileSync('.prepared','yes')"`): string {
  return `mode: adaptive
phase: correction-test
name: Adaptive correction lifecycle
baseBranch: ${baseBranch}
canonicalDesignDocument: design.md
goal: Review and correct one canonical finding
constraints: [Use only canonical evidence]
policy:
  allowedConcerns: [review]
  allowedOwnership: [feature.txt]
  allowedResources: []
  limits:
    maxConcurrentAgents: 2
    maxAgentInvocations: 8
    maxTotalWorkUnits: 10
    maxDecompositionDepth: 2
    maxFanOutPerWorkUnit: 3
    maxSynthesisInputs: 2
    maxWallClockMs: 600000
  requireEvidenceForExpansion: true
  agingIntervalMs: 1000
  agingStep: 1
  humanApprovalRisks: []
  correctionPolicy:
    allowedOwnership: [feature.txt]
    allowedRoles: [correction, testing]
    requireCanonicalFinding: true
    maxRounds: 2
initialCandidates:
  - role: final_review
    concern: review
    objective: Canonical review
    reason: Independent verdict is required
    evidence: [{ kind: file, reference: feature.txt, summary: implementation }]
    resourceClaims: [{ kind: repository_path, key: feature.txt, mode: read }]
    capabilities: [{ capability: review }]
    risk: medium
    priority: 90
executors:
  - id: reviewer
    adapter: claude
    capabilities: [{ capability: review }]
    roles: [review, final_review]
    effort: high
  - id: writer
    adapter: codex
    capabilities: [{ capability: typescript_backend_editing }, { capability: testing }]
    roles: [correction, testing]
    effort: high
agentRetries: 0
agentTimeoutMs: 60000
integration:
  prepare:
    - command: ${prepareCommand}
      required: true
  commands:
    - command: grep fixed feature.txt
      required: true
    - command: test -f .prepared
      required: true
  diagnostics: []
`;
}

test('changes_requested creates one policy-authorized root correction, targeted re-review, then preparation and integration', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await writeFile(join(fixture.repository, 'feature.txt'), 'buggy\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'implementation']);
    const phaseFile = join(fixture.container, 'phase.yaml');
    const runsRoot = join(fixture.container, 'runs');
    await writeFile(phaseFile, phase(fixture.baseBranch), 'utf8');
    const codex = new CorrectionLifecycleAgent('codex');
    const claude = new CorrectionLifecycleAgent('claude');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot, agents: { codex, claude },
    });
    const completed = await orchestrator.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify({ errors: completed.errors, tasks: completed.tasks, adaptive: completed.adaptive, integration: completed.integration }, null, 2));
    assert.equal(completed.integration.status, 'SUCCEEDED');
    assert.equal(await readFile(join(completed.integration.worktreePath!, 'feature.txt'), 'utf8'), 'fixed\n');
    assert.equal(completed.integration.preparation?.status, 'SUCCEEDED');
    assert.equal(completed.integration.preparation?.commands.length, 1);
    assert.equal(completed.integration.preparation?.commands[0]?.exitCode, 0);
    const corrections = completed.adaptive!.workRequests.filter((request) => request.authorization?.purpose === 'correction');
    const reverifications = completed.adaptive!.workRequests.filter((request) => request.authorization?.purpose === 'reverification');
    assert.equal(corrections.length, 1);
    assert.equal(reverifications.length, 1);
    assert.equal(corrections[0]?.parentWorkUnitId, undefined);
    assert.equal(corrections[0]?.source, 'orchestrator');
    const deniedChild = completed.adaptive!.workRequests.find((request) => request.parentWorkUnitId !== undefined && request.role === 'correction');
    assert.equal(completed.adaptive!.grantDecisions.find((decision) => decision.requestId === deniedChild?.id)?.reason, 'OUTSIDE_ALLOWED_OWNERSHIP');
    assert.equal(claude.invocations.map((request) => request.role).join(','), 'final_review,review');
    assert.equal(codex.invocations.length, 1);
    const events = (await readFile(orchestrator.stateStore.eventsPath, 'utf8')).trim().split('\n').map((line) => JSON.parse(line) as { name: string });
    const correctionIndex = events.findIndex((event) => event.name === 'ADAPTIVE_CORRECTION_REQUEST_CREATED');
    const reverifyIndex = events.findIndex((event) => event.name === 'ADAPTIVE_REVERIFICATION_CREATED');
    const prepareIndex = events.findIndex((event) => event.name === 'INTEGRATION_PREPARATION_STARTED');
    const integrationIndex = events.findIndex((event) => event.name === 'INTEGRATION_COMMAND_FINISHED');
    assert.ok(correctionIndex >= 0 && correctionIndex < reverifyIndex && reverifyIndex < prepareIndex && prepareIndex < integrationIndex);
    await orchestrator.cleanup();
  } finally {
    await fixture.dispose();
  }
});

test('required preparation failure is distinct and never executes the deterministic gate', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await writeFile(join(fixture.repository, 'feature.txt'), 'buggy\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'implementation']);
    const phaseFile = join(fixture.container, 'phase-fail.yaml');
    const runsRoot = join(fixture.container, 'runs');
    const approved = phase(fixture.baseBranch, `node -e "process.stderr.write('prepare failed');process.exit(7)"`)
      .replace("status: 'changes_requested'", "status: 'changes_requested'");
    await writeFile(phaseFile, approved, 'utf8');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot,
      agents: { codex: new CorrectionLifecycleAgent('codex'), claude: new CorrectionLifecycleAgent('claude') },
    });
    const stopped = await orchestrator.execute();
    assert.equal(stopped.status, 'BLOCKED');
    assert.equal(stopped.integration.error?.code, 'INTEGRATION_PREPARATION_FAILED');
    assert.equal(stopped.integration.preparation?.status, 'FAILED');
    assert.equal(stopped.integration.preparation?.commands[0]?.exitCode, 7);
    const events = (await readFile(orchestrator.stateStore.eventsPath, 'utf8')).trim();
    assert.match(events, /INTEGRATION_PREPARATION_FAILED/);
    assert.doesNotMatch(events, /INTEGRATION_COMMAND_FINISHED/);
  } finally {
    await fixture.dispose();
  }
});

test('unresolved finding at the configured correction-round limit blocks before integration', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await writeFile(join(fixture.repository, 'feature.txt'), 'buggy\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'implementation']);
    const phaseFile = join(fixture.container, 'phase-limit.yaml');
    await writeFile(phaseFile, phase(fixture.baseBranch).replace('maxRounds: 2', 'maxRounds: 1'), 'utf8');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot: join(fixture.container, 'runs'),
      agents: { codex: new CorrectionLifecycleAgent('codex'), claude: new CorrectionLifecycleAgent('claude', true) },
    });
    const stopped = await orchestrator.execute();
    assert.equal(stopped.status, 'BLOCKED');
    assert.equal(stopped.integration.status, 'PENDING');
    assert.equal(stopped.errors.at(-1)?.code, 'BLOCKED_FOR_HUMAN_REVIEW');
    assert.equal(stopped.adaptive!.workRequests.filter((request) => request.authorization?.purpose === 'correction').length, 1);
    assert.equal(stopped.adaptive!.workRequests.filter((request) => request.authorization?.purpose === 'reverification').length, 1);
  } finally {
    await fixture.dispose();
  }
});

test('integration retry reruns failed preparation and preserves the failed attempt', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await writeFile(join(fixture.repository, 'feature.txt'), 'buggy\n', 'utf8');
    await writeFile(join(fixture.repository, 'prepare-once.js'), "const f=require('fs');if(f.existsSync('.prep-attempt')){f.writeFileSync('.prepared','yes');process.exit(0)}f.writeFileSync('.prep-attempt','1');process.exit(7);\n", 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt', 'prepare-once.js']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'implementation']);
    const phaseFile = join(fixture.container, 'phase-retry.yaml');
    const runsRoot = join(fixture.container, 'runs');
    await writeFile(phaseFile, phase(fixture.baseBranch, 'node prepare-once.js'), 'utf8');
    const agents = { codex: new CorrectionLifecycleAgent('codex'), claude: new CorrectionLifecycleAgent('claude') };
    const first = await AgentOrchestrator.start(phaseFile, { repositoryPath: fixture.repository, runsRoot, agents });
    const failed = await first.execute();
    assert.equal(failed.integration.error?.code, 'INTEGRATION_PREPARATION_FAILED');
    const retry = await AgentOrchestrator.retryIntegrationGate(failed.runId, { repositoryPath: fixture.repository, runsRoot, agents });
    const completed = await retry.execute();
    assert.equal(completed.status, 'COMPLETED', JSON.stringify({ integration: completed.integration, errors: completed.errors }, null, 2));
    assert.equal(completed.integration.preparation?.status, 'SUCCEEDED');
    assert.equal(completed.integration.error, undefined);
    assert.equal(completed.integrationAttempts?.[0]?.preparation?.status, 'FAILED');
    assert.equal(completed.integrationAttempts?.[0]?.preparation?.commands[0]?.exitCode, 7);
    await retry.cleanup();
  } finally {
    await fixture.dispose();
  }
});

test('successful preparation command still fails closed if it changes tracked product source', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'design.md'), '# contract\n', 'utf8');
    await writeFile(join(fixture.repository, 'feature.txt'), 'buggy\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'design.md', 'feature.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'implementation']);
    const phaseFile = join(fixture.container, 'phase-tamper.yaml');
    await writeFile(phaseFile, phase(fixture.baseBranch, `node -e "require('fs').writeFileSync('feature.txt','tampered')"`), 'utf8');
    const orchestrator = await AgentOrchestrator.start(phaseFile, {
      repositoryPath: fixture.repository, runsRoot: join(fixture.container, 'runs'),
      agents: { codex: new CorrectionLifecycleAgent('codex'), claude: new CorrectionLifecycleAgent('claude') },
    });
    const stopped = await orchestrator.execute();
    assert.equal(stopped.status, 'BLOCKED');
    assert.equal(stopped.integration.error?.code, 'INTEGRATION_PREPARATION_FAILED');
    assert.equal(stopped.integration.preparation?.status, 'FAILED');
    assert.match(stopped.integration.error?.message ?? '', /tracked source|commit/);
  } finally {
    await fixture.dispose();
  }
});
