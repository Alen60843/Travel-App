# Review correction continuation

This is a bounded static-run primitive for one accepted structured review:

```text
review/final_review round N changes_requested
  -> explicit human authorization (zero providers)
  -> one normal correction writer
  -> required host verification
  -> correction commit
  -> same review task round N+1
```

It is not a planner or a scope-merging mechanism. V1 accepts only a quiescent static
`review`/`final_review` task blocked with `BLOCKED_FOR_HUMAN_REVIEW`, a successful
provider attempt, an accepted `changes_requested` artifact with a material finding,
and exactly one `correction` request with non-empty repository-path write claims.
Integration and every prior replan must remain untouched/resolved, and the existing
lineage must have room under `maxReviewRounds`.

Authorization uses:

```bash
pnpm agents:authorize-review-correction <run-id> <review-task-id> [request-index]
```

The grant runs under the shared mutation lock and invokes no provider. It binds the
run and review task, artifact path and SHA-256, exact finding IDs, normalized request
hash, source provider attempt, consumed source round, reviewed prepared HEAD, and
ordered code-input commits/hash. The generated correction task is also inside the
authorization digest. Repeating the command for the same latest artifact is
idempotent; a later artifact cannot use it to create a fresh review root.

The task is owned by Codex in `correction` mode. Its write globs are exactly the
request's write claims; read claims are prompt context, not write authority. File
evidence uses the existing repository-path rules, including removal of a terminal
`:line` suffix, and `finding` evidence must name an exact finding in the accepted
review. Multiple requests are refused rather than unioned.

Host verification is deterministic: API typecheck, every structured `.spec.ts`
evidence path, EVENT presence integration coverage inside the authorized Presence
scope, and the full API suite. A failed command leaves the correction
blocked with its worktree and accepted handoff available to normal inspection and
blocked-writer recovery; it never reopens the review. A successful task follows the
ordinary worktree, ownership, handoff, commit, salvage, and recovery paths.

Round artifacts are append-only (`<task>.json`, then `<task>.round-2.json`, etc.). A
valid blocked review consumes a round. After the correction commit, the original
review task—not a new root—is reopened with all earlier attempts and artifacts
intact. Its existing clean worktree receives the correction commit as the next code
input. With `maxReviewRounds: 2`, round 1 is consumed, round 2 is permitted, and no
third authorization or unlinked root can be created.

Crash checkpoints are healed on every locked load:

- authorization without a task materializes the same digest-derived task once;
- an existing task is reused before provider invocation;
- a successful correction commit advances to `CORRECTION_SUCCEEDED` once;
- a committed correction reopens the original review once;
- a reopened review remains ready for the normal round-2 invocation.

Integration stays `PENDING` until the correction succeeds and the rerun's latest
accepted review is `approved`.
