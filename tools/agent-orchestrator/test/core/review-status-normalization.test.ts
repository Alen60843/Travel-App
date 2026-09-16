import assert from 'node:assert/strict';
import test from 'node:test';

import { isOrchestratorError } from '../../src/errors';
import { normalizeApprovedReview, parseReview, validateReview } from '../../src/review/findings';

const finding = {
  id: 'F001',
  severity: 'medium',
  category: 'concurrency',
  file: 'apps/api/src/chat/chat.service.ts',
  location: 'history()',
  problem: 'History reads acquire an exclusive room lock.',
  evidence: 'history() calls withRoom(), which uses SELECT FOR UPDATE OF r.',
  impact: 'History reads serialize against sends and cursor updates.',
  suggestedFix: 'Use the existing lock-free authorization path for history.',
  verificationRequired: 'Test concurrent history, sends and cursor updates.',
  counterexample: 'A history transaction blocks a concurrent send.',
  reproduction: 'Hold a history transaction open while sending to the same room.',
  expectedBehavior: 'Reads do not block sends.',
  violatingBehavior: 'The send waits for the history transaction.',
};

for (const severity of ['medium', 'high', 'critical']) {
  test(`approved + ${severity} normalizes only status and preserves all fields`, () => {
    const original = {
      status: 'approved',
      findings: [{ ...finding, severity }, { ...finding, id: 'F002', severity: 'low' }],
      additionalWorkRequests: [{ role: 'review', concern: ' chat ', objective: 'Check contention', reason: 'Follow-up' }],
    };
    const before = structuredClone(original);
    assert.throws(() => parseReview(original), (error) => isOrchestratorError(error, 'REVIEW_BLOCKED'));
    for (const input of [original, JSON.stringify(original)]) {
      const normalized = normalizeApprovedReview(input);
      assert.deepEqual(normalized, { ...original, status: 'changes_requested' });
      assert.deepEqual(normalized?.findings, original.findings);
      assert.doesNotThrow(() => validateReview(normalized));
    }
    assert.deepEqual(original, before, 'the source evidence must not be mutated');
  });
}

for (const review of [
  { status: 'approved', findings: [{ ...finding, severity: 'low' }] },
  { status: 'approved', findings: [] },
  { status: 'changes_requested', findings: [finding] },
  { status: 'blocked', findings: [finding] },
]) {
  test(`valid ${review.status} with ${review.findings.length} findings needs no normalization`, () => {
    assert.deepEqual(parseReview(review), review);
    assert.equal(normalizeApprovedReview(review), null);
  });
}

const contradictory = { status: 'approved', findings: [finding] };
const invalidReviews: Record<string, unknown> = {
  'missing evidence': { ...contradictory, findings: [{ ...finding, evidence: undefined }] },
  'empty evidence': { ...contradictory, findings: [{ ...finding, evidence: '' }] },
  'null finding alongside a material finding': { ...contradictory, findings: [finding, null] },
  'unknown finding key': { ...contradictory, findings: [{ ...finding, unexpected: true }] },
  'unknown review key': { ...contradictory, unexpected: true },
  'invalid severity alongside a material finding': { ...contradictory, findings: [finding, { ...finding, id: 'F002', severity: 'urgent' }] },
  'duplicate finding ids': { ...contradictory, findings: [finding, finding] },
  'unsafe finding path': { ...contradictory, findings: [{ ...finding, file: '../secret' }] },
  'invalid additional work requests': { ...contradictory, additionalWorkRequests: [{}] },
  'unknown additional work request key': { ...contradictory, additionalWorkRequests: [{ role: 'review', concern: 'chat', objective: 'Check', reason: 'Follow-up', unexpected: true }] },
  'changes requested without findings': { status: 'changes_requested', findings: [] },
  'unknown status': { ...contradictory, status: 'APPROVED' },
  'malformed JSON': '{"status":"approved",',
  'no review': null,
};

for (const [label, review] of Object.entries(invalidReviews)) {
  test(`${label} remains REVIEW_BLOCKED and is not normalized`, () => {
    const before = structuredClone(review);
    assert.throws(() => parseReview(review), (error) => isOrchestratorError(error, 'REVIEW_BLOCKED'));
    assert.equal(normalizeApprovedReview(review), null);
    assert.deepEqual(review, before);
  });
}
