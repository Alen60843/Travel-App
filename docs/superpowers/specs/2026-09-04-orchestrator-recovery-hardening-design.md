# Orchestrator recovery hardening: bounded repair accounting + timed-out writer salvage

## Context

This extends the existing TripWith Agent Orchestrator (`tools/agent-orchestrator`), which already implements adaptive request/grant scheduling, a three-tier handoff-repair cascade, and process-layer retry (`agents:retry-agent`). Two real, still-open Phase 6 dogfood problems motivate this work, observed on the real continuation run `run-20260904124350-dc56690c` (base `b4bc2c56962754e9dad6118db00b28a885d0ceea`):

- **work-000002** (F002, testing correction): the agent succeeded and produced a correct, evidence-backed diff, but its handoff omitted the required `findingResponses` entry for F002. The existing repair cascade (`parseOrRepairHandoff` → `repairHandoff` → `repairHandoffViaAgent`, `src/orchestrator.ts:1905-2095`) already dispatched a real, bounded, evidence-only agent-based repair attempt for this — confirmed via `runs/run-20260904124350-dc56690c/events.jsonl:79` (`HANDOFF_REPAIR_ATTEMPTED {method:"none", succeeded:false}`) and the corresponding Codex CLI log, which shows a genuine invocation that produced zero stdout (an agent-invocation-layer failure, not a design defect in the cascade). Nothing today prevents `agents:recover-handoffs` from re-firing that same real, potentially paid, agent call indefinitely, and nothing records *why* the attempt failed. The real run's persisted state currently records this as the legacy shape `handoffRepairAttempted: true, handoffRepairSucceeded: false`.
- **work-000001** (F001, correctness correction): the agent's process timed out (`AGENT_TIMEOUT`) after leaving a correct, evidence-backed dirty diff in its worktree. `agents:retry-agent`'s eligibility check (`checkAgentFailureRetryEligibility`, `src/orchestrator.ts:2680+`) correctly refuses to retry because the worktree is dirty — by design, that command is for pure process failures with no partial work. There is currently no path to recover useful work left behind by a timed-out writer; the only options are to discard it or hand-inspect it manually.

**Note on scope correction:** an earlier problem statement for this work described the `recover-handoffs` failure as caused by strict validation running before repair dispatch. Repo inspection (`src/orchestrator.ts:1905-2010`, `checkStructuredOutputRecoveryEligibility` at `:2833-2877`, and the candidate-selection loop in `recoverHandoffFailures` at `:604-665`) shows the cascade already dispatches correctly and already ran for real on work-000002. The actual gap is the missing idempotency/attempt-accounting layer described below. This document reflects the verified repo state, not the original narrative.

**Revision note (this version):** revised per reviewer feedback on the first draft. Substantive changes: (1) eligibility failures and repair-execution failures are now given fully distinct, stable machine-readable representations rather than sharing prose strings; (2) `salvage.verify` is stated as categorically separate from `agentWorktree.prepare`, with an explicit invariant that verification must never mutate tracked source; (3) legacy persisted `handoffRepairAttempted`/`handoffRepairSucceeded` state is migrated on load rather than rejected as `STATE_CORRUPT`, and a migrated legacy attempt counts toward the new attempt budget; (4) salvage verification checkpoints are bound to a content fingerprint of the exact diff and verify config they validated, not just a step-completed flag; (5) a provider-neutral acceptance scenario shaped like the real F001/F002/F003/work-000004 state is added. See inline callouts below for exactly what changed and why.

An important consequence of point (3), stated explicitly here because it affects a decision the user will make later, outside this work: since the real work-000002 already has one recorded (legacy) failed repair attempt, and the default budget introduced below is 2, a future real `agents:recover-handoffs run-20260904124350-dc56690c` invocation (performed later, by the user, after this work is reviewed — **not** performed as part of this implementation) will have exactly **one** remaining real attempt before the budget is exhausted.

Two protected constraints carry through unchanged from the original brief and are non-negotiable for this work:

- Real runs (`run-20260904124350-dc56690c`, `run-20260904101940-9fdd27c5`, `run-20260903203914-cc2b57d4`) and `apps/api/src/events/**` are never modified, and `agents:recover-handoffs`/`agents:retry-agent`/`agents:salvage-task` are never invoked against them during this work.
- Tests use fake/injected agents only — no real Codex/Claude/Gemini/OpenAI invocations, matching what the real work-000002 log shows can silently fail in this environment anyway.

## Part A — Bounded handoff-repair accounting

### Problem this solves

`TaskRunState.handoffRepairAttempted`/`handoffRepairSucceeded` (`src/state/run-state.ts:97-99`) are plain booleans with no history and no failure classification. `checkStructuredOutputRecoveryEligibility` (`src/orchestrator.ts:2833`) never looks at them, so a task whose repair already genuinely failed is exactly as "eligible" for `agents:recover-handoffs` as one that's never been tried — rerunning the command just re-fires the same real agent call with no memory and no bound.

### Two distinct layers — never conflated

This is the central structural fix requested in review, so it is stated up front as an explicit invariant:

> **Eligibility failure** (can this repair even start?) and **repair execution failure** (it started, and did not produce a usable result) are different concepts, checked at different times, by different code, and persisted in different places. Neither is ever reported through the other's mechanism.

| | Eligibility failure | Repair execution failure |
|---|---|---|
| When | Before `repairHandoff` is ever called | Inside the `repairHandoff` cascade, after dispatch |
| Where checked | `checkStructuredOutputRecoveryEligibility` (extended below) | `repairHandoff` / `repairHandoffViaAgent` (extended below) |
| How reported | `OrchestratorError('TASK_STATE_INVALID', ..., { details: { ineligible: [{ taskId, reason, reasonCode }] } })` — unchanged error code, richer detail | Appended `HandoffRepairAttemptRecord` on the task's persisted state |
| Stable machine-readable value | New `HandoffRecoveryEligibilityReasonCode` enum (below) | Existing `failureReason` union on `HandoffRepairAttemptRecord` (below) |
| Example | "budget already exhausted, never even tried" | "budget had room, agent was invoked, agent produced no output" |

### Eligibility reason codes

`checkStructuredOutputRecoveryEligibility`'s return type gains a `reasonCode`, and the caller's `ineligible` reporting in `recoverHandoffFailures` (`:651-665`) carries it through:

```ts
type HandoffRecoveryEligibilityReasonCode =
  | 'HANDOFF_TASK_CONFIG_MISSING'          // task id not found in loaded phase config
  | 'HANDOFF_TASK_MODE_MISMATCH'           // review-kind candidate whose task.mode isn't a review/final_review mode
  | 'HANDOFF_TASK_NOT_FAILED'              // status !== FAILED, or error.code !== expected
  | 'HANDOFF_LAST_ATTEMPT_NOT_SUCCEEDED'   // most recent agentAttempt didn't succeed
  | 'HANDOFF_COMMIT_ALREADY_RECORDED'      // taskState.commit !== undefined
  | 'HANDOFF_WORKTREE_NOT_PRESERVED'       // worktreePath/preparedHeadSha missing
  | 'HANDOFF_WORKTREE_NOT_REGISTERED'      // assertRegistered failed
  | 'HANDOFF_WORKTREE_INVALID_DESCENDANT'  // inspectTaskCommits failed
  | 'HANDOFF_WORKTREE_HEAD_MOVED'          // headSha !== preparedHeadSha
  | 'HANDOFF_WORKTREE_HAS_FOREIGN_COMMITS' // commits.length > 0
  | 'HANDOFF_ORIGINAL_LOG_MISSING'         // preserved stdout log absent
  | 'HANDOFF_REPAIR_BUDGET_EXHAUSTED';     // NEW — handoffRepairAttempts.length >= maxHandoffRepairAttempts
```

Each existing `return { eligible: false, reason: '...' }` branch in `checkStructuredOutputRecoveryEligibility` (`:2837-2876`) and in the two pre-checks inside `recoverHandoffFailures`'s `checked.map` (`:628-643`) gains its matching code alongside the existing human-readable `reason` string — the string stays for logs/CLI output, the code is what tests and any future tooling assert against.

One code from the reviewer's example list, `HANDOFF_REPAIR_ALREADY_RESOLVED`, is deliberately **not** included: given the current architecture, a successful repair always transitions the task out of `FAILED` via `finishParsedHandoff`/`succeedTask`, so `HANDOFF_TASK_NOT_FAILED` already covers "this task's repair already succeeded" — there is no reachable branch where a task is still `FAILED` *and* its last repair attempt succeeded. Documented here rather than added unreachable, per the same "don't fabricate" principle applied to the legacy-state migration below.

Salvage eligibility (`checkSalvageEligibility`, Part B) gets the same treatment for consistency — a parallel `SalvageEligibilityReasonCode` enum, one code per check in the numbered list in Part B's eligibility section — even though the original review request focused on Part A. Flagging this as a deliberate, low-risk consistency extension rather than a silent scope change.

### Data model change (with legacy compatibility)

Replace the two booleans with a persisted, append-only attempt history on `TaskRunState`:

```ts
interface HandoffRepairAttemptRecord {
  readonly method: 'framing' | 'deterministic' | 'agent' | 'none' | 'legacy_unknown';
  readonly failureReason?: 'agent_invocation_failed' | 'evidence_insufficient' | 'contradiction_detected' | 'legacy_unknown';
  readonly succeeded: boolean;
  /** Absent only for a migrated legacy attempt that predates this field — its real time was never persisted. */
  readonly timestamp?: string; // ISO-8601 when present
}

// on TaskRunState, replacing handoffRepairAttempted/handoffRepairSucceeded:
readonly handoffRepairAttempts: readonly HandoffRepairAttemptRecord[];
```

**Legacy migration (required — this is what lets the real, protected run keep loading):** `src/state/run-state.ts`'s task-state parser gains a pure, synchronous normalization step, applied wherever a persisted `TaskRunState` is parsed:

```ts
function normalizeHandoffRepairAttempts(raw: unknown): readonly HandoffRepairAttemptRecord[] {
  const value = raw as Record<string, unknown>;
  if (Array.isArray(value.handoffRepairAttempts)) {
    return value.handoffRepairAttempts.map((entry, i) => parseHandoffRepairAttemptRecord(entry, i));
  }
  if (value.handoffRepairAttempted !== true) {
    return [];
  }
  const succeeded = value.handoffRepairSucceeded === true;
  return [{
    method: 'legacy_unknown',
    succeeded,
    ...(succeeded ? {} : { failureReason: 'legacy_unknown' }),
    // no timestamp: the boolean-only shape never persisted one
  }];
}
```

This is a pure function of the already-loaded JSON — no cross-file I/O, no reaching into `events.jsonl` (which does have a real timestamp for the real work-000002 attempt, but using it would require state parsing to become file-I/O-aware for one field on one legacy shape; not worth the architectural break for a value explicitly allowed to be absent). Applied against the real `run-20260904124350-dc56690c/run.json` shape (`handoffRepairAttempted: true, handoffRepairSucceeded: false`), this produces exactly one record: `{ method: 'legacy_unknown', succeeded: false, failureReason: 'legacy_unknown' }` — truthful to what was actually persisted, nothing invented.

`validateRunState` no longer rejects a `TaskRunState` for lacking `handoffRepairAttempts` or for having the old boolean fields — both shapes normalize to the same array representation before the rest of validation runs. A state that has *neither* the old booleans nor the new array (i.e. a task untouched by any repair) normalizes to `[]`, matching today's "both fields `undefined`" case exactly.

### Failure classification (repair execution)

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

New config, `AdaptiveLimits`-adjacent (or a sibling top-level field — final placement decided during implementation to match existing config parsing conventions): `maxHandoffRepairAttempts`, default `2`. `checkStructuredOutputRecoveryEligibility` gains a check: if `taskState.handoffRepairAttempts.length >= maxHandoffRepairAttempts`, return `{ eligible: false, reason: 'handoff repair attempt budget exhausted', reasonCode: 'HANDOFF_REPAIR_BUDGET_EXHAUSTED' }`. Because migration (above) normalizes legacy state into a real attempt record *before* this check runs, a migrated legacy attempt counts toward the budget exactly like a native one — the counter cannot be reset simply by upgrading the Orchestrator.

This delivers the idempotency the original brief asked for correctly: a task that has already exhausted its budget is simply never eligible again, so re-running `agents:recover-handoffs` on it is a safe no-op (fails fast with a clear reason/code) rather than a repeat real agent invocation. A task that succeeds is no longer `FAILED`, so `checkStructuredOutputRecoveryEligibility`'s first check (`taskState.status !== 'FAILED'`, `:2837-2839`, now tagged `HANDOFF_TASK_NOT_FAILED`) already makes success permanently idempotent — unchanged, just confirming existing behavior still holds.

No `--force` override is introduced — out of scope unless the user asks for it; an operator who needs to retry past the budget can raise `maxHandoffRepairAttempts` in phase config, which is itself an auditable, deliberate act rather than a silent flag.

The distinction from Part B's per-run "keep `TASK_STATE_INVALID`, add reason codes" decision is preserved exactly as before: eligibility failures never introduce a new top-level error code; they only get richer, machine-readable detail inside the existing one.

## Part B — Timed-out writer salvage

### New command

`pnpm agents:salvage-task <run-id> <task-id>` → `AgentOrchestrator.salvageTask(runId, taskId, options)`, wired into `src/cli.ts` next to the other recovery commands (`retry-agent`, `recover-handoffs`, `apply-integration-fix`).

### Eligibility (`checkSalvageEligibility`)

Structurally the mirror of `checkAgentFailureRetryEligibility` (`src/orchestrator.ts:2680+`), sharing its process-failure/no-commit/registered-worktree/HEAD-unmoved checks, but inverted on dirtiness and extended with ownership/content checks. Each branch below carries a `SalvageEligibilityReasonCode` (same pattern as Part A's enum):

1. `taskState.status` is `FAILED` or `BLOCKED` with `error.code === 'AGENT_TIMEOUT'` and the last recorded agent attempt's `outcome === 'timed_out'` (matching real work-000001's recorded state exactly, and mirroring how `checkAgentFailureRetryEligibility` already defines `AGENT_TIMEOUT` as a process-layer failure at `src/orchestrator.ts:2691-2693`). — `SALVAGE_NOT_TIMED_OUT`. `AGENT_FAILED` (a process crash, as opposed to a timeout) is deliberately excluded from salvage scope in this iteration — a crashed process is a different failure shape than a timed-out one, and folding it in without a real example to validate against would be scope creep. It can be added later behind the same eligibility function if a real case motivates it.
2. `taskState.commit === undefined`. — `SALVAGE_COMMIT_ALREADY_RECORDED`
3. Worktree is registered (`this.worktrees.assertRegistered`) and its path still exists on disk. — `SALVAGE_WORKTREE_NOT_REGISTERED`
4. Worktree HEAD equals `taskState.preparedHeadSha` (reusing `inspectTaskCommits`, same as retry-agent) — no foreign commits. — `SALVAGE_WORKTREE_HEAD_MOVED` / `SALVAGE_WORKTREE_HAS_FOREIGN_COMMITS`
5. Working tree **is** dirty (tracked changes and/or untracked files present) — the inverse of retry-agent's requirement. A clean worktree is not salvage work. — `SALVAGE_WORKTREE_CLEAN`
6. Every changed **tracked** file matches one of `task.files` (the task's authorized ownership globs), via the existing `matchesOwnershipPattern`/`assertChangedFileOwnership` (`src/tasks/ownership.ts`) — any tracked file outside ownership fails closed. — `SALVAGE_OWNERSHIP_VIOLATION`
7. No unexpected untracked files: only paths matching `task.files` ownership globs are tolerated as untracked-and-new; anything else (a stray script, an unrelated file) fails closed rather than being silently ignored. — `SALVAGE_UNEXPECTED_UNTRACKED_FILE`
8. `git diff --check` passes on the dirty diff. — `SALVAGE_DIFF_CHECK_FAILED`
9. The task has not already been consumed by integration (`taskState.status !== 'SUCCEEDED'` is implied by check 1, but this also confirms the run's `integration` state hasn't already advanced past this task). — `SALVAGE_ALREADY_INTEGRATED`
10. Dependencies (`task.dependsOn`) are all `SUCCEEDED`/`SKIPPED` — same rule `checkAgentFailureRetryEligibility` already applies. — `SALVAGE_DEPENDENCY_UNSATISFIED`

### Config: `salvage.verify` — categorically separate from `agentWorktree.prepare`

Stated explicitly per review: **preparation is not correctness evidence.** `agentWorktree.prepare` answers "is this environment usable" (e.g. `pnpm install`); `salvage.verify` answers "is the salvaged code actually correct" (e.g. running the real test suite). These are different questions, asked by different config, at different points in the flow. `salvage.verify` is never satisfied by, defaulted from, or silently aliased to `agentWorktree.prepare` — a phase with `agentWorktree.prepare` configured but no `salvage.verify` has *zero* usable verification for salvage, not a fallback to prepare commands.

New generic command list, same shape/parser as `IntegrationCommand` (`src/config.ts:9`):

```yaml
salvage:
  verify:
    - command: pnpm --filter @tripwith/api exec jest --config jest.config.js --runInBand src/events/event-validation.spec.ts
      required: true
      timeoutMs: 300000
```

No hardcoded package manager or test runner in core logic — same `parseCommand`/`parseCommandList` machinery already used for `integration.prepare`/`agentWorktree.prepare`. If a phase has no `salvage.verify` configured for a task's role, that task is never salvageable — matches the brief's "do not trust operator prose" requirement directly: a passing test claim recorded in agent stdout, or in a human's manual run, is never sufficient on its own.

The full ordered lifecycle, unchanged in sequence from the first draft but now with the invariants below made explicit at each step:

```
checkSalvageEligibility
        ↓
SALVAGE_AUTHORIZED (persisted checkpoint)
        ↓
agentWorktree.prepare, if configured  — makes the environment usable; NOT evidence
        ↓
salvage.verify                        — proves the salvaged code correct; verify-only (see below)
        ↓
SALVAGE_VERIFIED (persisted checkpoint, diff-bound — see below)
        ↓
canonical metadata completion / validation (reuses Part A's repair cascade)
        ↓
Orchestrator commit (ensureTaskCommit + assertChangedFileOwnership)
        ↓
targeted re-verification (existing path, unchanged)
```

### Invariant: verify commands must not silently become writers

New explicit rule, checked mechanically, not just documented: **`salvage.verify` commands are verification-only.** Before running the configured verify commands, the Orchestrator computes a fingerprint of the tracked-file diff:

```ts
async function computeTrackedDiffFingerprint(git: GitClient, worktreePath: string, baseSha: string): Promise<string> {
  const diff = (await git.run(worktreePath, ['diff', '--no-ext-diff', '--no-color', baseSha])).stdout;
  return sha256Hex(diff); // Node crypto, no new dependency
}
```

computed once immediately before the verify commands run (`preVerifyFingerprint`) and again immediately after (`postVerifyFingerprint`). If they differ, the verify step is treated as having **failed closed**, regardless of the commands' own exit codes: `SALVAGE_VERIFICATION_FAILED` with `details.reason: 'verify_mutated_tracked_source'`. This is the same error code used for an ordinary required-command failure — the two are distinguished by the `details.reason` field, mirroring how eligibility and execution failures are distinguished by field, not by code, elsewhere in this design. Untracked artifacts produced by verify commands (coverage output, build caches, etc.) are not part of `git diff` and are therefore not fingerprinted — they're tolerated exactly as any other untracked build byproduct already is, subject to the same untracked-file policy as eligibility check 7 (an unrecognized *new* untracked file that isn't a recognized build artifact still fails closed, but that's a pre-existing policy question, not new to this invariant).

This directly gives Part B's "writer creates, verifier proves, verifier never mutates" invariant a mechanical enforcement, not just a documentation promise.

### Salvage verification checkpoint is diff-bound

The first draft only recorded that verification had happened. Per review, the `SALVAGE_VERIFIED` checkpoint now persists everything needed to know whether it's still valid for the worktree's *current* state:

```ts
interface SalvageVerificationCheckpoint {
  readonly worktreeHeadSha: string;           // == taskState.preparedHeadSha at verify time
  readonly trackedDiffFingerprint: string;     // computeTrackedDiffFingerprint(...) result — same value used for mutation detection above
  readonly verifyConfigFingerprint: string;    // sha256 of the resolved salvage.verify command list (JSON)
  readonly result: 'passed';                   // only a passing checkpoint is ever persisted; a failure isn't a checkpoint, it's a thrown error
}
```

On resume (or on a second `salvage-task` invocation for the same task), before skipping straight to commit, the Orchestrator recomputes the current `trackedDiffFingerprint` and `verifyConfigFingerprint` and compares against the persisted checkpoint. All three fields (`worktreeHeadSha`, `trackedDiffFingerprint`, `verifyConfigFingerprint`) must match for the checkpoint to be reused; any mismatch invalidates it and verification runs again from scratch. This makes the "don't rerun verification unnecessarily" crash-safety goal precise rather than approximate — a checkpoint is valid for *this exact diff, against this exact HEAD, under this exact verify config*, never anything broader.

### Canonical finding handling, commit ownership, crash safety, failure isolation

Unchanged from the first draft:

- If the task carries required canonical findings (e.g. F001), a minimal handoff shell is synthesized from the diff and verify results (there was never an original agent handoff — the process timed out before producing one), then run through the *same* Part A repair cascade to attach `findingResponses`. Strict canonical validation applies exactly as for any other task; no bypass path.
- The Orchestrator creates the commit via `ensureTaskCommit` (`src/git/diff.ts:120`) + `assertChangedFileOwnership` (`src/tasks/ownership.ts:234`) — the same two helpers `applyIntegrationFix` already uses (`src/orchestrator.ts:836-846`). Salvage code itself never calls `git commit`.
- `taskState.commit !== undefined` (eligibility check 2) makes a duplicate commit structurally impossible on a second invocation, same invariant `checkStructuredOutputRecoveryEligibility` already relies on for handoff repair.
- `salvageTask` operates on exactly one `taskId`'s state slice via the same `updateTask`/`mutate` pattern used everywhere else in the orchestrator — it never iterates over sibling tasks. work-000003/work-000004 (already `SUCCEEDED`) are structurally untouched: nothing in this design reads or writes any task state keyed by a different task id.

## Acceptance scenario (new)

A provider-neutral, fake-agent-only test scenario shaped like the real Phase 6 state — implemented as an in-memory/fixture `RunState`, never by reading or touching the protected real run directories:

| Task | Initial state | Recovery action | Expected result |
|---|---|---|---|
| work-000001 (F001) | `BLOCKED`/`AGENT_TIMEOUT`, no commit, worktree with an authorized dirty diff inside ownership | `salvage-task` | `checkSalvageEligibility` passes → prepare (if configured) → `salvage.verify` passes → fake repair agent supplies a valid F001 `findingResponses` entry → Orchestrator creates commit → task `SUCCEEDED` → targeted re-verification scheduled |
| work-000002 (F002) | `FAILED`/`HANDOFF_INVALID`, correct code diff already present, generic handoff present, canonical metadata incomplete, **legacy** `handoffRepairAttempted: true`/`handoffRepairSucceeded: false` on the fixture | `recover-handoffs` | Legacy state normalizes to one `legacy_unknown` failed attempt (counts toward budget) → budget check passes (1 of 2 used) → eligible → fake repair agent supplies a valid F002 `findingResponses` entry, `withoutResponses` equality holds (no code diff change) → task `SUCCEEDED` |
| work-000003 | `SUCCEEDED`, commit `fdf696b2e5b7e60625ec1e09c37577ed7591a13b` (fixture uses an equivalent synthetic sha, not the real one) | none | Untouched |
| work-000004 | `SUCCEEDED` (targeted re-verification of F003) | none | Untouched |

Formal invariant asserted by the test, exactly as specified in review:

```
Recover(work-000001) or Recover(work-000002)
  ⇒ State(work-000003_after) deepEquals State(work-000003_before)
  AND State(work-000004_after) deepEquals State(work-000004_before)
```

asserted via structural deep-equality of the task-state objects before and after each recovery call, not by re-running any verification against them.

## Testing plan

All tests use fake/injected agents (the existing `agents/agent.ts` test-double pattern already used in `test/agents/*`, `test/workflow/agent-failure-retry.test.ts`) — never a real Codex/Claude process.

**Part A** (new: `test/workflow/handoff-repair-accounting.test.ts` or similar):
1. Canonical-incomplete handoff → repair dispatched (already true today; regression-proves it stays true).
2. Injected agent that throws / returns non-`succeeded` → recorded as `agent_invocation_failed`; task remains recoverable if budget remains.
3. Injected agent that returns a semantically-contradicting rewrite → `contradiction_detected`, fails closed, matches existing `withoutResponses` behavior.
4. Injected agent that can't produce sufficient evidence → `evidence_insufficient`.
5. Repeated `recover-handoffs` calls exceeding `maxHandoffRepairAttempts` → ineligible with `reasonCode: 'HANDOFF_REPAIR_BUDGET_EXHAUSTED'`, no further agent invocation attempted (assert the fake agent's call count stops increasing).
6. Malformed JSON / framing-only defect → unchanged existing framing-recovery behavior (regression).
7. Unknown/unassigned canonical finding ID in a would-be repair → still rejected (regression, existing `validateCanonicalFindingResponses` behavior).
8. Successful repair is permanently idempotent — a second `recover-handoffs` call is a no-op (task no longer `FAILED`, `reasonCode: 'HANDOFF_TASK_NOT_FAILED'`).
9. Generic (non-canonical) handoff repair paths unchanged (regression).
10. **New:** legacy fixture with `handoffRepairAttempted: true, handoffRepairSucceeded: false` and no `handoffRepairAttempts` array parses successfully (no `STATE_CORRUPT`), normalizes to one `legacy_unknown` failed record, and that record counts toward the budget on a subsequent eligibility check.
11. **New:** legacy fixture with `handoffRepairAttempted: true, handoffRepairSucceeded: true` normalizes to one `legacy_unknown` succeeded record (task-not-FAILED check makes this practically unreachable via the eligibility path, but the parser-level normalization is tested directly).
12. **New:** fixture with neither old booleans nor new array normalizes to `[]`, identical to today's "both undefined" behavior.

**Part B** (new: `test/workflow/agent-timeout-salvage.test.ts` or similar):
1. `AGENT_TIMEOUT` + dirty diff fully inside ownership → eligible.
2. Clean timed-out worktree → ineligible, `reasonCode: 'SALVAGE_WORKTREE_CLEAN'`.
3. Dirty change outside `task.files` ownership → ineligible, `reasonCode: 'SALVAGE_OWNERSHIP_VIOLATION'`.
4. Worktree HEAD has a foreign commit → ineligible, `reasonCode: 'SALVAGE_WORKTREE_HAS_FOREIGN_COMMITS'`.
5. Unexpected untracked file outside ownership → ineligible, `reasonCode: 'SALVAGE_UNEXPECTED_UNTRACKED_FILE'`.
6. `git diff --check` failure → ineligible, `reasonCode: 'SALVAGE_DIFF_CHECK_FAILED'`.
7. `salvage.verify` failure (required command fails on its own exit code, tracked source unchanged) → `SALVAGE_VERIFICATION_FAILED` with `details.reason` distinct from the mutation case, no commit created.
8. **New:** `salvage.verify` command that modifies a tracked source file → `SALVAGE_VERIFICATION_FAILED` with `details.reason: 'verify_mutated_tracked_source'`, regardless of the command's own exit code.
9. Task with a required canonical finding but a fake repair agent that can't produce a valid `findingResponses` entry → salvage fails closed, no commit.
10. Successful salvage → commit created via `ensureTaskCommit`, task `SUCCEEDED`, correct commit ownership enforced.
11. Sibling `SUCCEEDED` tasks' state is bitwise/deep-equal unchanged after a salvage run touching a different task.
12. Simulated crash after `SALVAGE_AUTHORIZED` but before verify → resume re-verifies (not silently skipped, since worktree could have changed) but does not re-authorize from scratch incorrectly.
13. **New:** simulated crash after `SALVAGE_VERIFIED` with the worktree diff unchanged → resume reuses the checkpoint (verify commands are not re-run — assert the fake verify command's call count doesn't increase).
14. **New:** simulated crash after `SALVAGE_VERIFIED`, but the worktree's tracked diff changed before resume → checkpoint is invalidated (fingerprint mismatch) and verify reruns.
15. **New:** simulated crash after `SALVAGE_VERIFIED`, worktree diff unchanged but `salvage.verify` config itself changed between crash and resume → checkpoint invalidated (`verifyConfigFingerprint` mismatch), verify reruns.
16. Simulated crash after commit → resume recognizes `taskState.commit !== undefined` and refuses a second salvage/commit.
17. A task whose failure is a genuine implementation/semantic error (not `AGENT_TIMEOUT`/process-layer) → salvage refuses, `reasonCode: 'SALVAGE_NOT_TIMED_OUT'`.
18. A task already consumed by integration → salvage refuses, `reasonCode: 'SALVAGE_ALREADY_INTEGRATED'`.

**Acceptance (new):** `test/workflow/phase6-dogfood-recovery-acceptance.test.ts` — the F001/F002/F003/work-000004-shaped scenario above, asserting the formal sibling-immutability invariant.

## Backward compatibility

No changes to: static DAG workflows, solver/verifier mode, ordinary adaptive scheduling, canonical cross-run continuation, `agents:retry-agent`'s existing clean-worktree requirement, framing/deterministic-key handoff recovery, correction authority boundaries, targeted re-verification, `agentWorktree.prepare`/`integration.prepare` semantics, or non-file resource policy.

The `handoffRepairAttempted`/`handoffRepairSucceeded` → `handoffRepairAttempts` field shape change is **not** a breaking change to persisted state, per the migration described above: both the old boolean shape and the new array shape parse successfully, normalizing to the same in-memory representation. This is a hard requirement, not a nice-to-have — it is what lets the real, protected `run-20260904124350-dc56690c` state keep loading under the new Orchestrator without hand-editing `run.json`, which the user has stated is necessary because they intend to run the real recovery against that exact run later.

## Explicit non-goals

- No terminal dashboard (`agents:watch`, colored `agents:status`) — deferred, tracked separately.
- No real recovery performed against the real runs; no commits, no pushes.
- No `--force` bypass for exhausted repair budgets.
- No fuzzy/heuristic text-matching of diff content against a finding's suggested fix as a substitute for agent-based semantic judgment — that would be per-finding hardcoding in disguise, which both the original brief and this design explicitly reject.
- No reconstruction of the real legacy attempt's original timestamp or method from `events.jsonl` during state parsing — parsing stays pure/synchronous; the legacy record honestly represents only what the boolean fields themselves proved.
