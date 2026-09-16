# Role / Capability Registry v1

Roles describe the class of work being requested. Capabilities describe what
an adapter/runtime can do. They are deliberately separate from provider and
model identity.

Most importantly, a capability never grants authority. `code_edit` means that
a runtime can perform code-editing work; it does not grant writer access, file
ownership, shell or commit authority, recovery authority, or permission to
mutate orchestrator state. Existing access, ownership, policy, and
authorization controls remain independently authoritative.

## Immutable minimum requirements

The registry is a static role-to-capability table. It has no registration API,
plugins, mutable global state, scoring, preferences, or fallback behavior.
Requirements are minimums: a profile satisfies a role when every required
capability is present. Extra known capabilities are allowed.

| Role | Minimum capabilities |
| --- | --- |
| `coordinator` | `structured_reasoning`, `structured_output` |
| `implementation` | baseline plus `repository_read`, `code_edit` |
| `review` | baseline plus `repository_read`, `code_review` |
| `correction` | baseline plus `repository_read`, `code_edit` |
| `testing` | baseline plus `repository_read`, `test_execution` |
| `synthesis` | `structured_reasoning`, `structured_output` |
| `final_review` | baseline plus `repository_read`, `code_review` |
| `escalation` | `structured_reasoning`, `structured_output` |
| `integration` | baseline plus `repository_read`, `code_edit` |
| `debate` | `structured_reasoning`, `structured_output` |
| `handoff_repair` | `structured_reasoning`, `structured_output` |

Here, “baseline” means `structured_reasoning` and `structured_output`.
Implementation intentionally does not require `test_execution`; deterministic
test execution can remain a separate responsibility.

The production table is compile-time exhaustive over the existing
`AgentRole` union, with `coordinator` as the sole additional role. Adding a
legacy role without adding its requirements therefore fails compilation. This
compatibility check does not import agent runtime behavior.

## Profiles and matching

A capability profile is provider-neutral trusted adapter/configuration
metadata:

```ts
interface CapabilityProfile {
  readonly version: 1;
  readonly capabilities: readonly CapabilityId[];
}
```

Capabilities are never accepted from model prose or a Coordinator proposal.
The runtime parser rejects malformed profiles, unknown or duplicate
capabilities, accessors, symbols, sparse/nonstandard arrays, extra fields, and
non-data properties. Valid capabilities are copied into canonical order; input
arrays are not mutated.

`requiredCapabilitiesForRole(role)` returns the immutable minimum requirement.
`matchCapabilities(role, profile)` is a deterministic subset check returning
the role, status, required, available, and missing capabilities in canonical
order. It evaluates one profile only. It does not select, rank, score, route,
authorize, invoke, or execute anything.

## Integration boundary

There is no provider adapter integration or vendor-to-role mapping in v1.
Existing agent adapters, role prompts, scheduling, `AgentName`, `TaskMode`,
`AgentAccess`, and Coordinator Core remain unchanged. A later provider-adapter
slice can expose a generic profile, and a later Model Router can compare
profiles. Neither is part of this registry.

This vocabulary exists before Phase 8 dogfood so that provider attachment can
be tested against a small, stable semantic contract without first entangling
ability, provider identity, routing, and authority.
