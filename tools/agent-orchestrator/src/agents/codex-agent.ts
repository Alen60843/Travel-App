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
    // request.requestedModel is intentionally NOT mapped to a flag here.
    // Codex was not installed in the environment used to add this field
    // (`codex` resolved to "command not found"), so its `exec` model-flag
    // support could not be verified the same way `claude --help` was — and
    // per policy, an unsupported/unverified flag is never fabricated. The
    // field is still accepted on TaskSpec so a phase file stays portable; for
    // Codex it is currently a no-op, exactly like `effort` already is for
    // this adapter (see the README's documented capability table). Wire a
    // real flag here once `codex exec --help` has actually been inspected.
    return {
      args: [
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
        '-',
      ],
      prompt: buildAgentPrompt(request),
    };
  }
}
