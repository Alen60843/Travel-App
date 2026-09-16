# Memory Graph v1

Memory Graph is a deterministic, read-only projection over the immutable Memory Foundation. Memory entries remain the only persisted source of truth. There is no graph file, node store, edge store, database, migration, or synchronization step: rebuilding from the same entry set produces the same graph.

## Model

Graph node references are ordinary structured data:

- `memory`: an immutable Memory entry ID;
- `subject`: an exact `MemorySubject` (`run`, `task(taskId)`, or `integration`);
- `run`: the exact `provenance.runId`, when present.

The closed v1 relations are:

- `FAILURE --AFFECTED--> subject`;
- `FAILURE --OCCURRED_IN--> run` when `provenance.runId` exists;
- `FAILURE --CANDIDATE_ACTION--> ACTION_CANDIDATE` from `sourceFailureMemoryId`;
- `ACTION_CANDIDATE --OUTCOME--> OUTCOME` from `sourceActionMemoryId`;
- `DECISION --ABOUT--> subject`;
- `INVARIANT --ABOUT--> subject`.

No relation is inferred from prose. In particular, v1 does not claim causality, dependency, supersession, or resolution.

Before emitting a candidate-action edge, the referenced entry must exist, be the exact referenced `FAILURE`, have the same structured subject, and have a classification equal to `basisClassification`. Before emitting an outcome edge, the referenced entry must exist, be the exact referenced `ACTION_CANDIDATE`, and have the same subject. Invalid or wrong-kind references fail closed with `STATE_CORRUPT`. A `FAILURE` with no candidate action is valid.

## Exact relevant memory

`getRelevantMemory(reader, { subject, runId?, taskId? })` performs one bounded Memory Foundation list operation, builds the graph, and returns structured ID-ordered groups for failures, action candidates, outcomes, decisions, and invariants plus deterministic nodes and edges. It performs no writes, traversal, summarization, ranking, prompt formatting, or provider invocation.

Relevance is exact. There is no fuzzy task matching, keyword search, prose parsing, embedding, or model selection. A task-subject query without `runId` returns that exact task subject across runs; adding `runId` restricts it to that run. Because `{ kind: "run" }` carries no physical identity, run-subject queries use `provenance.runId` when a particular run is required. Subject identity is scoped to this repository's Memory store; v1 does not assert that equal task IDs in unrelated repositories are globally equivalent.

Nodes sort by canonical reference identity. Edges sort by canonical source identity, the declared v1 relation order, and canonical target identity. Entry groups sort by Memory ID. Input or filesystem enumeration order therefore cannot change the result.

## Boundary and scope

The graph depends only on a small structural `MemoryReader` interface (`getMemory` and `listMemory`). `MemoryStore` satisfies it without an adapter, while a future SQLite, Postgres, remote, or MCP-facing implementation can preserve the same semantics. Graph construction itself is pure and has no filesystem, platform, IDE, Git host, package-manager, model, or provider dependency.

Memory Graph is distinct from Graph Context. Graph Context locates repository code related to a task; Memory Graph relates historical structured Memory facts to an exact subject. They are not merged and Memory is not injected into prompts in v1.

Future work may compose Memory Graph with Graph Context and current failure facts in a Context Builder, then expose the structured API through MCP. Context construction, Coordinator behavior, graph databases, graph-query languages, semantic search, RAG, embeddings, ranking, token budgeting, automatic producers, outcome inference, and historical backfill are explicitly deferred.
