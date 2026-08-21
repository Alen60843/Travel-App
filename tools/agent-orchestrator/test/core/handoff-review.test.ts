import assert from 'node:assert/strict';
import test from 'node:test';

import { isOrchestratorError } from '../../src/errors';
import { parseHandoff } from '../../src/handoff/parser';
import { parseReview } from '../../src/review/findings';

test('a complete structured handoff parses without freeform interpretation', () => {
  const handoff = parseHandoff(
    JSON.stringify({
      status: 'complete',
      summary: 'Implemented the assigned query.',
      filesChanged: ['apps/api/src/explorer/query.ts'],
      decisions: ['Used the existing GIST index.'],
      tests: [{ command: 'pnpm test', result: 'pass', details: '3 passed' }],
      openQuestions: [],
      reviewRequested: ['correctness'],
    }),
  );
  assert.equal(handoff.status, 'complete');
  assert.equal(handoff.tests[0]?.result, 'pass');
});

test('malformed, fenced, incomplete, and traversing handoffs are rejected', () => {
  for (const input of [
    '```json\n{}\n```',
    JSON.stringify({ status: 'complete' }),
    JSON.stringify({
      status: 'complete',
      summary: 'bad path',
      filesChanged: ['../secret'],
      decisions: [],
      tests: [],
      openQuestions: [],
      reviewRequested: [],
    }),
  ]) {
    assert.throws(
      () => parseHandoff(input),
      (error: unknown) => isOrchestratorError(error, 'HANDOFF_INVALID'),
    );
  }
});

test('review findings require evidence and a consistent review status', () => {
  const review = parseReview({
    status: 'changes_requested',
    findings: [
      {
        id: 'F001',
        severity: 'high',
        category: 'security',
        file: 'apps/api/src/explorer/query.ts',
        location: 'query()',
        problem: 'Authorization predicate missing.',
        evidence: 'The generated SQL omits user_blocks.',
        impact: 'Blocked users may appear.',
        suggestedFix: 'Add the bidirectional anti-join.',
        verificationRequired: 'Add a blocked-user integration case.',
      },
    ],
  });
  assert.equal(review.findings[0]?.id, 'F001');

  const withoutEvidence = structuredClone(review) as unknown as {
    findings: Array<Record<string, unknown>>;
  };
  withoutEvidence.findings[0]!.evidence = '';
  assert.throws(
    () => parseReview(withoutEvidence),
    (error: unknown) => isOrchestratorError(error, 'REVIEW_BLOCKED'),
  );
  assert.throws(
    () => parseReview({ status: 'changes_requested', findings: [] }),
    (error: unknown) => isOrchestratorError(error, 'REVIEW_BLOCKED'),
  );
});
