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
pnpm agents:recover-handoffs <runId>
pnpm agents:retry-agent <runId> <taskId>
pnpm agents:salvage-task <runId> <taskId>
pnpm agents:retry-integration <runId>
pnpm agents:apply-integration-fix <runId> <summary> <ownership-glob> [more-globs...]
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

`agents:retry-agent` is an explicit recovery authorization for one task whose process failed before any structured result was accepted. It accepts only a terminal `FAILED`/`BLOCKED` run with untouched integration state, a `FAILED` task whose final attempt ended as `AGENT_FAILED` or `AGENT_TIMEOUT`, satisfied dependencies, no task commit or accepted handoff/review, and a clean registered worktree still at its prepared SHA. It archives the terminal failure metadata append-only, makes only that task `READY`, resets only pristine `TASK_DEPENDENCY_FAILED` descendants attributable solely to it, and makes the run resumable. It never parses provider error prose and never invokes an agent; use `agents:resume` afterward. Successful tasks and their attempts/commits are immutable.

`agents:salvage-task` recovers useful work a timed-out writer left behind in a dirty worktree — the inverse case from `agents:retry-agent`, which requires a *clean* worktree. It accepts only a `FAILED`/`BLOCKED` task whose final attempt ended `AGENT_TIMEOUT` (not `AGENT_FAILED` — a process crash is out of scope), no task commit, satisfied dependencies, and a dirty worktree whose every changed tracked file is inside the task's own ownership globs, with no foreign commits, no unexpected untracked files, and a clean `git diff --check`. A dirty diff is never treated as success on its own: it runs `agentWorktree.prepare` (if configured, environment readiness only) and then the phase's `salvage.verify` commands — a config surface categorically separate from `prepare` and required for any task to be salvageable at all, since a passing test claim in agent stdout or a human's manual run is never sufficient evidence by itself. A `salvage.verify` command that mutates tracked source fails the salvage closed regardless of its own exit code. Verification success is checkpointed bound to the exact worktree HEAD, diff content, and verify config that produced it, so a crash-resumed salvage only reuses a still-valid checkpoint. The Orchestrator itself then creates the commit, the same way `agents:apply-integration-fix` does — salvage code never calls `git commit`. A task with a required canonical finding still needs one bounded, evidence-only repair call (the same cascade `agents:recover-handoffs` uses) to complete its `findingResponses`; salvage never bypasses canonical validation. Use `agents:resume` afterward. See `docs/superpowers/specs/2026-09-04-orchestrator-recovery-hardening-design.md` for the full design.

## Phase file

The YAML schema supports:

- immutable `baseBranch` resolution;
- `concurrency`, `agentRetries`, `agentTimeoutMs`, and `maxReviewRounds`;
- task `owner`, `mode`, `effort`, ownership globs, dependencies, and optional timeout/instructions;
- optional bounded `agentWorktree.prepare`, sequential required integration commands, and separate non-blocking diagnostics.

An optional task-level `timeoutMs` overrides the phase-level `agentTimeoutMs`; tasks that omit it keep the phase default. Both are provider-neutral execution budgets, and task values must be integer milliseconds from 1,000 through 86,400,000.

Fresh Git worktrees do not inherit ignored dependency directories. Configure repository-specific task bootstrap with `agentWorktree.prepare`; these bounded direct-exec commands run after each isolated task worktree and dependency commits exist, but before any agent is invoked. A successful result is reused only for the same registered worktree and exact prepared HEAD (package-manager stores such as pnpm's may still provide their own immutable-content reuse). Required failure records `AGENT_WORKTREE_PREPARATION_FAILED` with logs/timing and prevents agent launch. The engine never guesses or hard-codes a package manager. Integration setup remains separately configured with `integration.prepare`.

Task states are `PENDING`, `READY`, `RUNNING`, `SUCCEEDED`, `FAILED`, `BLOCKED`, `CANCELLED`, and `SKIPPED`. A task becomes READY once every dependency has either succeeded or been skipped — SKIPPED satisfies a downstream dependency the same way SUCCEEDED does, so a conditional branch never blocks the tasks after it. `SKIPPED` is a distinct terminal state, not a reuse of `FAILED`/`CANCELLED`: a skipped task creates no worktree, no commit, and does not count as a failure anywhere (metrics, the integration gate, or escalation eligibility). See "Conditional execution" under Solver/Verifier workflow mode for how a task becomes eligible to be skipped. Independent READY tasks can run concurrently, but parallel writers with overlapping globs are rejected. Sequential correction/Lead tasks may explicitly reuse ownership.

`mode: debate` is bounded: Codex and Claude each produce one proposal and one critique of the other proposal. A later Lead task receives those artifacts and selects `A`, `B`, `HYBRID`, or `BLOCKED`. There is no free-form conversation loop.

## Worktrees and commits

Writer tasks never share a working tree. The orchestrator creates branches such as `agent/<runId>/<taskId>` under the repository-owned `.agent-worktrees/` directory. Every branch originates from the run's captured SHA; known dependency commits are then applied in deterministic order.

Agents edit owned files, run tests, and emit structured handoffs; they must not run `git commit`. After validating the handoff and changed-file ownership, the orchestrator alone creates the task commit. This avoids linked-worktree Git-metadata permission assumptions and keeps commit provenance deterministic.

After an agent exits, Git—not the agent's narrative—determines changed paths. A writer that touches anything outside its ownership is stopped with `OWNERSHIP_VIOLATION`; its work is not integrated. Successful writers end with exactly one local `agent(<agent>): <taskId> <summary>` commit. Multiple commits, or a mixture of committed and uncommitted work, are rejected so integration cannot omit an earlier fragment. Nothing is pushed.

The ownership registry is atomically persisted and guarded by a repository-local cross-process lock. Separate orchestrator processes cannot silently overwrite one another's registrations. Cleanup still refuses unregistered or dirty worktrees and never uses `--force`.

The integration worktree also starts from the immutable run SHA and cherry-picks recorded task commits in dependency order. A conflict produces `INTEGRATION_CONFLICT`; no model silently resolves it. Integration commands execute directly as argument arrays, not through a shell, and record exit code, duration, timeout/termination state, and separate stdout/stderr. Per-command timeouts are bounded and terminate the process group before returning. Required failures stop the gate; diagnostics do not.

## Handoffs and reviews

Agents do not chat freely. Implementation/correction tasks return the runtime-validated handoff in `schemas/handoff.schema.json`. Review tasks return `schemas/review.schema.json`; every finding requires evidence, impact, a suggested fix, and verification.

Review and correction agents receive the actual dependency diff (bounded to 2 MiB so oversized tasks must be split), implementation handoffs, and earlier findings. Review, final-review, and escalation roles must start from that diff and the explicit task invariants; they inspect additional files only to prove or disprove a concrete suspicion using directly relevant schema, contracts, or neighboring code. Their contract forbids broad speculative repository exploration, unrelated-module review, architecture rediscovery, and mentally re-implementing the task. This preserves adversarial depth while requiring a material evidence-backed result within the configured execution budget. Correction prompts require each finding to be marked CONFIRMED or REJECTED with evidence. Final review is bounded by `maxReviewRounds`; unresolved material findings stop as `BLOCKED_FOR_HUMAN_REVIEW`.

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

Stable failures include `CONFIG_INVALID`, `BASE_BRANCH_MOVED`, `DAG_CYCLE`, `OWNERSHIP_OVERLAP`, `OWNERSHIP_VIOLATION`, `AGENT_NOT_FOUND`, `AGENT_FAILED`, `AGENT_TIMEOUT`, `HANDOFF_INVALID`, `REVIEW_BLOCKED`, `BLOCKED_FOR_HUMAN_REVIEW`, `CONTINUATION_SOURCE_INVALID`, `INTEGRATION_CONFLICT`, `INTEGRATION_TEST_FAILED`, and `STATE_CORRUPT`.

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
- `findingResponses` — optional for generic tasks, but mandatory for correction/testing work authorized by canonical finding provenance. Every assigned ID receives exactly one `{findingId, canonicalFindingKey, decision: confirmed|rejected, resolution: resolved|unresolved|not_applicable, evidence, fix?, verification?, reason?}` response; both ID and provenance key must exactly match the trusted assignment. Confirmed/resolved requires evidence, fix and verification; rejected requires evidence/reason and `not_applicable`. A canonical-incomplete but otherwise valid handoff may receive one bounded read-only metadata repair using only its original handoff, diff, tests/log evidence and immutable finding provenance; unsupported success fails closed and code generation is not rerun.

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

The test suite creates disposable Git repositories and fake Codex/Claude executables. It exercises process capture, timeout/kill, DAG scheduling, handoff validation, state recovery, worktree ownership, commits, conflicts, and integration failure without authentication or paid calls. The optional parser-only real Codex CLI compatibility smoke is disabled unless a human explicitly sets `ORCHESTRATOR_REAL_CLI_SMOKE=1`; it never starts a model task.

An optional first real-agent smoke should be a separately approved documentation-only phase file with ownership limited to a disposable file. Plan it first, inspect every printed wave/path, then run it once. Do not use `phase5.example.yaml` until Phase 5 execution is explicitly approved.

## Adaptive request/grant execution

`src/adaptive/` is an explicit, provider-neutral execution strategy for phases whose runtime topology is derived from evidence. The same `agents:plan`, `agents:run`, `agents:status`, `agents:resume`, `agents:retry-agent`, `agents:salvage-task`, and `agents:recover-handoffs` commands dispatch by phase strategy. Files without `mode: adaptive` still use the original static/solver-verifier path and output unchanged.

The authority boundaries are explicit:

```text
repository analysis -> DecompositionPlanner -> untrusted WorkRequest
                                              |
                         deterministic Arbiter (policy authority)
                                              |
                                           GRANT
                                              |
                         capability AgentRouter -> executor/adapter
                                              |
                      result evaluation -> possible new request
                                              |
                    bounded synthesis -> verdict gate
                         | changes_requested
             canonical finding -> policy-authorized ROOT correction
                         -> targeted re-review -> approved
                         -> configured preparation -> deterministic gate -> human
```

- The planner proposes explainable, evidence-bearing work; it cannot launch an executor.
- The arbiter alone grants resources. It checks dependencies, evidence, ownership scope/conflicts, capability availability, concurrency, fan-out/depth, wall-clock, invocation and estimated-cost budgets. Priority aging is deterministic.
- Non-file authority is exact and mode-aware: a request for `{kind, key, mode}` must be contained by `policy.allowedResources`; write contains read, while read never contains write. Missing legacy `mode` defaults conservatively to read. Executor capability and concrete resource authority are independent gates—neither grants the other, and agent-proposed child work cannot enlarge phase policy.
- The router sees an already-granted request and chooses by generic capabilities. Neither a provider nor a model appears in a grant decision.
- An agent may submit only the strict `WorkRequestDraft` shape. IDs, depth, state, policy, budget, provider and grant authority are deliberately absent, and unknown fields are rejected.
- AI-produced success is insufficient: `completionStatus(false)` cannot become complete until the deterministic gate passes.
- A read-only child can never request broader write authority. A correction is instead a new orchestrator root carrying persisted canonical-finding provenance and is checked against the separate correction write policy. Shard and synthesis proposals for the same canonical finding collapse to one correction per round.
- `changes_requested` is a hard integration barrier. Successful correction creates only a targeted re-review; integration is eligible after approval. `correctionPolicy.maxRounds` bounds the loop and unresolved findings then require human review.
- Configured `initialCandidates` are deterministic inputs, not pretend repository-semantic analysis. Later evidence-backed requests can come only from the strict structured-output field `additionalWorkRequests` and must pass the same Arbiter.

The adaptive policy shape is separate and opt-in:

```yaml
mode: adaptive
phase: future-phase
name: Evidence-driven future phase
baseBranch: main
canonicalDesignDocument: docs/design.md
goal: Implement and independently verify the approved goal
constraints:
  - no push
policy:
  allowedConcerns: [implementation, review, security, database, tests, synthesis]
  allowedOwnership: [apps/api/src/example/**]
  allowedResources:
    - { kind: database, key: tripwith-test, mode: write }
  requireEvidenceForExpansion: true
  agingIntervalMs: 30000
  agingStep: 5
  humanApprovalRisks: [critical]
  correctionPolicy:
    allowedOwnership: [apps/api/src/example/**]
    allowedRoles: [correction, testing]
    requireCanonicalFinding: true
    maxRounds: 2
  limits:
    maxConcurrentAgents: 4
    maxAgentInvocations: 16
    maxTotalWorkUnits: 24
    maxDecompositionDepth: 3
    maxFanOutPerWorkUnit: 6
    maxSynthesisInputs: 4
    maxWallClockMs: 3600000
    maxEstimatedCostUnits: 100
initialCandidates:
  - role: implementation
    concern: implementation
    objective: Implement the bounded approved change
    reason: The canonical contract identifies this work
    evidence:
      - { kind: file, reference: docs/design.md, summary: Approved invariant }
    resourceClaims:
      - { kind: repository_path, key: apps/api/src/example/**, mode: write }
    capabilities:
      - { capability: typescript, minimumLevel: 1 }
      - { capability: typescript_backend_editing, minimumLevel: 1 }
      - { capability: testing, minimumLevel: 1 }
    risk: medium
    priority: 80
executors:
  - id: primary-writer
    adapter: codex
    roles: [implementation, correction, testing]
    capabilities:
      - { capability: typescript, minimumLevel: 1 }
    effort: high
  - id: independent-reviewer
    adapter: claude
    roles: [review, synthesis, final_review, escalation]
    capabilities:
      - { capability: review, minimumLevel: 1 }
    effort: high
agentRetries: 1
agentTimeoutMs: 3600000
agentWorktree:
  prepare:
    - { command: pnpm install --frozen-lockfile, required: true, timeoutMs: 900000 }
integration:
  prepare:
    - { command: pnpm install --frozen-lockfile, required: true, timeoutMs: 900000 }
  commands:
    - { command: pnpm --filter @tripwith/api typecheck, required: true }
  diagnostics: []
```

`WorkRequest`, every `GrantDecision`, generated `DynamicWorkUnit`, attempt and lifecycle event are append-only persisted data under optional `RunState.adaptive`. A granted unit receives a stable ID and a complete materialized definition. Resume reconstructs that exact state; it never asks a planner to rediscover an authorized topology. Failed shards can be individually reopened, while successful siblings and synthesis inputs remain unchanged.

Correction authorization is never parsed from `additionalWorkRequests`. The orchestrator reads a validated persisted review artifact, records the finding ID, source work unit, artifact path, stable canonical key and round on a new root request, and only then asks the Arbiter for a grant. Reverification uses the correction commit as its dependency and retains every earlier review artifact. Process failure retries only the affected correction or re-review unit.

`integration.prepare` uses the same bounded direct-exec command shape as `integration.commands`. Results persist command, required flag, timeout, termination, exit status, duration, and redacted stdout/stderr paths. A required failure records `INTEGRATION_PREPARATION_FAILED`, distinct from `INTEGRATION_TEST_FAILED`. A successful preparation can be reused only for the exact same registered worktree and integration HEAD; a recreated worktree or changed checkpoint reruns it. Preparation cannot mark a run successful or create a commit, and tracked source modifications fail closed. Untracked dependency artifacts are tolerated and may be removed only during validated integration-worktree cleanup.

Fan-out is bounded by parent, depth, work-unit, agent-invocation and concurrency limits. Fan-in is constructed from `maxSynthesisInputs`, producing as many levels as required rather than assuming a fixed shard count. Writer conflicts reuse the repository's existing glob-overlap logic; concurrent readers do not conflict. A released resource becomes eligible for the next arbitration pass.

Adaptive planning is a true dry run: it resolves the immutable base and prints limits, requests, evidence, dependencies, claims, capabilities and current Arbiter decisions without creating run state, branches, worktrees or model calls. A real run persists the strategy, proposals, decisions, materialized units and routes before launching an agent. Resume rebuilds executable tasks solely from that persisted topology and the copied phase policy; it never invokes the planner again. Granted units reuse the production Agent adapters, worktree isolation, timeout/retry, strict handoff/review parsing, recovery commands, commit/ownership enforcement and deterministic integration gate. Completion still leaves the integration worktree for explicit human approval; nothing merges or pushes automatically.

### Cross-run canonical finding continuation

An adaptive phase may opt into `continuation.mode: canonical_findings` to create a new correction run from a prior run's accepted structured review. The YAML supplies only immutable pointers (`sourceRunId`, `sourceWorkUnitId`, `sourceArtifactType: review`, `expectedBaseSha`, and optional `expectedArtifactSha256`); it cannot supply finding contents or trusted authorization. `initialCandidates` must be empty/omitted and `correctionPolicy` is mandatory. When a prior digest is available, pinning it makes even schema-valid source-artifact replacement fail closed.

Planning loads the source run read-only and requires an adaptive, settled run; an eligible successful canonical synthesis/final review (or a lone canonical review); the exact latest `reviews/<work-unit>.json` artifact recorded by that task; a read-only prepared head equal to the source base; strict review-schema validity; `changes_requested`; repository identity; and exact equality among source base, expected base, and the continuation target base. It rejects symlinked/out-of-run artifacts. The imported snapshot records every complete finding, canonical key, source run/unit/path/base, import time, round, and SHA-256 of the exact artifact bytes.

The dry-run plan shows the imported findings, generated correction requests, and Arbiter decisions but creates no destination run, worktree, branch, or model call. On `agents:run`, the complete import, root requests, decisions, work units, and routes are atomically persisted before any executor can launch. Imported findings still pass ordinary phase ownership/capability/budget checks and the separate correction policy; a read-only source never transfers write access by itself.

Each correction is deduplicated by the provenance-bearing canonical key and round. Its targeted read-only re-verifier receives the original finding/provenance through the persisted task contract, the correction commit as `actualDependencyDiff`, and the correction handoff/tests. Resume does not reopen the source run or rediscover topology: it uses only the new run's persisted import and authorized work units. The source remains immutable evidence. See [`phases/phase6.canonical-continuation.yaml`](phases/phase6.canonical-continuation.yaml) for the concrete Phase 6 continuation, which is safe to plan but must not be run until explicitly approved.
