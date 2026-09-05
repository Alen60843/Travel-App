export const ERROR_CODES = [
  'CONFIG_INVALID',
  'BASE_BRANCH_MOVED',
  'DAG_CYCLE',
  'OWNERSHIP_OVERLAP',
  'OWNERSHIP_VIOLATION',
  'AGENT_NOT_FOUND',
  'AGENT_FAILED',
  'AGENT_TIMEOUT',
  'AGENT_WORKTREE_PREPARATION_FAILED',
  'HANDOFF_INVALID',
  'REVIEW_BLOCKED',
  'BLOCKED_FOR_HUMAN_REVIEW',
  'CONTINUATION_SOURCE_INVALID',
  'TASK_DEPENDENCY_FAILED',
  'TASK_STATE_INVALID',
  'INTEGRATION_CONFLICT',
  'INTEGRATION_PREPARATION_FAILED',
  'INTEGRATION_TEST_FAILED',
  'SALVAGE_VERIFICATION_FAILED',
  'STATE_CORRUPT',
  'STATE_IO_FAILED',
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ErrorDetails {
  readonly [key: string]: unknown;
}

/** An expected, user-actionable orchestrator failure with a stable code. */
export class OrchestratorError extends Error {
  readonly code: ErrorCode;
  readonly details: ErrorDetails;

  constructor(
    code: ErrorCode,
    message: string,
    options: { cause?: unknown; details?: ErrorDetails } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'OrchestratorError';
    this.code = code;
    this.details = options.details ?? {};
  }
}

export function isOrchestratorError(
  error: unknown,
  code?: ErrorCode,
): error is OrchestratorError {
  return (
    error instanceof OrchestratorError &&
    (code === undefined || error.code === code)
  );
}

export function asOrchestratorError(
  error: unknown,
  fallbackCode: ErrorCode,
  fallbackMessage: string,
): OrchestratorError {
  if (error instanceof OrchestratorError) {
    return error;
  }

  return new OrchestratorError(fallbackCode, fallbackMessage, { cause: error });
}
