# Review correction verification recovery

Filtered pnpm commands execute from the selected package root. Correction verification therefore converts every focused repository path under `apps/api/` to its package-relative suffix before passing it to Jest. A path outside `apps/api` is rejected; it is never stripped or rewritten heuristically. The Presence integration selector is likewise `src/chat/presence/.*\.int-spec\.ts$`.

Before any correction Jest process starts, the host must explicitly provide `TEST_DB_HOST`, `TEST_DB_PORT`, `TEST_DB_USER`, `TEST_DB_PASSWORD`, and `TEST_DB_NAME`. Missing values or an invalid port fail closed. Values are used only in the child environment and are never written to state or events; command logs use the existing secret redaction.

An older authorized correction may retain the pre-fix repository-relative commands. If its provider succeeded but host verification failed on that exact legacy contract, recover the preserved worktree with:

```bash
pnpm agents:retry-review-correction-verification <run-id> <correction-task-id>
```

The command accepts no replacement shell command and invokes no provider. It proves a static quiescent `BLOCKED / REVIEW_BLOCKED` correction, successful finished provider attempt, unchanged accepted handoff, no commit/completion, untouched integration, prepared HEAD, exact handoff file set, correction ownership, and the original failed command prefix. Only the known legacy generator may normalize to the current canonical generator.

The append-only recovery evidence binds the run, correction authorization, provider attempt, handoff path/SHA, prepared and worktree heads, content fingerprint, and original/normalized commands. Each host execution appends sanitized command/log/exit evidence. A failure leaves the task blocked and dirty work intact.

A pass is checkpointed before commit. If the tree is still identical, the orchestrator creates or reconciles exactly one canonical correction commit, preserves the provider handoff and attempt history, marks the correction successful, and reopens the same source review for its next round. Integration remains pending until that review approves. Repeating a successful recovery is a no-op; matching pre-commit and post-commit crash windows reconcile without re-running verification or duplicating the commit.
