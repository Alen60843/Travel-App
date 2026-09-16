# Claude Coordinator Adapter and Shadow Mode

`ClaudeCoordinatorReasoner` is the first concrete transport implementation of
the provider-neutral `CoordinatorReasoner` interface. It receives a complete
ready `ContextBundle`, makes one Claude Code call, extracts the untrusted
structured proposal, and returns that proposal to Coordinator Core. The
adapter does not validate authority or execute a decision.

Its provider-neutral capability profile is exactly:

```json
{"version":1,"capabilities":["structured_reasoning","structured_output"]}
```

This configuration deliberately claims no repository-read, edit, review, or
test capability. Capability compatibility does not grant authorization.

## Verified Claude CLI transport

Development verified Claude Code `2.1.71`. Its local help and argument parser
accept the exact transport flags used here:

- `-p` for one headless print-mode call;
- `--no-session-persistence`;
- `--output-format json`;
- `--json-schema <schema>`;
- `--permission-mode dontAsk`;
- `--tools ""`, whose help explicitly defines the empty value as disabling
  all built-in tools;
- `--disable-slash-commands`;
- `--strict-mcp-config --mcp-config '{"mcpServers":{}}'`, preventing configured
  MCP servers from being inherited;
- `--no-chrome`.
- `--setting-sources ""`, preventing user, project, and local settings from
  contributing tools, hooks, or plugins.

Together, the empty built-in tool set, strict empty MCP configuration, disabled
slash commands, and disabled Chrome integration prevent repository, shell,
web, browser, and MCP tool use. The adapter receives the complete context over
stdin and does not read repository files to enrich it. Optional model and
low/medium/high effort overrides exist only on the concrete adapter; the
default effort is `high` and no model is hardcoded.

The executable is mandatory constructor input. The Shadow CLI resolves it
once through the existing `CLAUDE_EXECUTABLE`/PATH discipline and passes the
resolved path to runtime, preventing discovery/spawn disagreement.

## Structured output and authority

With the verified local Claude Code `2.1.71` setup, structured output was
empirically observed to stall on JSON Schemas using `oneOf`, including a tiny
two-branch reproduction, while simple object schemas completed normally. This
is a description of that verified setup, not a claim about every Claude
version or environment.

The Coordinator transport schema is therefore one intentionally flat,
combinator-free object. It bounds known fields, decision and action enums,
reference count, reference kinds, and string lengths, and rejects unknown
fields. `actionId` and the three reference payload fields are optional at the
transport layer because their conditional relationships require branching.
The flat reference item similarly requires `kind`, exposes the known
`reference`, `memoryId`, and `path` fields, and requires exactly two total
properties: `kind` plus one payload. This prevents multi-payload objects but
cannot prove that the chosen payload matches the chosen kind without
reintroducing branching.

Claude returns a JSON provider envelope. A small generic envelope helper,
shared with the existing structured-review path, accepts only a verified
success envelope and extracts only `structured_output`. Missing, null,
malformed, or provider-error envelopes fail closed. The established review
wrapper remains API-compatible and retains its prior semantics.

Schema validation is transport defense-in-depth only. It may admit invalid
field combinations, such as `no_action` with `actionId` or a `memory` reference
with `path`. The extracted value remains untrusted, and
`parseCoordinatorProposal()` remains the sole runtime and semantic authority,
including variant field relationships, UTF-8 byte limits, and hostile-runtime
rules. Coordinator Core remains the current-state authority for action
selection, evidence existence, historical/current separation, and status truth
tables. Flattening the transport schema grants the model no additional
authority.

The prompt supplies the exact two-field shape for every reference kind and
distinguishes a semantic evidence reference such as `run.status` from the JSON
location where that value appears. This guides provider output but does not
replace transport or runtime validation.

## Bounded process behavior

One `propose()` call spawns at most one non-shell process. There is no retry,
repair, fallback, second model, or self-critique. The process runs in its own
POSIX process group where supported and the whole tree is terminated on
timeout, abort, or output overflow. Stdout is capped at 2 MiB and stderr at
256 KiB by default. Provider stdout/stderr are held only within these bounds
and are never persisted as run artifacts. Stderr and provider messages are not
included in thrown errors. Executable absence, spawn failure, timeout, abort,
nonzero exit, overflow, and invalid envelopes produce small stable adapter
errors; Coordinator Core projects any throw to `reasoner_failed / REASONER_ERROR`.

## Explicit Shadow command

From the repository root:

```sh
pnpm agents:coordinate-shadow:claude <run-id> [task-id]
```

The command explicitly composes persisted read-only run loading, Failure
Intelligence diagnosis, exact-subject cross-run Memory, optional bounded Graph
Context, Context Builder, the capability compatibility assertion, the Claude
adapter, and Coordinator Core. Its output wrapper states `mode: "shadow"`,
`authoritative: false`, `executed: false`, and `persisted: false`.

The command displays one result only. It never executes or authorizes the
decision, writes Memory, appends events, changes run or phase state, creates a
commit/worktree, invokes recovery, retries, or resumes. It is not called by
normal task execution, reviews, integration, recovery, or resume.

The first opt-in real Phase 8 dogfood command is:

```sh
pnpm agents:coordinate-shadow:claude run-20260910100819-8ddbdc28
```

Future provider implementations can implement the same `CoordinatorReasoner`
interface and expose the same generic profile shape. Provider routing,
ranking, fallback, policy, authorization, execution, persistence, automatic
Memory decisions, and lifecycle wiring remain deferred.
