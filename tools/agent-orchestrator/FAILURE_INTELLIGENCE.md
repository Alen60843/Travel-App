# Failure Intelligence v1

Failure Intelligence v1 is a deterministic, read-only interpretation layer over one
persisted orchestrator run. It answers what is currently blocked, which durable evidence
supports that classification, and which factual variant—if any—was proven. The separate
Action Mapping layer converts this diagnosis into bounded action candidates.

Run it with:

```text
pnpm agents:diagnose <run-id> [task-id]
```

The command reads validated `run.json` state first, then only the persisted events,
accepted artifacts, bounded run-owned logs, and narrowly justified filesystem facts needed
by a matching rule. It does not invoke agents or providers, acquire a mutation lock, append
events, edit state or phase configuration, touch a worktree, create a commit, retry work, or
authorize recovery. Unsafe, symlinked, unreadable, or oversized evidence fails closed.

The v1 classifications, in task precedence order, are:

1. `AGENT_EXECUTABLE_DRIFT`
2. `PROVIDER_OUTPUT_CONTRACT_FAILURE`
3. `MALFORMED_REVIEW_OUTPUT`
4. `OWNERSHIP_EXPANSION_REQUIRED`
5. `INTEGRATION_ENVIRONMENT_MISMATCH` for an integration subject

`unknown` means the available evidence did not satisfy a rule exactly, or that more than
one current blocker made subject selection ambiguous. `no_active_failure` means the selected
task or run has no current terminal failure; completed runs therefore do not resurrect their
historical failures.

A mapped candidate is not an eligibility decision. Existing commands such as
`repin-agent-executable`, `retry-review-output`, `continue-claude-review-output`,
`propose-replan`, and `retry-integration` remain the sole authority for mutation. Each must
independently revalidate its full safety and authorization contract when a human explicitly
executes it.

Coordinator reasoning, durable memory, vector or graph storage, capability routing, agent
debate, automatic execution, and generalized recovery rules are intentionally deferred.
