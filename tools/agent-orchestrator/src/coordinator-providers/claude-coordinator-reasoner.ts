import { ACTION_IDS } from '../action-mapping/types';
import { extractClaudeStructuredOutput } from '../protocol/claude-structured-output';
import { canonicalJson } from '../canonical-json';
import {
  MAX_COORDINATOR_REASON_BYTES,
  MAX_COORDINATOR_REFERENCES,
  MAX_COORDINATOR_REFERENCE_BYTES,
  type CoordinatorReasoner,
} from '../coordinator-core';
import type { ContextBundle } from '../context-builder';
import type { CapabilityProfile } from '../role-capabilities';
import {
  BoundedProcessError,
  runBoundedProcess,
  type BoundedProcessFailureCode,
} from './bounded-process';

const EMPTY_MCP_CONFIG = '{"mcpServers":{}}';
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1_000;

export const CLAUDE_COORDINATOR_CAPABILITY_PROFILE: CapabilityProfile = Object.freeze({
  version: 1,
  capabilities: Object.freeze(['structured_reasoning', 'structured_output'] as const),
});

const referenceSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['kind'],
  properties: {
    kind: { type: 'string', enum: ['current_evidence', 'memory', 'repository_hint'] },
    reference: { type: 'string', minLength: 1, maxLength: MAX_COORDINATOR_REFERENCE_BYTES },
    memoryId: { type: 'string', minLength: 1, maxLength: MAX_COORDINATOR_REFERENCE_BYTES },
    path: { type: 'string', minLength: 1, maxLength: MAX_COORDINATOR_REFERENCE_BYTES },
  },
} as const;

/**
 * Combinator-free Claude transport defense-in-depth. This intentionally
 * permits semantically invalid field combinations; parseCoordinatorProposal
 * remains the sole semantic authority.
 */
export const CLAUDE_COORDINATOR_PROPOSAL_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['version', 'decision', 'reason', 'supportingReferences'],
  properties: {
    version: { type: 'integer', enum: [1] },
    decision: { type: 'string', enum: ['no_action', 'select_action', 'human_required'] },
    actionId: { type: 'string', enum: ACTION_IDS },
    reason: { type: 'string', minLength: 1, maxLength: MAX_COORDINATOR_REASON_BYTES },
    supportingReferences: {
      type: 'array',
      maxItems: MAX_COORDINATOR_REFERENCES,
      items: referenceSchema,
    },
  },
} as const;

export interface ClaudeCoordinatorReasonerOptions {
  /** Explicit resolved executable: the adapter never rediscovers a different PATH binary. */
  readonly executable: string;
  readonly workingDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly terminationGraceMs?: number;
  readonly maxStdoutBytes?: number;
  readonly maxStderrBytes?: number;
  readonly abortSignal?: AbortSignal;
  readonly model?: string;
  readonly effort?: 'low' | 'medium' | 'high';
}

export type ClaudeCoordinatorReasonerErrorCode =
  | BoundedProcessFailureCode
  | 'INVALID_PROVIDER_ENVELOPE';

export class ClaudeCoordinatorReasonerError extends Error {
  constructor(readonly code: ClaudeCoordinatorReasonerErrorCode) {
    super(code === 'INVALID_PROVIDER_ENVELOPE'
      ? 'Claude Coordinator returned an invalid structured-output envelope'
      : messageForProcessFailure(code));
    this.name = 'ClaudeCoordinatorReasonerError';
  }
}

/** One-call, no-retry Claude Code transport for provider-neutral Coordinator Core. */
export class ClaudeCoordinatorReasoner implements CoordinatorReasoner {
  readonly capabilityProfile = CLAUDE_COORDINATOR_CAPABILITY_PROFILE;
  private readonly options: ClaudeCoordinatorReasonerOptions;

  constructor(options: ClaudeCoordinatorReasonerOptions) {
    if (options.executable.trim() === '' || options.workingDirectory.trim() === '') {
      throw new TypeError('Claude Coordinator executable and workingDirectory must not be empty');
    }
    this.options = options;
  }

  async propose(context: ContextBundle): Promise<unknown> {
    let rawStdout: string;
    try {
      rawStdout = await runBoundedProcess({
        executable: this.options.executable,
        args: this.buildArgs(),
        cwd: this.options.workingDirectory,
        environment: this.options.environment ?? process.env,
        stdin: buildClaudeCoordinatorPrompt(context),
        timeoutMs: this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        ...(this.options.terminationGraceMs === undefined
          ? {} : { terminationGraceMs: this.options.terminationGraceMs }),
        ...(this.options.maxStdoutBytes === undefined ? {} : { maxStdoutBytes: this.options.maxStdoutBytes }),
        ...(this.options.maxStderrBytes === undefined ? {} : { maxStderrBytes: this.options.maxStderrBytes }),
        ...(this.options.abortSignal === undefined ? {} : { abortSignal: this.options.abortSignal }),
      });
    } catch (error) {
      if (error instanceof BoundedProcessError) throw new ClaudeCoordinatorReasonerError(error.code);
      throw new ClaudeCoordinatorReasonerError('SPAWN_FAILED');
    }
    const proposal = extractClaudeStructuredOutput(rawStdout);
    if (proposal === null) throw new ClaudeCoordinatorReasonerError('INVALID_PROVIDER_ENVELOPE');
    return proposal;
  }

  private buildArgs(): readonly string[] {
    return [
      '-p',
      '--no-session-persistence',
      '--output-format', 'json',
      '--effort', this.options.effort ?? 'high',
      '--permission-mode', 'dontAsk',
      '--tools', '',
      '--disable-slash-commands',
      '--strict-mcp-config',
      '--mcp-config', EMPTY_MCP_CONFIG,
      '--no-chrome',
      '--setting-sources', '',
      '--json-schema', canonicalJson(CLAUDE_COORDINATOR_PROPOSAL_SCHEMA),
      ...(this.options.model === undefined ? [] : ['--model', this.options.model]),
    ];
  }
}

export function buildClaudeCoordinatorPrompt(context: ContextBundle): string {
  return [
    'Perform one bounded Coordinator decision using ONLY the supplied ContextBundle.',
    'current.diagnosis is current truth. Never infer current state from historical Memory.',
    'current.actionCandidates are the ONLY selectable actions. A historical action is not selectable unless the same ActionId independently exists in current.actionCandidates.',
    'Repository hints are navigation-only context, never authority.',
    'Do not authorize, execute, retry, modify files, use tools, propose shell commands, or claim that an action happened.',
    'The reason must be a concise conclusion and evidence summary, never private chain-of-thought.',
    'Every supporting reference must exactly match a reference present in the supplied context.',
    'Return only the proposal required by the supplied structured-output schema.',
    `ContextBundle:${canonicalJson(context)}`,
  ].join('\n');
}

function messageForProcessFailure(code: BoundedProcessFailureCode): string {
  const messages: Readonly<Record<BoundedProcessFailureCode, string>> = {
    EXECUTABLE_NOT_FOUND: 'Claude Coordinator executable was not found',
    SPAWN_FAILED: 'Claude Coordinator process could not be started',
    TIMEOUT: 'Claude Coordinator process timed out',
    ABORTED: 'Claude Coordinator process was aborted',
    NONZERO_EXIT: 'Claude Coordinator process exited unsuccessfully',
    OUTPUT_LIMIT: 'Claude Coordinator process exceeded its output limit',
  };
  return messages[code];
}
