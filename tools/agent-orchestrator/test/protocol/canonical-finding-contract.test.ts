import assert from 'node:assert/strict';
import test from 'node:test';

import { buildAgentPrompt, type AgentRequest } from '../../src/agents';
import {
  validateCanonicalFindingResponses,
  validateHandoff,
  type RequiredCanonicalFinding,
} from '../../src/handoff';

const assigned = (findingId: string): RequiredCanonicalFinding => ({
  findingId,
  canonicalFindingKey: `source:review:${findingId}`,
  sourceWorkUnitId: 'work-000005',
  artifactPath: '/runs/source/reviews/work-000005.json',
  finding: { id: findingId, problem: 'missing owner-boundary proof' },
});

const generic = (findingResponses?: unknown[]) => validateHandoff({
  status: 'complete', summary: 'done', filesChanged: ['feature.spec.ts'], decisions: [],
  tests: [{ command: 'test', result: 'pass', details: '8/8' }],
  openQuestions: [], reviewRequested: [],
  ...(findingResponses === undefined ? {} : { findingResponses }),
});

const resolved = (findingId = 'F002') => ({
  findingId, canonicalFindingKey: `source:review:${findingId}`, decision: 'confirmed', resolution: 'resolved', evidence: 'diff adds both cases',
  fix: 'added owner-boundary tests', verification: 'focused test passed 8/8',
});

test('generic non-canonical handoff remains valid without findingResponses', () => {
  assert.doesNotThrow(() => validateCanonicalFindingResponses(generic(), []));
});

test('canonical completion fails closed when an assigned response is missing', () => {
  assert.throws(() => validateCanonicalFindingResponses(generic(), [assigned('F002')]), /F002/);
});

test('a complete exact F002 response passes', () => {
  assert.doesNotThrow(() => validateCanonicalFindingResponses(generic([resolved()]), [assigned('F002')]));
});

test('unknown and duplicate finding IDs fail', () => {
  assert.throws(() => validateCanonicalFindingResponses(generic([resolved('F999')]), [assigned('F002')]), /does not belong/);
  assert.throws(() => generic([resolved(), resolved()]), /unique/);
});

test('matching ID with foreign provenance fails closed', () => {
  assert.throws(
    () => validateCanonicalFindingResponses(generic([{ ...resolved(), canonicalFindingKey: 'other:review:F002' }]), [assigned('F002')]),
    /canonical provenance/,
  );
});

test('resolved without correction evidence fails', () => {
  const handoff = generic([{ findingId: 'F002', canonicalFindingKey: 'source:review:F002', decision: 'confirmed', resolution: 'resolved', evidence: 'claim only' }]);
  assert.throws(() => validateCanonicalFindingResponses(handoff, [assigned('F002')]), /evidence, fix, and verification/);
});

test('every assigned finding is required', () => {
  assert.throws(
    () => validateCanonicalFindingResponses(generic([resolved('F001')]), [assigned('F001'), assigned('F002')]),
    /F002/,
  );
});

test('canonical testing and correction prompts carry IDs, provenance, write scope, response contract, and Git ownership', () => {
  for (const role of ['testing', 'correction'] as const) {
    const request: AgentRequest = {
      runId: 'run-test', taskId: 'work-000002', role, worktreePath: '/tmp/worktree', baseSha: 'a'.repeat(40),
      taskSpecification: {
        task: { files: ['feature.spec.ts'] }, requiredCanonicalFindings: [assigned('F002')],
        canonicalFindingResponseContract: ['every assigned finding'], responseSchema: {},
      },
      canonicalDesignDocumentPath: '/repo/design.md', allowedFileOwnership: ['feature.spec.ts'],
      dependencyHandoffs: [], previousReviewFindings: [], requestedEffort: 'high', timeoutMs: 1000,
      artifactsDirectory: '/tmp/logs', access: 'writer',
    };
    const prompt = buildAgentPrompt(request);
    assert.match(prompt, /F002/);
    assert.match(prompt, /source:review:F002/);
    assert.match(prompt, /findingResponses/);
    assert.match(prompt, /Generic summary text is not sufficient|generic summary text is not sufficient/i);
    assert.match(prompt, /feature\.spec\.ts/);
    assert.match(prompt, /Do not run git commit/);
  }
});

test('rejected canonical finding requires evidence, reason, and not_applicable', () => {
  const missingReason = generic([{ findingId: 'F002', canonicalFindingKey: 'source:review:F002', decision: 'rejected', resolution: 'not_applicable', evidence: 'checked code' }]);
  assert.throws(() => validateCanonicalFindingResponses(missingReason, [assigned('F002')]), /reason and evidence/);
  const valid = generic([{ findingId: 'F002', canonicalFindingKey: 'source:review:F002', decision: 'rejected', resolution: 'not_applicable', evidence: 'guard already covers both methods', reason: 'finding premise is false' }]);
  assert.doesNotThrow(() => validateCanonicalFindingResponses(valid, [assigned('F002')]));
});

test('resolution values are a strict enum', () => {
  assert.throws(() => generic([{ ...resolved(), resolution: 'done' }]), /must be one of/);
});
