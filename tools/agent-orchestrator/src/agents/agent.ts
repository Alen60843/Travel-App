export type AgentName = 'codex' | 'claude';

export type AgentRole =
  | 'implementation'
  | 'review'
  | 'correction'
  | 'testing'
  | 'synthesis'
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
  readonly adaptive?: boolean;
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
    || role === 'synthesis'
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
      : '- Work only in the assigned worktree. Do not run git commit, push, merge, force-push, or rewrite branch history. The orchestrator validates and creates the task commit.',
    access === 'read_only'
      ? '- Inspect the supplied actual diff and relevant repository files as evidence.'
      : '- Edit files, run bounded verification, and emit the structured handoff; leave commit creation to the orchestrator.',
    '- Do not reveal private chain-of-thought. Return conclusions, evidence, decisions, diffs, and test outcomes only.',
    '- Do not print credentials, tokens, private keys, or complete environment dumps.',
    ...(request.adaptive === true
      ? ['- You may only propose additionalWorkRequests in the structured response. You cannot grant or directly launch another agent.']
      : []),
    '',
    'Role contract:',
    roleContract(request),
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

function roleContract(request: AgentRequest): string {
  const role = request.role;
  switch (role) {
    case 'implementation':
      return 'Implement the smallest complete change, verify it proportionately, and report only the structured handoff evidence.';
    case 'review':
      return `Independently and adversarially verify the implementation read-only. ${boundedVerificationContract('Approve when no material defect is found; otherwise return only material evidence-backed findings.')}`;
    case 'correction':
      return 'Do not apply findings blindly. For every assigned canonical finding, emit exactly one findingResponses entry using the strict decision and resolution enums. Generic summary text is not sufficient. For confirmed/resolved findings report evidence, fix, and verification; for rejected findings report evidence, reason, and not_applicable.';
    case 'testing':
      return 'Execute only the bounded verification objective. Do not broaden into implementation unless the owned task explicitly requires a test artifact change. When canonical findings are assigned, answer every assigned ID in findingResponses; generic summary text is not sufficient.';
    case 'synthesis':
      return `Synthesize only the supplied structured findings: deduplicate, normalize severity, preserve disagreements, and return one canonical verdict. Do not restart repository exploration. ${boundedVerificationContract('Return the canonical review result supported by the supplied shard evidence.')}`;
    case 'final_review':
      return `Independently and adversarially verify the corrected implementation, prior findings, correction responses, and tests read-only. ${boundedVerificationContract('Approve when no material defect remains; otherwise return only material evidence-backed remaining findings.')}`;
    case 'escalation':
      return `You are the Judge. This task runs whenever a corrected diff has been re-reviewed, whether or not that re-review actually found a remaining disagreement — the orchestrator has no cheaper way to know in advance. If the re-review approved the diff, there is nothing to arbitrate: say so plainly and return status "complete" immediately. Do not invent objections to justify your own involvement. If it did not approve, decide with evidence whether the disputed findings are resolved. Report your ruling in decisions. Return status "complete" if resolved (state exactly what is and is not confirmed, so a following task can act on it) or status "blocked" if it is not (state precisely what remains unresolved and why a human must decide). This is a single bounded arbitration, not a new review round: do not request another round of review. ${boundedVerificationContract('Finish with status "complete" when no material dispute remains; use "blocked" only for a concrete unresolved dispute requiring a human.')}`;
    case 'integration':
      return 'Perform only the explicitly owned Lead composition work. If bounded debate artifacts are supplied, record an explicit A, B, HYBRID, or BLOCKED selection in decisions. Do not merge the phase branch or push; the orchestrator performs deterministic integration and verification later.';
    case 'debate':
      return 'If no peer proposal is supplied, produce one bounded proposal. If one peer proposal is supplied, critique that proposal once. Do not start an open-ended conversation.';
    case 'handoff_repair':
      return isRecord(request.taskSpecification)
        && request.taskSpecification.repairKind === 'canonical_finding_metadata'
        ? 'You are performing one bounded semantic HANDOFF REPAIR, not the original task. Preserve every original handoff field and value, adding only the required findingResponses metadata. Use only requiredCanonicalFindings and deterministicTaskEvidence supplied in the task specification. Never invent a test, diff, fix, or success; when evidence does not support resolution, use unresolved or fail. Do not implement anything, run tools/commands, modify files, or change Git state. Return only the repaired JSON object.'
        : 'You are performing a bounded HANDOFF REPAIR, not the original task. Preserve every value exactly as given: do not invent, remove, or alter factual content. Re-emit it with the correct property names and shape. Do not implement anything, run tools/commands, modify files, or change Git state. Return only the corrected JSON object.';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Shared provider-neutral scope contract for every role that verifies rather than implements. */
function boundedVerificationContract(conclusion: string): string {
  return [
    'Start from taskSpecification.actualDependencyDiff and the explicit task invariants.',
    'Attempt to falsify those invariants deeply, but keep the investigation targeted.',
    'Inspect extra repository files only to prove or disprove a concrete suspicion raised by the changed files, directly referenced schema/contracts, or immediately relevant existing code.',
    'Do not perform broad speculative repository exploration, rediscover or redesign the complete architecture, review unrelated modules, or mentally re-implement the task.',
    'Prefer evidence from changed files, directly referenced schema/contracts, and immediately relevant existing code.',
    'Report only material findings supported by concrete evidence and impact; omit style-only or hypothetical concerns.',
    conclusion,
    'Finish within the allocated execution budget.',
  ].join(' ');
}

function stringifyPromptValue(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  const serialized = JSON.stringify(value, null, 2);
  return serialized ?? 'null';
}
