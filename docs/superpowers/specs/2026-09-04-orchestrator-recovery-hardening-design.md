# Orchestrator recovery hardening: bounded repair accounting + timed-out writer salvage

## Context

This extends the existing TripWith Agent Orchestrator (`tools/agent-orchestrator`), which already implements adaptive request/grant scheduling, a three-tier handoff-repair cascade, and process-layer retry (`agents:retry-agent`). Two real, still-open Phase 6 dogfood problems motivate this work, observed on the real continuation run `run-20260904124350-dc56690c` (base `b4bc2c56962754e9dad6118db00b28a885d0ceea`):

- **work-000002** (F002, testing correction): the agent succeeded and produced a correct, evidence-backed diff, but its handoff omitted the required `findingResponses` entry for F002. The existing repair cascade (`parseOrRepairHandoff` → `repairHandoff` → `repairHandoffViaAgent`, `src/orchestrator.ts:1905-2095`) already dispatched a real, bounded, evidence-only agent-based repair attempt for this — confirmed via `runs/run-20260904124350-dc56690c/events.jsonl:79` (`HANDOFF_REPAIR_ATTEMPTED {method:"none", succeeded:false}`) and the corresponding Codex CLI log, which shows a genuine invocation that produced zero stdout (an agent-invocation-layer failure, not a design defect in the cascade). Nothing today prevents `agents:recover-handoffs` from re-firing that same real, potentially paid, agent call indefinitely, and nothing records *why* the attempt failed.
- **work-000001** (F001, correctness correction): the agent's process timed out (`AGENT_TIMEOUT`) after leaving a correct, evidence-backed dirty diff in its worktree. `agents:retry-agent`'s eligibility check (`checkAgentFailureRetryEligibility`, `src/orchestrator.ts:2680+`) correctly refuses to retry because the worktree is dirty — by design, that command is for pure process failures with no partial work. There is currently no path to recover useful work left behind by a timed-out writer; the only options are to discard it or hand-inspect it manually.

**Note on scope correction:** an earlier problem statement for this work described the `recover-handoffs` failure as caused by strict validation running before repair dispatch. Repo inspection (`src/orchestrator.ts:1905-2010`, `checkStructuredOutputRecoveryEligibility` at `:2833-2877`, and the candidate-selection loop in `recoverHandoffFailures` at `:604-665`) shows the cascade already dispatches correctly and already ran for real on work-000002. The actual gap is the missing idempotency/attempt-accounting layer described below. This document reflects the verified repo state, not the original narrative.

Two protected constraints carry through unchanged from the original brief and are non-negotiable for this work:

- Real runs (`run-20260904124350-dc56690c`, `run-20260904101940-9fdd27c5`, `run-20260903203914-cc2b57d4`) and `apps/api/src/events/**` are never modified, and `agents:recover-handoffs`/`agents:retry-agent`/`agents:salvage-task` are never invoked against them during this work.
- Tests use fake/injected agents only — no real Codex/Claude/Gemini/OpenAI invocations, matching what the real work-000002 log shows can silently fail in this environment anyway.

## Part A — Bounded handoff-repair accounting

### Problem this solves

`TaskRunState.handoffRepairAttempted`/`handoffRepairSucceeded` (`src/state/run-state.ts:97-99`) are plain booleans with no history and no failure classification. `checkStructuredOutputRecoveryEligibility` (`src/orchestrator.ts:2833`) never looks at them, so a task whose repair already genuinely failed is exactly as "eligible" for `agents:recover-handoffs` as one that's never been tried — rerunning the command just re-fires the same real agent call with no memory and no bound.

### Data model change

Replace the two booleans with a persisted, append-only attempt history on `TaskRunState`:

```ts
interface HandoffRepairAttemptRecord {
  readonly method: 'framing' | 'deterministic' | 'agent' | 'none';
  readonly failureReason?: 'agent_invocation_failed' | 'evidence_insufficient' | 'contradiction_detected';
  readonly succeeded: boolean;
  readonly timestamp: string; // ISO-8601, from the same clock the rest of run-state uses
}

// on TaskRunState, replacing handoffRepairAttempted/handoffRepairSucceeded:
readonly handoffRepairAttempts: readonly HandoffRepairAttemptRecord[];
```

`handoffRepairAttempts.length > 0` replaces the old `handoffRepairAttempted !== undefined` checks (two call sites in `checkAgentFailureRetryEligibility`, `src/orchestrator.ts:2710-2711` and `:2804-2805` — both keep working unchanged, just reading array-non-empty instead of boolean-defined). `handoffRepairAttempts.at(-1)?.succeeded` replaces `handoffRepairSucceeded`. `src/state/run-state.ts`'s parse/validate functions gain a bounded array parser for the new field (reusing the existing per-field parser pattern already used for `agentAttempts`).

### Failure classification

`repairHandoff` (`src/orchestrator.ts:1970-2010`) and `repairHandoffViaAgent` (`:2019-2095`) currently collapse every non-success path to `null`. Change the return type to carry a reason instead of losing it:

```ts
type RepairOutcome =
  | { readonly ok: true; readonly handoff: StructuredHandoff; readonly method: 'framing' | 'deterministic' | 'agent' }
  | { readonly ok: false; readonly reason: 'agent_invocation_failed' | 'evidence_insufficient' | 'contradiction_detected' };
```

Mapping from existing code paths (no behavioral change to *what* is accepted or rejected — only to what gets recorded):
- `repairHandoffViaAgent`'s `catch { return null }` around `this.agents[task.owner].run(request)` (`:2066-2070`) and its `result.status !== 'succeeded'` branch (`:2071-2073`) → `agent_invocation_failed`. This is exactly what happened for real on work-000002.
- The `withoutResponses(repaired) !== withoutResponses(originalHandoff)` mismatch (`:2082-2084`) → `contradiction_detected`. Fails closed exactly as today; only the label changes.
- The `claimsResolved && (no diff || no passing test)` guard (`:2085-2089`) and the final `parseHandoff`/`validateCanonicalFindingResponses` catch (`:2092-2094`) → `evidence_insufficient`.
- `framed.reason === 'ambiguous'` (`:1988-1990`) keeps failing closed exactly as today, recorded as method `'framing'`, `failureReason: 'evidence_insufficient'` (ambiguous framing is a form of "not enough to act on").

`parseOrRepairHandoff` (`:1905-1943`) records one `HandoffRepairAttemptRecord` per attempt via `recordHandoffOutcome`, appending rather than overwriting.

### Attempt budget + idempotency

New config, `AdaptiveLimits`-adjacent (or a sibling top-level field — final placement decided during implementation to match existing config parsing conventions): `maxHandoffRepairAttempts`, default `2`. `checkStructuredOutputRecoveryEligibility` gains a check: if `taskState.handoffRepairAttempts.length >= maxHandoffRepairAttempts`, return `{ eligible: false, reason: 'handoff repair attempt budget exhausted' }`. `recoverHandoffFailures`'s existing all-or-nothing eligibility gate (`:651-665`) surfaces this the same way it surfaces every other ineligibility reason today — no new error code needed there, it already reports structured per-task reasons under `TASK_STATE_INVALID`.

This delivers the idempotency the original brief asked for correctly: a task that has already exhausted its budget is simply never eligible again, so re-running `agents:recover-handoffs` on it is a safe no-op (fails fast with a clear reason) rather than a repeat real agent invocation. A task that succeeds is no longer `FAILED`, so `checkStructuredOutputRecoveryEligibility`'s first check (`taskState.status !== 'FAILED'`, `:2837-2839`) already makes success permanently idempotent — unchanged, just confirming existing behavior still holds.

No `--force` override is introduced — out of scope unless the user asks for it; an operator who needs to retry past the budget can raise `maxHandoffRepairAttempts` in phase config, which is itself an auditable, deliberate act rather than a silent flag.

## Part B — Timed-out writer salvage

### New command

`pnpm agents:salvage-task <run-id> <task-id>` → `AgentOrchestrator.salvageTask(runId, taskId, options)`, wired into `src/cli.ts` next to the other recovery commands (`retry-agent`, `recover-handoffs`, `apply-integration-fix`).

### Eligibility (`checkSalvageEligibility`)

Structurally the mirror of `checkAgentFailureRetryEligibility` (`src/orchestrator.ts:2680+`), sharing its process-failure/no-commit/registered-worktree/HEAD-unmoved checks, but inverted on dirtiness and extended with ownership/content checks:

1. `taskState.status` is `FAILED` or `BLOCKED` with `error.code === 'AGENT_TIMEOUT'` and the last recorded agent attempt's `outcome === 'timed_out'` (matching real work-000001's recorded state exactly, and mirroring how `checkAgentFailureRetryEligibility` already defines `AGENT_TIMEOUT` as a process-layer failure at `src/orchestrator.ts:2691-2693`). `AGENT_FAILED` (a process crash, as opposed to a timeout) is deliberately excluded from salvage scope in this iteration — a crashed process is a different failure shape than a timed-out one, and folding it in without a real example to validate against would be scope creep. It can be added later behind the same eligibility function if a real case motivates it.
2. `taskState.commit === undefined`.
3. Worktree is registered (`this.worktrees.assertRegistered`) and its path still exists on disk.
4. Worktree HEAD equals `taskState.preparedHeadSha` (reusing `inspectTaskCommits`, same as retry-agent) — no foreign commits.
5. Working tree **is** dirty (tracked changes and/or untracked files present) — the inverse of retry-agent's requirement. A clean worktree is not salvage work; `checkSalvageEligibility` returns ineligible with reason `'worktree has no dirty changes to salvage'`.
6. Every changed **tracked** file matches one of `task.files` (the task's authorized ownership globs), via the existing `matchesOwnershipPattern`/`assertChangedFileOwnership` (`src/tasks/ownership.ts`) — any tracked file outside ownership fails closed.
7. No unexpected untracked files: only paths matching `task.files` ownership globs are tolerated as untracked-and-new; anything else (a stray script, an unrelated file) fails closed rather than being silently ignored.
8. `git diff --check` passes on the dirty diff.
9. The task has not already been consumed by integration (`taskState.status !== 'SUCCEEDED'` is implied by check 1, but this also confirms the run's `integration` state hasn't already advanced past this task).
10. Dependencies (`task.dependsOn`) are all `SUCCEEDED`/`SKIPPED` — same rule `checkAgentFailureRetryEligibility` already applies.

### Config: `salvage.verify`

New generic command list, same shape/parser as `IntegrationCommand` (`src/config.ts:9`) and `agentWorktree.prepare`:

```yaml
salvage:
  verify:
    - command: pnpm --filter @tripwith/api exec jest --config jest.config.js --runInBand src/events/event-validation.spec.ts
      required: true
      timeoutMs: 300000
```

No hardcoded package manager or test runner in core logic — same `parseCommand`/`parseCommandList` machinery already used for `integration.prepare`/`agentWorktree.prepare`. If a phase has no `salvage.verify` configured for a task's role, that task is never salvageable — matches the brief's "do not trust operator prose" requirement (§18) directly: a passing test claim recorded in agent stdout, or in a human's manual run, is never sufficient on its own.

### Flow

```
checkSalvageEligibility
  → SALVAGE_AUTHORIZED (persisted event/state checkpoint)
  → agentWorktree.prepare (if configured; worktree may be stale)
  → run salvage.verify commands
  → SALVAGE_VERIFIED (persisted checkpoint; required commands must all pass,
    else throw SALVAGE_VERIFICATION_FAILED — new error code, same family as
    INTEGRATION_TEST_FAILED/AGENT_WORKTREE_PREPARATION_FAILED)
  → if the task carries required canonical findings (e.g. F001):
      synthesize a minimal handoff shell (filesChanged from the diff,
      tests from verify results, summary noting salvage) — there was never
      an original agent handoff to start from — then run it through the
      SAME Part A repair cascade (parseOrRepairHandoff) to attach
      findingResponses. Strict canonical validation applies exactly as for
      any other task; no bypass path.
  → Orchestrator creates the commit via ensureTaskCommit (src/git/diff.ts:120)
    + assertChangedFileOwnership (src/tasks/ownership.ts:234) — the same
    two helpers applyIntegrationFix already uses (src/orchestrator.ts:836-846).
    Salvage code itself never calls git commit.
  → succeedTask / existing targeted re-verification path (same as any other
    canonical correction, per the existing changes_requested-blocks-integration
    gate) — no salvage-specific integration shortcut.
```

### Crash safety

Each arrow above is a persisted checkpoint via the existing `mutate`/`event` pattern already used throughout the orchestrator (e.g. `applyIntegrationFix`, `recoverHandoffInvalidTask`). On resume, `salvageTask` re-checks the latest persisted checkpoint for that task and skips completed steps: already-authorized doesn't re-run eligibility from scratch in a way that could reach a different answer on a since-changed worktree (it re-validates, since the worktree is external state — but doesn't redo verification if `SALVAGE_VERIFIED` is already recorded for the current diff), already-verified doesn't re-run verify commands, and already-committed (`taskState.commit !== undefined`) makes the task ineligible for salvage at all (check 2 above), so a duplicate commit is structurally impossible — same invariant `checkStructuredOutputRecoveryEligibility` already relies on.

### Failure isolation

`salvageTask` operates on exactly one `taskId`'s state slice via the same `updateTask`/`mutate` pattern used everywhere else in the orchestrator — it never iterates over sibling tasks. work-000003/work-000004 (already `SUCCEEDED`) are structurally untouched: nothing in this design reads or writes any task state keyed by a different task id.

## Testing plan

All tests use fake/injected agents (the existing `agents/agent.ts` test-double pattern already used in `test/agents/*`, `test/workflow/agent-failure-retry.test.ts`) — never a real Codex/Claude process.

**Part A** (new: `test/workflow/handoff-repair-accounting.test.ts` or similar):
1. Canonical-incomplete handoff → repair dispatched (already true today; regression-proves it stays true).
2. Injected agent that throws / returns non-`succeeded` → recorded as `agent_invocation_failed`; task remains recoverable if budget remains.
3. Injected agent that returns a semantically-contradicting rewrite → `contradiction_detected`, fails closed, matches existing `withoutResponses` behavior.
4. Injected agent that can't produce sufficient evidence → `evidence_insufficient`.
5. Repeated `recover-handoffs` calls exceeding `maxHandoffRepairAttempts` → ineligible with a clear reason, no further agent invocation attempted (assert the fake agent's call count stops increasing).
6. Malformed JSON / framing-only defect → unchanged existing framing-recovery behavior (regression).
7. Unknown/unassigned canonical finding ID in a would-be repair → still rejected (regression, existing `validateCanonicalFindingResponses` behavior).
8. Successful repair is permanently idempotent — a second `recover-handoffs` call is a no-op (task no longer `FAILED`).
9. Generic (non-canonical) handoff repair paths unchanged (regression).

**Part B** (new: `test/workflow/agent-timeout-salvage.test.ts` or similar):
1. `AGENT_TIMEOUT` + dirty diff fully inside ownership → eligible.
2. Clean timed-out worktree → ineligible (`'worktree has no dirty changes to salvage'`).
3. Dirty change outside `task.files` ownership → ineligible.
4. Worktree HEAD has a foreign commit → ineligible.
5. Unexpected untracked file outside ownership → ineligible.
6. `git diff --check` failure → ineligible.
7. `salvage.verify` failure (required command fails) → `SALVAGE_VERIFICATION_FAILED`, no commit created.
8. Task with a required canonical finding but a fake repair agent that can't produce a valid `findingResponses` entry → salvage fails closed, no commit.
9. Successful salvage → commit created via `ensureTaskCommit`, task `SUCCEEDED`, correct commit ownership enforced.
10. Sibling `SUCCEEDED` tasks' state is bitwise unchanged after a salvage run touching a different task.
11. Simulated crash after `SALVAGE_AUTHORIZED` but before verify → resume re-verifies (not silently skipped, since worktree could have changed) but does not re-authorize from scratch incorrectly.
12. Simulated crash after commit → resume recognizes `taskState.commit !== undefined` and refuses a second salvage/commit.
13. A task whose failure is a genuine implementation/semantic error (not `AGENT_TIMEOUT`/process-layer) → salvage refuses regardless of diff cleanliness.
14. A task already consumed by integration → salvage refuses.

## Backward compatibility

No changes to: static DAG workflows, solver/verifier mode, ordinary adaptive scheduling, canonical cross-run continuation, `agents:retry-agent`'s existing clean-worktree requirement, framing/deterministic-key handoff recovery, correction authority boundaries, targeted re-verification, `agentWorktree.prepare`/`integration.prepare` semantics, or non-file resource policy. The `handoffRepairAttempted`/`handoffRepairSucceeded` → `handoffRepairAttempts` field rename is the one breaking shape change to persisted state; existing run-state files with the old boolean fields will fail `validateRunState`'s strict parsing (`STATE_CORRUPT`) the same way any other unrecognized-shape state already does today — this is acceptable because the three protected real runs are never resumed/mutated during this work, and no other run state is expected to exist that needs migrating.

## Explicit non-goals

- No terminal dashboard (`agents:watch`, colored `agents:status`) — deferred, tracked separately.
- No real recovery performed against the real runs; no commits, no pushes.
- No `--force` bypass for exhausted repair budgets.
- No fuzzy/heuristic text-matching of diff content against a finding's suggested fix as a substitute for agent-based semantic judgment — that would be per-finding hardcoding in disguise, which both the original brief and this design explicitly reject.
