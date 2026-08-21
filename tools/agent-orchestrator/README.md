# TripWith local agent orchestrator

This package coordinates bounded Codex and Claude Code tasks for future TripWith phases. It is a local engineering tool, not a runtime service and not an autonomous merge system.

The controlled workflow is:

```text
Codex implementation
  -> Claude independent review
  -> Codex evidence-based correction
  -> Claude final review
  -> deterministic Lead integration
  -> orchestrator-run regression commands
  -> human approval before merge or push
```

The orchestrator never implements Phase 5 merely because the example file exists. `agents:plan` is read-only. `agents:run` starts paid/local agent processes and must only be used after the phase itself is approved.

## Requirements

- Node.js 20.11 or newer and pnpm 9
- Git with worktree support
- Codex CLI and Claude Code on `PATH` for real runs
- Existing local authentication for the chosen CLIs

The detected development interfaces were Codex `0.149.0-alpha.4` (`codex exec`) and Claude Code `2.1.220` (`claude --print`). Codex supports explicit cwd, sandbox/approval policy and structured-output files, but documents no effort flag. Claude supports non-interactive output, permission modes, JSON schemas and `--effort`; `extra_high` maps to Claude's documented `xhigh`. Unsupported flags are never fabricated.

## Commands

From the repository root:

```bash
pnpm agents:plan tools/agent-orchestrator/phases/phase5.example.yaml
pnpm agents:run tools/agent-orchestrator/phases/phase5.example.yaml
pnpm agents:resume <runId>
pnpm agents:status <runId>
pnpm agents:cleanup <runId>
```

Package verification:

```bash
pnpm --filter @tripwith/agent-orchestrator typecheck
pnpm --filter @tripwith/agent-orchestrator test
pnpm --filter @tripwith/agent-orchestrator smoke
```

`agents:plan` validates YAML and runtime schemas, resolves the immutable base SHA, verifies executables, rejects DAG cycles and unsafe concurrent ownership, and prints execution waves. It creates no run, branch or worktree and invokes no agent.

`agents:run` creates a run and executes READY tasks up to the conservative configured limit. `agents:resume` uses the stored phase snapshot/base SHA and reconciles interrupted tasks rather than blindly rerunning committed work. `agents:status` reads state only. `agents:cleanup` removes only terminal run worktrees recorded in the ownership registry; it refuses unknown worktrees.

## Phase file

The YAML schema supports:

- immutable `baseBranch` resolution;
- `concurrency`, `agentRetries`, `agentTimeoutMs`, and `maxReviewRounds`;
- task `owner`, `mode`, `effort`, ownership globs, dependencies, and optional timeout/instructions;
- sequential required integration commands and separate non-blocking diagnostics.

Fresh Git worktrees do not inherit ignored `node_modules` directories. Real phase task instructions should run `pnpm install --frozen-lockfile` before task-local tests when dependencies are absent, and the integration gate should bootstrap the same way. The Phase 5 example includes this explicitly.

Task states are `PENDING`, `READY`, `RUNNING`, `SUCCEEDED`, `FAILED`, `BLOCKED`, and `CANCELLED`. A task becomes READY only after every dependency succeeds. Independent READY tasks can run concurrently, but parallel writers with overlapping globs are rejected. Sequential correction/Lead tasks may explicitly reuse ownership.

`mode: debate` is bounded: Codex and Claude each produce one proposal and one critique of the other proposal. A later Lead task receives those artifacts and selects `A`, `B`, `HYBRID`, or `BLOCKED`. There is no free-form conversation loop.

## Worktrees and commits

Writer tasks never share a working tree. The orchestrator creates branches such as `agent/<runId>/<taskId>` under the repository-owned `.agent-worktrees/` directory. Every branch originates from the run's captured SHA; known dependency commits are then applied in deterministic order.

After an agent exits, Git—not the agent's narrative—determines changed paths. A writer that touches anything outside its ownership is stopped with `OWNERSHIP_VIOLATION`; its work is not integrated. Successful writers end with exactly one local `agent(<agent>): <taskId> <summary>` commit. Multiple commits, or a mixture of committed and uncommitted work, are rejected so integration cannot omit an earlier fragment. Nothing is pushed.

The ownership registry is atomically persisted and guarded by a repository-local cross-process lock. Separate orchestrator processes cannot silently overwrite one another's registrations. Cleanup still refuses unregistered or dirty worktrees and never uses `--force`.

The integration worktree also starts from the immutable run SHA and cherry-picks recorded task commits in dependency order. A conflict produces `INTEGRATION_CONFLICT`; no model silently resolves it. Integration commands execute directly as argument arrays, not through a shell, and record exit code, duration, timeout/termination state, and separate stdout/stderr. Per-command timeouts are bounded and terminate the process group before returning. Required failures stop the gate; diagnostics do not.

## Handoffs and reviews

Agents do not chat freely. Implementation/correction tasks return the runtime-validated handoff in `schemas/handoff.schema.json`. Review tasks return `schemas/review.schema.json`; every finding requires evidence, impact, a suggested fix, and verification.

Review and correction agents receive the actual dependency diff (bounded to 2 MiB so oversized tasks must be split), implementation handoffs, and earlier findings. Correction prompts require each finding to be marked CONFIRMED or REJECTED with evidence. Final review is bounded by `maxReviewRounds`; unresolved material findings stop as `BLOCKED_FOR_HUMAN_REVIEW`.

Prompts and artifacts contain summaries, diffs, evidence, decisions, and test results—not private chain-of-thought.

## Persistent state and observability

Each run owns:

```text
runs/<runId>/
  run.json
  phase.yaml
  events.jsonl
  tasks/
  logs/
  handoffs/
  reviews/
```

Critical JSON uses write-to-temp, fsync, atomic rename, and directory fsync. Events are structured JSONL records such as `RUN_CREATED`, `TASK_READY`, `AGENT_STARTED`, `TASK_COMMITTED`, `INTEGRATION_COMMAND_FINISHED`, `RUN_BLOCKED`, and `RUN_COMPLETED`. Prompt bodies and complete environment dumps are not events.

Resume verifies the repository identity and original branch SHA. If the branch moved, it stops with `BASE_BRANCH_MOVED`. A task left `RUNNING` is inspected for its known worktree and commit: a valid committed result is recovered; an absent process without a valid commit is made safely retryable or failed according to its recorded attempts.

Stable failures include `CONFIG_INVALID`, `BASE_BRANCH_MOVED`, `DAG_CYCLE`, `OWNERSHIP_OVERLAP`, `OWNERSHIP_VIOLATION`, `AGENT_NOT_FOUND`, `AGENT_FAILED`, `AGENT_TIMEOUT`, `HANDOFF_INVALID`, `REVIEW_BLOCKED`, `BLOCKED_FOR_HUMAN_REVIEW`, `INTEGRATION_CONFLICT`, `INTEGRATION_TEST_FAILED`, and `STATE_CORRUPT`.

## Security and approval boundaries

- Child processes receive argument arrays and explicit cwd; prompt text is passed over stdin.
- Agent timeouts first terminate the process group, then force-kill after a bounded grace period.
- CLI `SIGINT`/`SIGTERM` is propagated through the same abort path, persists the run as `CANCELLED`, and leaves no agent/integration descendants running.
- Captured logs are permission-restricted and redact known secret environment values, private-key blocks, bearer tokens, and common credential assignments.
- YAML has no executable JavaScript, aliases are disabled, traversal is rejected, and integration commands reject shell interpolation/operators.
- Cleanup verifies the repository-owned root and ownership registry before removing a worktree.
- There is no force push, auto-push, automatic phase/main merge, secret editing, arbitrary remote execution, deployment, or unknown-worktree deletion.

The tool stops for a human before merge/push, unapproved migrations/dependencies, destructive Git/history changes, or conflict resolution. The manual next step after a green run is to inspect `agents:status`, the integration branch/worktree, handoffs, reviews, and gate logs; then the human decides whether and how to merge.

## Fake-agent smoke testing

The test suite creates disposable Git repositories and fake Codex/Claude executables. It exercises process capture, timeout/kill, DAG scheduling, handoff validation, state recovery, worktree ownership, commits, conflicts, and integration failure without authentication or paid calls.

An optional first real-agent smoke should be a separately approved documentation-only phase file with ownership limited to a disposable file. Plan it first, inspect every printed wave/path, then run it once. Do not use `phase5.example.yaml` until Phase 5 execution is explicitly approved.
