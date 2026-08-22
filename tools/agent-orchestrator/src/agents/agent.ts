export type AgentName = 'codex' | 'claude';

export type AgentRole =
  | 'implementation'
  | 'review'
  | 'correction'
  | 'final_review'
  | 'escalation'
  | 'integration'
  | 'debate'
  /**
   * §6/§10 bounded handoff repair (not a TaskMode — never assigned to a
   * TaskSpec, never produced by planPhase's waves): a single, cheap,
   * read-only invocation that reformats a previously-malformed structured
   * output into the exact expected schema without rerunning the original
   * work. See orchestrator.ts's repairHandoffViaAgent.
   */
  | 'handoff_repair';

export type AgentEffort = 'medium' | 'high' | 'extra_high';

export type AgentAccess = 'read_only' | 'writer';

export type AgentRunStatus =
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'aborted'
  | 'not_found'
  | 'spawn_error';

export type AgentFailureCode =
  | 'AGENT_NOT_FOUND'
  | 'AGENT_FAILED'
  | 'AGENT_TIMEOUT'
  | 'AGENT_ABORTED'
  | 'AGENT_SPAWN_ERROR';

export interface AgentTestReport {
  readonly command: string;
  readonly result: 'pass' | 'fail' | 'not_run';
  readonly details: string;
}

export interface AgentRequest {
  readonly runId: string;
  readonly taskId: string;
  readonly role: AgentRole;
  readonly worktreePath: string;
  readonly baseSha: string;
  readonly taskSpecification: unknown;
  readonly canonicalDesignDocumentPath: string;
  readonly allowedFileOwnership: readonly string[];
  readonly dependencyHandoffs: readonly unknown[];
  readonly previousReviewFindings: readonly unknown[];
  readonly requestedEffort: AgentEffort;
  /** See TaskSpec.model: optional, only honored by adapters with verified CLI support. */
  readonly requestedModel?: string;
  readonly timeoutMs: number;
  readonly artifactsDirectory: string;
  readonly access?: AgentAccess;
  readonly attempt?: number;
  readonly abortSignal?: AbortSignal;
  /** Persist the child PID before awaiting completion so crash recovery can inspect it. */
  readonly onStarted?: (pid: number) => void | Promise<void>;
}

export interface AgentResult {
  readonly agent: AgentName;
  readonly runId: string;
  readonly taskId: string;
  readonly status: AgentRunStatus;
  readonly failureCode: AgentFailureCode | null;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdoutPath: string;
  readonly stderrPath: string;
  readonly structuredHandoff: unknown | null;
  /**
   * The raw, bounded, already-redacted stdout text `structuredHandoff` was
   * derived from — null when unavailable (no process ran, or genuinely
   * empty/oversized output). Optional so existing fake-agent test doubles
   * that only ever modeled the already-decided `structuredHandoff` value
   * don't need updating; a repair/framing step that needs the raw text
   * simply treats its absence as "nothing to recover from," which is
   * correct for those synthetic cases. See src/protocol/structured-output.ts.
   */
  readonly rawStdout?: string | null;
  readonly changedFiles: readonly string[];
  readonly gitDiffSummary: string | null;
  readonly testsReported: readonly AgentTestReport[];
  readonly unresolvedQuestions: readonly string[];
  readonly startedAt: string;
  readonly endedAt: string;
  readonly durationMs: number;
  readonly timedOut: boolean;
  readonly aborted: boolean;
  readonly errorMessage: string | null;
}

export interface Agent {
  readonly name: AgentName;

  run(request: AgentRequest): Promise<AgentResult>;
}

export function defaultAccessForRole(role: AgentRole): AgentAccess {
  return role === 'review'
    || role === 'final_review'
    || role === 'escalation'
    || role === 'debate'
    || role === 'handoff_repair'
    ? 'read_only'
    : 'writer';
}

export function buildAgentPrompt(request: AgentRequest): string {
  const access = request.access ?? defaultAccessForRole(request.role);

  return [
    'You are executing one bounded task for the TripWith local development orchestrator.',
    '',
    'Execution contract:',
    `- Run ID: ${request.runId}`,
    `- Task ID: ${request.taskId}`,
    `- Role: ${request.role}`,
    `- Access: ${access}`,
    `- Assigned worktree: ${request.worktreePath}`,
    `- Immutable run base SHA: ${request.baseSha}`,
    `- Canonical design document: ${request.canonicalDesignDocumentPath}`,
    `- Allowed file ownership: ${JSON.stringify(request.allowedFileOwnership)}`,
    '- Never modify a path outside the allowed ownership list.',
    access === 'read_only'
      ? '- This is a read-only task. Do not modify files, create commits, or change Git state.'
      : '- Work only in the assigned worktree. Do not push, merge, force-push, or rewrite branch history.',
    access === 'read_only'
      ? '- Inspect the supplied actual diff and relevant repository files as evidence.'
      : '- Produce at most one local task commit. Leave no mixture of committed and uncommitted task changes.',
    '- Do not reveal private chain-of-thought. Return conclusions, evidence, decisions, diffs, and test outcomes only.',
    '- Do not print credentials, tokens, private keys, or complete environment dumps.',
    '',
    'Role contract:',
    roleContract(request.role),
    '',
    'Task specification:',
    stringifyPromptValue(request.taskSpecification),
    '',
    'Dependency handoffs:',
    stringifyPromptValue(request.dependencyHandoffs),
    '',
    'Previous review findings:',
    stringifyPromptValue(request.previousReviewFindings),
    '',
    'Your final response must be exactly one JSON object using precisely the property names shown in the task specification\'s responseSchema — copy each key exactly as written, character for character. Never add a description, comment, parenthetical, or any other annotation into a property name; optionality and scope notes are listed separately in responseSchemaNotes, in prose, and must stay there, not in a key. Include an optional field only when you have real content for it; omit it entirely otherwise rather than leaving an empty placeholder. Do not wrap the JSON in Markdown fences or add any text before or after it.',
  ].join('\n');
}

function roleContract(role: AgentRole): string {
  switch (role) {
    case 'implementation':
      return 'Implement the smallest complete change, verify it proportionately, and report only the structured handoff evidence.';
    case 'review':
      return 'Independently review the supplied actual diff read-only. Findings require concrete evidence and material impact; omit style-only preferences.';
    case 'correction':
      return 'Do not apply findings blindly. In decisions, classify every finding as CONFIRMED or REJECTED with evidence. For confirmed findings report Finding -> Evidence -> Fix -> Verification; for rejected findings report why it is incorrect and the supporting evidence.';
    case 'final_review':
      return 'Review the corrected actual diff, prior findings, correction responses, and tests read-only. Approve only if no material issue remains; otherwise return evidence-backed remaining findings.';
    case 'escalation':
      return 'You are the Judge. This task runs whenever a corrected diff has been re-reviewed, whether or not that re-review actually found a remaining disagreement — the orchestrator has no cheaper way to know in advance. If the re-review approved the diff, there is nothing to arbitrate: say so plainly and return status "complete" immediately. Do not invent objections to justify your own involvement. If it did not approve, read the disputed findings, the correction responses, and the actual diff read-only, and decide with evidence whether the disagreement is resolved. Report your ruling in decisions. Return status "complete" if resolved (state exactly what is and is not confirmed, so a following task can act on it) or status "blocked" if it is not (state precisely what remains unresolved and why a human must decide). This is a single bounded arbitration, not a new review round: do not request another round of review.';
    case 'integration':
      return 'Perform only the explicitly owned Lead composition work. If bounded debate artifacts are supplied, record an explicit A, B, HYBRID, or BLOCKED selection in decisions. Do not merge the phase branch or push; the orchestrator performs deterministic integration and verification later.';
    case 'debate':
      return 'If no peer proposal is supplied, produce one bounded proposal. If one peer proposal is supplied, critique that proposal once. Do not start an open-ended conversation.';
    case 'handoff_repair':
      return 'You are performing a bounded HANDOFF REPAIR, not the original task. The task specification\'s malformedOutput field is a previous, real result that failed strict schema validation for a formatting/key-naming reason only — it was not rejected as incorrect work. Preserve every value exactly as given: do not invent, remove, or alter any factual content. Your only job is to re-emit it with the correct property names and shape, matching responseSchema exactly. Do not implement anything, run any tools or commands, or modify any file. Return only the corrected JSON object.';
  }
}

function stringifyPromptValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? 'null';
}
