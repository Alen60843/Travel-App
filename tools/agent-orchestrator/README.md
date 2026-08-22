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
- Codex CLI and Claude Code discoverable per "Executable resolution" below
- Existing local authentication for the chosen CLIs

The detected development interfaces were Codex `0.149.0-alpha.4.1` (`codex exec`) and Claude Code `2.1.220` (`claude --print`). Codex supports explicit cwd, sandbox/approval policy, structured-output files, and `-m/--model` (confirmed via `codex exec --help`), but documents no effort/reasoning flag. Claude supports non-interactive output, permission modes, JSON schemas, `--model`, and `--effort`; `extra_high` maps to Claude's documented `xhigh`. Unsupported flags are never fabricated. `agents:plan` prints each resolved executable's path, discovery source, and per-agent model/effort override support so this stays visible per run rather than only documented here.

### Executable resolution

Neither adapter assumes its CLI is on `PATH`. Each agent name (`codex`, `claude`) resolves in this order, stopping at the first match:

1. **`CODEX_EXECUTABLE` / `CLAUDE_EXECUTABLE`** — an explicit environment-variable override, if set. Authoritative: if the configured path is not a valid executable file, resolution fails loudly with `AGENT_NOT_FOUND` rather than silently continuing to PATH. An empty/whitespace-only value is treated as unset.
2. **`PATH`** — the standard shell lookup.
3. **(Codex only) a conservative VS Code extension fallback** — `codex` may be installed only inside the OpenAI ChatGPT/Codex VS Code extension rather than on any shell's `PATH`. The fallback looks solely under `$HOME/.vscode/extensions/openai.chatgpt-*/bin/<platform>/codex`, macOS only, and never scans the filesystem. When multiple extension versions are present it prefers the most recently modified directory (by mtime, not lexical version-string ordering, since e.g. `0.9.0` sorts after `0.10.0` lexically but is actually older).

The path `agents:plan` resolves and prints is the exact same path threaded into the real adapter at run time — never a display-only value that the runtime silently re-resolves or falls back from. `agents:resume` reuses the path persisted at `start()` rather than re-resolving, so a run stays pinned to the binary it started with even if the environment changes mid-run.

## Commands

From the repository root:

```bash
pnpm agents:plan tools/agent-orchestrator/phases/phase5.example.yaml
pnpm agents:run tools/agent-orchestrator/phases/phase5.example.yaml
pnpm agents:resume <runId>
pnpm agents:status <runId>
pnpm agents:metrics <runId>
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

Task states are `PENDING`, `READY`, `RUNNING`, `SUCCEEDED`, `FAILED`, `BLOCKED`, `CANCELLED`, and `SKIPPED`. A task becomes READY once every dependency has either succeeded or been skipped — SKIPPED satisfies a downstream dependency the same way SUCCEEDED does, so a conditional branch never blocks the tasks after it. `SKIPPED` is a distinct terminal state, not a reuse of `FAILED`/`CANCELLED`: a skipped task creates no worktree, no commit, and does not count as a failure anywhere (metrics, the integration gate, or escalation eligibility). See "Conditional execution" under Solver/Verifier workflow mode for how a task becomes eligible to be skipped. Independent READY tasks can run concurrently, but parallel writers with overlapping globs are rejected. Sequential correction/Lead tasks may explicitly reuse ownership.

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

## Solver/Verifier workflow mode

Semantic roles — SOLVER, VERIFIER, FIXER, JUDGE, INTEGRATOR — are a naming layer over the same generic DAG engine described above, not a second scheduler. `src/workflow/solver-verifier.ts`'s `SEMANTIC_ROLE_BY_TASK_MODE` maps each existing `TaskMode` to its role (`implementation`→SOLVER, `review`/`final_review`→VERIFIER, `correction`→FIXER, `escalation`→JUDGE); INTEGRATOR has no generated task at all — it names the orchestrator's own automatic deterministic gate, which every run already goes through unconditionally once its tasks succeed. A future `solverPool: Agent[]` only changes what this module generates (e.g. multiple `solve-N` tasks feeding a shared `verify`), not how the unmodified engine runs it.

A phase file may use this mode as a shorthand instead of hand-writing a task list:

```yaml
phase: <id>
name: <string>
baseBranch: <branch>

workflow:
  mode: solver_verifier
  files: [<ownership glob>, ...]        # shared by the generated solve/fix tasks
  solver:     { agent: codex,  effort: high, model: <optional> }
  verifier:   { agent: claude, effort: high, model: <optional> }
  correction: { agent: codex,  effort: high, model: <optional> }
  maxCorrectionRounds: 0 | 1              # §6 MVP bound — rejected outright above 1, never silently clamped
  escalation:
    enabled: true
    agent: claude
    effort: extra_high

deterministicGate:
  commands: [...]     # same shape as the generic `integration.commands`
  diagnostics: [...]
```

This expands deterministically to `solve (implementation) -> verify (review) -> [fix (correction) -> reverify (final_review)] -> [judge (escalation)]`, then runs through the exact same `parsePhaseConfig` validation (DAG-cycle and ownership-overlap checks included) as a hand-written phase file. `pnpm agents:plan`/`agents:run`/`agents:resume` accept either shape in the same phase-file argument — `loadAnyPhaseConfig` dispatches on the presence of a top-level `workflow` key, so every existing generic phase file (including `phases/phase5.example.yaml`) is completely unaffected. See `phases/solver-verifier.example.yaml` for a complete, plannable illustration (targets a disposable path, not real application code, so it stays safe to `agents:plan` against any repository state).

### Conditional execution

`fix`, `reverify`, and `judge` are static graph edges (dependencies, ownership, and worktree wiring are all fixed at plan time — no second scheduler was built), but each carries an optional `condition` that the orchestrator evaluates immediately before that task would otherwise start, strictly before any worktree is created:

- `fix`/`reverify` carry `condition: { reviewOf: 'verify', skipIfStatus: ['approved'] }`. When `maxCorrectionRounds: 1` and `verify` approved on the first pass, both transition straight to `SKIPPED` — no Fixer invocation, no Re-Verifier invocation, no worktree, no commit.
- `judge` carries `condition: { reviewOf: 'reverify', skipIfStatus: ['approved'], minimumSeverity }`. It is skipped whenever `reverify` approved (nothing to arbitrate) or produced no review artifact at all (because `reverify` was itself skipped). `minimumSeverity` defaults to `'high'` — the MVP rule is that only critical/high findings make the expensive Judge eligible to run at all; a `final_review` whose only unresolved findings are medium/low still stops as `BLOCKED_FOR_HUMAN_REVIEW` rather than silently escalating or silently passing. A phase author can widen this via `workflow.escalation.minimumSeverity`.

The condition is evaluated against the same runtime-validated `StructuredReview` artifact everything else in this package already uses — never free-form text. A skipped task's `SKIPPED` status satisfies downstream dependencies exactly like `SUCCEEDED` (see "Worktrees and commits" above), so the deterministic integration gate still runs correctly on a clean path where `fix`/`reverify`/`judge` were all skipped. Crash/resume safety for a conditional task needs no special-case code: `agents:resume`'s existing reconciliation already returns an interrupted, uncommitted `RUNNING` task to `READY`, and re-evaluating the same persisted artifact after resume reaches the identical, deterministic answer.

This still mirrors the engine's pre-existing precedent that a `correction` task may make an empty commit when there is genuinely nothing to fix — the role contracts (`agent.ts`'s `roleContract`, `prompts/judge.md`, `prompts/fixer.md`) instruct the Fixer and Judge to report a trivial "nothing to do" completion on the rare path where they do run without a real defect to act on. But on the common clean path, they do not run at all.

### Candidate Solution and adversarial findings

`StructuredHandoff` gained four optional fields, all backward compatible with existing generic `implementation`/`correction`/`integration`/`debate` usage:

- `assumptions`, `knownRisks`, `attackSurface` — for implementation/Solver tasks: non-obvious constraints, known gaps, and the Solver's own pointer to where an adversarial Verifier is most likely to find a real defect. The Verifier is free to ignore `attackSurface`; it is a hint, not a substitute for independent judgment.
- `findingResponses` — for correction/Fixer tasks: one `{findingId, decision: confirmed|rejected, evidence, fix?, verification?, reason?}` entry per finding acted on. §5's requirement that the Fixer never apply findings blindly is enforced by requiring evidence on every entry, not by trusting a bare diff.

`ReviewFinding` gained four optional adversarial-verification fields — `counterexample`, `reproduction`, `expectedBehavior`, `violatingBehavior` — described in `prompts/adversarial-verifier.md`. They are optional rather than schema-required (enforcing them only for solver_verifier-mode reviews would need mode-conditional validation this MVP does not implement): a finding lacking them is weaker evidence, not an invalid one. What actually catches an unsubstantiated finding is the same mechanism that already existed — the Fixer's CONFIRMED/REJECTED response and the independent re-Verify.

### Escalation

A non-approved `final_review` normally stops the run as `BLOCKED_FOR_HUMAN_REVIEW` immediately and unconditionally — that remains the exact behavior for every phase without an escalation task. It changes only when that specific `final_review` has an `escalation`-mode dependent in the graph (detected structurally from the DAG, not from configuration): then the disagreement is handed to the Judge for one bounded arbitration attempt instead of failing immediately. The Judge itself runs read-only by default and reuses the ordinary handoff path — `status: "complete"` means resolved, `status: "blocked"` means unresolved and reports the same `BLOCKED_FOR_HUMAN_REVIEW` code `final_review` would have used. There is no second escalation attempt and no loop: a phase author who wants the Judge's resolution to trigger a further correction wires that as another explicit task depending on `judge`, by hand.

### Provider / model / effort

These are three independent axes. `TaskSpec.model` is optional and separate from `effort`. Whether it does anything depends on the adapter, verified against the actual installed CLI rather than assumed:

- **Claude** (`claude --help`, verified against Claude Code 2.1.220 while adding this field): `--model <model>` is a real, independent flag alongside the existing `--effort`. Wired in `agents/claude-agent.ts`, added to the invocation only when a task requests one.
- **Codex** (`codex exec --help`, verified against `codex-cli 0.149.0-alpha.4.1`, discovered via the VS Code extension fallback described under "Executable resolution"): `-m, --model <MODEL>` is a real, documented `exec`-subcommand flag. Wired in `agents/codex-agent.ts`, added to the invocation (after the `exec` subcommand and its options, before the stdin-prompt positional) only when a task requests one. The same `--help` output has no `--effort`/`--reasoning` flag of any kind, confirmed directly rather than inferred — `effort` remains a documented no-op for this adapter.

`pnpm agents:plan` prints each agent's resolved executable, discovery source, and this same model/effort support summary per run.

### Metrics

`pnpm agents:metrics <run-id>` (read-only; touches no agents, worktrees, or state) recomputes a `RunMetrics` summary purely from what a run already persists — `run.json`, `phase.yaml`, `events.jsonl`, and the handoff/review artifacts on disk — rather than adding new write-path state. Per task: role, agent, model, effort, status, attempts, duration, findings produced, confirmed/rejected findings, `executed` (false for a task that never left `PENDING`/`READY`/`RUNNING`/`SKIPPED`), and `skipReason` (the persisted reason, `null` unless the task's terminal status is `SKIPPED`). Aggregate: `verifierPrecision` (confirmed / total findings, `null` when no findings exist rather than a divide-by-zero), correction-round count, `roleExecution` (whether the Solver/Verifier/Fixer/Judge task actually executed, `null` when that role has no generated task in this run — a skipped Judge reports `judgeExecuted: false`, never counted toward escalation), whether escalation occurred and whether it resolved, and the deterministic gate's per-command results (recovered from `INTEGRATION_COMMAND_FINISHED` events, the same durable record the run itself already writes). `tokensUsed`/`costUsd` are always `null`: neither adapter's single-JSON-object response channel exposes structured usage data, and inventing a number would be worse than the honest "unknown" this field asks for. This shape is what lets a later pass compute verifier precision, escalation rate, and success rate broken down by provider/model/role/effort/task type across many runs, without this MVP needing to build that analysis itself.

## Fake-agent smoke testing

The test suite creates disposable Git repositories and fake Codex/Claude executables. It exercises process capture, timeout/kill, DAG scheduling, handoff validation, state recovery, worktree ownership, commits, conflicts, and integration failure without authentication or paid calls.

An optional first real-agent smoke should be a separately approved documentation-only phase file with ownership limited to a disposable file. Plan it first, inspect every printed wave/path, then run it once. Do not use `phase5.example.yaml` until Phase 5 execution is explicitly approved.
