# Context Builder v1

Context Builder is a deterministic composition layer, not a reasoning or authority layer. It packages already-derived structured sources for a future Coordinator without creating another source of truth.

Source ownership remains explicit:

- Failure Intelligence owns the current failure diagnosis.
- Action Mapping owns bounded current action candidates. Context Builder calls the existing pure mapper and removes CLI command metadata from the portable result.
- Memory Foundation and Memory Graph own immutable historical facts and their typed relations.
- Graph Context supplies incomplete, advisory repository-navigation hints. Its presence, score, and absence never grant ownership or authority and never prove that an unlisted file is irrelevant.

`buildContextBundle({ runId, subject, repositoryContext, diagnosis, relevantMemory })` is pure. It performs no source loading, filesystem or Git access, state or Memory writes, process execution, provider calls, clock access, or randomness. Scope validation fails closed when the diagnosis, relevant-memory query, or any contained Memory fact conflicts with the requested exact structured subject. When the relevant-memory result declares a `runId`, every contained fact must carry that exact run provenance; a result without `runId` intentionally accepts exact-subject cross-run and repository-scoped history.

The ready bundle separates current diagnosis and mapped actions from Memory. Memory facts are partitioned into the requested physical run, deterministic historical run groups, and repository-scoped facts with no run provenance. Existing Memory Graph edges are preserved as structured relations; no causal or dependency relation is inferred. An `unknown` or `no_active_failure` diagnosis is never upgraded from history.

Repository navigation is represented as `available` or `unavailable`, always with `authority: navigation_only`. Available hints retain paths, scores, reasons, scan counts, maximums, and source truncation. An unavailable resolver does not prevent context assembly.

## Bound and determinism

Ready bundles have a fixed 256 KiB maximum canonical UTF-8 representation. Context Builder performs no semantic ranking and never silently drops facts, edges, evidence, or relationship chains. If the complete package exceeds the limit, the result is `limit_exceeded` with the fixed maximum and measured canonical size; it is not presented as ready.

Repository hints sort by score, path, and reasons. Current action candidates sort by semantic action ID. Memory facts sort by Memory ID, historical groups by run ID, and graph edges by canonical structured identity. Caller-owned arrays are copied before sorting.

The schema is provider-independent and consumes Graph Context through a small structural navigation shape rather than its JS/TS scanner internals. It contains data, not markdown prompts or provider messages, and does not depend on the target repository's language, OS, IDE, Git host, package manager, model, or MemoryStore layout.

Coordinator decisions, prompts, MCP exposure, RAG, embeddings, semantic ranking, model routing, model-specific token budgets, action execution, new Memory producers, and historical backfill are deferred.
