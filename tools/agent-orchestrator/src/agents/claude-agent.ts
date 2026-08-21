import {
  buildAgentPrompt,
  defaultAccessForRole,
  type AgentEffort,
  type AgentRequest,
} from './agent';
import {
  ProcessAgent,
  type AgentInvocation,
  type ProcessAgentOptions,
} from './process-agent';

const CLAUDE_EFFORT: Readonly<Record<AgentEffort, string>> = {
  medium: 'medium',
  high: 'high',
  extra_high: 'xhigh',
};

export class ClaudeAgent extends ProcessAgent {
  readonly name = 'claude' as const;
  protected readonly defaultExecutable = 'claude';

  constructor(options: ProcessAgentOptions = {}) {
    super(options);
  }

  protected buildInvocation(request: AgentRequest): AgentInvocation {
    const access = request.access ?? defaultAccessForRole(request.role);
    const args = [
      '-p',
      '--safe-mode',
      '--no-session-persistence',
      '--output-format',
      'text',
      '--effort',
      CLAUDE_EFFORT[request.requestedEffort],
      '--permission-mode',
      access === 'read_only' ? 'plan' : 'acceptEdits',
      '--tools',
      access === 'read_only' ? 'Read,Glob,Grep' : 'default',
    ];

    return {
      args,
      prompt: buildAgentPrompt(request),
    };
  }
}
