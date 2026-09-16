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
import {
  CLAUDE_REVIEW_OUTPUT_SCHEMA,
  CLAUDE_STRUCTURED_REVIEW_OUTPUT_CONTRACT_ID,
  extractStructuredHandoffFromStdout,
  usesClaudeStructuredReviewOutput,
} from './claude-review-output';

const CLAUDE_EFFORT: Readonly<Record<AgentEffort, string>> = {
  medium: 'medium',
  high: 'high',
  extra_high: 'xhigh',
};

export class ClaudeAgent extends ProcessAgent {
  readonly name = 'claude' as const;
  readonly structuredOutputContractId = CLAUDE_STRUCTURED_REVIEW_OUTPUT_CONTRACT_ID;
  protected readonly defaultExecutable = 'claude';

  constructor(options: ProcessAgentOptions = {}) {
    super(options);
  }

  protected buildInvocation(request: AgentRequest): AgentInvocation {
    const access = request.access ?? defaultAccessForRole(request.role);
    const structuredReview = usesClaudeStructuredReviewOutput(request.role);
    // Claude Code 2.1.71 documents workflow permission modes independently
    // from --tools. `dontAsk` keeps headless reviews in normal execution while
    // the explicit tool list supplies the read-only capability boundary.
    const args = [
      '-p',
      '--no-session-persistence',
      '--output-format',
      structuredReview ? 'json' : 'text',
      '--effort',
      CLAUDE_EFFORT[request.requestedEffort],
      '--permission-mode',
      access === 'read_only' ? 'dontAsk' : 'acceptEdits',
      '--tools',
      access === 'read_only' ? 'Read,Glob,Grep' : 'default',
    ];

    if (structuredReview) {
      args.push('--json-schema', JSON.stringify(CLAUDE_REVIEW_OUTPUT_SCHEMA));
    }

    // `claude --help` documents `--model <model>` as a real, independent flag
    // (accepting an alias or a full model name) alongside --effort, verified
    // against Claude Code 2.1.71 before wiring this. Only added when a task
    // explicitly requests one, so the default behavior (session default
    // model) is unchanged for every existing phase file.
    if (request.requestedModel !== undefined) {
      args.push('--model', request.requestedModel);
    }

    return {
      args,
      prompt: buildAgentPrompt(request),
    };
  }

  protected override extractStructuredHandoff(
    request: AgentRequest,
    rawStdout: string | null,
  ): unknown | null {
    return usesClaudeStructuredReviewOutput(request.role)
      ? extractStructuredHandoffFromStdout({
          agent: this.name,
          role: request.role,
          rawStdout,
          structuredOutputContractId: this.structuredOutputContractId,
        })
      : super.extractStructuredHandoff(request, rawStdout);
  }
}
