# Orchestrator Working Context

> Persistent source of truth for continuing Orchestrator development across chats, agents, and context resets.
>
> Read this file first in any future session, but **always inspect live persisted run state/events/worktree state before mutating anything**.

Last updated: 2026-09-12

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
8. Prefer the **smallest proven mechanism** over speculative architecture. Do not turn every useful repository idea into a new subsystem.

### Design restraint / anti-overdesign rule

New architecture must earn its complexity through a concrete dogfood problem.

```text
proven recurring problem
→ smallest deterministic primitive
→ regression coverage
→ real dogfood
→ generalize only if the pattern repeats
```

Prefer extending an existing subsystem over creating a new one when the semantics are the same.

Examples:

```text
Evidence Verifier        -> capability/stage inside Failure Intelligence, not a new agent service
Action Router            -> part of Provider/Action routing, not a separate platform until action count justifies it
Code Intelligence        -> start read-only and local; no heavyweight graph database until blast-radius/context use cases prove value
Agent specialization     -> machine-readable capabilities, not a large persona hierarchy
Runtime traces / ADRs    -> add only when they improve actual repair/routing decisions
Visual graph             -> render existing runtime/code data; never build graph infrastructure only for UI
```

---

## Current live dogfood run

```text
run-20260910100819-8ddbdc28
phase: 7
baseBranch: phase7/chat-realtime-design
orchestrator development branch: orchestrator/final-review-lineage-reset
```

### Current state

Phase 7 product work and both static replans have reached verified canonical state.

```text
Durable Chat                     SUCCEEDED
Event/Chat replan                RESOLVED
Event review retry               SUCCEEDED
Realtime Chat                    SUCCEEDED
Presence                         SUCCEEDED
Composed verification            SUCCEEDED
Testing-origin transport replan  RESOLVED
Full API suite after replan      PASSED
Integration                      PENDING
Phase final review               blocked only by Orchestrator lineage accounting defect
```

Second replan canonical artifacts:

```text
source: phase7-composed-verification
source checkpoint: 691637793ec50f4cf7caab5328b6b54f09eba966
follow-up: replan-2183f1607a8650de1213
follow-up commit: b332e46b296942e7d3006bc1f7f4999feda4f3f2
proposal: 66f6c4e9dd41065a3f8f615b6b4d0d072f88483110fc7e4b78fbc282985ea6b6
replan.phase: RESOLVED
```

Verification for the second replan:

```text
pnpm install --frozen-lockfile                    PASS
pnpm --filter @tripwith/shared build             PASS
pnpm --filter @tripwith/api typecheck            PASS
pnpm --filter @tripwith/api test -- --runInBand  PASS
```

The narrow Transport-only repair was sufficient. Codex had hypothesized that Presence also required a write change, but host verification passed without granting Presence write ownership. This is a key dogfood proof that **provider claims are hypotheses, not facts**.

### Current blocker: final-review lineage overcount

After the second replan resolved, `phase7-final-review` failed **before provider invocation**:

```text
status: FAILED
attempts: 0
reviewRounds: 0
error.code: BLOCKED_FOR_HUMAN_REVIEW
completedRounds: 4
maxReviewRounds: 2
```

`agents:retry-preflight` deterministically reproduced the same incorrect count.

Root cause: `completedReviewRounds()` allowed an unconditioned phase-level final review to inherit four unrelated review roots through the composed-testing join.

Correct semantic rule:

```text
review/final_review/synthesis + explicit reviewOf
  -> continue exactly that review lineage

review/final_review/synthesis + no reviewOf
  -> start a fresh review budget lineage

non-review intermediate tasks
  -> may propagate review lineage

implementation
  -> breaks upstream review lineage
```

Fix:

```text
branch: orchestrator/final-review-lineage-reset
commit: 73d24e0  fix(orchestrator): reset unlinked review lineages
```

Verification:

```text
typecheck: PASS
build: PASS
full Orchestrator tests: 717/717 PASS
smoke: 3/3 PASS
git diff --check: PASS
```

Current next step: independent Claude adversarial review of `73d24e0`. Do **not** run the real `retry-preflight` again until that review approves the safety semantics.

---

## Major Phase 7 lessons / milestones

### First static scope replan succeeded

The Event writer required complementary Chat authorization changes outside its static ownership.

```text
proposal: d75171ce9e43ef28ec89bce27462826bfa1cbcaf7f88541787ba6f2a372f6424
source checkpoint: b324663a719eb519a884117a8a556c98936c0738
follow-up: replan-709cb1086b25fd5da117
follow-up commit: a57c582e4ec4027d6b5bd94b4795d2243563c28c
replan.phase: RESOLVED
```

The dynamic Chat follow-up initially blocked on PostgreSQL verification. Host verification exposed a real SQL integration-test defect rather than accepting the provider's sandbox explanation as truth. After a narrow SQL enum-cast repair, focused and full API tests passed and canonical verification promoted the work.

### Claude read-only review recovery succeeded end-to-end

`phase7-event-chat-review` originally returned prose because Claude read-only execution incorrectly used Plan Mode with only `Read,Glob,Grep` tools.

Root cause:

```text
read_only task
→ --permission-mode plan
→ no plan-writing / ExitPlanMode tools
→ prose response
→ strict structured review validation fails
```

Fix:

```text
commit: 354bc7c36bca76c1584be1068e4c05b8107b422c
read-only mode: --permission-mode dontAsk
read-only tools: Read,Glob,Grep
```

Bounded recovery primitive:

```text
pnpm agents:retry-review-output <run-id> <task-id>
```

Real dogfood:

```text
attempt 1 evidence preserved
retry authorization invoked zero providers
attempt 2 Claude review SUCCEEDED
reviewRounds = 1
normal strict review path preserved
```

### Composed verification exposed multiple failure clusters

The composed suite initially produced five failures with two independent root causes.

```text
same failing suite
├── TEST_FIXTURE_CLEANUP_DEFECT
└── EVENT_REALTIME_AUTHORIZATION_DEFECT
```

Fixture root cause:

```text
users deleted before dependent chat rows
→ messages.sender_user_id ON DELETE SET NULL
→ messages_sender_chk violation
```

Narrow fixture fix:

```text
DELETE tracked matches
DELETE tracked chat_rooms
DELETE tracked users
```

Realtime root cause:

```text
ChatService.authorizeRoom succeeds
→ ChatGateway then hard-rejects EVENT
→ CHAT_ROOM_UNSUPPORTED
```

The verification task correctly refused to edit production Transport code outside ownership.

### Testing-origin static replan + interpretation v2 succeeded

Static Replan v1 originally allowed only implementation writers. Real dogfood proved that a blocked testing writer may also have legitimate partial owned work plus an implementation scope gap.

```text
862cd80  support testing writer replans
```

Safe source modes remain exactly:

```text
implementation | testing
```

The real handoff also contained legacy ambiguity: failed salvage provenance, multiple work requests, overbroad claims, line-suffixed evidence, and file-shaped evidence mislabeled as test evidence.

Rather than weakening validation, Replan Interpretation v2 added explicit immutable human interpretation:

```text
aaf3cb1  add bounded replan interpretation
```

Principle:

```text
raw facts remain immutable
+
human-authorized interpretation is explicit and narrowing-only
+
strict proposal validation remains strict
```

The interpretation selected one work request, kept Transport write, downgraded Presence to read, canonicalized path:line references, and normalized file-shaped test evidence. The resulting replan completed successfully.

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
354bc7c  Claude read-only mode + bounded structured-review retry
862cd80  testing-writer replan source support
aaf3cb1  bounded replan interpretation + explicit salvage lifecycle
73d24e0  reset unlinked review lineages (awaiting independent review before real-run recovery)
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
agents:finalize-failed-salvage
agents:interpret-replan
agents:propose-replan
agents:authorize-replan
agents:resume
```

Design rule: preserve evidence and provenance; prefer deterministic recovery; never convert an unverified failure into success.

---

## Core architectural rules

### Provider claims are hypotheses, not facts

```text
agent claim
→ evidence probe
→ observed facts
→ classification
→ recovery/repair policy
```

Examples:

- PostgreSQL sandbox claim -> host verification exposed a real SQL test defect.
- Composed DB/Redis claim -> host probes and host verification exposed real fixture/Transport defects.
- Presence-write claim -> host verification passed without Presence modification, refuting the speculative claim.

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
read-only Claude Plan Mode bug    -> Orchestrator repair + bounded retry
static ownership gap              -> authorized replan
```

### Failure clustering matters

One failed command or suite may contain multiple root causes. Never issue a generic "fix all failing tests" repair without clustering evidence first.

### Dynamic work uses the same safety machinery

Dynamic replan tasks use normal ownership, worktrees, verification, provenance, locks, review, salvage, and recovery. No special bypass path.

### Host verification is first-class

Capability-aware policy should eventually know when sandbox verification is insufficient and schedule host validation directly.

### Facts, interpretation, policy, and action are separate

```text
Raw Facts
  handoffs / events / logs / git state
        ↓
Authorized Interpretation
  narrowing / canonicalization only
        ↓
Policy
  risk / ownership / retry / routing
        ↓
Action
  retry / verify / repair / replan / escalate
```

Do not derive mutation directly from free-form provider prose.

---

## Active roadmap

Keep the roadmap incremental; several items are capabilities inside existing subsystems, not necessarily separate services.

```text
1. Finish Phase 7 dogfood
2. Health / Capability Plane
3. Failure Facts + Evidence Probe Layer
4. Code Intelligence primitives (freshness-bound, read-only first)
5. Failure Intelligence
6. Failure Memory / Failure Graph
7. Event-Sourced Runtime
8. Recovery Controller
9. Bounded Repair Controller
10. Provider / Action Router
11. Task / Dispatch separation
12. Dynamic Plan IR / Graph
13. Versioned Self-Repair Framework
14. Context Triage / Long-term Operational Memory
15. Adaptive Review Policy
16. Control Plane / Visual UI
```

Reliability, diagnosis, and safe repair come before UI polish.

Do not implement roadmap items merely because they sound architecturally clean. Implement them when a repeated dogfood failure or scaling constraint creates measurable value.

---

## Failure Intelligence direction

Failure Intelligence is a **core subsystem**.

### Failure Facts

Persist machine-readable observations separately from policy decisions. Do not put subjective policy such as `retryable: true` into raw facts.

Useful facts:

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
RAW_ARTIFACT_AMBIGUITY
REVIEW_BUDGET_ACCOUNTING
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

## Code Intelligence direction

The newest repository research suggests adding **incremental Code Intelligence**, but only where it directly improves existing decisions.

Primary use cases:

```text
changed files/symbols
→ callers/dependencies
→ blast radius
→ ownership/context suggestions
→ risk classification
→ verification selection
```

Initial implementation should be lightweight and read-only:

```text
Git diff / worktree fingerprints
+ deterministic parser/index where useful
+ dependency/call/import relationships
+ exact freshness binding to HEAD + diff/tree fingerprints
```

Do not begin with a heavyweight persistent graph database unless repository scale or repeated queries justify it.

### Freshness invariant

Any structural analysis used for mutation decisions must be bound to the exact source state:

```text
HEAD
+
trackedDiffFingerprint
+
treeFingerprint
```

Stale code intelligence must fail closed or be refreshed.

### Adaptive verification

Longer term, blast radius can help choose verification scope:

```text
small isolated change
→ focused tests

shared authorization / transport / cross-service change
→ focused + integration + full regression + independent review
```

Static analysis is evidence, not proof. Runtime traces may be added later only if they materially improve decisions that static analysis cannot resolve.

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
final-review lineage overcount through composed join
useful AGENT_FAILED dirty writer had no recovery path
pre-invocation review failure had no reopen primitive
static Event/Chat ownership gap
legacy mislabeled replan evidence
raw handoff ambiguity requiring authorized interpretation
PostgreSQL sandbox limitation
SQL enum parameter inference test defect
Claude read-only Plan Mode / structured-output failure
composed fixture cleanup ordering defect
EVENT realtime transport obsolete unsupported-room guard
second static scope gap: composed verification -> chat transport
```

Goals: cluster recurring failures, measure human interventions, identify hotspots, reuse successful repairs, learn provider weaknesses, and predict avoidable failures before dispatch.

---

## Provider / Action Router direction

Do not build a standalone routing platform prematurely.

Near-term router responsibilities should remain simple:

```text
Failure Facts + task requirements
        ↓
Health / Capability Plane
        ↓
small candidate set of providers/actions
        ↓
main policy/reasoning decision
```

As the recovery/action catalog grows, a cheap local confidence-gated selector may reduce context and cost by ranking the top candidate actions before invoking an expensive reasoning model.

Safety rule:

```text
low-confidence routing
→ no mutation
→ escalate to stronger reasoning / human policy
```

This is an optimization layer, not a source of truth.

---

## Agent capability registry

Represent specialization as machine-readable capabilities rather than a large persona library.

Example shape:

```text
provider/model
supported task classes
repository read/write capability
sandbox/network/database capability
structured-output reliability
observed latency/cost/quality
risk ceiling
required verification strength
```

Use this inside the existing Health / Capability Plane and Provider Router. Do not create a separate agent-persona framework unless real routing data proves the need.

---

## Evidence Verifier direction

Formalize the pattern already proven by Phase 7:

```text
provider claim
→ independent deterministic probe
→ VERIFIED | REFUTED | UNKNOWN
```

This should be a capability/stage inside Failure Intelligence, not necessarily a standalone agent.

Examples:

```text
"DB unavailable"       -> host TCP/service probe + canonical test
"Presence must change" -> run verified narrow repair first
"review is approved"   -> strict structured output validation
```

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

### Graft

Use selectively:

```text
deterministic structural code graph
callers / dependencies / blast radius
freshness-aware analysis of uncommitted worktree changes
small context maps for agents
```

Do not adopt a graph backend merely for visualization. The graph earns its cost only if it improves context selection, repair risk, ownership, or verification decisions.

### codebase-memory-mcp

Useful ideas:

```text
change-impact analysis
architecture/call relationships
cross-service edges
optional runtime evidence
architecture decision memory
```

Start with static read-only value. Runtime traces and richer persistent architecture memory are later additions only if they solve repeated ambiguity.

### Needle

Useful routing ideas:

```text
tool/action retrieval instead of exposing the entire catalog
confidence-gated selection
cheap local routing before expensive reasoning
facts separated from instructions
```

Do not add a local model merely because it is available. Add one only when the action/tool catalog becomes large enough that routing cost/context becomes measurable.

### agency-agents

Useful patterns:

```text
capability/specialist catalog
independent evidence/reality checking
separation between builder and verifier roles
```

Adopt capabilities as structured metadata, not dozens of persona prompts.

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

Longer-term event sourcing may support shadow replay of recorded events through current vs candidate Orchestrator versions, but only implement this when self-repair dogfood proves the need.

---

## Future Control Plane / Visual UI

Eventually visualize existing runtime facts:

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

The UI consumes the runtime/event model; it is never the source of truth.

Do not build additional graph/storage infrastructure solely to power the UI.

---

## Operational rules for future sessions

1. Inspect persisted run state/events/worktree status before mutation.
2. Never manually edit protected run artifacts.
3. Do not manually commit preserved task worktrees when a canonical recovery/replan primitive should own the commit.
4. Treat provider explanations as hypotheses until verified.
5. Prefer the narrowest repair over broad refactors.
6. Preserve raw stdout, handoffs, reviews, checkpoints, interpretations, and provenance.
7. Fail closed on ambiguity.
8. Do not delete active run worktrees or prune while Phase 7 is unresolved.
9. Avoid provider calls when deterministic probes can classify the failure first.
10. Separate multiple failure clusters before choosing a repair.
11. Never fix an out-of-ownership production defect inside a verification/test-only task; use authorized replan.
12. Prefer extending an existing capability over adding a new subsystem when semantics overlap.
13. Do not implement repository-inspired architecture until a concrete dogfood/use-case justifies its complexity.
14. Update this file after every material architectural decision, recovery primitive, roadmap change, or dogfood milestone.
