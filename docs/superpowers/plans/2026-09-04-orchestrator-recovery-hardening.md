# Orchestrator Recovery Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add bounded, idempotent handoff-repair attempt accounting (Part A) and a timed-out-writer salvage command (Part B) to the TripWith Agent Orchestrator, without touching any protected real run and without invoking any real LLM provider in tests.

**Architecture:** Part A replaces two untracked booleans on `TaskRunState` with an append-only, migration-compatible attempt history, and splits "can repair even start" (eligibility, `TASK_STATE_INVALID` + `reasonCode`) from "did the dispatched repair actually work" (execution, `HandoffRepairAttemptRecord.failureReason`). Part B adds a new `checkSalvageEligibility`/`salvageTask` pair, structurally the mirror of the existing `checkAgentFailureRetryEligibility`/`retryAgentFailure`, with a new `salvage.verify` config surface kept categorically separate from `agentWorktree.prepare`, a tracked-source-mutation guard, and a diff-bound verification checkpoint. Both parts reuse existing helpers (`ensureTaskCommit`, `assertChangedFileOwnership`, `matchesOwnershipPattern`, `inspectTaskCommits`, `parseCommand`/`parseCommandList`) rather than introducing parallel mechanisms.

**Tech Stack:** TypeScript (strict), Node's built-in `node:test` + `node:assert/strict`, `node:crypto` for fingerprinting (no new dependency), existing `GitClient`/`OwnedWorktree` abstractions.

**Spec:** `docs/superpowers/specs/2026-09-04-orchestrator-recovery-hardening-design.md`

## Global Constraints

- Never modify, resume, retry, recover, or salvage against the protected real runs: `tools/agent-orchestrator/runs/run-20260904124350-dc56690c/**`, `runs/run-20260904101940-9fdd27c5/**`, `runs/run-20260903203914-cc2b57d4/**`.
- Never modify `apps/api/src/events/**`.
- All tests use the fake `Agent` test-double pattern (`implements Agent { run(request): Promise<AgentResult> }`, see `test/workflow/agent-failure-retry.test.ts`) — never a real Codex/Claude/Gemini/OpenAI process, in tests or otherwise, during this work.
- No `--force` bypass for an exhausted handoff-repair budget.
- No new `HANDOFF_REPAIR_EXHAUSTED` (or similar) top-level error code — budget exhaustion is reported via the existing `TASK_STATE_INVALID` code with a `reasonCode: 'HANDOFF_REPAIR_BUDGET_EXHAUSTED'` detail, exactly like every other eligibility failure.
- `AGENT_FAILED` (process crash) is out of scope for salvage eligibility in this iteration — only `AGENT_TIMEOUT` with `outcome === 'timed_out'` qualifies.
- The legacy-state migration (`handoffRepairAttempted`/`handoffRepairSucceeded` → `handoffRepairAttempts`) must never fabricate a `timestamp`, `method`, or `failureReason` beyond what the boolean fields themselves prove — use `'legacy_unknown'` for both, and no `timestamp`, on migrated records.
- `salvage.verify` must never be defaulted from, aliased to, or satisfied by `agentWorktree.prepare` — a phase with only `prepare` configured has zero usable salvage verification.
- Do not commit or push anything to a shared/remote branch as part of this work; local commits per task step are expected and required by the TDD workflow below.
- Run `pnpm run typecheck` and `pnpm run test` (see `tools/agent-orchestrator/package.json`) after every task; both must pass before moving to the next task.

---

## File Structure

| File | Change |
|---|---|
| `tools/agent-orchestrator/src/state/run-state.ts` | `HandoffRepairAttemptRecord` type, legacy-migrating `parseTask`, `TaskRunState.handoffRepairAttempts` |
| `tools/agent-orchestrator/src/config.ts` | `maxHandoffRepairAttempts` on `PhaseConfig`; new `SalvageConfig`/`salvage.verify` |
| `tools/agent-orchestrator/src/errors.ts` | New `SALVAGE_VERIFICATION_FAILED` error code |
| `tools/agent-orchestrator/src/git/diff.ts` | New `computeTrackedDiffFingerprint` helper |
| `tools/agent-orchestrator/src/orchestrator.ts` | `repairHandoff`/`repairHandoffViaAgent` failure classification; `checkStructuredOutputRecoveryEligibility` reason codes + budget; `recoverHandoffFailures` reason-code plumbing; new `checkSalvageEligibility`, `salvageTask`, `SalvageEligibilityReasonCode` |
| `tools/agent-orchestrator/src/cli.ts` | `agents:salvage-task <run-id> <task-id>` wiring |
| `tools/agent-orchestrator/test/state/task-run-state-legacy-migration.test.ts` | New — pure parser-level legacy migration tests |
| `tools/agent-orchestrator/test/workflow/handoff-repair-accounting.test.ts` | New — Part A behavior tests |
| `tools/agent-orchestrator/test/workflow/agent-timeout-salvage.test.ts` | New — Part B behavior tests |
| `tools/agent-orchestrator/test/workflow/phase6-dogfood-recovery-acceptance.test.ts` | New — F001/F002/F003/work-000004-shaped acceptance scenario |

---

### Task 1: Config — `maxHandoffRepairAttempts`

**Files:**
- Modify: `tools/agent-orchestrator/src/config.ts`
- Test: `tools/agent-orchestrator/test/core/config-scheduler.test.ts` (existing file — add cases; do not create a new file for this alone)

**Interfaces:**
- Produces: `PhaseConfig.maxHandoffRepairAttempts: number` (default `2` when the YAML key is absent).

- [ ] **Step 1: Write the failing test**

Add to `test/core/config-scheduler.test.ts` (follow the existing test's phase-YAML-fixture-and-`parsePhaseConfig`-call pattern already in that file):

```ts
test('maxHandoffRepairAttempts defaults to 2 when absent from phase YAML', async () => {
  const config = await parsePhaseConfigFromYaml(minimalPhaseYaml());
  assert.equal(config.maxHandoffRepairAttempts, 2);
});

test('maxHandoffRepairAttempts honors an explicit positive integer', async () => {
  const config = await parsePhaseConfigFromYaml(minimalPhaseYaml({ maxHandoffRepairAttempts: 5 }));
  assert.equal(config.maxHandoffRepairAttempts, 5);
});

test('maxHandoffRepairAttempts rejects a non-positive value', async () => {
  await assert.rejects(
    () => parsePhaseConfigFromYaml(minimalPhaseYaml({ maxHandoffRepairAttempts: 0 })),
    (error: unknown) => isOrchestratorError(error, 'CONFIG_INVALID'),
  );
});
```

(Use whatever this file's existing minimal-phase-YAML builder is named; extend its options with an optional `maxHandoffRepairAttempts` field that interpolates a `maxHandoffRepairAttempts: N` line into the YAML when provided.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/core/config-scheduler.test.js`
Expected: FAIL — `config.maxHandoffRepairAttempts` is `undefined` / compile error (property doesn't exist yet).

- [ ] **Step 3: Implement**

In `src/config.ts`, add to `PhaseConfig`:

```ts
export interface PhaseConfig {
  readonly phase: number | string;
  readonly name: string;
  readonly baseBranch: string;
  readonly canonicalDesignDocument: string;
  readonly concurrency: number;
  readonly maxReviewRounds: number;
  readonly agentRetries: number;
  readonly agentTimeoutMs: number;
  readonly agentWorktree: AgentWorktreeConfig;
  readonly tasks: readonly TaskSpec[];
  readonly integration: IntegrationConfig;
  readonly maxHandoffRepairAttempts: number; // NEW
}
```

Add `'maxHandoffRepairAttempts'` to the existing `TOP_LEVEL_KEYS` set. In the function that builds the final `PhaseConfig` object (the one already reading `concurrency`/`maxReviewRounds`/etc. off the parsed YAML document), add:

```ts
const maxHandoffRepairAttempts = value.maxHandoffRepairAttempts === undefined
  ? 2
  : (() => {
      const n = value.maxHandoffRepairAttempts;
      if (typeof n !== 'number' || !Number.isSafeInteger(n) || n < 1) {
        throw new OrchestratorError('CONFIG_INVALID', 'maxHandoffRepairAttempts must be a positive integer');
      }
      return n;
    })();
```

and include `maxHandoffRepairAttempts` in the returned `PhaseConfig` object literal.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/core/config-scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`

```bash
git add tools/agent-orchestrator/src/config.ts tools/agent-orchestrator/test/core/config-scheduler.test.ts
git commit -m "Add maxHandoffRepairAttempts phase config (default 2)"
```

---

### Task 2: State — `HandoffRepairAttemptRecord` + legacy migration + call-site rewiring

**Files:**
- Modify: `tools/agent-orchestrator/src/state/run-state.ts`
- Modify: `tools/agent-orchestrator/src/orchestrator.ts` (only the read/write call sites listed below — no new behavior yet)
- Test: `tools/agent-orchestrator/test/state/task-run-state-legacy-migration.test.ts` (new)

**Interfaces:**
- Produces:
  ```ts
  export interface HandoffRepairAttemptRecord {
    readonly method: 'framing' | 'deterministic' | 'agent' | 'none' | 'legacy_unknown';
    readonly failureReason?: 'agent_invocation_failed' | 'evidence_insufficient' | 'contradiction_detected' | 'legacy_unknown';
    readonly succeeded: boolean;
    readonly timestamp?: string;
  }
  // on TaskRunState:
  readonly handoffRepairAttempts: readonly HandoffRepairAttemptRecord[];
  // handoffRepairAttempted / handoffRepairSucceeded are REMOVED from TaskRunState.
  ```
- Consumes: existing `string`, `integer`, `timestamp`, `optionalBoolean`, `isObject`, `OrchestratorError` helpers already in `src/state/run-state.ts`.

- [ ] **Step 1: Write the failing test**

Create `test/state/task-run-state-legacy-migration.test.ts`:

```ts
import assert from 'node:assert/strict';
import test from 'node:test';

import { validateRunState } from '../../src/state/run-state';

function baseRunState(taskOverrides: Record<string, unknown>): unknown {
  return {
    schemaVersion: 1,
    runId: 'run-20260101000000-aaaaaaaa',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    status: 'FAILED',
    strategy: 'static',
    baseBranch: 'main',
    baseSha: '0'.repeat(40),
    tasks: {
      'task-one': {
        id: 'task-one',
        status: 'FAILED',
        agentAttempts: [],
        reviewRounds: 0,
        reviewPaths: [],
        ...taskOverrides,
      },
    },
    integration: { status: 'PENDING', integratedTaskCommits: [] },
  };
}

test('legacy handoffRepairAttempted=true/handoffRepairSucceeded=false migrates to one legacy_unknown failed attempt', () => {
  const state = validateRunState(baseRunState({
    handoffRepairAttempted: true,
    handoffRepairSucceeded: false,
  }));
  assert.deepEqual(state.tasks['task-one']!.handoffRepairAttempts, [
    { method: 'legacy_unknown', succeeded: false, failureReason: 'legacy_unknown' },
  ]);
});

test('legacy handoffRepairAttempted=true/handoffRepairSucceeded=true migrates to one legacy_unknown succeeded attempt', () => {
  const state = validateRunState(baseRunState({
    handoffRepairAttempted: true,
    handoffRepairSucceeded: true,
  }));
  assert.deepEqual(state.tasks['task-one']!.handoffRepairAttempts, [
    { method: 'legacy_unknown', succeeded: true },
  ]);
});

test('absent legacy fields and absent handoffRepairAttempts both normalize to an empty array', () => {
  const state = validateRunState(baseRunState({}));
  assert.deepEqual(state.tasks['task-one']!.handoffRepairAttempts, []);
});

test('native handoffRepairAttempts array round-trips unchanged', () => {
  const native = [{ method: 'agent', succeeded: false, failureReason: 'agent_invocation_failed', timestamp: '2026-01-01T00:00:00.000Z' }];
  const state = validateRunState(baseRunState({ handoffRepairAttempts: native }));
  assert.deepEqual(state.tasks['task-one']!.handoffRepairAttempts, native);
});
```

(If `validateRunState` requires additional top-level fields beyond what's stubbed above — check the actual `RunState` interface in `src/state/run-state.ts` around line 147 onward and the body of `validateRunState` starting at line 697 for any other required keys, e.g. `strategy`, `config` references, etc. — add them to `baseRunState` as empty-but-valid values; do not weaken `validateRunState` to make the fixture pass.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/state/task-run-state-legacy-migration.test.js`
Expected: FAIL (compile error — `handoffRepairAttempts` doesn't exist yet, or the migration logic doesn't exist).

- [ ] **Step 3: Implement the type and migration**

In `src/state/run-state.ts`, add the new interface near `AgentFailureRecoveryState` (around line 67):

```ts
export interface HandoffRepairAttemptRecord {
  readonly method: 'framing' | 'deterministic' | 'agent' | 'none' | 'legacy_unknown';
  readonly failureReason?: 'agent_invocation_failed' | 'evidence_insufficient' | 'contradiction_detected' | 'legacy_unknown';
  readonly succeeded: boolean;
  readonly timestamp?: string;
}
```

In `TaskRunState` (around line 69-102), replace:

```ts
  readonly handoffRepairAttempted?: boolean;
  readonly handoffRepairSucceeded?: boolean;
```

with:

```ts
  readonly handoffRepairAttempts: readonly HandoffRepairAttemptRecord[];
```

Add a parser and the migration function near `parseTask` (around line 566):

```ts
const HANDOFF_REPAIR_METHODS = new Set(['framing', 'deterministic', 'agent', 'none', 'legacy_unknown']);
const HANDOFF_REPAIR_FAILURE_REASONS = new Set([
  'agent_invocation_failed', 'evidence_insufficient', 'contradiction_detected', 'legacy_unknown',
]);

function parseHandoffRepairAttemptRecord(value: unknown, path: string): HandoffRepairAttemptRecord {
  if (!isObject(value)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path} must be an object`);
  }
  const method = string(value.method, `${path}.method`);
  if (!HANDOFF_REPAIR_METHODS.has(method)) {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.method is invalid`);
  }
  if (typeof value.succeeded !== 'boolean') {
    throw new OrchestratorError('STATE_CORRUPT', `${path}.succeeded must be a boolean`);
  }
  let failureReason: HandoffRepairAttemptRecord['failureReason'];
  if (value.failureReason !== undefined) {
    const reason = string(value.failureReason, `${path}.failureReason`);
    if (!HANDOFF_REPAIR_FAILURE_REASONS.has(reason)) {
      throw new OrchestratorError('STATE_CORRUPT', `${path}.failureReason is invalid`);
    }
    failureReason = reason as HandoffRepairAttemptRecord['failureReason'];
  }
  return {
    method: method as HandoffRepairAttemptRecord['method'],
    succeeded: value.succeeded,
    ...(failureReason === undefined ? {} : { failureReason }),
    ...(value.timestamp === undefined ? {} : { timestamp: timestamp(value.timestamp, `${path}.timestamp`) }),
  };
}

/**
 * Legacy compatibility: a persisted TaskRunState written before
 * handoffRepairAttempts existed carries handoffRepairAttempted/
 * handoffRepairSucceeded booleans instead. Normalize both shapes to the
 * same array representation. Never fabricates a method, failureReason, or
 * timestamp beyond what the booleans themselves proved — a migrated record
 * uses 'legacy_unknown' for method (and failureReason, when failed) and
 * omits timestamp entirely, because the boolean-only shape never persisted
 * one. See docs/superpowers/specs/2026-09-04-orchestrator-recovery-hardening-design.md.
 */
function normalizeHandoffRepairAttempts(value: Record<string, unknown>, path: string): readonly HandoffRepairAttemptRecord[] {
  if (value.handoffRepairAttempts !== undefined) {
    if (!Array.isArray(value.handoffRepairAttempts)) {
      throw new OrchestratorError('STATE_CORRUPT', `${path}.handoffRepairAttempts must be an array`);
    }
    return value.handoffRepairAttempts.map((entry, index) =>
      parseHandoffRepairAttemptRecord(entry, `${path}.handoffRepairAttempts[${index}]`));
  }
  const attempted = optionalBoolean(value.handoffRepairAttempted, `${path}.handoffRepairAttempted`);
  if (attempted !== true) {
    return [];
  }
  const succeeded = optionalBoolean(value.handoffRepairSucceeded, `${path}.handoffRepairSucceeded`) === true;
  return [{
    method: 'legacy_unknown',
    succeeded,
    ...(succeeded ? {} : { failureReason: 'legacy_unknown' as const }),
  }];
}
```

In `parseTask`'s returned object (around lines 685-692), replace the two `handoffRepairAttempted`/`handoffRepairSucceeded` spread blocks with:

```ts
    handoffRepairAttempts: normalizeHandoffRepairAttempts(value, path),
```

- [ ] **Step 4: Rewire orchestrator.ts call sites**

In `src/orchestrator.ts`:

- `recordHandoffOutcome` (around line 1945-1952) currently writes:
  ```ts
  handoffOutcome: outcome.outcome,
  handoffRepairAttempted: outcome.repairAttempted,
  ...(outcome.repairSucceeded === undefined ? {} : { handoffRepairSucceeded: outcome.repairSucceeded }),
  ```
  For this task ONLY, keep `recordHandoffOutcome`'s signature and `HandoffOutcomeRecord` shape unchanged (Task 3 will extend it with method/failureReason) but change what it writes to the new field: append rather than overwrite. Since `HandoffOutcomeRecord` at this point still only carries `repairAttempted`/`repairSucceeded` booleans (Task 3 extends it), map minimally:
  ```ts
  await this.mutate((state) => updateTask(state, taskId, (task) => ({
    ...task,
    handoffOutcome: outcome.outcome,
    ...(outcome.repairAttempted
      ? {
          handoffRepairAttempts: [
            ...task.handoffRepairAttempts,
            {
              method: 'none' as const,
              succeeded: outcome.repairSucceeded === true,
            },
          ],
        }
      : {}),
  })));
  ```
  (This is an intentionally minimal, behavior-preserving intermediate step — Task 3 replaces the `method: 'none'` placeholder with the real classified method/failureReason. Do not skip ahead; this task's scope is only "stop losing history," not "classify failures.")
- The two `handoffRepairAttempted !== undefined || handoffRepairSucceeded !== undefined` checks (around lines 2710-2711 and 2804-2805) become `taskState.handoffRepairAttempts.length > 0`.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/state/task-run-state-legacy-migration.test.js`
Expected: PASS

Run: `cd tools/agent-orchestrator && pnpm run test` (full suite — this task touches shared orchestrator.ts call sites, so the full suite, not just the new file, must stay green)
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`

```bash
git add tools/agent-orchestrator/src/state/run-state.ts tools/agent-orchestrator/src/orchestrator.ts tools/agent-orchestrator/test/state/task-run-state-legacy-migration.test.ts
git commit -m "Migrate handoffRepairAttempted/Succeeded to an append-only handoffRepairAttempts history"
```

---

### Task 3: Orchestrator — repair execution failure classification

**Files:**
- Modify: `tools/agent-orchestrator/src/orchestrator.ts` (`repairHandoff`, `repairHandoffViaAgent`, `parseOrRepairHandoff`, `HandoffOutcomeRecord`, `recordHandoffOutcome`)
- Test: `tools/agent-orchestrator/test/workflow/handoff-repair-accounting.test.ts` (new)

**Interfaces:**
- Consumes: `HandoffRepairAttemptRecord` (Task 2), existing `repairHandoff`/`repairHandoffViaAgent`/`parseOrRepairHandoff` at `src/orchestrator.ts:1905-2095`.
- Produces:
  ```ts
  type HandoffRepairMethod = 'framing' | 'deterministic' | 'agent';
  type HandoffRepairFailureReason = 'agent_invocation_failed' | 'evidence_insufficient' | 'contradiction_detected';
  type RepairOutcome =
    | { readonly ok: true; readonly handoff: StructuredHandoff; readonly method: HandoffRepairMethod }
    | { readonly ok: false; readonly reason: HandoffRepairFailureReason };
  ```
  `repairHandoff` and `repairHandoffViaAgent` return `RepairOutcome` (repairHandoffViaAgent: `RepairOutcome` restricted to the `method: 'agent'` / no-method-needed-on-failure shape) instead of `T | null`.

- [ ] **Step 1: Write the failing tests**

Create `test/workflow/handoff-repair-accounting.test.ts`. Follow `test/workflow/agent-failure-retry.test.ts`'s exact scaffolding pattern (`createTemporaryRepository`, a fake `Agent` implementation, `AgentOrchestrator.start`, a minimal phase YAML with one `mode: correction` task that has a canonical finding requirement). Since wiring a real canonical-finding-requiring correction task requires adaptive-mode `continuation` config (see `phases/phase6.canonical-continuation.yaml` for the real shape), build the fixture at the `parseOrRepairHandoff`/`repairHandoff` unit level instead of a full run — these are `private` methods, so test them through the orchestrator's public surface using the same static-mode `handoff_repair`-role agent-failure path already exercised implicitly by `test/workflow/agent-failure-retry.test.ts`. Concretely:

```ts
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { isOrchestratorError } from '../../src/errors';
import { AgentOrchestrator } from '../../src/orchestrator';
import { createTemporaryRepository } from '../git/helpers';

class HandoffRepairScenarioAgent implements Agent {
  invocations = 0;

  constructor(
    readonly name: AgentName,
    private readonly behavior: (request: AgentRequest) => AgentResult,
  ) {}

  async run(request: AgentRequest): Promise<AgentResult> {
    if (request.role === 'handoff_repair') this.invocations += 1;
    await request.onStarted?.(process.pid);
    return this.behavior(request);
  }
}

function baseAgentResult(name: AgentName, request: AgentRequest, overrides: Partial<AgentResult>): AgentResult {
  const timestamp = new Date().toISOString();
  return {
    agent: name, runId: request.runId, taskId: request.taskId, status: 'succeeded', failureCode: null,
    exitCode: 0, signal: null,
    stdoutPath: join(request.artifactsDirectory, `${request.taskId}.stdout.log`),
    stderrPath: join(request.artifactsDirectory, `${request.taskId}.stderr.log`),
    structuredHandoff: null, changedFiles: [], gitDiffSummary: null, testsReported: [],
    unresolvedQuestions: [], startedAt: timestamp, endedAt: timestamp, durationMs: 0,
    timedOut: false, aborted: false, errorMessage: null,
    ...overrides,
  };
}
```

Then write the four classification tests directly against this scaffold (each starts a run where the primary task returns a canonical-incomplete handoff — omit `findingResponses` from an otherwise-`complete` handoff — triggering the repair cascade; a distinct fake `handoff_repair`-role agent invocation supplies the scenario-specific behavior):

```ts
test('agent invocation failure during repair classifies as agent_invocation_failed', async () => {
  // primary task's fake agent returns status: 'complete' with no findingResponses
  // (canonical-incomplete) to force HANDOFF_INVALID -> repair dispatch;
  // the handoff_repair-role fake agent throws.
  // Assert the resulting task's handoffRepairAttempts.at(-1) equals
  // { method: 'agent', succeeded: false, failureReason: 'agent_invocation_failed', timestamp: <string> }.
});

test('a repair that changes original handoff content classifies as contradiction_detected', async () => {
  // handoff_repair-role fake agent returns a handoff whose summary/decisions/etc
  // differ from the original (only findingResponses may legitimately differ).
  // Assert failureReason === 'contradiction_detected'.
});

test('a repair with no diff/passing test evidence for a claimed resolution classifies as evidence_insufficient', async () => {
  // handoff_repair-role fake agent returns findingResponses claiming
  // decision: 'confirmed', resolution: 'resolved' with no diff/no passing test
  // backing it. Assert failureReason === 'evidence_insufficient'.
});

test('a successful repair records method agent with succeeded true and a real timestamp', async () => {
  // handoff_repair-role fake agent returns a valid, evidence-backed
  // findingResponses-only patch. Assert handoffRepairAttempts.at(-1) equals
  // { method: 'agent', succeeded: true, timestamp: <ISO string> } (no failureReason key).
});
```

(Fill in each test body using the exact phase-YAML/adaptive-continuation fixture pattern from `phases/phase6.canonical-continuation.yaml` and `test/adaptive/adaptive-continuation.test.ts` — that existing test file already builds a run with a real canonical finding requirement end-to-end and is the closest existing template; adapt its fixture-construction helpers rather than re-deriving them. Do not leave these four tests as comments — this step's actual deliverable is the four complete, runnable test bodies.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/handoff-repair-accounting.test.js`
Expected: FAIL (the classification doesn't exist yet — `failureReason` is never set today).

- [ ] **Step 3: Implement classification**

In `src/orchestrator.ts`, change `repairHandoffViaAgent`'s return type (around line 2019) from `Promise<StructuredHandoff | null>` to a discriminated result, and update its three failure returns:

```ts
private async repairHandoffViaAgent(
  task: TaskSpec,
  malformedOutput: unknown,
  requiredCanonicalFindings: readonly RequiredCanonicalFinding[],
  taskDiff: string,
  originalHandoff?: StructuredHandoff,
): Promise<
  | { readonly ok: true; readonly handoff: StructuredHandoff }
  | { readonly ok: false; readonly reason: HandoffRepairFailureReason }
> {
  // ...unchanged request construction (lines ~2026-2059)...
  let result: AgentResult;
  try {
    result = await this.agents[task.owner].run(request);
  } catch {
    return { ok: false, reason: 'agent_invocation_failed' };
  }
  if (result.status !== 'succeeded') {
    return { ok: false, reason: 'agent_invocation_failed' };
  }
  try {
    const repaired = parseHandoff(result.structuredHandoff);
    validateCanonicalFindingResponses(repaired, requiredCanonicalFindings);
    if (originalHandoff !== undefined) {
      const withoutResponses = (handoff: StructuredHandoff): unknown => {
        const { findingResponses: _responses, ...rest } = handoff;
        return rest;
      };
      if (JSON.stringify(withoutResponses(repaired)) !== JSON.stringify(withoutResponses(originalHandoff))) {
        return { ok: false, reason: 'contradiction_detected' };
      }
      const claimsResolved = repaired.findingResponses?.some((response) =>
        response.decision === 'confirmed' && response.resolution === 'resolved');
      if (claimsResolved && (taskDiff.trim() === '' || !originalHandoff.tests.some((test) => test.result === 'pass'))) {
        return { ok: false, reason: 'evidence_insufficient' };
      }
    }
    return { ok: true, handoff: repaired };
  } catch {
    return { ok: false, reason: 'evidence_insufficient' };
  }
}
```

Update `repairHandoff` (around line 1970) to return `RepairOutcome` (`method` added on the `ok: true` branches, `reason` passed through on `ok: false`):

```ts
private async repairHandoff(
  task: TaskSpec,
  rawStructuredHandoff: unknown,
  rawStdout: string | null,
  requiredCanonicalFindings: readonly RequiredCanonicalFinding[],
  taskDiff: string,
): Promise<RepairOutcome> {
  const validate = (value: unknown): StructuredHandoff => {
    const handoff = validateHandoff(value);
    validateCanonicalFindingResponses(handoff, requiredCanonicalFindings);
    return handoff;
  };
  const framed = extractStructuredPayload(rawStdout, validate);
  if (framed.ok) {
    return { ok: true, handoff: framed.value, method: 'framing' };
  }
  if (framed.reason === 'ambiguous') {
    return { ok: false, reason: 'evidence_insufficient' };
  }

  const deterministic = deterministicallyRepairHandoffKeys(rawStructuredHandoff);
  if (deterministic.changed) {
    try {
      const handoff = parseHandoff(deterministic.value);
      validateCanonicalFindingResponses(handoff, requiredCanonicalFindings);
      return { ok: true, handoff, method: 'deterministic' };
    } catch {
      // fall through, as before
    }
  }
  const original = (() => {
    try { return parseHandoff(rawStructuredHandoff); } catch { return undefined; }
  })();
  const repaired = await this.repairHandoffViaAgent(
    task, rawStructuredHandoff, requiredCanonicalFindings, taskDiff, original,
  );
  return repaired.ok ? { ok: true, handoff: repaired.handoff, method: 'agent' } : repaired;
}
```

Update `HandoffOutcomeRecord` (around line 126) and `parseOrRepairHandoff` (around line 1905-1943):

```ts
interface HandoffOutcomeRecord {
  readonly outcome: 'valid' | 'invalid';
  readonly repairAttempted: boolean;
  readonly repairRecord?: HandoffRepairAttemptRecord; // NEW — replaces repairSucceeded
}
```

```ts
private async parseOrRepairHandoff(/* unchanged params */): Promise<
  | { readonly handoff: StructuredHandoff; readonly error: null; readonly outcome: HandoffOutcomeRecord }
  | { readonly handoff: null; readonly error: unknown; readonly outcome: HandoffOutcomeRecord }
> {
  try {
    const handoff = parseHandoff(rawStructuredHandoff);
    validateCanonicalFindingResponses(handoff, requiredCanonicalFindings);
    return { handoff, error: null, outcome: { outcome: 'valid', repairAttempted: false } };
  } catch (error) {
    if (!isOrchestratorError(error, 'HANDOFF_INVALID')) {
      throw error;
    }
    const repaired = await this.repairHandoff(task, rawStructuredHandoff, rawStdout, requiredCanonicalFindings, taskDiff);
    const record: HandoffRepairAttemptRecord = repaired.ok
      ? { method: repaired.method, succeeded: true, timestamp: this.clock().toISOString() }
      : { method: 'none', succeeded: false, failureReason: repaired.reason, timestamp: this.clock().toISOString() };
    await this.event('HANDOFF_REPAIR_ATTEMPTED', task.id, { method: record.method, succeeded: record.succeeded, failureReason: record.failureReason });
    if (!repaired.ok) {
      return { handoff: null, error, outcome: { outcome: 'invalid', repairAttempted: true, repairRecord: record } };
    }
    return { handoff: repaired.handoff, error: null, outcome: { outcome: 'valid', repairAttempted: true, repairRecord: record } };
  }
}
```

(Note: `record.method` on a failed *non-agent* path — e.g. ambiguous framing — is `'none'` per the mapping in the spec's Failure classification section; only a failed `repairHandoffViaAgent` attempt legitimately reaches here with method `'agent'` and `ok: false`, which the ternary above already handles since `repaired.reason` is only read on the `!repaired.ok` branch and `record.method` is unconditionally `'none'` there. If you want method-fidelity on a failed attempt too — e.g. recording `'framing'` when framing itself failed ambiguously — thread the attempted method through `RepairOutcome`'s `ok: false` variant as an additional optional field; this is a reasonable refinement but not required by the spec's test list, so only do it if it doesn't complicate the type. Prefer keeping `method: 'none'` for all `ok:false` outcomes for simplicity, matching the original pre-existing `'none'` sentinel value.)

Update `recordHandoffOutcome` (replacing Task 2's minimal placeholder) to append the full record:

```ts
private async recordHandoffOutcome(taskId: string, outcome: HandoffOutcomeRecord): Promise<void> {
  await this.mutate((state) => updateTask(state, taskId, (task) => ({
    ...task,
    handoffOutcome: outcome.outcome,
    ...(outcome.repairRecord === undefined
      ? {}
      : { handoffRepairAttempts: [...task.handoffRepairAttempts, outcome.repairRecord] }),
  })));
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/handoff-repair-accounting.test.js`
Expected: PASS

Run full suite: `cd tools/agent-orchestrator && pnpm run test`
Expected: PASS (this changes `repairHandoff`'s and `repairHandoffViaAgent`'s return shape, and any other call sites — grep for both names to confirm no other caller exists beyond `parseOrRepairHandoff`)

- [ ] **Step 5: Typecheck and commit**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`

```bash
git add tools/agent-orchestrator/src/orchestrator.ts tools/agent-orchestrator/test/workflow/handoff-repair-accounting.test.ts
git commit -m "Classify handoff repair execution failures (agent_invocation_failed / evidence_insufficient / contradiction_detected)"
```

---

### Task 4: Orchestrator — eligibility reason codes + repair budget

**Files:**
- Modify: `tools/agent-orchestrator/src/orchestrator.ts` (`checkStructuredOutputRecoveryEligibility`, `recoverHandoffFailures`)
- Test: `tools/agent-orchestrator/test/workflow/handoff-repair-accounting.test.ts` (extend from Task 3)

**Interfaces:**
- Consumes: `PhaseConfig.maxHandoffRepairAttempts` (Task 1), `TaskRunState.handoffRepairAttempts` (Task 2).
- Produces:
  ```ts
  type HandoffRecoveryEligibilityReasonCode =
    | 'HANDOFF_TASK_CONFIG_MISSING' | 'HANDOFF_TASK_MODE_MISMATCH' | 'HANDOFF_TASK_NOT_FAILED'
    | 'HANDOFF_LAST_ATTEMPT_NOT_SUCCEEDED' | 'HANDOFF_COMMIT_ALREADY_RECORDED'
    | 'HANDOFF_WORKTREE_NOT_PRESERVED' | 'HANDOFF_WORKTREE_NOT_REGISTERED'
    | 'HANDOFF_WORKTREE_INVALID_DESCENDANT' | 'HANDOFF_WORKTREE_HEAD_MOVED'
    | 'HANDOFF_WORKTREE_HAS_FOREIGN_COMMITS' | 'HANDOFF_ORIGINAL_LOG_MISSING'
    | 'HANDOFF_REPAIR_BUDGET_EXHAUSTED';
  ```
  `checkStructuredOutputRecoveryEligibility` returns `{ eligible: boolean; reason: string; reasonCode?: HandoffRecoveryEligibilityReasonCode }`; `recoverHandoffFailures`'s `ineligible` detail array gains `reasonCode` per entry.

- [ ] **Step 1: Write the failing tests**

Add to `test/workflow/handoff-repair-accounting.test.ts`:

```ts
test('recover-handoffs reports HANDOFF_REPAIR_BUDGET_EXHAUSTED once the configured attempt budget is used up, without invoking the repair agent again', async () => {
  // Build a scenario with maxHandoffRepairAttempts: 1 in the phase YAML.
  // Drive one failed repair attempt (as in Task 3's agent_invocation_failed test)
  // so handoffRepairAttempts.length === 1.
  // Call AgentOrchestrator.recoverHandoffFailures again on the same run.
  // Assert it throws an OrchestratorError with code 'TASK_STATE_INVALID' and
  // details.ineligible[0].reasonCode === 'HANDOFF_REPAIR_BUDGET_EXHAUSTED'.
  // Assert the handoff_repair-role fake agent's invocation count is unchanged
  // from before this second call (no repeat dispatch).
});

test('a task not currently FAILED with HANDOFF_INVALID reports HANDOFF_TASK_NOT_FAILED', async () => {
  // Any SUCCEEDED task passed through the same recovery path (or simply: call
  // recoverHandoffFailures on a run with no eligible candidates at all, and
  // assert recovered/skipped are both empty with no ineligible entries — or,
  // to exercise the code path directly, construct a run where a task exists
  // with status FAILED but error.code !== 'HANDOFF_INVALID' and confirm it's
  // simply never a candidate, per the existing candidatesOf filter — this
  // reasonCode is primarily reachable via the config-missing/mode-mismatch
  // pre-checks in recoverHandoffFailures, so prefer asserting one of those
  // two directly (see next test) if HANDOFF_TASK_NOT_FAILED itself proves
  // hard to reach through the public candidatesOf filter alone.
});
```

(The second test's exact shape depends on what's actually reachable through the public `recoverHandoffFailures` entry point — since `candidatesOf` already filters to `status === 'FAILED' && error.code === errorCode` before eligibility runs, `HANDOFF_TASK_NOT_FAILED` is mostly a defensive code for a race between candidate selection and eligibility check on a live run, not something a single-threaded test can trivially force. It's acceptable for this task's test suite to assert the code exists and is correctly used in `checkStructuredOutputRecoveryEligibility`'s branch (via a narrower unit-style test if the method is exposed for testing, or via code review) rather than forcing every one of the twelve reason codes through a full run — but `HANDOFF_REPAIR_BUDGET_EXHAUSTED` specifically, being the new behavior this task adds, MUST be exercised end-to-end as in the first test above.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/handoff-repair-accounting.test.js`
Expected: FAIL (budget check doesn't exist yet).

- [ ] **Step 3: Implement**

In `src/orchestrator.ts`, update `checkStructuredOutputRecoveryEligibility` (around line 2833-2877) — add `reasonCode` to every existing `return { eligible: false, reason: ... }` and add the new budget branch as the first check after the status/error-code check:

```ts
private async checkStructuredOutputRecoveryEligibility(
  taskState: TaskRunState,
  expectedErrorCode: 'HANDOFF_INVALID' | 'REVIEW_BLOCKED',
): Promise<{ readonly eligible: boolean; readonly reason: string; readonly reasonCode?: HandoffRecoveryEligibilityReasonCode }> {
  if (taskState.status !== 'FAILED' || taskState.error?.code !== expectedErrorCode) {
    return { eligible: false, reason: `task is not currently FAILED with error code ${expectedErrorCode}`, reasonCode: 'HANDOFF_TASK_NOT_FAILED' };
  }
  if (expectedErrorCode === 'HANDOFF_INVALID' && taskState.handoffRepairAttempts.length >= this.config.maxHandoffRepairAttempts) {
    return { eligible: false, reason: `handoff repair attempt budget (${this.config.maxHandoffRepairAttempts}) exhausted`, reasonCode: 'HANDOFF_REPAIR_BUDGET_EXHAUSTED' };
  }
  const lastAttempt = taskState.agentAttempts.at(-1);
  if (lastAttempt?.outcome !== 'succeeded') {
    return { eligible: false, reason: 'the most recent recorded agent attempt did not succeed', reasonCode: 'HANDOFF_LAST_ATTEMPT_NOT_SUCCEEDED' };
  }
  if (taskState.commit !== undefined) {
    return { eligible: false, reason: 'a task commit is already recorded for this task', reasonCode: 'HANDOFF_COMMIT_ALREADY_RECORDED' };
  }
  if (taskState.worktreePath === undefined || taskState.preparedHeadSha === undefined) {
    return { eligible: false, reason: 'no preserved worktree path / prepared SHA recorded for this task', reasonCode: 'HANDOFF_WORKTREE_NOT_PRESERVED' };
  }
  let worktree: OwnedWorktree;
  try {
    worktree = await this.worktrees.assertRegistered(taskState.worktreePath);
  } catch (error) {
    return { eligible: false, reason: `preserved worktree is not registered/present: ${errorText(error)}`, reasonCode: 'HANDOFF_WORKTREE_NOT_REGISTERED' };
  }
  let inspection: Awaited<ReturnType<typeof inspectTaskCommits>>;
  try {
    inspection = await inspectTaskCommits(this.git, worktree.path, taskState.preparedHeadSha);
  } catch (error) {
    return { eligible: false, reason: `worktree is not a valid descendant of its own prepared SHA: ${errorText(error)}`, reasonCode: 'HANDOFF_WORKTREE_INVALID_DESCENDANT' };
  }
  if (inspection.headSha !== taskState.preparedHeadSha) {
    return { eligible: false, reason: 'worktree HEAD has moved past the SHA prepared for this task', reasonCode: 'HANDOFF_WORKTREE_HEAD_MOVED' };
  }
  if (inspection.commits.length > 0) {
    return { eligible: false, reason: 'worktree already has commits beyond the prepared SHA', reasonCode: 'HANDOFF_WORKTREE_HAS_FOREIGN_COMMITS' };
  }
  try {
    await stat(this.taskAttemptStdoutLogPath(taskState.id, lastAttempt));
  } catch {
    return { eligible: false, reason: 'original agent stdout log is missing', reasonCode: 'HANDOFF_ORIGINAL_LOG_MISSING' };
  }
  return { eligible: true, reason: '' };
}
```

In `recoverHandoffFailures` (around line 604-665), add the two reason codes to the pre-checks inside `checked.map`, and thread `reasonCode` through the `ineligible.map` detail:

```ts
if (task === undefined) {
  return { taskState, task: undefined, kind, check: { eligible: false, reason: 'task id not found in the loaded phase config', reasonCode: 'HANDOFF_TASK_CONFIG_MISSING' as const } };
}
if (kind === 'review' && !REVIEW_MODES.has(task.mode)) {
  return { taskState, task, kind, check: { eligible: false, reason: `mode ${task.mode} is not a review/final_review task`, reasonCode: 'HANDOFF_TASK_MODE_MISMATCH' as const } };
}
```

```ts
ineligible: ineligible.map((entry) => ({
  taskId: entry.taskState.id,
  reason: entry.check.reason,
  reasonCode: entry.check.reasonCode,
})),
```

Declare `HandoffRecoveryEligibilityReasonCode` as a top-level type in `orchestrator.ts` near `HandoffOutcomeRecord`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/handoff-repair-accounting.test.js`
Expected: PASS

Run full suite: `cd tools/agent-orchestrator && pnpm run test`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`

```bash
git add tools/agent-orchestrator/src/orchestrator.ts tools/agent-orchestrator/test/workflow/handoff-repair-accounting.test.ts
git commit -m "Add stable eligibility reason codes and enforce the handoff repair attempt budget"
```

This completes Part A. Tasks 5-11 implement Part B.

---

### Task 5: Config — `salvage.verify`

**Files:**
- Modify: `tools/agent-orchestrator/src/config.ts`
- Test: `tools/agent-orchestrator/test/core/config-scheduler.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface SalvageConfig {
    readonly verify: readonly IntegrationCommand[];
  }
  // on PhaseConfig:
  readonly salvage: SalvageConfig; // { verify: [] } when the YAML key is absent
  ```

- [ ] **Step 1: Write the failing test**

```ts
test('salvage.verify defaults to an empty command list when absent', async () => {
  const config = await parsePhaseConfigFromYaml(minimalPhaseYaml());
  assert.deepEqual(config.salvage.verify, []);
});

test('salvage.verify parses a configured command list using the same shape as integration.prepare', async () => {
  const config = await parsePhaseConfigFromYaml(minimalPhaseYaml({
    extraYaml: `
salvage:
  verify:
    - command: echo verify
      required: true
      timeoutMs: 1000
`,
  }));
  assert.deepEqual(config.salvage.verify, [{ command: 'echo verify', required: true, timeoutMs: 1000 }]);
});
```

(Reuse this file's existing mechanism for splicing extra top-level YAML into the minimal fixture, matching however `agentWorktree.prepare` or `integration.prepare` are already tested in this same file, if such a test exists — follow that exact pattern.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/core/config-scheduler.test.js`
Expected: FAIL

- [ ] **Step 3: Implement**

In `src/config.ts`, add:

```ts
export interface SalvageConfig {
  readonly verify: readonly IntegrationCommand[];
}
```

Add `'salvage'` to `TOP_LEVEL_KEYS`. Add a parser mirroring `parseAgentWorktree` (line 190):

```ts
export function parseSalvage(value: unknown): SalvageConfig {
  if (value === undefined) {
    return { verify: [] };
  }
  if (!isObject(value)) {
    throw new OrchestratorError('CONFIG_INVALID', 'salvage must be an object');
  }
  const keys = new Set(Object.keys(value));
  for (const key of keys) {
    if (key !== 'verify') {
      throw new OrchestratorError('CONFIG_INVALID', `Unknown salvage key: ${key}`);
    }
  }
  return { verify: value.verify === undefined ? [] : parseCommandList(value.verify, 'salvage.verify') };
}
```

(Match `parseCommandList`'s actual exported/internal signature exactly — confirm at `src/config.ts:155` before writing this; adjust the call if its parameter order or name differs from `(value, path)`.)

Add `salvage: parseSalvage(value.salvage)` to the `PhaseConfig` object construction and add `salvage: SalvageConfig` to the `PhaseConfig` interface.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/core/config-scheduler.test.js`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`

```bash
git add tools/agent-orchestrator/src/config.ts tools/agent-orchestrator/test/core/config-scheduler.test.ts
git commit -m "Add salvage.verify phase config, categorically separate from agentWorktree.prepare"
```

---

### Task 6: Errors + tracked-diff fingerprint helper

**Files:**
- Modify: `tools/agent-orchestrator/src/errors.ts`
- Modify: `tools/agent-orchestrator/src/git/diff.ts`
- Test: `tools/agent-orchestrator/test/git/diff.test.ts` (existing file if present — check `test/git/` directory; otherwise create `test/git/diff.test.ts`)

**Interfaces:**
- Produces:
  ```ts
  // errors.ts: 'SALVAGE_VERIFICATION_FAILED' added to ERROR_CODES
  // diff.ts:
  export async function computeTrackedDiffFingerprint(
    git: GitClient,
    worktreePath: string,
    baseSha: string,
  ): Promise<string>; // sha256 hex of `git diff --no-ext-diff --no-color <baseSha>` stdout
  ```

- [ ] **Step 1: Write the failing test**

Check for an existing `test/git/` directory and its helpers (`createTemporaryRepository`, seen imported in `test/workflow/agent-failure-retry.test.ts` from `../git/helpers`) first — reuse them.

```ts
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import { computeTrackedDiffFingerprint } from '../../src/git/diff';
import { createTemporaryRepository } from './helpers';

test('computeTrackedDiffFingerprint is stable for identical tracked content and changes when tracked content changes', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'file.txt'), 'original\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'file.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'base']);
    const baseSha = (await fixture.git.run(fixture.repository, ['rev-parse', 'HEAD'])).stdout.trim();

    await writeFile(join(fixture.repository, 'file.txt'), 'changed once\n', 'utf8');
    const first = await computeTrackedDiffFingerprint(fixture.git, fixture.repository, baseSha);
    const firstAgain = await computeTrackedDiffFingerprint(fixture.git, fixture.repository, baseSha);
    assert.equal(first, firstAgain);

    await writeFile(join(fixture.repository, 'file.txt'), 'changed twice\n', 'utf8');
    const second = await computeTrackedDiffFingerprint(fixture.git, fixture.repository, baseSha);
    assert.notEqual(first, second);
  } finally {
    await fixture.dispose();
  }
});

test('computeTrackedDiffFingerprint ignores untracked files', async () => {
  const fixture = await createTemporaryRepository();
  try {
    await writeFile(join(fixture.repository, 'file.txt'), 'original\n', 'utf8');
    await fixture.git.run(fixture.repository, ['add', '--', 'file.txt']);
    await fixture.git.run(fixture.repository, ['commit', '-m', 'base']);
    const baseSha = (await fixture.git.run(fixture.repository, ['rev-parse', 'HEAD'])).stdout.trim();
    const before = await computeTrackedDiffFingerprint(fixture.git, fixture.repository, baseSha);
    await writeFile(join(fixture.repository, 'untracked.txt'), 'new untracked file\n', 'utf8');
    const after = await computeTrackedDiffFingerprint(fixture.git, fixture.repository, baseSha);
    assert.equal(before, after);
  } finally {
    await fixture.dispose();
  }
});
```

(Confirm `TemporaryRepository`'s exact shape — `.repository`, `.git`, `.dispose()` or similar — by reading `test/git/helpers.ts` before writing this; adjust field names to match exactly.)

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/git/diff.test.js`
Expected: FAIL (compile error — function doesn't exist)

- [ ] **Step 3: Implement**

In `src/errors.ts`, add `'SALVAGE_VERIFICATION_FAILED'` to the `ERROR_CODES` array (near `'INTEGRATION_TEST_FAILED'`).

In `src/git/diff.ts`, add:

```ts
import { createHash } from 'node:crypto';

export async function computeTrackedDiffFingerprint(
  git: GitClient,
  worktreePath: string,
  baseSha: string,
): Promise<string> {
  assertRevision(baseSha);
  const result = await git.run(worktreePath, ['diff', '--no-ext-diff', '--no-color', baseSha]);
  return createHash('sha256').update(result.stdout, 'utf8').digest('hex');
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/git/diff.test.js`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`

```bash
git add tools/agent-orchestrator/src/errors.ts tools/agent-orchestrator/src/git/diff.ts tools/agent-orchestrator/test/git/diff.test.ts
git commit -m "Add SALVAGE_VERIFICATION_FAILED error code and computeTrackedDiffFingerprint helper"
```

---

### Task 7: Orchestrator — `checkSalvageEligibility`

**Files:**
- Modify: `tools/agent-orchestrator/src/orchestrator.ts`
- Test: `tools/agent-orchestrator/test/workflow/agent-timeout-salvage.test.ts` (new)

**Interfaces:**
- Consumes: `TaskSpec.files`/`dependsOn` (`src/tasks/task-schema.ts:57-78`), `matchesOwnershipPattern`/`assertChangedFileOwnership` (`src/tasks/ownership.ts`), `OwnedWorktree`/`this.worktrees.assertRegistered` (`src/git/worktree-manager.ts`), `inspectTaskCommits` (`src/git/diff.ts:72`).
- Produces:
  ```ts
  type SalvageEligibilityReasonCode =
    | 'SALVAGE_NOT_TIMED_OUT' | 'SALVAGE_COMMIT_ALREADY_RECORDED' | 'SALVAGE_WORKTREE_NOT_REGISTERED'
    | 'SALVAGE_WORKTREE_HEAD_MOVED' | 'SALVAGE_WORKTREE_HAS_FOREIGN_COMMITS' | 'SALVAGE_WORKTREE_CLEAN'
    | 'SALVAGE_OWNERSHIP_VIOLATION' | 'SALVAGE_UNEXPECTED_UNTRACKED_FILE' | 'SALVAGE_DIFF_CHECK_FAILED'
    | 'SALVAGE_ALREADY_INTEGRATED' | 'SALVAGE_DEPENDENCY_UNSATISFIED';
  private async checkSalvageEligibility(taskId: string): Promise<
    { readonly eligible: true; readonly changedFiles: readonly string[] }
    | { readonly eligible: false; readonly reason: string; readonly reasonCode: SalvageEligibilityReasonCode }
  >;
  ```

**Test approach for this task:** confirmed by grepping `tools/agent-orchestrator/test/` — `checkAgentFailureRetryEligibility` (the existing private eligibility check this task's `checkSalvageEligibility` mirrors) has no dedicated unit test file; it's exercised only indirectly through its public caller, `retryAgentFailure`, in `test/workflow/agent-failure-retry.test.ts`. Follow the same precedent: this task (Step 1 below) implements `checkSalvageEligibility` as production code only, with no new test file yet. Task 8 (which adds `salvageTask`, the public entry point) is where all of this method's behavior gets exercised end-to-end, including the `AGENT_TIMEOUT` simulation technique described there (direct `stateStore.save` rewrite of a task's `agentAttempts`/`error`, matching `test/workflow/agent-failure-retry.test.ts:158-190`'s existing pattern for the same error code).

- [ ] **Step 1: Implement `checkSalvageEligibility`**

Add near `checkAgentFailureRetryEligibility` in `src/orchestrator.ts`:

```ts
type SalvageEligibilityReasonCode =
  | 'SALVAGE_NOT_TIMED_OUT' | 'SALVAGE_COMMIT_ALREADY_RECORDED' | 'SALVAGE_WORKTREE_NOT_REGISTERED'
  | 'SALVAGE_WORKTREE_HEAD_MOVED' | 'SALVAGE_WORKTREE_HAS_FOREIGN_COMMITS' | 'SALVAGE_WORKTREE_CLEAN'
  | 'SALVAGE_OWNERSHIP_VIOLATION' | 'SALVAGE_UNEXPECTED_UNTRACKED_FILE' | 'SALVAGE_DIFF_CHECK_FAILED'
  | 'SALVAGE_ALREADY_INTEGRATED' | 'SALVAGE_DEPENDENCY_UNSATISFIED';

private async checkSalvageEligibility(taskId: string): Promise<
  | { readonly eligible: true; readonly worktree: OwnedWorktree; readonly changedFiles: readonly string[] }
  | { readonly eligible: false; readonly reason: string; readonly reasonCode: SalvageEligibilityReasonCode }
> {
  const taskSpec = this.config.tasks.find((task) => task.id === taskId);
  const taskState = this.state.tasks[taskId];
  if (taskSpec === undefined || taskState === undefined) {
    return { eligible: false, reason: 'task id does not exist in this run', reasonCode: 'SALVAGE_NOT_TIMED_OUT' };
  }
  const lastAttempt = taskState.agentAttempts.at(-1);
  const timedOut = taskState.error?.code === 'AGENT_TIMEOUT' && lastAttempt?.outcome === 'timed_out';
  if ((taskState.status !== 'FAILED' && taskState.status !== 'BLOCKED') || !timedOut) {
    return { eligible: false, reason: 'task did not end in a timed-out agent attempt', reasonCode: 'SALVAGE_NOT_TIMED_OUT' };
  }
  if (taskState.commit !== undefined) {
    return { eligible: false, reason: 'a task commit is already recorded for this task', reasonCode: 'SALVAGE_COMMIT_ALREADY_RECORDED' };
  }
  if (
    this.state.integration.integratedTaskCommits.length > 0
    || (this.state.integration.integrationFixCommits?.length ?? 0) > 0
  ) {
    return { eligible: false, reason: 'integration has already consumed committed work for this run', reasonCode: 'SALVAGE_ALREADY_INTEGRATED' };
  }
  const unsatisfiedDependencies = taskSpec.dependsOn.filter((dependencyId) => {
    const status = this.state.tasks[dependencyId]?.status;
    return status !== 'SUCCEEDED' && status !== 'SKIPPED';
  });
  if (unsatisfiedDependencies.length > 0) {
    return { eligible: false, reason: `dependencies are not satisfied: ${unsatisfiedDependencies.join(', ')}`, reasonCode: 'SALVAGE_DEPENDENCY_UNSATISFIED' };
  }
  if (taskState.worktreePath === undefined || taskState.preparedHeadSha === undefined) {
    return { eligible: false, reason: 'no preserved worktree path / prepared SHA recorded for this task', reasonCode: 'SALVAGE_WORKTREE_NOT_REGISTERED' };
  }
  let worktree: OwnedWorktree;
  try {
    worktree = await this.worktrees.assertRegistered(taskState.worktreePath);
  } catch (error) {
    return { eligible: false, reason: `preserved worktree is not registered/present: ${errorText(error)}`, reasonCode: 'SALVAGE_WORKTREE_NOT_REGISTERED' };
  }
  const headSha = await this.git.resolveCommit(worktree.path, 'HEAD');
  if (headSha !== taskState.preparedHeadSha) {
    return { eligible: false, reason: 'worktree HEAD has moved past the SHA prepared for this task', reasonCode: 'SALVAGE_WORKTREE_HEAD_MOVED' };
  }
  const ancestorCheck = await this.git.run(
    worktree.path, ['log', '--format=%H', `${taskState.preparedHeadSha}..HEAD`],
  );
  if (ancestorCheck.stdout.trim().length > 0) {
    return { eligible: false, reason: 'worktree already has commits beyond the prepared SHA', reasonCode: 'SALVAGE_WORKTREE_HAS_FOREIGN_COMMITS' };
  }
  const status = await this.git.run(
    worktree.path, ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  );
  const entries = status.stdout.split('\0').filter((entry) => entry.length > 0);
  if (entries.length === 0) {
    return { eligible: false, reason: 'worktree has no dirty changes to salvage', reasonCode: 'SALVAGE_WORKTREE_CLEAN' };
  }
  const trackedChanged: string[] = [];
  const untrackedNew: string[] = [];
  for (const entry of entries) {
    const marker = entry.slice(0, 2);
    const path = entry.slice(3);
    if (marker === '??') {
      untrackedNew.push(path);
    } else {
      trackedChanged.push(path);
    }
  }
  const ownershipCheck = validateChangedFileOwnership(trackedChanged, taskSpec.files);
  if (ownershipCheck.violations.length > 0) {
    return { eligible: false, reason: `tracked changes outside ownership: ${ownershipCheck.violations.join(', ')}`, reasonCode: 'SALVAGE_OWNERSHIP_VIOLATION' };
  }
  const untrackedViolations = untrackedNew.filter(
    (path) => !taskSpec.files.some((pattern) => matchesOwnershipPattern(path, pattern)),
  );
  if (untrackedViolations.length > 0) {
    return { eligible: false, reason: `unexpected untracked files: ${untrackedViolations.join(', ')}`, reasonCode: 'SALVAGE_UNEXPECTED_UNTRACKED_FILE' };
  }
  const diffCheck = await this.git.run(
    worktree.path, ['diff', '--check', taskState.preparedHeadSha], { allowFailure: true },
  );
  if (diffCheck.exitCode !== 0) {
    return { eligible: false, reason: 'git diff --check reported whitespace/conflict-marker errors', reasonCode: 'SALVAGE_DIFF_CHECK_FAILED' };
  }
  return { eligible: true, worktree, changedFiles: [...trackedChanged, ...untrackedNew] };
}
```

(`GitClient.run(cwd, args, options)` and `GitClient.resolveCommit(cwd, revision)` are confirmed at `src/git/git.ts:50` and `:154`; `{ allowFailure: true }` is the same option `inspectTaskCommits` already passes at `src/git/diff.ts:82`. Import `validateChangedFileOwnership` and `matchesOwnershipPattern` from `src/tasks/ownership.ts` at the top of `orchestrator.ts` alongside the existing `assertChangedFileOwnership` import at line 59.)

- [ ] **Step 2: Typecheck**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`
Expected: PASS (no behavior change yet — `checkSalvageEligibility` is unused dead code until Task 8, which is fine for one commit as long as the linter/typechecker doesn't flag unused-private-method as an error; if it does, mark it `// eslint-disable-next-line` per existing convention or fold Tasks 7+8 into a single commit — check `.eslintrc`/`tsconfig` `noUnusedLocals` settings first).

- [ ] **Step 3: Commit**

```bash
git add tools/agent-orchestrator/src/orchestrator.ts
git commit -m "Add checkSalvageEligibility (unused until salvageTask lands in the next task)"
```

---

### Task 8: Orchestrator — `salvageTask` core flow (authorize → prepare → verify → commit, no canonical findings yet)

**Files:**
- Modify: `tools/agent-orchestrator/src/orchestrator.ts`
- Modify: `tools/agent-orchestrator/src/state/run-state.ts` (add `SalvageState`/checkpoint persistence)
- Test: `tools/agent-orchestrator/test/workflow/agent-timeout-salvage.test.ts`

**Interfaces:**
- Consumes: `checkSalvageEligibility` (Task 7), `computeTrackedDiffFingerprint` (Task 6), `ensureTaskCommit`/`assertChangedFileOwnership`, `PhaseConfig.agentWorktree.prepare`/`salvage.verify` (Task 5).
- Produces:
  ```ts
  export interface SalvageResult {
    readonly orchestrator: AgentOrchestrator;
    readonly taskId: string;
    readonly commitSha: string;
  }
  // static AgentOrchestrator.salvageTask(runId: string, taskId: string, options: OrchestratorOptions): Promise<SalvageResult>
  ```
  ```ts
  // on TaskRunState (run-state.ts):
  readonly salvage?: {
    readonly authorizedAt: string;
    readonly verification?: {
      readonly worktreeHeadSha: string;
      readonly trackedDiffFingerprint: string;
      readonly verifyConfigFingerprint: string;
      readonly result: 'passed';
    };
  };
  ```

- [ ] **Step 1: Write the failing tests**

In `test/workflow/agent-timeout-salvage.test.ts`, build the scenario scaffold (adapt `agent-failure-retry.test.ts`'s pattern). `createTimeoutScenario` runs an ordinary scenario where the fake writer agent for `'timed-out-task'` writes a file inside its ownership glob directly into the worktree (`writeFile(join(request.worktreePath, 'feature.txt'), 'salvageable work\n', 'utf8')`, then returns any `successfulResult`/`failedResult`-shaped `AgentResult` — the returned status doesn't matter, since the test immediately overwrites it) and then rewrites the persisted state via `scenario.orchestrator.stateStore.save({ ...before, tasks: { ...before.tasks, 'timed-out-task': { ...taskBefore, agentAttempts: [...taskBefore.agentAttempts.slice(0, -1), { ...taskBefore.agentAttempts.at(-1)!, outcome: 'timed_out' as const }], error: { code: 'AGENT_TIMEOUT', message: 'bounded execution timeout', at: before.updatedAt }, status: 'BLOCKED' as const } } })`, exactly matching the established pattern at `test/workflow/agent-failure-retry.test.ts:158-190`. Configure the phase YAML with a `salvage: { verify: [...] }` block whose command is something trivially deterministic and shell-portable, e.g. `command: 'true'` for the passing case and `command: 'false'` for the failing case (both are POSIX builtins available in the test environment; do not depend on `pnpm`/`jest` inside this unit test), and an `agentWorktree.prepare` left empty (`[]`) to keep this test's scope on `salvage.verify` specifically.

```ts
test('successful salvage authorizes, verifies, and commits an owned dirty diff, then the task is SUCCEEDED', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true' });
  try {
    const before = scenario.orchestrator.snapshot();
    assert.equal(before.tasks['timed-out-task']?.error?.code, 'AGENT_TIMEOUT');

    const result = await AgentOrchestrator.salvageTask('the-run-id', 'timed-out-task', {
      repositoryPath: scenario.fixture.repository,
      runsRoot: scenario.runsRoot,
      agents: { codex: scenario.codex, claude: scenario.claude },
    });

    const after = result.orchestrator.snapshot();
    assert.equal(after.tasks['timed-out-task']?.status, 'SUCCEEDED');
    assert.equal(after.tasks['timed-out-task']?.commit?.sha, result.commitSha);
  } finally {
    await scenario.fixture.dispose();
  }
});

test('clean timed-out worktree refuses salvage', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'true', leaveDirtyDiff: false });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask('the-run-id', 'timed-out-task', {
        repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
        agents: { codex: scenario.codex, claude: scenario.claude },
      }),
      (error: unknown) => isOrchestratorError(error, 'TASK_STATE_INVALID')
        && (error as { details: { reasonCode?: string } }).details.reasonCode === 'SALVAGE_WORKTREE_CLEAN',
    );
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a required salvage.verify command failure prevents commit', async () => {
  const scenario = await createTimeoutScenario({ verifyCommand: 'false' });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask('the-run-id', 'timed-out-task', {
        repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
        agents: { codex: scenario.codex, claude: scenario.claude },
      }),
      (error: unknown) => isOrchestratorError(error, 'SALVAGE_VERIFICATION_FAILED'),
    );
    const after = scenario.orchestrator.snapshot(); // re-load if snapshot is stale after a throw; reload run state from disk if salvageTask doesn't return an orchestrator on throw
    // Assert no commit was recorded for 'timed-out-task'.
  } finally {
    await scenario.fixture.dispose();
  }
});

test('a verify command that modifies tracked source fails closed regardless of its own exit code', async () => {
  // verifyCommand writes to the already-tracked salvaged file, e.g.
  // `sh -c "echo mutated >> feature.txt"`, and exits 0.
  const scenario = await createTimeoutScenario({ verifyCommand: 'sh -c "echo mutated >> feature.txt"' });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask('the-run-id', 'timed-out-task', {
        repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
        agents: { codex: scenario.codex, claude: scenario.claude },
      }),
      (error: unknown) => isOrchestratorError(error, 'SALVAGE_VERIFICATION_FAILED')
        && (error as { details: { reason?: string } }).details.reason === 'verify_mutated_tracked_source',
    );
  } finally {
    await scenario.fixture.dispose();
  }
});
```

(`createTimeoutScenario` is a new local helper in this test file, written to mirror `createFailedScenario` in `test/workflow/agent-failure-retry.test.ts` exactly, but producing a phase YAML with one writer task whose fake agent leaves a dirty owned file and simulates `AGENT_TIMEOUT`, plus a `salvage.verify` block using the `verifyCommand` option. Write its full body as part of this step — do not leave it as a stub.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/agent-timeout-salvage.test.js`
Expected: FAIL (compile error — `salvageTask` doesn't exist)

- [ ] **Step 3: Implement `SalvageState` persistence**

In `src/state/run-state.ts`, add to `TaskRunState`:

```ts
readonly salvage?: {
  readonly authorizedAt: string;
  readonly verification?: {
    readonly worktreeHeadSha: string;
    readonly trackedDiffFingerprint: string;
    readonly verifyConfigFingerprint: string;
    readonly result: 'passed';
  };
};
```

Add matching parse logic in `parseTask` (an `isObject`/`string`/`timestamp`-based parser mirroring `parseTaskPreparation`'s existing style, optional field, defaulting to `undefined` when absent).

- [ ] **Step 4: Implement `salvageTask`**

Add to `src/orchestrator.ts`, near `retryAgentFailure`/`applyIntegrationFix`:

```ts
export interface SalvageResult {
  readonly orchestrator: AgentOrchestrator;
  readonly taskId: string;
  readonly commitSha: string;
}

static async salvageTask(
  runId: string,
  taskId: string,
  options: OrchestratorOptions,
): Promise<SalvageResult> {
  const orchestrator = await AgentOrchestrator.loadRunForContinuation(runId, options);
  const checked = await orchestrator.checkSalvageEligibility(taskId);
  if (!checked.eligible) {
    throw new OrchestratorError(
      'TASK_STATE_INVALID',
      `Refusing salvage for ${taskId}: ${checked.reason}`,
      { details: { runId, taskId, reason: checked.reason, reasonCode: checked.reasonCode } },
    );
  }
  const taskSpec = orchestrator.config.tasks.find((task) => task.id === taskId)!;
  const taskState = orchestrator.state.tasks[taskId]!;

  await orchestrator.mutate((state) => updateTask(state, taskId, (task) => ({
    ...task,
    salvage: { authorizedAt: orchestrator.clock().toISOString() },
  })));
  await orchestrator.event('SALVAGE_AUTHORIZED', taskId, {});

  const verifyConfigFingerprint = createHash('sha256')
    .update(JSON.stringify(orchestrator.config.salvage.verify), 'utf8')
    .digest('hex');
  const existingCheckpoint = orchestrator.state.tasks[taskId]?.salvage?.verification;
  const currentDiffFingerprint = await computeTrackedDiffFingerprint(orchestrator.git, checked.worktree.path, taskState.preparedHeadSha!);
  const checkpointValid = existingCheckpoint !== undefined
    && existingCheckpoint.worktreeHeadSha === taskState.preparedHeadSha
    && existingCheckpoint.trackedDiffFingerprint === currentDiffFingerprint
    && existingCheckpoint.verifyConfigFingerprint === verifyConfigFingerprint;

  if (!checkpointValid) {
    if (orchestrator.config.agentWorktree.prepare.length > 0) {
      const prepResult = await new IntegrationGate().run({
        cwd: checked.worktree.path,
        logsDirectory: join(orchestrator.stateStore.runDirectory, 'logs', taskId, 'salvage-prepare'),
        commands: orchestrator.config.agentWorktree.prepare,
        ...(orchestrator.signal === undefined ? {} : { signal: orchestrator.signal }),
      });
      if (!prepResult.passed) {
        throw new OrchestratorError(
          'AGENT_WORKTREE_PREPARATION_FAILED',
          `Refusing salvage for ${taskId}: worktree preparation failed`,
          { details: { runId, taskId } },
        );
      }
    }
    if (orchestrator.config.salvage.verify.length === 0) {
      throw new OrchestratorError(
        'SALVAGE_VERIFICATION_FAILED',
        `Refusing salvage for ${taskId}: no salvage.verify commands configured`,
        { details: { runId, taskId, reason: 'no_verify_configured' } },
      );
    }
    const preFingerprint = await computeTrackedDiffFingerprint(orchestrator.git, checked.worktree.path, taskState.preparedHeadSha!);
    const verifyResult = await new IntegrationGate().run({
      cwd: checked.worktree.path,
      logsDirectory: join(orchestrator.stateStore.runDirectory, 'logs', taskId, 'salvage-verify'),
      commands: orchestrator.config.salvage.verify,
      ...(orchestrator.signal === undefined ? {} : { signal: orchestrator.signal }),
    });
    const postFingerprint = await computeTrackedDiffFingerprint(orchestrator.git, checked.worktree.path, taskState.preparedHeadSha!);
    if (postFingerprint !== preFingerprint) {
      throw new OrchestratorError(
        'SALVAGE_VERIFICATION_FAILED',
        `Refusing salvage for ${taskId}: verify commands modified tracked source`,
        { details: { runId, taskId, reason: 'verify_mutated_tracked_source' } },
      );
    }
    if (!verifyResult.passed) {
      throw new OrchestratorError(
        'SALVAGE_VERIFICATION_FAILED',
        `Refusing salvage for ${taskId}: required verify command failed`,
        { details: { runId, taskId, reason: 'verify_command_failed' } },
      );
    }
    await orchestrator.mutate((state) => updateTask(state, taskId, (task) => ({
      ...task,
      salvage: {
        authorizedAt: task.salvage!.authorizedAt,
        verification: {
          worktreeHeadSha: taskState.preparedHeadSha!,
          trackedDiffFingerprint: postFingerprint,
          verifyConfigFingerprint,
          result: 'passed',
        },
      },
    })));
    await orchestrator.event('SALVAGE_VERIFIED', taskId, {});
  }

  const ensured = await ensureTaskCommit(orchestrator.git, {
    worktreePath: checked.worktree.path,
    baseSha: taskState.preparedHeadSha!,
    agent: taskSpec.owner,
    taskId,
    summary: `Salvaged timed-out writer work for ${taskId}`,
  });
  assertChangedFileOwnership(taskId, ensured.changedFiles, taskSpec.files);

  await orchestrator.succeedTask(taskId, '', {
    sha: ensured.commitSha, parentSha: taskState.preparedHeadSha!, changedFiles: [...ensured.changedFiles],
  }); // handoffPath: canonical-finding handling in Task 9 replaces the '' placeholder with a real synthesized handoff path; for a task with NO required canonical findings, '' is acceptable only if succeedTask tolerates it — confirm succeedTask's actual handling of handoffPath before finalizing; if it must be non-empty, synthesize a minimal handoff file here even in this task.

  return { orchestrator, taskId, commitSha: ensured.commitSha };
}
```

**Implementation note:** `IntegrationGate` (imported at `src/orchestrator.ts:39` — `import { IntegrationGate, canReuseIntegrationPreparation } from './integration/integration-gate';`) is the exact same class `prepareTask`'s existing `agentWorktree.prepare` handling already uses (see `src/orchestrator.ts:1562-1567` for the precedent this code mirrors). Its `run(options)` method takes `{ cwd, logsDirectory, commands, signal? }` and returns `{ passed: boolean, commands: readonly IntegrationCommandResult[] }` (`src/integration/integration-gate.ts:34-48`) — no separate command-runner is introduced here; both the prepare step and the verify step above go through this one shared class, exactly like every other command-list execution in this codebase already does.

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/agent-timeout-salvage.test.js`
Expected: PASS

Run full suite: `cd tools/agent-orchestrator && pnpm run test`
Expected: PASS

- [ ] **Step 6: Typecheck and commit**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`

```bash
git add tools/agent-orchestrator/src/orchestrator.ts tools/agent-orchestrator/src/state/run-state.ts tools/agent-orchestrator/test/workflow/agent-timeout-salvage.test.ts
git commit -m "Add salvageTask: authorize/verify/commit flow for timed-out writer worktrees with dirty owned diffs"
```

---

### Task 9: Orchestrator — canonical finding handling in salvage

**Files:**
- Modify: `tools/agent-orchestrator/src/orchestrator.ts` (`salvageTask`)
- Test: `tools/agent-orchestrator/test/workflow/agent-timeout-salvage.test.ts`

**Interfaces:**
- Consumes: `requiredCanonicalFindings(taskId)` (`src/orchestrator.ts:1804`), `repairHandoff` (Task 3, reused directly — NOT `repairHandoffViaAgent` alone, since salvage needs the full cascade in case framing/deterministic tiers apply too, though in practice a synthesized handoff will always need the agent tier since it starts with no `findingResponses` at all).

- [ ] **Step 1: Write the failing test**

```ts
test('salvage of a task with a required canonical finding synthesizes a handoff and attaches a valid findingResponses entry via the repair cascade', async () => {
  const scenario = await createTimeoutScenario({
    verifyCommand: 'true',
    requiredCanonicalFinding: { findingId: 'F001', canonicalFindingKey: 'test-run:test-unit:F001' },
    handoffRepairAgentBehavior: (request) => /* return a valid findingResponses-only completion for F001, evidence-backed by the salvaged diff */,
  });
  try {
    const result = await AgentOrchestrator.salvageTask('the-run-id', 'timed-out-task', {
      repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
      agents: { codex: scenario.codex, claude: scenario.claude },
    });
    const after = result.orchestrator.snapshot();
    assert.equal(after.tasks['timed-out-task']?.status, 'SUCCEEDED');
    assert.equal(after.tasks['timed-out-task']?.handoffOutcome, 'valid');
  } finally {
    await scenario.fixture.dispose();
  }
});

test('salvage fails closed if the repair cascade cannot produce a valid findingResponses entry for a required canonical finding', async () => {
  const scenario = await createTimeoutScenario({
    verifyCommand: 'true',
    requiredCanonicalFinding: { findingId: 'F001', canonicalFindingKey: 'test-run:test-unit:F001' },
    handoffRepairAgentBehavior: (request) => /* returns status: 'complete' with NO findingResponses, or throws */,
  });
  try {
    await assert.rejects(
      () => AgentOrchestrator.salvageTask('the-run-id', 'timed-out-task', {
        repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
        agents: { codex: scenario.codex, claude: scenario.claude },
      }),
      (error: unknown) => isOrchestratorError(error, 'HANDOFF_INVALID'),
    );
    const after = scenario.orchestrator.snapshot();
    assert.notEqual(after.tasks['timed-out-task']?.status, 'SUCCEEDED');
    assert.equal(after.tasks['timed-out-task']?.commit, undefined);
  } finally {
    await scenario.fixture.dispose();
  }
});
```

(`requiredCanonicalFinding` in `createTimeoutScenario`'s options drives the adaptive-mode fixture construction needed for `requiredCanonicalFindings(taskId)` to return a non-empty array — follow `test/adaptive/adaptive-continuation.test.ts`'s existing pattern for how a task acquires a real `authorization.purpose === 'correction'` with a `canonicalFindingKey`, exactly as referenced in Task 3.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/agent-timeout-salvage.test.js`
Expected: FAIL (canonical handling doesn't exist in `salvageTask` yet — the first test's assertion on `handoffOutcome` fails, or the second test's `HANDOFF_INVALID` never throws because nothing checks canonical findings yet).

- [ ] **Step 3: Implement**

In `salvageTask` (Task 8), replace the placeholder `succeedTask(taskId, '', ...)` call at the end with:

```ts
const requiredCanonicalFindings = orchestrator.requiredCanonicalFindings(taskId);
const finalDiff = (await orchestrator.git.run(
  checked.worktree.path, ['diff', '--no-ext-diff', '--no-color', taskState.preparedHeadSha!],
)).stdout;

let handoff: StructuredHandoff;
if (requiredCanonicalFindings.length === 0) {
  handoff = {
    status: 'complete',
    summary: `Salvaged timed-out writer work for ${taskId} after deterministic verification.`,
    filesChanged: [...ensured.changedFiles],
    decisions: [],
    tests: orchestrator.config.salvage.verify.map((command) => ({ command: command.command, result: 'pass' as const, details: 'salvage.verify required command passed' })),
    openQuestions: [],
    reviewRequested: [],
  };
} else {
  const synthesizedShell: unknown = {
    status: 'complete',
    summary: `Salvaged timed-out writer work for ${taskId} after deterministic verification.`,
    filesChanged: [...ensured.changedFiles],
    decisions: [],
    tests: orchestrator.config.salvage.verify.map((command) => ({ command: command.command, result: 'pass', details: 'salvage.verify required command passed' })),
    openQuestions: [],
    reviewRequested: [],
    // findingResponses intentionally absent -> forces the repair cascade to run
  };
  const repaired = await orchestrator.repairHandoff(taskSpec, synthesizedShell, null, requiredCanonicalFindings, finalDiff);
  if (!repaired.ok) {
    throw new OrchestratorError(
      'HANDOFF_INVALID',
      `Refusing salvage for ${taskId}: canonical finding response could not be completed`,
      { details: { runId, taskId, reason: repaired.reason } },
    );
  }
  handoff = repaired.handoff;
}

const handoffPath = await writeHandoff(join(orchestrator.stateStore.runDirectory, 'handoffs'), taskId, handoff);
await orchestrator.succeedTask(taskId, handoffPath, {
  sha: ensured.commitSha, parentSha: taskState.preparedHeadSha!, changedFiles: [...ensured.changedFiles],
});
```

(Confirm `writeHandoff`'s exact import/signature — it's already used in `finishParsedHandoff` at `src/orchestrator.ts:1837-1844`; reuse that exact import rather than re-declaring it. `repairHandoff` is currently `private` — since `salvageTask` is a `static` method operating on an `orchestrator` instance it already constructed via `loadRunForContinuation`, calling `orchestrator.repairHandoff(...)` from within the same class body is legal TypeScript (private members are accessible from any code in the same class, including static methods), so no visibility change is needed.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/agent-timeout-salvage.test.js`
Expected: PASS

Run full suite: `cd tools/agent-orchestrator && pnpm run test`
Expected: PASS

- [ ] **Step 5: Typecheck and commit**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`

```bash
git add tools/agent-orchestrator/src/orchestrator.ts tools/agent-orchestrator/test/workflow/agent-timeout-salvage.test.ts
git commit -m "Handle required canonical findings during salvage via the shared repair cascade"
```

---

### Task 10: CLI — `agents:salvage-task`

**Files:**
- Modify: `tools/agent-orchestrator/src/cli.ts`
- Modify: `tools/agent-orchestrator/package.json` (new `salvage-task` script, mirroring `retry-agent`)
- Modify: `tools/agent-orchestrator/README.md` (document the new command, mirroring how `retry-agent`/`recover-handoffs` are already documented)
- Test: covered by Task 8/9's orchestrator-level tests; this task adds no new orchestrator test, only a thin CLI smoke check if `test/smoke/` already covers other commands similarly (check first).

**Interfaces:**
- Consumes: `AgentOrchestrator.salvageTask` (Task 8/9).

- [ ] **Step 1: Check for an existing CLI smoke test pattern**

Run: `grep -rln "recover-handoffs\|retry-agent" tools/agent-orchestrator/test/smoke/` — if CLI commands are smoke-tested there, add a `salvage-task` case following that exact pattern in Step 4 below. If not, skip straight to implementation (Step 2) — this task's real coverage already exists via Task 8/9's direct `AgentOrchestrator.salvageTask` tests.

- [ ] **Step 2: Implement CLI wiring**

In `src/cli.ts`, following the `retry-agent` block (around line 76-95) exactly:

```ts
if (command === 'salvage-task') {
  const [taskId] = extra;
  if (argument === undefined || taskId === undefined || extra.length !== 1) {
    process.stderr.write(`${USAGE}\n`);
    return 1;
  }
  const repositoryPath = await new GitClient().repositoryRoot(process.cwd());
  const result = await AgentOrchestrator.salvageTask(argument, taskId, { repositoryPath });
  process.stdout.write(`${JSON.stringify({
    runId: result.orchestrator.snapshot().runId,
    runStatus: result.orchestrator.snapshot().status,
    taskId: result.taskId,
    commitSha: result.commitSha,
    manualNextStep: 'Inspect the salvaged commit below, then run `pnpm agents:resume <run-id>` to continue the run.',
  }, null, 2)}\n`);
  return 0;
}
```

Add `'salvage-task'` to the `USAGE` string (near the existing `retry-agent`/`recover-handoffs` usage lines, around line 21-24).

In `package.json`'s `scripts`, add (mirroring the `retry-agent` entry exactly):

```json
"salvage-task": "pnpm --silent run build && node dist/cli.js salvage-task",
```

In `README.md`, add a `salvage-task` entry to whatever section already documents `retry-agent`/`recover-handoffs`/`apply-integration-fix`, following that section's existing format (usage line, one-paragraph description, eligibility summary — cross-reference the spec at `docs/superpowers/specs/2026-09-04-orchestrator-recovery-hardening-design.md` rather than re-explaining every eligibility rule inline).

- [ ] **Step 3: Typecheck**

Run: `cd tools/agent-orchestrator && pnpm run typecheck`
Expected: PASS

- [ ] **Step 4 (only if Step 1 found an existing smoke pattern): Add a smoke test**

Follow the exact existing smoke test's structure for `retry-agent`/`recover-handoffs`, substituting `salvage-task` and its two required positional args.

- [ ] **Step 5: Run full suite and smoke, then commit**

Run: `cd tools/agent-orchestrator && pnpm run test && pnpm run smoke`
Expected: PASS

```bash
git add tools/agent-orchestrator/src/cli.ts tools/agent-orchestrator/package.json tools/agent-orchestrator/README.md
git commit -m "Wire agents:salvage-task CLI command"
```

---

### Task 11: Orchestrator — crash/resume checkpoint reuse verification

**Files:**
- Modify: `tools/agent-orchestrator/test/workflow/agent-timeout-salvage.test.ts` (no production code changes — Task 8 already implemented checkpoint persistence and reuse logic; this task is dedicated to proving it, since it's a subtle invariant worth its own reviewable increment)

**Interfaces:**
- Consumes: `salvageTask`'s checkpoint-reuse logic from Task 8 (the `checkpointValid` branch).

- [ ] **Step 1: Write the failing/pending tests**

```ts
test('a second salvageTask call reuses a valid SALVAGE_VERIFIED checkpoint without rerunning verify commands', async () => {
  let verifyInvocations = 0;
  const scenario = await createTimeoutScenario({
    verifyCommand: 'true',
    onVerifyInvoked: () => { verifyInvocations += 1; }, // wire this counter into createTimeoutScenario's verify command construction if the helper supports instrumentation, or track it via a sentinel file the verify command touches and count file-touch occurrences instead
  });
  try {
    await AgentOrchestrator.salvageTask('the-run-id', 'timed-out-task', {
      repositoryPath: scenario.fixture.repository, runsRoot: scenario.runsRoot,
      agents: { codex: scenario.codex, claude: scenario.claude },
    });
    const afterFirst = verifyInvocations;
    assert.equal(afterFirst, 1);
    // taskState.commit is now set, so a second salvageTask call is refused by
    // checkSalvageEligibility (SALVAGE_COMMIT_ALREADY_RECORDED) before it
    // ever reaches the verify-reuse branch — this proves duplicate-commit
    // safety (already covered) but NOT checkpoint reuse specifically, since
    // eligibility already blocks a second full call once committed.
    // To actually exercise checkpoint reuse, this test must simulate a crash
    // BETWEEN SALVAGE_VERIFIED and the commit step — see the next test.
  } finally {
    await scenario.fixture.dispose();
  }
});

test('resuming after a crash between SALVAGE_VERIFIED and commit reuses the checkpoint (no re-verification) when the diff is unchanged', async () => {
  // This requires driving salvageTask up through the SALVAGE_VERIFIED
  // persisted state and then simulating a fresh process by constructing a
  // brand-new AgentOrchestrator.salvageTask call against the same runId
  // without ever having reached the commit step in the first call. Since
  // salvageTask in this plan runs authorize->verify->commit as one
  // synchronous call with no externally-observable pause point, the
  // cleanest way to simulate "crash after verify, before commit" in a test
  // is to pre-seed the run state file on disk with a task that already has
  // taskState.salvage.verification set (matching the current worktree diff
  // and current salvage.verify config) but no taskState.commit, mimicking
  // exactly what persisted state would look like after a real crash at that
  // point, then call salvageTask and assert the verify command's touch-file
  // was NOT created/incremented during this second call, while a commit IS
  // still produced.
});

test('resuming with a checkpoint whose trackedDiffFingerprint no longer matches the worktree reruns verify', async () => {
  // Same pre-seeding technique as above, but before calling salvageTask,
  // mutate the worktree's tracked file further (simulating the diff having
  // changed since the checkpoint was recorded). Assert the verify command
  // DOES run again (touch-file count increments).
});

test('resuming with a checkpoint whose verifyConfigFingerprint no longer matches the current salvage.verify config reruns verify', async () => {
  // Same pre-seeding technique, but reload the orchestrator against a phase
  // YAML whose salvage.verify command differs from what's recorded in the
  // checkpoint. Assert verify reruns.
});
```

Write each test's full body — the comments above describe the scenario each must construct; the deliverable for this step is complete, runnable test code, not the comments themselves. Use `writeFile`/`readFile` on the run's `run.json` directly (via the same `RunState`/`stateStore` shape Task 2's parser already validates) to pre-seed the "as if resumed after a crash" state, since that's the only way to reach a state `salvageTask`'s own synchronous flow doesn't otherwise pause at.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/agent-timeout-salvage.test.js`
Expected: the first test should already PASS (it doesn't test anything new); the pre-seeded-state tests should FAIL if checkpoint reuse has any bug, or PASS immediately if Task 8's implementation is already correct — in the latter case, this task's value is the regression coverage itself, and Step 3 is a no-op.

- [ ] **Step 3: Fix any bug surfaced, or confirm no changes needed**

If a pre-seeded-state test fails, the most likely cause is `salvageTask`'s `checked.worktree`/`taskState` being captured from the eligibility check before the checkpoint comparison, rather than re-read fresh — ensure `existingCheckpoint`, `currentDiffFingerprint`, and `verifyConfigFingerprint` are all computed from the freshly-loaded `orchestrator.state` (post `loadRunForContinuation`), not from stale values. Fix in `src/orchestrator.ts`'s `salvageTask` if needed.

- [ ] **Step 4: Run full suite and commit**

Run: `cd tools/agent-orchestrator && pnpm run test && pnpm run typecheck`

```bash
git add tools/agent-orchestrator/test/workflow/agent-timeout-salvage.test.ts tools/agent-orchestrator/src/orchestrator.ts
git commit -m "Prove salvage verification checkpoint reuse/invalidation across simulated crash-resume"
```

---

### Task 12: Acceptance scenario — F001/F002/F003/work-000004-shaped regression

**Files:**
- Create: `tools/agent-orchestrator/test/workflow/phase6-dogfood-recovery-acceptance.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-11 (`recoverHandoffFailures`, `salvageTask`, legacy migration).

- [ ] **Step 1: Write the failing test**

```ts
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';

import type { Agent, AgentName, AgentRequest, AgentResult } from '../../src/agents';
import { AgentOrchestrator } from '../../src/orchestrator';
import { createTemporaryRepository } from '../git/helpers';

test('Phase6-shaped acceptance: salvaging F001 and recovering F002 leaves F003 and its re-verification untouched', async () => {
  // 1. Build a fixture run with four tasks shaped like the real
  //    work-000001..work-000004: F001 (writer, AGENT_TIMEOUT, dirty owned
  //    diff, requires canonical finding F001), F002 (correction, FAILED/
  //    HANDOFF_INVALID, correct diff + generic handoff already present,
  //    legacy handoffRepairAttempted=true/handoffRepairSucceeded=false
  //    seeded directly into the persisted run state file, requires
  //    canonical finding F002), F003 (already SUCCEEDED with a synthetic
  //    commit sha), work-000004 (F003's targeted re-verification, already
  //    SUCCEEDED).
  // 2. Snapshot F003 and work-000004's TaskRunState objects (deep clone).
  // 3. Call AgentOrchestrator.salvageTask(...) for F001 with a fake
  //    handoff_repair agent that supplies a valid F001 findingResponses
  //    entry backed by the salvaged diff/verify evidence. Assert F001
  //    becomes SUCCEEDED with a commit.
  // 4. Call AgentOrchestrator.recoverHandoffFailures(...) for F002. Assert
  //    the legacy attempt is counted (one remaining attempt under the
  //    default budget of 2), the fake handoff_repair agent is invoked
  //    exactly once more, and F002 becomes SUCCEEDED with its diff
  //    unchanged (only findingResponses added).
  // 5. Re-read F003 and work-000004's TaskRunState objects from the final
  //    orchestrator snapshot and assert.deepEqual against the step-2
  //    snapshots.
});
```

Write the complete fixture-construction and assertion code for this test — it is the single most important test in this plan (the formal sibling-immutability invariant from the spec) and must not be left as a comment skeleton.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd tools/agent-orchestrator && pnpm run test:compile && node --test dist-test/test/workflow/phase6-dogfood-recovery-acceptance.test.js`
Expected: FAIL initially only if any wiring gap remains from Tasks 1-11; if all prior tasks are complete and correct, this test should PASS on the first run since it exercises only already-implemented behavior — in that case, this step's "fail" is acceptable to skip, but still run the command once to confirm a genuine PASS (never assume).

- [ ] **Step 3: Fix any gap surfaced**

If this test fails, it means Tasks 1-11 have an integration gap not caught by their own narrower tests (e.g. two tasks' state mutations interacting unexpectedly). Fix in whichever of `src/orchestrator.ts`/`src/state/run-state.ts` the failure traces to. Do not weaken this test's assertions to make it pass.

- [ ] **Step 4: Run full suite, smoke, and typecheck**

Run: `cd tools/agent-orchestrator && pnpm run test && pnpm run smoke && pnpm run typecheck`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add tools/agent-orchestrator/test/workflow/phase6-dogfood-recovery-acceptance.test.ts
git commit -m "Add Phase 6-shaped acceptance test: salvage+recover leaves sibling tasks provably unchanged"
```

---

## Final verification (after Task 12)

- [ ] `cd tools/agent-orchestrator && pnpm run typecheck` — PASS
- [ ] `cd tools/agent-orchestrator && pnpm run build` — PASS
- [ ] `cd tools/agent-orchestrator && pnpm run test` — PASS, report exact pass count (do not assume it matches any previously-reported number)
- [ ] `cd tools/agent-orchestrator && pnpm run smoke` — PASS, report exact pass count
- [ ] `git diff --check` (from repo root) — PASS, no whitespace errors introduced
- [ ] `git status --short` (from repo root) — confirm the three protected run directories and `apps/api/src/events/**` show no changes
- [ ] Confirm no test in this plan invoked a real Codex/Claude/Gemini/OpenAI process — grep the new test files for `new CodexAgent(` / `new ClaudeAgent(` and confirm none appear (only the fake `Agent` test-doubles should be used)

Do not run `agents:recover-handoffs`, `agents:retry-agent`, or `agents:salvage-task` against `run-20260904124350-dc56690c`, `run-20260904101940-9fdd27c5`, or `run-20260903203914-cc2b57d4` at any point during this plan's execution.
