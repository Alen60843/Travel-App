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
