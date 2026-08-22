import {
  buildAgentPrompt,
  defaultAccessForRole,
  type AgentRequest,
} from './agent';
import {
  ProcessAgent,
  type AgentInvocation,
  type ProcessAgentOptions,
} from './process-agent';

export class CodexAgent extends ProcessAgent {
  readonly name = 'codex' as const;
  protected readonly defaultExecutable = 'codex';

  constructor(options: ProcessAgentOptions = {}) {
    super(options);
  }

  protected buildInvocation(request: AgentRequest): AgentInvocation {
    const access = request.access ?? defaultAccessForRole(request.role);
    // `-C`/`-s`/`-a` MUST precede the `exec` keyword: `-a, --ask-for-approval`
    // is a top-level-only option, confirmed absent from `codex exec --help`'s
    // own option list (codex-cli 0.149.0-alpha.4.1) — `codex exec -a never`
    // is rejected outright ("unexpected argument '-a' found"), verified
    // directly against the real binary. `-C`/`-s` also exist as top-level
    // options (and, separately, as exec-scoped ones); keeping all three
    // together before `exec` avoids relying on that overlap. `-m`,
    // `--ephemeral`, and `--color` are genuinely exec-scoped and are built
    // after `exec` accordingly. See test/agents/codex-cli-invocation.test.ts
    // for the real-CLI parser-acceptance proof of this exact ordering.
    //
    // request.requestedModel -> `-m <MODEL>`, verified real and documented
    // under `codex exec --help` (codex-cli 0.149.0-alpha.4.1, discovered via
    // the VS Code extension fallback in executable-resolution.ts — the same
    // installation this adapter's README capability table now cites).
    // request.requestedEffort remains UNMAPPED: the same --help output has no
    // --effort/--reasoning flag of any kind, confirmed directly rather than
    // inferred from its absence in an older, indirect note.
    const args = [
      '-C',
      request.worktreePath,
      '-s',
      access === 'read_only' ? 'read-only' : 'workspace-write',
      '-a',
      'never',
      'exec',
      '--ephemeral',
      '--color',
      'never',
    ];
    if (request.requestedModel !== undefined) {
      args.push('-m', request.requestedModel);
    }
    args.push('-');
    return {
      args,
      prompt: buildAgentPrompt(request),
    };
  }
}
