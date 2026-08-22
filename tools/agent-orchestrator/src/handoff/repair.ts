import { FINDING_RESPONSE_KEYS, HANDOFF_KEYS } from './schemas';

const ANNOTATED_KEY = /^([a-zA-Z][a-zA-Z0-9]*)\s*\(.+\)$/;

function renameAnnotatedKeys(
  value: Readonly<Record<string, unknown>>,
  allowedKeys: ReadonlySet<string>,
): { readonly result: Record<string, unknown>; readonly renamed: boolean } {
  let renamed = false;
  const result: Record<string, unknown> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (allowedKeys.has(key)) {
      result[key] = entryValue;
      continue;
    }
    const bareKey = ANNOTATED_KEY.exec(key)?.[1];
    if (
      bareKey !== undefined &&
      allowedKeys.has(bareKey) &&
      !(bareKey in value) &&
      !(bareKey in result)
    ) {
      result[bareKey] = entryValue;
      renamed = true;
      continue;
    }
    // Not a known key, even after stripping a trailing "(...)" annotation:
    // leave it exactly as written. Deterministic repair never guesses at an
    // actually-unknown field — the strict validator downstream will reject
    // it precisely as it would any other unsupported key.
    result[key] = entryValue;
  }
  return { result, renamed };
}

/**
 * §10 (real Phase 5 dogfood recovery, run-20260822094645-5b090308): both real
 * Codex Solver tasks returned otherwise-valid JSON whose optional keys were
 * literally `"assumptions (optional; implementation tasks)"` instead of
 * `"assumptions"` — the model copied the field's schema *description*
 * (see orchestrator.ts's now-fixed handoffResponseSchema()) directly into the
 * key, because that was, at the time, the actual (buggy) shape of the
 * example it was shown. This function repairs exactly that class of mistake:
 * a key that doesn't match a supported field, but does after stripping a
 * trailing parenthetical annotation, where the resulting bare key is a real
 * supported field and does not collide with one already present.
 *
 * This is deliberately NOT fuzzy matching: no similarity scoring, no edit
 * distance, no content-based inference — only an exact, allowlisted,
 * one-to-one correspondence to a name the real validator already accepts
 * (`HANDOFF_KEYS/FINDING_RESPONSE_KEYS` in ./schemas, the same source of
 * truth `validateHandoff` itself uses). A key that cannot be resolved this
 * way is left untouched; the caller must fall through to a bounded
 * agent-based repair, or fail closed. This function never loosens what the
 * real validator accepts — it only tries to produce something that already
 * satisfies it unmodified.
 */
export function deterministicallyRepairHandoffKeys(
  raw: unknown,
): { readonly value: unknown; readonly changed: boolean } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { value: raw, changed: false };
  }
  const topLevel = renameAnnotatedKeys(raw as Record<string, unknown>, HANDOFF_KEYS);
  let changed = topLevel.renamed;
  const result = { ...topLevel.result };

  if (Array.isArray(result.findingResponses)) {
    let findingsChanged = false;
    const repairedFindings = result.findingResponses.map((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return entry;
      }
      const nested = renameAnnotatedKeys(entry as Record<string, unknown>, FINDING_RESPONSE_KEYS);
      if (nested.renamed) findingsChanged = true;
      return nested.result;
    });
    if (findingsChanged) {
      result.findingResponses = repairedFindings;
      changed = true;
    }
  }

  return { value: result, changed };
}
