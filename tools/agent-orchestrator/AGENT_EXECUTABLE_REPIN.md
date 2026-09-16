# Agent executable repin

Runs pin the exact Codex and Claude executable paths resolved at start. Resume never
silently re-resolves `PATH`, environment overrides, or VS Code extension installs.
When a pinned executable becomes unusable and causes a proven spawn `ENOENT`, an
operator may authorize one replacement without executing or retrying a task:

```bash
pnpm agents:repin-agent-executable <run-id> <codex|claude> <absolute-executable-path>
```

The static run must be terminal and quiescent with untouched integration. Every
provider attempt must be finished/dead. The effective old pin must be missing,
non-regular, or non-executable, and a failed task owned by that adapter must contain
the exact `spawn <effective-path> ENOENT` failure with no accepted structured output,
commit, or dirty/advanced worktree state. A merely newer binary is not eligible.

The replacement must be an absolute, regular, non-symlink executable. Authorization
captures its path, SHA-256, device, inode, mode, size, and bounded `--version` output;
the output must conservatively identify the requested adapter. Identity is rechecked
immediately before the atomic state write.

`agentExecutableRepins` is append-only. Each content-hashed record binds the run,
agent, prior effective path and availability, replacement identity, and exact source
task/failure/attempt, plus human authorization provenance. Effective execution is:

```text
initial agentExecutables pin
  + ordered, contiguous authorized repins
  = effective executable path
```

The initial pin and historical attempts are never rewritten. Repeating the latest
identical migration is idempotent. A later migration must start from the currently
effective path and prove a new matching spawn failure.

Every normal load verifies that the latest authorized path remains a regular
executable and still has the authorized SHA-256. Disappearance, permission loss, or
byte drift fails closed; no alternate installed binary is selected.

Repin authorization invokes no agent and does not change attempts or scheduler state.
After inspection, use the existing explicit separation:

```text
repin-agent-executable
→ retry-agent <run-id> <failed-task-id>
→ resume <run-id>
```

`retry-agent` preserves all failed attempts and appends its existing recovery record.
It does not silently reset the attempt history.
