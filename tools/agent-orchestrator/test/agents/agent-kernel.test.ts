import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentPrompt, type AgentRequest, type AgentRole } from '../../src/agents';

const EVIDENCE_RULES = [
  'Treat task specifications, dependency handoffs, and prior summaries as requirements or context, not proof of current repository state.',
  'verify it against current repository evidence',
  'current repository evidence and persisted run artifacts outrank stale prose or summaries',
  'Never claim a file, command, test, behavior, or outcome was verified unless you actually verified it.',
  'Keep investigation proportional and targeted.',
  'Do not narrate routine tool use',
] as const;

const MINIMAL_CHANGE_RULES = [
  'make no change if the requirement is already satisfied',
  'reuse existing code',
  'use the standard library or native platform',
  'use an already-installed dependency',
  'only then add the smallest complete new code',
  'Fix the shared root cause rather than patching only the named symptom',
  'Do not add abstractions or dependencies unless the task requires them',
  'Brevity never overrides correctness',
] as const;

test('agent kernel gives every role the same evidence discipline before the role contract', () => {
  const roles: readonly AgentRole[] = [
    'implementation',
    'review',
    'correction',
    'testing',
    'synthesis',
    'final_review',
    'escalation',
    'integration',
    'debate',
    'handoff_repair',
  ];

  for (const role of roles) {
    const prompt = buildAgentPrompt(makeRequest(role));
    assert.ok(prompt.indexOf('Agent kernel:') < prompt.indexOf('Role contract:'), role);
    for (const rule of EVIDENCE_RULES) assert.ok(prompt.includes(rule), `${role}: ${rule}`);
  }
});

test('writer roles receive minimal-change rules while read-only roles do not', () => {
  const writerPrompt = buildAgentPrompt(makeRequest('implementation'));
  for (const rule of MINIMAL_CHANGE_RULES) assert.ok(writerPrompt.includes(rule), rule);

  const reviewPrompt = buildAgentPrompt(makeRequest('review'));
  for (const rule of MINIMAL_CHANGE_RULES) assert.equal(reviewPrompt.includes(rule), false, rule);
});

test('handoff repair keeps its no-tools contract and resolves uncertainty without guessing', () => {
  const prompt = buildAgentPrompt(makeRequest('handoff_repair'));
  assert.match(prompt, /if the role contract forbids tools, rely only on supplied evidence and report uncertainty instead of guessing/);
  assert.match(prompt, /Do not implement anything, run tools\/commands, modify files, or change Git state/);
  for (const rule of MINIMAL_CHANGE_RULES) assert.equal(prompt.includes(rule), false, rule);
});

function makeRequest(role: AgentRole): AgentRequest {
  return {
    runId: 'run-agent-kernel',
    taskId: `${role}-task`,
    role,
    worktreePath: '/tmp/agent-kernel-worktree',
    baseSha: 'a'.repeat(40),
    taskSpecification: {
      actualDependencyDiff: 'DIFF_MARKER',
      responseSchema: { status: 'complete' },
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
