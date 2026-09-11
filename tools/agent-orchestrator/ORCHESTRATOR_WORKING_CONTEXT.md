# Orchestrator Working Context

> Persistent source of truth for continuing Orchestrator development across chats, agents, and context resets.
>
> **Update this file after every material architectural decision, recovery primitive, roadmap change, or dogfood milestone.**
>
> Last updated: 2026-09-11

## Continuation prompt

When continuing this project in a fresh session, read this file first and treat it as the current working context. Do not assume the latest Phase 7 run state from this document alone; inspect the persisted run before mutating anything.

The project priority is the **agent orchestrator itself**, not the Travel App feature work. The Travel App is primarily the dogfood workload used to expose orchestration failures, recovery gaps, scheduling bugs, provider limitations, verification problems, and opportunities for adaptive repair.

Primary goals:

1. Make the orchestrator highly reliable and fail-closed.
2. Reduce human intervention by diagnosing failures automatically.
3. Add bounded, evidence-driven recovery and repair rather than hard-coded one-off commands.
4. Support multiple providers/models with capability- and health-aware routing.
5. Move toward a dynamic graph / Plan IR instead of a rigid static pipeline.
6. Eventually support **versioned self-repair** of the orchestrator itself, never unsafe live self-modification.
7. Add a visual Control Plane only after runtime reliability, diagnosis, repair, and routing are strong.

---

## Current live dogfood run

Run:

```text
run-20260910100819-8ddbdc28
```

Phase: `7`

Base branch recorded by the run:

```text
phase7/chat-realtime-design
```

Current Orchestrator development branch:

```text
orchestrator/replan-evidence-normalization
```

Current branch tip when this file was created:

```text
c6cd427 feat(orchestrator): normalize replan evidence
```

### Last confirmed Phase 7 milestone

The authorized static scope replan for `phase7-event-chat-integration` successfully created and ran a dynamic Chat follow-up:

```text
replan-709cb1086b25fd5da117
```

The source Event checkpoint is:

```text
b324663a719eb519a884117a8a556c98936c0738
```

The dynamic follow-up initially blocked on host PostgreSQL verification. Investigation proved that the DB environment was healthy and exposed a real test setup bug in:

```text
apps/api/src/chat/event-chat.int-spec.ts
```

Root cause: PostgreSQL inferred conflicting types for `$2` because it was reused in an `event_status` assignment and an untyped comparison. The narrow fix explicitly cast `$2` and `'COMPLETED'` to `event_status`.

After correction:

```text
focused integration suite: 14/14 passed
full API suite: 74 suites / 639 tests passed
```

Canonical host verification then succeeded and created:

```text
a57c582e4ec4027d6b5bd94b4795d2243563c28c
```

for task:

```text
replan-709cb1086b25fd5da117
```

Immediately after that, the user started:

```bash
pnpm agents:resume run-20260910100819-8ddbdc28
```

**Do not assume its outcome. First run `pnpm agents:status run-20260910100819-8ddbdc28` or inspect persisted state/events.**

---

## Important Orchestrator hardening already completed

Key commits, in chronological architectural order:

```text
1575c36  review status normalization
5283e71  salvage useful dirty AGENT_FAILED writers + resumability
9ce6299  review budget scoped by lineage, not whole DAG ancestry
eaed966  safe retry of eligible pre-invocation review failures
c2701c6  stale preflight lock cleanup race hardening
f170d54  authorized static scope-gap replanning
aef8c50  strict replan evidence + ownership hardening
c6cd427  explicit normalization of legacy mislabeled replan evidence
```

Notable recovery primitives currently available:

```text
agents:recover-handoffs
agents:resume
agents:verify-blocked-task
agents:salvage-task
agents:retry-preflight
agents:propose-replan
agents:authorize-replan
agents:normalize-replan-evidence
```

Design rule: preserve evidence and provenance; prefer deterministic recovery; never silently convert an unverified failure into success.

---

## Lessons from Phase 7 dogfood

### 1. Provider claims are evidence, not truth

Agents repeatedly reported environmental explanations that later proved incomplete. Example: PostgreSQL was reported as sandbox-blocked, but host verification exposed a real SQL integration-test defect.

Future diagnosis must use:

```text
agent claim
→ evidence probe
→ observed facts
→ classification
→ repair/recovery policy
```

Never classify a material failure solely from provider prose.

### 2. Separate Recovery from Repair

```text
Recovery = continue safely without changing implementation
Repair   = change implementation, policy, config, test, or orchestrator code
```

Examples:

```text
quota exhaustion                  → recovery / reroute
useful dirty AGENT_FAILED writer  → recovery / salvage
blocked DB verification           → recovery / host verification
bad SQL integration test          → bounded repair
review-lineage algorithm defect   → orchestrator self-repair candidate
```

### 3. Dynamic work must still use the same safety machinery

Dynamic replan follow-ups should use the same ownership, worktree, provenance, verification, salvage, review, and mutation locks as static tasks. Avoid special bypass paths.

### 4. Host verification is a first-class validation tier

Sandbox verification may be incomplete. A future policy should know capability limits in advance and schedule host verification deliberately rather than discovering them by failure every time.

---

## Active roadmap

The agreed direction is:

```text
1. Finish Phase 7 dogfood
        ↓
2. Health / Capability Plane
        ↓
3. Failure Facts + Evidence Probe Layer
        ↓
4. Failure Intelligence
        ↓
5. Failure Memory / Failure Graph
        ↓
6. Event-Sourced Runtime
        ↓
7. Recovery Controller
        ↓
8. Bounded Repair Controller
        ↓
9. Provider Router
        ↓
10. Task / Dispatch separation
        ↓
11. Dynamic Plan IR / Graph
        ↓
12. Versioned Self-Repair Framework
        ↓
13. Context Triage / Long-term Operational Memory
        ↓
14. Adaptive Review Policy
        ↓
15. Control Plane / Visual UI
```

Some items overlap and may be developed together, but reliability and diagnosis come before UI polish.

---

## Failure Intelligence design direction

Failure Intelligence is now considered a **core subsystem**, not a side feature.

### Failure Facts

Persist machine-readable observations separately from policy decisions.

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
line: 84
databaseReachable: true
```

Do not encode subjective policy such as `retryable: true` directly into raw failure facts.

### Evidence probes

The system should be able to run bounded probes before declaring a cause:

```text
logs
focused tests
git state
provider health
DB reachability
permission/sandbox capability
schema inspection
previous failure history
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
OWNERSHIP_GAP
PLAN_GAP
RECOVERY_GAP
ORCHESTRATOR_DEFECT
UNKNOWN
```

The taxonomy should evolve from evidence rather than become a rigid closed enum too early.

### Repair Planner

After diagnosis, choose the narrowest safe action:

```text
existing deterministic recovery
provider reroute
host verification
bounded config adjustment
bounded project correction
replan
self-repair candidate
human escalation
```

### Risk-aware verification

Example policy:

```text
low-risk test-only repair
→ focused test
→ full suite

medium-risk implementation repair
→ focused proof
→ full suite
→ independent review

high-risk architecture / orchestrator repair
→ deterministic reproduction
→ full suite + smoke
→ independent provider review
→ explicit authorization
```

---

## Failure Memory / Graph

Failures should become persistent graph objects rather than disconnected log strings.

Suggested relationships:

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

Example nodes from Phase 7 history:

```text
review status contradiction
review budget charged across unrelated workstreams
useful AGENT_FAILED dirty writer had no recovery path
pre-invocation review failure had no reopen primitive
static scope gap between Event and Chat ownership
legacy mislabeled replan evidence
PostgreSQL sandbox EPERM
SQL enum parameter inference failure
```

Goals:

```text
cluster recurring failures
measure human interventions
identify architectural hotspots
reuse successful repairs
learn provider-specific weaknesses
predict avoidable failures before dispatch
```

---

## Repository inspirations and what to borrow

Do not copy whole frameworks. Extract useful design principles.

### DeepSeek Harness

Use for:

```text
structured failure facts
separation of facts from retry policy
single owner of retry budget
explicit durable attempt history
provider error normalization
```

### gstack

Use for:

```text
evidence-first root cause methodology
"no fix before root cause"
cheap live probe before declaring limitation
prior-investigation recall
recurring-problem hotspots
retrospective learning
```

### Hermes Agent

Use for:

```text
closed learning loop
turn repeated corrections into durable operational knowledge
skills/config/memory can improve more freely than immutable core runtime
versioned core change instead of live self-edit
```

### Beads

Use for:

```text
persistent dependency/failure graph
ready/blocked state derived from graph
relations such as duplicates / supersedes / relates-to
structured long-horizon memory
history compaction
```

### Claudex Loop

Use for:

```text
bounded builder / independent inspector separation
role-based model routing
proof commands
review/fix budgets
fresh inspection after later edits
no silent provider fallback
```

### Herdr

Use for:

```text
runtime liveness states
working / blocked / idle distinction
background session supervision
real-time indication of agents waiting for input
```

### claude-mem / Grok Mem

Use for:

```text
lifecycle-hook observations
progressive disclosure of historical context
searchable cross-session project history
token-aware retrieval instead of dumping all history into context
```

### gstack / other specialist-role systems

Potential later use for role-specific diagnosis, QA, security, architecture, and release specialists, but the Orchestrator should own the graph and policy rather than delegating its control plane to a prompt framework.

---

## Antigravity / Gemini provider findings

Antigravity CLI 1.2.1 was installed and tested locally on macOS arm64.

Observed models included Gemini Flash/Pro variants plus Claude and GPT-OSS through the Antigravity runtime.

Validated capabilities:

```text
headless JSON output                 ✅
stream-json telemetry                ✅
model discovery                      ✅
usage telemetry                      ✅
read-only permission enforcement     ✅
fail-closed permission denial        ✅
workspace-scoped reads               ✅
macOS sandbox                        ✅
bounded write directory              ✅
out-of-scope write denial            ✅
main repo remained untouched         ✅
```

Important adapter requirements discovered experimentally:

```text
1. Parse stream-json, not only final stdout.
2. `status: SUCCESS` is insufficient by itself.
3. Inspect `denied_actions`.
4. Distinguish permission/tool/provider/model failures.
5. Validate every requested path against authorized workspace/ownership.
6. Generate exact read/write permission rules from TaskSpec ownership.
7. Run with sandbox; never use --dangerously-skip-permissions in production.
8. Persist model, duration, input/output/thinking/cache-read token usage.
9. Benchmark provider × model × task class empirically.
10. Keep Orchestrator post-run git ownership verification mandatory.
11. Distinguish repository-edit tools from artifact-generation tools.
12. Flash Low may be sufficient for health probes / cheap inspection tasks.
```

Critical observed behavior:

```text
Antigravity can return status = SUCCESS
while required actions were denied.
```

Therefore provider result validation must include denied actions and required output/proof presence.

---

## Self-repair direction

Desired end state:

```text
failure
→ diagnosis
→ detect ORCHESTRATOR_DEFECT
→ create isolated self-repair worktree
→ agent produces minimal patch
→ reproduce original failure
→ full orchestrator tests + smoke
→ independent review
→ explicit policy/human authorization when risk requires it
→ promote new orchestrator version
→ resume durable original run
```

Never allow the currently running orchestrator process to live-edit and hot-reload its own core source.

Prefer:

```text
Supervisor/runtime vN
        ↓
Candidate vN+1 in isolation
        ↓
verification / shadow replay
        ↓
promotion
        ↓
restart/re-exec from durable state
```

Event sourcing should eventually make shadow replay possible: compare old and candidate versions against the same recorded event stream before promotion.

---

## Future Control Plane / Visual UI

The visual layer is useful but secondary to runtime correctness.

Eventually show:

```text
run graph / DAG
current task states
provider + model per task
working / blocked / idle / stalled
review lineage and round budget
recovery / repair attempts
failure clusters
worktrees and commits
verification progress
provider health / quota / capability
live stream-json/tool events
human authorization points
```

The UI should consume the same event-sourced runtime and never become the source of truth.

---

## Operational rules for future sessions

1. **Inspect before mutate.** Read persisted run state/events/worktree status before recovery actions.
2. **Do not manually edit protected Phase 7 run artifacts.** Use supported recovery/replan primitives.
3. **Do not manually commit preserved task worktrees when a canonical recovery primitive is expected to commit them.**
4. **Treat provider explanations as hypotheses until verified.**
5. **Prefer narrow repair over broad refactor.**
6. **Preserve original stdout, handoffs, run evidence, checkpoints, and provenance.**
7. **Fail closed on ambiguity.**
8. **Do not delete active run worktrees or run `git worktree prune` while Phase 7 is unresolved.**
9. **Avoid wasting provider quota on failures that deterministic probes can classify first.**
10. **Update this file after material decisions so future sessions can recover context from GitHub.**
