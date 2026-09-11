# Orchestrator Working Context

> Persistent source of truth for continuing Orchestrator development across chats, agents, and context resets.
>
> Read this file first in any future session, but **always inspect live persisted run state/events before mutating anything**.

Last updated: 2026-09-11

## Project priority

The **agent orchestrator is the primary project**. TripWith is the dogfood workload used to expose orchestration failures, recovery gaps, scheduling bugs, provider limitations, verification problems, and opportunities for adaptive repair.

Core goals:

1. Reliable, fail-closed execution.
2. Minimal human intervention through evidence-driven diagnosis.
3. Separate deterministic recovery from code/policy repair.
4. Multi-provider/model routing based on health, capability, risk, cost, and observed quality.
5. Dynamic Plan IR / graph rather than a permanently rigid pipeline.
6. Bounded project auto-repair and eventually **versioned self-repair** of the Orchestrator itself; never unsafe live self-modification.
7. Visual Control Plane after runtime correctness, diagnosis, repair, and routing are mature.

---

## Current live dogfood run

```text
run-20260910100819-8ddbdc28
phase: 7
baseBranch: phase7/chat-realtime-design
orchestrator development branch: orchestrator/replan-evidence-normalization
```

### Major Phase 7 milestone: static scope replan succeeded

The original Event writer `phase7-event-chat-integration` hit a legitimate ownership gap: Event work required complementary Chat authorization changes outside its static ownership.

An explicit human-authorized static replan was created:

```text
proposal: d75171ce9e43ef28ec89bce27462826bfa1cbcaf7f88541787ba6f2a372f6424
source checkpoint: b324663a719eb519a884117a8a556c98936c0738
dynamic follow-up: replan-709cb1086b25fd5da117
follow-up commit: a57c582e4ec4027d6b5bd94b4795d2243563c28c
```

A legacy mislabeled evidence entry (`kind: test` containing a repository file path) was normalized explicitly to file evidence without modifying the original handoff.

The dynamic Chat follow-up initially blocked on PostgreSQL verification. Host verification then exposed a **real test setup defect**, not a DB outage: PostgreSQL could not infer `$2` consistently because the integration test reused it both as `event_status` and in an untyped comparison. The preserved worktree was corrected narrowly with explicit `event_status` casts.

Verification after that repair:

```text
focused integration test: 14/14 passed
full API suite: 74 suites / 639 tests passed
```

Canonical `verify-blocked-task` then succeeded and produced the follow-up commit above.

On the next `agents:resume`, the replan completed successfully:

```text
phase7-event-chat-integration.status = SUCCEEDED
phase7-event-chat-integration.commit = b324663a719eb519a884117a8a556c98936c0738
replan.phase = RESOLVED
composed verification = PASSED
```

The composed verification ran:

```text
pnpm install --frozen-lockfile                       PASS
pnpm --filter @tripwith/shared build                PASS
pnpm --filter @tripwith/api typecheck               PASS
pnpm --filter @tripwith/api test -- --runInBand     PASS
```

### Current blocker: Event review structured output

After successful replan resolution, `phase7-event-chat-review` invoked Claude and the **provider process itself succeeded**, but the structured review failed strict validation:

```text
phase7-event-chat-review.status = FAILED
attempts = 1
latestAttempt.outcome = succeeded
error.code = REVIEW_BLOCKED
error.message = "review: must be an object"
reviewRounds = 0
```

All downstream Event correction/final-review and final composed tasks are blocked only by dependency failure.

Important: the current runtime's `parseOrRecoverReview()` already performs two deterministic recovery attempts during live completion:

1. normalize only `approved` + material findings -> `changes_requested`;
2. framing extraction from raw stdout followed by strict `validateReview`.

Therefore the current failure means the live parser did **not** find a valid review through those paths. `agents:recover-handoffs` still explicitly supports terminal `REVIEW_BLOCKED` review tasks whose agent process succeeded, so it is safe to try as the canonical persisted structured-output recovery primitive, but it may legitimately skip this task if the same persisted evidence is insufficient. It must not silently manufacture review semantics.

If deterministic recovery skips, inspect the original raw stdout and `HANDOFF_REPAIR_ATTEMPTED`/repair-history evidence before designing any new primitive. Preserve the original stdout byte-for-byte.

---

## Important Orchestrator hardening already completed

```text
1575c36  review status normalization
5283e71  salvage useful dirty AGENT_FAILED writers + resumability
9ce6299  review budget scoped by lineage instead of all DAG ancestry
eaed966  safe retry of eligible pre-invocation review failures
c2701c6  stale preflight lock cleanup race hardening
f170d54  authorized static scope-gap replanning
aef8c50  strict replan evidence + ownership hardening
c6cd427  explicit normalization of legacy mislabeled replan evidence
```

Current recovery/replan primitives include:

```text
agents:recover-handoffs
agents:retry-agent
agents:salvage-task
agents:verify-blocked-task
agents:retry-preflight
agents:normalize-replan-evidence
agents:propose-replan
agents:authorize-replan
agents:resume
```

Design rule: preserve evidence and provenance; prefer deterministic recovery; never convert an unverified failure into success.

---

## Core architectural lessons

### Provider claims are hypotheses, not facts

Use:

```text
agent claim
→ evidence probe
→ observed facts
→ classification
→ recovery/repair policy
```

A provider saying “sandbox EPERM” is not enough. In Phase 7, host verification disproved the simple environmental explanation and exposed a real SQL test defect.

### Recovery != Repair

```text
Recovery = continue safely without changing implementation semantics
Repair   = change implementation, test, config, policy, or Orchestrator code
```

Examples:

```text
quota exhaustion                  -> recovery / reroute
useful dirty AGENT_FAILED writer  -> salvage recovery
blocked sandbox DB verification   -> host verification recovery
bad SQL integration test          -> bounded repair
review-lineage algorithm defect   -> Orchestrator self-repair candidate
```

### Dynamic work uses the same safety machinery

Dynamic replan tasks must use normal ownership, worktrees, verification, provenance, locks, review, salvage, and recovery. No special bypass path.

### Host verification is first-class

Capability-aware policy should eventually know in advance when sandbox verification is insufficient and schedule host validation directly.

---

## Active roadmap

```text
1. Finish Phase 7 dogfood
2. Health / Capability Plane
3. Failure Facts + Evidence Probe Layer
4. Failure Intelligence
5. Failure Memory / Failure Graph
6. Event-Sourced Runtime
7. Recovery Controller
8. Bounded Repair Controller
9. Provider Router
10. Task / Dispatch separation
11. Dynamic Plan IR / Graph
12. Versioned Self-Repair Framework
13. Context Triage / Long-term Operational Memory
14. Adaptive Review Policy
15. Control Plane / Visual UI
```

Reliability, diagnosis, and safe repair come before UI polish.

---

## Failure Intelligence direction

Failure Intelligence is a **core subsystem**.

### Failure Facts

Persist machine-readable observations separately from policy decisions. Do not put subjective fields such as `retryable: true` into raw facts.

Example:

```text
source: verification
command: pnpm --filter @tripwith/api test -- --runInBand
exitCode: 1
passingSuites: 73
failingSuites: 1
passingTests: 635
failingTests: 4
errorClass: QueryFailedError
file: src/chat/event-chat.int-spec.ts
databaseReachable: true
```

### Evidence probes

```text
logs
focused tests
git state
provider health/quota
DB reachability
permission/sandbox capability
schema inspection
previous failure history
structured-output inspection
```

### Initial taxonomy

```text
PROVIDER_FAILURE
PROVIDER_QUOTA
CAPABILITY_MISSING
PERMISSION_DENIED
ENVIRONMENT_FAILURE
VERIFICATION_FAILURE
TEST_FAILURE
STRUCTURED_OUTPUT_FAILURE
OWNERSHIP_GAP
PLAN_GAP
RECOVERY_GAP
ORCHESTRATOR_DEFECT
UNKNOWN
```

The taxonomy should evolve from evidence and not become an inflexible enum too early.

### Repair Planner

Choose the narrowest safe action:

```text
existing deterministic recovery
provider reroute
host verification
bounded configuration adjustment
bounded project correction
replan
self-repair candidate
human escalation
```

Risk-aware verification:

```text
low-risk test-only repair
  -> focused proof -> full suite

medium-risk implementation repair
  -> focused proof -> full suite -> independent review

high-risk architecture/orchestrator repair
  -> deterministic reproduction -> full tests + smoke -> independent provider review -> explicit authorization
```

---

## Failure Memory / Graph

Failures should become persistent graph objects rather than disconnected log strings.

Useful relationships:

```text
blocks
caused-by
relates-to
duplicates
supersedes
occurred-in
resolved-by
recurred-as
provider-specific
capability-specific
```

Known Phase 7 failure nodes include:

```text
review status contradiction
review budget charged across unrelated workstreams
useful AGENT_FAILED dirty writer had no recovery path
pre-invocation review failure had no reopen primitive
static Event/Chat ownership gap
legacy mislabeled replan evidence
PostgreSQL sandbox limitation
SQL enum parameter inference test defect
Event review structured-output shape failure
```

Goals: cluster recurring failures, measure human interventions, identify hotspots, reuse successful repairs, learn provider weaknesses, and predict avoidable failures before dispatch.

---

## Repository inspirations

Borrow principles, not whole frameworks.

### DeepSeek Harness

```text
structured failure facts
facts separated from retry policy
one owner for retry budget
durable attempt history
provider error normalization
```

### gstack

```text
evidence-first root cause analysis
no fix before root cause
cheap live probes before declaring limitations
prior-investigation recall
recurring-problem hotspots
retrospective learning
```

### Hermes Agent

```text
closed learning loop
repeated corrections -> durable operational knowledge
skills/config/memory can evolve more freely than core runtime
versioned core changes instead of live self-editing
```

### Beads

```text
persistent dependency/failure graph
ready/blocked derived from graph
relations such as duplicates/supersedes/relates-to
long-horizon structured memory
history compaction
```

### Claudex Loop

```text
bounded builder + independent inspector
role-based provider/model selection
proof commands
review/fix budgets
fresh inspection after edits
no silent provider fallback
```

### Herdr

```text
runtime liveness states
working / blocked / idle distinction
background session supervision
real-time indication that an agent needs input
```

### claude-mem / Grok Mem

```text
lifecycle observations
progressive disclosure
searchable cross-session history
token-aware context retrieval
```

---

## Antigravity / Gemini findings

Antigravity CLI 1.2.1 was tested locally on macOS arm64.

Validated:

```text
headless JSON                 PASS
stream-json telemetry         PASS
model discovery               PASS
usage telemetry               PASS
read-only permission control  PASS
fail-closed denial            PASS
workspace-scoped reads        PASS
macOS sandbox                 PASS
bounded write directory       PASS
out-of-scope write denial     PASS
main repo remained untouched  PASS
```

Provider-adapter requirements:

```text
parse stream-json
status=SUCCESS is insufficient alone
inspect denied_actions
classify permission/tool/provider/model failures separately
validate every requested path against ownership
synthesize exact read/write permission rules from TaskSpec
run sandboxed; never --dangerously-skip-permissions in production
persist model/duration/input/output/thinking/cache-read usage
benchmark provider x model x task class empirically
retain Orchestrator post-run git ownership verification
distinguish repository-edit tools from artifact-generation tools
```

Observed critical behavior: Antigravity can return `status: SUCCESS` while a required action was denied. Provider success must therefore include required-output/proof validation.

---

## Versioned self-repair direction

Desired path:

```text
failure
→ Failure Intelligence identifies ORCHESTRATOR_DEFECT
→ isolated self-repair worktree
→ minimal candidate patch
→ reproduce original failure
→ full Orchestrator tests + smoke
→ independent review
→ policy/human authorization as required
→ promote candidate version
→ restart/re-exec
→ resume original durable run
```

Never let the currently running Orchestrator live-edit/hot-reload its own core source.

Longer-term event sourcing should support shadow replay of the same recorded events through current vs candidate Orchestrator versions before promotion.

---

## Future Control Plane / Visual UI

Eventually visualize:

```text
run DAG / dynamic graph
current task states
provider/model per task
working / blocked / idle / stalled
review lineage and round budget
recovery/repair attempts
failure clusters
worktrees/commits
verification progress
provider health/quota/capability
live stream/tool events
human authorization points
```

The UI consumes the event-sourced runtime; it is never the source of truth.

---

## Operational rules for future sessions

1. Inspect persisted run state/events/worktree status before mutation.
2. Never manually edit protected run artifacts.
3. Do not manually commit preserved task worktrees when a canonical recovery primitive should commit them.
4. Treat provider explanations as hypotheses until verified.
5. Prefer the narrowest repair over broad refactors.
6. Preserve raw stdout, handoffs, reviews, checkpoints, and provenance.
7. Fail closed on ambiguity.
8. Do not delete active run worktrees or prune while Phase 7 is unresolved.
9. Avoid provider calls when deterministic probes can classify the failure first.
10. Update this file after every material architectural decision, recovery primitive, roadmap change, or dogfood milestone.
