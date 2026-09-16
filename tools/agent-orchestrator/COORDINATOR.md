# Coordinator Core v1

Coordinator Core consumes only a ready, bounded `ContextBundle` and answers one question: what bounded decision should the system propose next? It does not own current truth. Failure Intelligence owns the diagnosis, Action Mapping owns current candidates, Memory owns historical facts, and Graph Context provides advisory navigation hints.

The trust boundary is explicit:

```text
ContextBundle
  -> CoordinatorReasoner.propose(context)
  -> untrusted CoordinatorProposal
  -> strict parsing and deterministic validation
  -> canonical CoordinatorDecision
```

`CoordinatorReasoner` is provider-neutral and can be implemented by an in-memory fake. Coordinator Core has no dependency on task agents, worktrees, providers, models, CLI flags, filesystems, Git, state stores, or Memory stores. Real provider adapters and prompt design are deferred.

## Proposal and deterministic rules

The model may propose only `no_action`, `select_action`, or `human_required`, with a concise reason of at most 2,000 UTF-8 bytes and at most 16 supporting references. A selection contains only a semantic `actionId`. The reason is a conclusion/evidence summary, not private chain-of-thought. Unknown fields and model-supplied scope, authority, mutation, execution, command, provider, or runtime metadata are rejected.

The deterministic core applies these rules:

- `no_active_failure` permits only `NO_ACTION`.
- `unknown` permits only `HUMAN_REQUIRED`; history cannot manufacture a diagnosis.
- `diagnosed` permits `HUMAN_REQUIRED` or `SELECT_ACTION` for one exact current candidate, and never `NO_ACTION`.

Historical action Memory may inform a proposal but can never satisfy current action selection. The canonical selected action is copied from `context.current.actionCandidates`, including its subject, mutation flag, manual execution mode, human-authority requirement, classification, and evidence references. Duplicate current IDs with incompatible semantics fail closed. `MANUAL_INSPECTION` remains an ordinary semantic action when it is a current candidate.

Supporting references are strict exact references to current diagnosis/action evidence, a Memory fact ID present anywhere in the bundle, or an available repository hint path. Repository hints remain navigation-only and grant no ownership, authority, relevance proof, or recovery eligibility. Duplicate, malformed, fabricated, or excessive references are rejected.

## Result boundary

`CoordinatorResult` distinguishes a canonical `decided` result from `reasoner_failed` protocol/transport outcomes and `context_unavailable`. A `limit_exceeded` Context Builder result invokes no reasoner and is never truncated or exposed as partial context. A ready context causes at most one reasoner call; failures and malformed output are not retried and are never converted into `HUMAN_REQUIRED`.

Coordinator Core does not authorize or execute selected actions and does not persist decisions, append events, write Memory, create tasks, or mutate runs. Policy, authorization, execution, routing, MCP exposure, decision persistence, provider wiring, Context Selection, model-token budgeting, RAG, embeddings, retries, debate, voting, and judge behavior are deferred.
