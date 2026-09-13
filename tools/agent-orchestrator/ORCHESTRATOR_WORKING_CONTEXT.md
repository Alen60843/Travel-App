# Orchestrator Working Context

> Persistent source of truth for continuing Orchestrator development across chats, agents, and context resets.
>
> Read this file first in any future session, but **always inspect live persisted run state/events/worktree state before mutating anything**.

Last updated: 2026-09-13

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
orchestrator development branch: orchestrator/review-correction-continuation
```

### Current blocker: final review requested a narrow Presence correction

The lineage fix at `73d24e0` allowed the real final review to run. Its accepted
structured result is `changes_requested`, with one medium correctness finding
(`F001`) proving that `PresenceService.authorize` still rejects every EVENT room
after both callers pass `ChatService` authorization. The review contains exactly
one correction request:

```text
write apps/api/src/chat/presence/**
read  apps/api/src/chat/chat.service.ts
```

The bounded implementation on `orchestrator/review-correction-continuation` adds
explicit `agents:authorize-review-correction`, one hash-bound dynamic correction
writer, deterministic host verification, immutable round artifacts, and same-task
round-2 reopening without resetting the lineage budget.

Read-only assessment on 2026-09-13 confirmed the real run is structurally eligible:
the artifact hash is `b2c6e4f661bd76cc40a0a7551cca56f5188cda2c80831b7cbeb8a296e65e60ff`,
the review worktree is clean at its persisted prepared HEAD, ordered code-input
history matches, both replans are `RESOLVED`, integration is untouched `PENDING`,
the provider PID is dead, and exactly one of two review rounds remains. No real
authorization, resume, recovery, or replan command was executed.

### Major Phase 7 milestone: first static scope replan succeeded

The original Event writer `phase7-event-chat-integration` hit a legitimate ownership gap: Event work required complementary Chat authorization changes outside its static ownership.

An explicit human-authorized static replan was created:

```text
proposal: d75171ce9e43ef28ec89bce27462826bfa1cbcaf7f88541787ba6f2a372f6424
source checkpoint: b324663a719eb519a884117a8a556c98936c0738
dynamic follow-up: replan-709cb1086b25fd5da117
follow-up commit: a57c582e4ec4027d6b5bd94b4795d2243563c28c
```

A legacy mislabeled evidence entry (`kind: test` containing a repository file path) was normalized explicitly to file evidence without modifying the original handoff.

The dynamic Chat follow-up initially blocked on PostgreSQL verification. Host verification exposed a real test setup defect: PostgreSQL could not infer `$2` consistently because an integration test reused it both as `event_status` and in an untyped comparison. The preserved worktree was corrected narrowly with explicit `event_status` casts.

Verification after that repair:

```text
focused integration test: 14/14 passed
full API suite: 74 suites / 639 tests passed
```

Canonical `verify-blocked-task` produced the follow-up commit, and the next `agents:resume` completed the replan:

```text
phase7-event-chat-integration.status = SUCCEEDED
phase7-event-chat-integration.commit = b324663a719eb519a884117a8a556c98936c0738
replan.phase = RESOLVED
composed replan verification = PASSED
```

### Major Phase 7 milestone: Claude read-only review recovery succeeded end-to-end

`phase7-event-chat-review` originally failed even though the Claude process succeeded:

```text
status = FAILED
error.code = REVIEW_BLOCKED
error.message = "review: must be an object"
attempt 1 outcome = succeeded
reviewRounds = 0
```

Raw stdout proved Claude had completed the review reasoning and intended `approved`, but it had been placed in Claude Plan Mode while only `Read,Glob,Grep` were available. The adapter conflated read-only capability with Plan Mode workflow semantics.

Root cause:

```text
read_only task
→ --permission-mode plan
→ tools restricted to Read,Glob,Grep
→ Claude expects plan-file / ExitPlanMode workflow
→ cannot complete Plan Mode
→ returns prose instead of structured review
```

Orchestrator fix on branch `orchestrator/claude-readonly-review-retry`:

```text
commit: 354bc7c36bca76c1584be1068e4c05b8107b422c
read-only Claude mode: --permission-mode dontAsk
read-only tools: Read,Glob,Grep
writer behavior: unchanged
```

A bounded explicit recovery primitive was added:

```text
pnpm agents:retry-review-output <run-id> <task-id>
```

It preserves attempt 1/stdout/provenance, invokes zero providers during authorization, allows one retry, reopens only attributable pristine descendants, and requires the retry to pass through the normal strict review path.

Real dogfood result:

```text
retry-review-output authorization: PASSED
phase7-event-chat-review attempt 2: SUCCEEDED
reviewRounds: 1
phase7-event-chat-correction: SKIPPED
phase7-event-chat-final-review: SKIPPED
```

This proves the complete sequence:

```text
real provider-adapter defect
→ evidence-first diagnosis
→ Orchestrator code repair
→ independent adversarial review
→ bounded retry authorization
→ original evidence preserved
→ second real provider invocation
→ strict structured-review validation
→ scheduler continuation
```

Failure classification to remember:

```text
ORCHESTRATOR_DEFECT
└── PROVIDER_ADAPTER_MODE_MISMATCH
    └── STRUCTURED_OUTPUT_FAILURE
```

### Prior blocker: Phase 7 composed verification exposed two independent defects

`phase7-composed-verification` ran after Event review succeeded. Codex added seven composed integration cases inside its declared ownership and blocked with `REVIEW_BLOCKED` because live verification could not complete inside its sandbox.

Host probes proved infrastructure was healthy:

```text
PostgreSQL 127.0.0.1:5432      reachable / healthy
Redis queue 127.0.0.1:6379     reachable / healthy
Redis cache 127.0.0.1:6380     reachable / healthy
```

Canonical `verify-blocked-task` then ran the real host verification:

```text
pnpm install --frozen-lockfile                       PASS
pnpm --filter @tripwith/shared build                PASS
pnpm --filter @tripwith/api typecheck               PASS
pnpm --filter @tripwith/api test -- --runInBand     FAIL
```

Result:

```text
75 suites total
74 passed
1 failed
646 tests total
641 passed
5 failed
only failing suite: test/phase7-chat-realtime/composed.int-spec.ts
```

The failures split into **two distinct clusters** and must not be treated as one generic failure.

#### Cluster A — TEST_FIXTURE_CLEANUP_DEFECT

Three composed tests failed only during teardown. Root cause:

```text
cleanup deleted users before chat rooms/messages
→ messages.sender_user_id ON DELETE SET NULL
→ non-SYSTEM messages temporarily had sender_user_id = NULL
→ messages_sender_chk rejected the row state
```

Additional constraint: Match rooms cannot simply be deleted first because `matches.chat_room_id` uses `ON DELETE RESTRICT`.

Authorized fixture correction inside the preserved composed-verification worktree:

```text
DELETE tracked matches by chat_room_id
DELETE tracked chat_rooms       # cascades messages/memberships
DELETE tracked users
```

Codex verified the unaffected composed cases after this correction. No commit was created.

#### Cluster B — EVENT_REALTIME_AUTHORIZATION_DEFECT / second scope gap

Both EVENT composed cases fail at the first realtime `chat:join` for approved Event host/member (`manual=true` and `manual=false`).

Complete wire payload:

```json
{"ok":false,"error":{"code":"CHAT_ROOM_UNSUPPORTED","message":"Event chat is not available yet."}}
```

Evidence trace:

```text
ChatGateway.authorize
→ ChatService.authorizeRoom succeeds
→ ChatService already enforces Event membership/lifecycle/account policy
→ ChatGateway then unconditionally rejects room.type === 'EVENT'
→ valid approved Event host/member cannot join realtime chat
```

Presence is not involved in this initial `chat:join` rejection.

The obsolete guard is in:

```text
apps/api/src/chat/transport/chat.gateway.ts
```

Required production ownership:

```text
apps/api/src/chat/transport/**
```

But `phase7-composed-verification` owns only:

```text
apps/api/test/phase7-chat-realtime/**
```

Therefore Codex correctly **did not edit production code** and reported a second real static ownership gap. The next canonical action is to use the existing authorized static-scope replanning mechanism rather than bypass ownership.

Current preserved composed-verification worktree contains only the authorized fixture cleanup/test work and remains uncommitted for canonical recovery/replan handling.

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
354bc7c  fix Claude read-only mode + bounded structured-review retry
```

Current recovery/replan primitives include:

```text
agents:recover-handoffs
agents:retry-agent
agents:salvage-task
agents:verify-blocked-task
agents:retry-preflight
agents:retry-review-output
agents:normalize-replan-evidence
agents:propose-replan
agents:authorize-replan
agents:resume
```

Design rule: preserve evidence and provenance; prefer deterministic recovery; never convert an unverified failure into success.

---

## Core architectural lessons

### Provider claims are hypotheses, not facts

```text
agent claim
→ evidence probe
→ observed facts
→ classification
→ recovery/repair policy
```

Examples from Phase 7:

- “PostgreSQL blocked by sandbox” was not accepted as truth; host verification exposed a real SQL test defect.
- “PostgreSQL/Redis connection failures” from composed verification were followed by host health probes and canonical host verification, which exposed a real realtime Event guard plus a fixture cleanup defect.

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
read-only Claude Plan Mode bug     -> Orchestrator repair + bounded retry
static ownership gap              -> authorized replan
```

### Failure clustering matters

One failed command or suite may contain multiple root causes. Do not issue a generic “fix all failing tests” repair.

The composed suite demonstrated:

```text
same failing suite
├── TEST_FIXTURE_CLEANUP_DEFECT
└── EVENT_REALTIME_AUTHORIZATION_DEFECT
```

Failure Intelligence must cluster failures before selecting repairs.

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

Persist machine-readable observations separately from policy decisions. Do not put subjective policy such as `retryable: true` into raw facts.

Useful facts include:

```text
source
command
exitCode
provider/process outcome
passing/failing suites and tests
error class/code
file/line
DB/Redis reachability
worktree/git state
ownership scope
structured-output validity
provider capability/quota state
```

### Evidence probes

```text
logs
focused tests
git state
provider health/quota
DB/Redis reachability
permission/sandbox capability
schema inspection
previous failure history
structured-output inspection
exact wire/API payloads
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
TEST_FIXTURE_CLEANUP_DEFECT
STRUCTURED_OUTPUT_FAILURE
PROVIDER_ADAPTER_MODE_MISMATCH
EVENT_REALTIME_AUTHORIZATION_DEFECT
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
Claude read-only Plan Mode / structured-output failure
composed fixture cleanup ordering defect
EVENT realtime transport obsolete unsupported-room guard
second static scope gap: composed verification -> chat transport
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
3. Do not manually commit preserved task worktrees when a canonical recovery/replan primitive should own the commit.
4. Treat provider explanations as hypotheses until verified.
5. Prefer the narrowest repair over broad refactors.
6. Preserve raw stdout, handoffs, reviews, checkpoints, and provenance.
7. Fail closed on ambiguity.
8. Do not delete active run worktrees or prune while Phase 7 is unresolved.
9. Avoid provider calls when deterministic probes can classify the failure first.
10. Separate multiple failure clusters before choosing a repair.
11. Never fix an out-of-ownership production defect inside a verification/test-only task; use authorized replan.
12. Update this file after every material architectural decision, recovery primitive, roadmap change, or dogfood milestone.
