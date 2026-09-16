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

The transport schema has three strict variants: `no_action`, `select_action`,
and `human_required`. Every object and reference variant rejects additional
properties; action IDs use the stable production enum; strings and reference
counts carry structural bounds.

Claude returns a JSON provider envelope. A small generic envelope helper,
shared with the existing structured-review path, accepts only a verified
success envelope and extracts only `structured_output`. Missing, null,
malformed, or provider-error envelopes fail closed. The established review
wrapper remains API-compatible and retains its prior semantics.

Schema validation is transport defense-in-depth. The extracted value remains
untrusted, and `parseCoordinatorProposal()` remains the sole runtime and
semantic authority, including UTF-8 byte limits, hostile-runtime rules,
current-action selection, evidence existence, and status truth tables.

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
