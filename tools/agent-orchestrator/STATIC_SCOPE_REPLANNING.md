# Static scope-gap replanning

This host CLI recovery flow completes partial work when a blocked static implementation or testing writer's accepted handoff requests a bounded implementation outside its ownership. It retains the static strategy and the frozen `phase.yaml`. It neither uses AdaptiveCoordinator nor accepts arbitrary DAG edits.

```sh
pnpm agents:propose-replan <run-id> <source-task-id>
# Inspect the complete returned proposal, including follow-up files, downstream
# dependency/ownership patches, evidence, risk, and verification commands.
pnpm agents:authorize-replan <run-id> <proposal-id>
pnpm agents:resume <run-id>
```

For a legacy handoff that needs bounded interpretation, authorize a content-hashed record first with `pnpm agents:interpret-replan <run-id> <source-task-id> <interpretation-file>`. A legacy salvage attempt whose event and command logs prove a terminal required-command failure must first be finalized with `pnpm agents:finalize-failed-salvage <run-id> <source-task-id>`. Both commands invoke zero providers and leave the source worktree and handoff untouched.

Proposal and authorization invoke no providers and execute no tasks. Proposal **does persist metadata and an event**, so it is not a wholly read-only command. Authorization creates a source checkpoint; only subsequent normal execution runs the follow-up and verification. Every risk level, including high/critical, requires an explicit host authorization call. No handoff field or agent-produced draft can grant authority. These are local operator commands, not an authenticated multi-user service.

## Proposal contract

V1 requires all of the following:

- A `BLOCKED` static run with no integration history/worktree, running/ready tasks, unfinished attempts, or live recorded agent PIDs. Pristine pending tasks whose dependencies remain unsatisfied are allowed.
- A blocked `implementation` writer with `REVIEW_BLOCKED`, a completed successful process attempt, a valid blocked handoff, a registered worktree, a prepared HEAD, and no canonical commit. A salvage-bearing source must carry an exact terminal `FAILED` record; verified, authorized, verifying, and ambiguous legacy salvage remains ineligible.
- The exact canonical `handoffs/<source-id>.json` path must equal the source's persisted `handoffPath`. The artifact must be a bounded regular file, with no symlink escape. Raw bytes are SHA-256 hashed and parsed through the existing handoff/WorkRequestDraft schemas.
- Exactly one additional implementation request, unless a v2 interpretation explicitly selects one raw request by index. Only repository resource claims are supported. Write claims become follow-up ownership and must be nonempty and disjoint from source ownership. Read claims remain explicit context, not write permission. Request dependencies must be existing source ancestors. Evidence must identify in-scope worktree files or an exactly matching handoff test whose persisted result is `pass`; failed, not-run, missing, unsafe, or unsupported references fail closed.
- All source ancestors are successful or legitimately skipped. The prepared history must reproduce those canonical input patches. HEAD must still equal the prepared checkpoint. The nonempty dirty candidate must stay inside source ownership and match the handoff's changed-file set.
- The source must have an existing direct downstream review. Reviews receiving a new dependency and their direct future correction tasks receiving union ownership must have no attempts, preparation, worktree, commit, artifacts, review rounds, or recovery evidence. They must be dependency-failure blocked or pending.
- The complete proposed effective graph passes TaskGraph and parallel ownership checks. Required `salvage.verify` commands must already be configured; agent prose never supplies executable verification commands.

The immutable proposal includes the normalized request, source artifact path/hash, prepared HEAD, dirty-diff fingerprint, full candidate Git-tree fingerprint, original source error, source-state hash, current config/task/integration context hash, the complete overlay, and pinned prepare/verify commands. Its ID is the SHA-256 of the canonical body. Repeated identical proposals are deduplicated.

Follow-up identity is deterministic. It inherits the source's static owner/model/effort/timeout; there is no new routing or capability discovery. Requested capabilities, risk, reason, and evidence remain visible in the proposal. The operator must inspect these alongside the chosen executor and required verification.

## Evidence normalization

Historical blocked handoffs may label a repository test-file path as `test` evidence. The explicit host command `pnpm agents:normalize-replan-evidence <run-id> <task-id> <evidence-index> file` records the only supported correction: `test -> file`. It does not edit the handoff, run a task, invoke a provider, or create a commit.

The command uses the shared run mutation lock and requires the same static, untouched-integration, quiescent, blocked-source eligibility as proposal creation. It refuses when the reference exactly matches any persisted handoff test command, regardless of that test's result. The unchanged reference must normalize to a repository path, resolve to a regular non-symlink file in the registered source worktree, remain inside existing evidence scope, and appear in the handoff's changed-file evidence.

Each append-only record is content-addressed over its source task, exact handoff SHA-256, request and evidence indexes, original evidence hash, unchanged reference, fixed reason `TEST_REFERENCE_IS_REPOSITORY_PATH`, prepared HEAD, and dirty-tree fingerprints. Proposal derivation revalidates that record against the immutable raw handoff and current worktree, changes only the in-memory evidence kind, then sends the derived request through ordinary strict file-evidence validation. The proposal hash includes the normalization ID. Authorization re-derives that identity; a removed, changed, stale, or mismatched record fails closed.

## Interpretation v2 and failed salvage provenance

V2 retains the raw handoff as the source of facts and stores a separate append-only human authorization. Its identity binds the run and source, handoff SHA-256, prepared HEAD, tracked diff and tree fingerprints, selected request index and original request hash, exact selected claims, and ordered evidence transformations. The proposal body includes the interpretation ID, and authorization recomputes the proposal from the raw handoff and persisted record.

An interpretation may select exactly one request; retain an exact subset of its original repository claims or downgrade the same exact path from write to read; remove a single positive decimal line suffix from a canonical in-worktree regular-file reference; and change `test` to `file` only for a changed, in-scope repository file that is not any persisted handoff test command. It cannot merge requests, rewrite globs, add paths, escalate read to write, add capabilities or dependencies, or rewrite objectives and execution metadata. Selected requests still pass the ordinary strict proposal validator.

New salvage attempts persist `AUTHORIZED`, `VERIFYING`, and terminal `FAILED` or `VERIFIED` phases. `VERIFIED` retains the exact successful checkpoint. `FAILED` retains append-only content-hashed failure records. Missing phases on legacy salvage objects remain ambiguous and ineligible. The legacy finalizer accepts only a quiescent static blocked run before integration, checks the registered worktree without changing it, requires the latest authorized attempt to terminate in `SALVAGE_VERIFICATION_FAILED`, rejects later success or reordered lifecycle evidence, and hashes the exact JSONL lines and bounded stdout/stderr log contents. Static replanning accepts a salvage-bearing source only in terminal `FAILED` state with failure evidence, no successful checkpoint, and no canonical commit.

## Authorization and effective configuration

Initial authorization re-runs the entire proposal calculation against current state, re-reads/re-hashes the handoff, and requires the exact same proposal ID. Any material change requires a new proposal. It appends a human grant with proposal ID, time, and overlay hash, and persists checkpoint intent before changing Git. Repeating an existing grant never duplicates tasks, dependencies, ownership, or commits; unresolved ready checkpoints are checked again before returning.

Each static continuation load applies:

```text
frozen phase config -> latest recovery policy -> authorized replan overlays
                    -> complete TaskGraph / ownership validation
```

Metrics also use the effective configuration. Overlays always start from a freshly loaded base; they are never repeatedly layered onto an already-effective config. Proposal and grant digests, lifecycle links, and canonical-result invariants are validated on state load. Runs without replan fields retain their previous serialized shape.

An Event/Chat overlay adds one Chat writer. The existing Event review gains that follow-up dependency in addition to Event. Its pristine correction task gains Events + Chat ownership. The source Event TaskSpec is unchanged. Final review and later composed-phase tasks inherit both changes through the ordinary dependency closure, with their existing conditions intact.

## Checkpoint inputs and lifecycle

The follow-up's scheduler dependencies include the source's already-satisfied dependencies and completed overlapping sibling writers. This explicitly orders a broad Chat scope after already-successful Realtime/Presence writers and includes their canonical changes. An overlapping sibling that is not already successful or legitimately skipped causes refusal. **It does not depend on the blocked source.** Its trusted overlay has a separate `checkpointInputs` entry. This field is deliberately not accepted in phase YAML or agent drafts. Preparation applies canonical successful ancestors and then the explicitly authorized partial checkpoint, checking the resulting input history. The blocked handoff is also supplied as context.

```text
proposal -> human grant / CHECKPOINT_PREPARING -> CHECKPOINT_READY
         -> FOLLOWUP_RUNNING -> COMPOSED_VERIFIED -> RESOLVED
```

During preparation, `source.replan.proposalId` references the immutable intent containing the source ID, expected prepared HEAD, dirty fingerprint, handoff hash, and expected tree fingerprint. The source's canonical `commit` stays absent. The checkpoint commit has a `Replan-Checkpoint: <proposal-id>` trailer; its SHA, parent, and changed files are persisted separately under `source.replan.checkpoint`.

- If the process crashes before commit creation, repeated authorization or normal resume checks the intent and finishes the commit. The tree fingerprint is independent of staged/unstaged status, so a crash after `git add` is recoverable.
- If commit creation happened but SHA persistence did not, recovery accepts exactly one clean commit at HEAD with the expected parent, trailer, complete Git-tree fingerprint, and source-only changed files. Message text alone never suffices. Extra/foreign commits, altered trees, or dirty work refuse adoption.
- New files, binary blobs, executable modes, symlink objects, and deletions participate in the tree fingerprint. The original dirty-diff fingerprint remains in the proposal as pre-commit provenance.

## Verification and resolution

After the follow-up succeeds, the host verifies its exact prepared checkpoint inputs, its canonical follow-up commit, and the source checkpoint. IntegrationGate runs the proposal-pinned preparation and `salvage.verify` commands in the composed follow-up worktree. It records command results/logs, HEAD, and a content fingerprint. Verification must leave the source content/HEAD unchanged. This checkpoint is separate from ordinary whole-run integration, which explicitly refuses unresolved replans.

A failed gate preserves the blocked source, checkpoint, follow-up commit, original evidence, and failed verification attempt. Normal resume retries the deterministic gate without re-invoking the successful follow-up. Environmental failures can be corrected externally; modified code/foreign history fails closed. A failed follow-up retains the existing retry/salvage semantics and its authorized ownership.

On success, the exact Event checkpoint SHA becomes Event's canonical commit, after ownership is checked again. Chat remains the follow-up's separate commit. A separate completion handoff records composed verification; the original blocked handoff, original error in the proposal, attempts, and stdout/stderr remain available. Pristine attributable dependency-failure descendants reopen. Approval skips correction/final review normally; changes requested can be corrected in either authorized scope.

Events record `REPLAN_PROPOSED`, `REPLAN_AUTHORIZED`, `REPLAN_CHECKPOINT_PREPARING`, `REPLAN_CHECKPOINT_READY`, `REPLAN_COMPOSED_VERIFIED` (including failed outcomes), and `REPLAN_RESOLVED`. State is authoritative if a crash separates an atomic lifecycle write from its diagnostic event append.

## Exclusion and v1 boundaries

Host continuation/recovery commands, proposal, authorization, execution/integration, and cleanup share `StateStore.withRunMutationLock`. It reuses the hardened preflight primitive and its historical `retry-preflight.lock` path, so preflight participates in the same exclusion. Execution holds the lock through provider calls and deterministic verification. A stale loaded orchestrator must be reloaded before execution/cleanup rather than overwriting newer state. Source authorization additionally requires a quiescent run and fails closed on live/unfinished attempts.

This is cooperative exclusion among this version's host commands. Older binaries, manual `run.json` edits, and unrelated Git processes do not participate; stop them before recovery. Raw v1 proposals support one request; v2 requires explicit selection when a handoff contains more than one. The system supports one replan per source and one unresolved replan at a time. It does not automatically replan, expand a running task, convert strategy, route providers, or edit the frozen phase snapshot.
