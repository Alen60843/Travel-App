# Memory Foundation v1

Memory stores facts, not conversations. Its source of truth is a small closed set of structured,
JSON-compatible records with explicit provenance; chat transcripts and model-authored prose are
not canonical memory.

The supported `MemoryKind` values are `FAILURE`, `ACTION_CANDIDATE`, `OUTCOME`, `DECISION`, and
`INVARIANT`. Only `FAILURE` and `ACTION_CANDIDATE` currently have trusted automatic producers.
Outcome, decision, and invariant schemas exist for future explicit producers, but v1 never infers
them from events, commits, reviews, documentation, or LLM output.

Each entry is versioned and its ID is the SHA-256 digest of its canonical JSON body excluding
`id`. The body includes semantic data and provenance, so identical facts from identical provenance
deduplicate while a semantic or provenance change creates a different identity. Presentation text
and CLI command spelling are omitted from automatic entries.

Entries persist outside individual runs at:

```text
tools/agent-orchestrator/memory/entries/<sha256>.json
```

This runtime directory is ignored by Git. Persistence is immutable: a completed temporary file is
published with an exclusive filesystem link, identical repeated writes are idempotent, and an
existing conflicting or corrupt entry fails closed. Reads reject invalid IDs, traversal, symlinks,
non-regular files, oversized or malformed JSON, unsupported versions, noncanonical bytes, and
directories exceeding the bounded scan limit. There is no update or delete API.

Retrieval is exact only: by ID or deterministic listing filtered by exact kind, subject, run ID,
or task ID. There is no full-text search, fuzzy ranking, graph traversal, embedding, or semantic
similarity.

`projectDiagnosisToMemory` is pure. A diagnosed failure produces one `FAILURE` entry followed by
linked `ACTION_CANDIDATE` entries. `unknown` and `no_active_failure` produce nothing. Action entries
reference the originating failure ID and preserve stable `ActionId`, authority, mutation, basis,
and evidence references; command strings are not stored.

Capture is explicit through:

```text
pnpm agents:remember-diagnosis <run-id> [task-id]
```

The command reuses the read-only diagnosis and approved pure action mapper, then writes only Memory.
It never changes `run.json`, `events.jsonl`, or `phase.yaml`, invokes providers, creates worktrees or
commits, or executes candidates. Normal `agents:diagnose` and `agents:resume` do not write Memory.

Graph Context continues to answer which code is related to a task and remains unchanged. Memory
will later answer what structured facts have been learned about a subject; the future Memory Graph
can derive relationships from stable entry IDs without changing this storage contract. Future MCP
tools may expose the plain internal API, but MCP, Memory Graph traversal, RAG, vector databases,
Coordinator integration, prompt injection, automatic capture, and automatic outcome/decision/
invariant producers are explicitly deferred.
