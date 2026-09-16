# Failure → Action Mapping v1

The orchestrator keeps four responsibilities separate:

1. **Diagnosis** determines what happened from durable evidence.
2. **Action Mapping** purely maps that diagnosis to relevant bounded candidates.
3. **Policy** will decide who may approve an action in a future layer.
4. **Execution** remains the responsibility of the existing authoritative command.

`mapFailureToActions(diagnosis)` reads no run state, events, logs, filesystem, Git state, or
worktrees. It invokes no provider and performs no recovery eligibility checks. Its compact,
serializable output uses stable action identities and structured evidence references so a future
Memory or MCP interface can consume a stored diagnosis without reopening the original run.

The v1 `ActionId` values are:

- `REPIN_AGENT_EXECUTABLE`
- `RETRY_REVIEW_OUTPUT`
- `CONTINUE_CLAUDE_REVIEW_OUTPUT`
- `PROPOSE_REPLAN`
- `RETRY_INTEGRATION`
- `MANUAL_INSPECTION`

The deterministic mapping is:

| Failure classification | Candidate |
| --- | --- |
| `AGENT_EXECUTABLE_DRIFT` | `REPIN_AGENT_EXECUTABLE` |
| `MALFORMED_REVIEW_OUTPUT` | `RETRY_REVIEW_OUTPUT` |
| `PROVIDER_OUTPUT_CONTRACT_FAILURE` with `CLAUDE_TEXT_CONTRACT_MIGRATION` | `CONTINUE_CLAUDE_REVIEW_OUTPUT` |
| other `PROVIDER_OUTPUT_CONTRACT_FAILURE` | `MANUAL_INSPECTION` |
| ordinary `OWNERSHIP_EXPANSION_REQUIRED` | `PROPOSE_REPLAN` |
| ownership expansion with an existing replan checkpoint or non-repository write boundary | `MANUAL_INSPECTION` |
| `INTEGRATION_ENVIRONMENT_MISMATCH` | `RETRY_INTEGRATION` |

CLI command metadata is only a display or dispatch hint; it is not the action's identity and is
never executed by the mapper. All mutating candidates use manual execution and require explicit
human authorization. `MANUAL_INSPECTION` is non-mutating and requires no authorization.

An `unknown` or `no_active_failure` diagnosis maps to no candidate. A generic provider-output
contract failure maps only to manual inspection; the Claude-specific continuation is exposed only
when the diagnosis carries the proven `CLAUDE_TEXT_CONTRACT_MIGRATION` variant.

Every existing recovery command remains authoritative and independently revalidates its complete
eligibility and safety contract. Automatic policy, action execution, Coordinator reasoning,
Memory, graph/vector storage, routing, MCP, plugins, and generic rule engines remain deferred.
