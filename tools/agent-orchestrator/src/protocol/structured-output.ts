/**
 * Layer A: structured-payload extraction / framing.
 *
 * Real Phase 5 dogfood finding (run-20260822094645-5b090308,
 * explorer-final-review): Claude's final response was semantically a
 * perfectly valid review verdict, but it was not the ONLY thing in stdout —
 * the model prefaced it with prose explaining why it was providing raw JSON
 * ("this task's execution contract requires my final response to be a
 * single JSON verdict object..."). The existing rule (parse the ENTIRE
 * trimmed stdout as one JSON value) correctly rejected that as a transport
 * failure, but the semantic content itself was fine.
 *
 * This module answers exactly one question — "which JSON value did the
 * agent intend as its final protocol payload?" — and nothing else. It never
 * corrects, renames, or loosens semantic content: the caller always supplies
 * the real strict validator (validateHandoff / validateReview), and this
 * module only decides WHICH parsed candidate gets handed to it. A key that
 * is spelled wrong, a status value that isn't one of the accepted enums, a
 * missing required field — none of that becomes acceptable here just
 * because a candidate was found; the validator still rejects it exactly as
 * it always did.
 *
 * Deliberately excluded from this layer, on purpose: fuzzy field-name
 * matching, semantic correction, choosing "probably last/first" among
 * multiple valid candidates, and unbounded/backtracking parsing. If more
 * than one candidate validates, or none do, this fails closed — it never
 * guesses.
 */

const MAX_SCAN_LENGTH = 2 * 1024 * 1024;

/**
 * Finds every maximal, balanced, top-level `{...}` span in `text`, aware of
 * quoted strings (so a `{`/`}` inside a string, including an escaped quote or
 * backslash, is never mistaken for structural JSON). A single linear scan —
 * no backtracking, no regex-based recursive matching, no eval.
 *
 * "Top-level" means depth-0 relative to this scan: a `{...}` nested inside
 * another object is part of that object's span, not a separate candidate.
 */
export function findTopLevelJsonObjectSpans(text: string): readonly string[] {
  const bounded = text.length > MAX_SCAN_LENGTH ? text.slice(0, MAX_SCAN_LENGTH) : text;
  const spans: string[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escapeNext = false;

  for (let index = 0; index < bounded.length; index += 1) {
    const char = bounded[index];
    if (inString) {
      if (escapeNext) {
        escapeNext = false;
      } else if (char === '\\') {
        escapeNext = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === '{') {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth > 0) {
        depth -= 1;
        if (depth === 0 && start !== -1) {
          spans.push(bounded.slice(start, index + 1));
          start = -1;
        }
      }
    }
  }
  return spans;
}

export type StructuredPayloadResult<T> =
  | { readonly ok: true; readonly value: T; readonly recovered: boolean }
  | { readonly ok: false; readonly reason: 'empty' | 'no-valid-candidate' | 'ambiguous' };

/**
 * STEP 1 (preferred, unchanged behavior): the entire trimmed text parses as
 * JSON and validates. STEP 2 (fallback): scan for top-level JSON object
 * candidates and validate each independently; accept ONLY if exactly one
 * candidate validates. Zero or multiple valid candidates both fail closed —
 * "more than one" is treated as genuine ambiguity, never resolved by
 * position (first/last) or any other heuristic.
 */
export function extractStructuredPayload<T>(
  rawText: string | null,
  validate: (value: unknown) => T,
): StructuredPayloadResult<T> {
  if (rawText === null || rawText.trim().length === 0) {
    return { ok: false, reason: 'empty' };
  }
  const trimmed = rawText.trim();

  try {
    return { ok: true, value: validate(JSON.parse(trimmed) as unknown), recovered: false };
  } catch {
    // Fall through to candidate scanning below.
  }

  const spans = findTopLevelJsonObjectSpans(rawText);
  const validCandidates: T[] = [];
  for (const span of spans) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(span) as unknown;
    } catch {
      continue;
    }
    try {
      validCandidates.push(validate(parsed));
    } catch {
      continue;
    }
  }

  if (validCandidates.length === 0) {
    return { ok: false, reason: 'no-valid-candidate' };
  }
  if (validCandidates.length > 1) {
    return { ok: false, reason: 'ambiguous' };
  }
  return { ok: true, value: validCandidates[0]!, recovered: true };
}
