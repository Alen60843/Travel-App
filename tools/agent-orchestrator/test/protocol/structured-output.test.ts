import assert from 'node:assert/strict';
import test from 'node:test';

import { extractStructuredPayload, findTopLevelJsonObjectSpans } from '../../src/protocol';
import { validateHandoff } from '../../src/handoff';
import { validateReview } from '../../src/review/findings';

/**
 * §10 (real Phase 5 dogfood recovery, second finding, explorer-final-review):
 * Layer A (framing/extraction) is exercised here in complete isolation from
 * Layer B (the real, unmodified strict validators — validateReview here,
 * exactly the one the live orchestrator uses). This is deliberate: these
 * tests prove the framing layer never weakens what "valid" means, because
 * they run the actual validator, not a stand-in.
 */

const approvedReview = { status: 'approved', findings: [] };
const changesRequestedReview = {
  status: 'changes_requested',
  findings: [{
    id: 'F001',
    severity: 'high',
    category: 'correctness',
    file: 'a.ts',
    location: 'x',
    problem: 'p',
    evidence: 'e',
    impact: 'i',
    suggestedFix: 'f',
    verificationRequired: 'v',
  }],
};

// TEST A — clean exact JSON: accepted through the normal exact path, not recovered.
test('TEST A: clean exact JSON is accepted through the exact path, recovered = false', () => {
  const result = extractStructuredPayload(JSON.stringify(approvedReview), validateReview);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.recovered, false);
    assert.deepEqual(result.value, approvedReview);
  }
});

// TEST B — leading prose: exactly one valid candidate, accepted, recovered = true.
test('TEST B: leading prose around one valid object is recovered', () => {
  const stdout = `Review complete.\n${JSON.stringify(approvedReview)}`;
  const result = extractStructuredPayload(stdout, validateReview);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.recovered, true);
    assert.deepEqual(result.value, approvedReview);
  }
});

// TEST C — trailing prose: accepted only because exactly one semantic candidate exists.
test('TEST C: trailing prose after one valid object is recovered', () => {
  const stdout = `${JSON.stringify(approvedReview)}\nDone.`;
  const result = extractStructuredPayload(stdout, validateReview);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.recovered, true);
    assert.deepEqual(result.value, approvedReview);
  }
});

// TEST D — markdown code-fence case: the fence text itself is just more
// surrounding prose to the scanner; the object inside is still found.
test('TEST D: a JSON object inside a markdown code fence is recovered', () => {
  const stdout = ['```json', JSON.stringify(approvedReview), '```'].join('\n');
  const result = extractStructuredPayload(stdout, validateReview);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.recovered, true);
    assert.deepEqual(result.value, approvedReview);
  }
});

// TEST E — braces inside strings must not corrupt extraction.
test('TEST E: braces inside a string value do not corrupt extraction', () => {
  const withBracesInString = {
    ...changesRequestedReview,
    findings: [{
      ...changesRequestedReview.findings[0],
      problem: 'expected object {x} but got {y}, and a stray "quote\\" too',
    }],
  };
  const stdout = `Some notes about {this and that}.\n${JSON.stringify(withBracesInString)}\nmore {noise}`;
  const result = extractStructuredPayload(stdout, validateReview);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.equal(result.recovered, true);
    assert.deepEqual(result.value, withBracesInString);
  }
});

// TEST F — nested JSON (nested objects/arrays) is correctly parsed as one span.
test('TEST F: nested objects and arrays inside the candidate are parsed correctly', () => {
  const nested = {
    status: 'complete',
    summary: 's',
    filesChanged: ['a.ts', 'b.ts'],
    decisions: ['use approach {A}', 'reject approach B'],
    tests: [
      { command: 'pnpm test', result: 'pass', details: 'nested { detail: "ok" }' },
      { command: 'pnpm lint', result: 'not_run', details: '' },
    ],
    openQuestions: [],
    reviewRequested: [],
    findingResponses: [{ findingId: 'F001', decision: 'confirmed', evidence: 'e', fix: 'f', verification: 'v' }],
  };
  const stdout = `Working...\n${JSON.stringify(nested)}`;
  const result = extractStructuredPayload(stdout, validateHandoff);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, nested);
  }
});

// TEST G — two independently valid review objects: ambiguous, fail closed.
// Never choose the last (or first) one merely because of its position.
test('TEST G: two independently valid candidates fail closed as ambiguous', () => {
  const stdout = `${JSON.stringify(approvedReview)}\nActually, on reflection:\n${JSON.stringify(changesRequestedReview)}`;
  const result = extractStructuredPayload(stdout, validateReview);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'ambiguous');
  }
});

// TEST H — one syntactically-invalid-as-the-schema example plus one real
// valid final object: only the one that actually passes strict validation
// is accepted.
test('TEST H: only the candidate that actually validates is accepted', () => {
  const notAReview = { status: 'PENDING', notes: 'still working' };
  const stdout = `Draft: ${JSON.stringify(notAReview)}\nFinal: ${JSON.stringify(approvedReview)}`;
  const result = extractStructuredPayload(stdout, validateReview);
  assert.equal(result.ok, true);
  if (result.ok) {
    assert.deepEqual(result.value, approvedReview);
  }
});

// TEST I — syntactically valid JSON, semantically invalid: still rejected.
test('TEST I: a syntactically valid but semantically invalid object is rejected', () => {
  const semanticallyInvalid = { status: 'not-a-real-status', findings: [] };
  const result = extractStructuredPayload(JSON.stringify(semanticallyInvalid), validateReview);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'no-valid-candidate');
  }
});

// TEST J — unknown keys: still rejected (the real validator is untouched by framing).
test('TEST J: an object with an unknown key is rejected, exactly as the validator requires', () => {
  const withUnknownKey = { ...approvedReview, extraField: 'not allowed' };
  const result = extractStructuredPayload(JSON.stringify(withUnknownKey), validateReview);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'no-valid-candidate');
  }
});

// TEST K — no JSON at all: blocked.
test('TEST K: stdout with no JSON object at all is blocked', () => {
  const result = extractStructuredPayload('I could not complete this task for reasons X, Y, Z.', validateReview);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'no-valid-candidate');
  }
});

test('null/empty stdout is blocked, not a crash', () => {
  assert.deepEqual(extractStructuredPayload(null, validateReview), { ok: false, reason: 'empty' });
  assert.deepEqual(extractStructuredPayload('   ', validateReview), { ok: false, reason: 'empty' });
});

// TEST L — large/boundary output respects the configured size bound rather
// than scanning an unbounded amount of text.
test('TEST L: the scanner is bounded and does not scan unboundedly large input', () => {
  const huge = `${'x'.repeat(3 * 1024 * 1024)}${JSON.stringify(approvedReview)}`;
  const start = Date.now();
  const result = extractStructuredPayload(huge, validateReview);
  const elapsedMs = Date.now() - start;
  // Bounded scanning: this must return quickly (linear over the bound, not
  // the whole 3MB+ input) and, since the real object sits past the bound,
  // it correctly finds nothing rather than scanning forever to find it.
  assert.ok(elapsedMs < 2000, `expected a bounded scan, took ${elapsedMs}ms`);
  assert.equal(result.ok, false);
});

test('findTopLevelJsonObjectSpans finds only top-level spans, not nested ones separately', () => {
  const text = `noise {"a": {"b": 1}} more noise {"c": 2}`;
  const spans = findTopLevelJsonObjectSpans(text);
  assert.deepEqual(spans, ['{"a": {"b": 1}}', '{"c": 2}']);
});

test('findTopLevelJsonObjectSpans ignores an unbalanced/unterminated object', () => {
  const text = `{"a": 1} and then {"b": unterminated`;
  const spans = findTopLevelJsonObjectSpans(text);
  assert.deepEqual(spans, ['{"a": 1}']);
});

test('a handoff-shaped candidate with a description-annotated key is rejected by the strict validator (framing never loosens Layer B)', () => {
  const annotated = {
    status: 'complete',
    summary: 's',
    filesChanged: [],
    decisions: [],
    tests: [],
    openQuestions: [],
    reviewRequested: [],
    'assumptions (optional; implementation tasks)': ['x'],
  };
  const result = extractStructuredPayload(`Note: here is my output.\n${JSON.stringify(annotated)}`, validateHandoff);
  // The candidate is found, but the description-annotated key is STILL an
  // unsupported field to the real validator — framing extraction does not
  // rename it. This proves Layer A never corrects semantic content.
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'no-valid-candidate');
  }
});

test('a wrong-case enum value ("APPROVE" instead of "approved") still fails validation', () => {
  const wrongCase = { status: 'APPROVE', findings: [] };
  const result = extractStructuredPayload(`Verdict: ${JSON.stringify(wrongCase)}`, validateReview);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.equal(result.reason, 'no-valid-candidate');
  }
});
