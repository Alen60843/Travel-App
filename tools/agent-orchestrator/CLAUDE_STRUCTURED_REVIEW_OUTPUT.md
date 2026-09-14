# Claude structured review output

The Claude adapter uses CLI-enforced structured output for `review`,
`synthesis`, and `final_review`. Those roles all feed the same canonical
`StructuredReview` validator. Writer roles and `handoff_repair` retain their
existing text-output behavior.

## Verified CLI contract

The implementation was verified directly against the installed Claude Code
2.1.71 executable with `claude --version`, `claude --help`, and two bounded
scratch invocations outside every orchestrator run. The installed CLI accepts:

```text
--output-format json
--json-schema <JSON Schema object serialized as one argument>
```

With the orchestrator's complete review projection, a successful approved
scratch result had this relevant stdout shape (unrelated usage/session fields
omitted here):

```json
{
  "type": "result",
  "subtype": "success",
  "is_error": false,
  "result": "",
  "structured_output": {
    "status": "approved",
    "findings": []
  }
}
```

The adapter therefore extracts only `structured_output` from that exact
successful result envelope. `ProcessAgent` still persists and returns the raw,
redacted stdout envelope unchanged. Malformed JSON, an unexpected envelope,
a missing/null payload, or prose-only stdout produces a null handoff and flows
to the existing `REVIEW_BLOCKED` path.

## Schema and validation boundary

`taskSpecification.responseSchema` remains a model-facing example and is not
passed to Claude as JSON Schema. The adapter builds a real schema projection
from the canonical review enums and structural field names. It constrains the
outer `{status, findings, additionalWorkRequests?}` handoff, including finding
and work-request object shapes.

The projection is not a second business validator. Existing `parseReview()`
validation remains authoritative for non-empty evidence, safe relative paths,
unique finding IDs, cross-field status rules, work-request semantics, and all
other acceptance decisions. There is no prose fallback or prose-to-JSON
conversion.

## Already-consumed retry continuation

`agents:continue-claude-review-output <runId> <taskId>` is a separate one-time
authorization for a static Claude `review`/`final_review` round whose ordinary
same-round v2 structured-output retry was consumed and also produced prose.
It does not reset or widen that retry budget.

The appended v3 recovery binds the consumed v2 recovery hash, both consecutive
successful malformed-attempt stdout hashes, old and new adapter contract IDs,
the same review round, prepared HEAD, dependency commits, accepted review
history, and every prompt input artifact. Authorization invokes no provider.
Normal `agents:resume` may make one post-fix invocation; no automatic or
explicit second invocation is permitted through this continuation.
