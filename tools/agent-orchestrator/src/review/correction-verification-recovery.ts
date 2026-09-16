import type { IntegrationCommand } from '../config';
import { OrchestratorError } from '../errors';
import { canonicalHash } from './correction-continuation';

export interface CorrectionVerificationCommandResult {
  readonly command: string;
  readonly required: boolean;
  readonly timeoutMs: number;
  readonly termination: 'timeout' | 'aborted' | null;
  readonly timedOut: boolean;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly durationMs: number;
  readonly stdoutPath: string;
  readonly stderrPath: string;
}

export interface ReviewCorrectionVerificationRecoveryIdentity {
  readonly version: 1;
  readonly runId: string;
  readonly correctionTaskId: string;
  readonly correctionAuthorizationId: string;
  readonly providerAttempt: number;
  readonly handoffPath: string;
  readonly handoffSha256: string;
  readonly preparedHeadSha: string;
  readonly worktreeHeadSha: string;
  readonly worktreeDiffFingerprint: string;
  readonly originalVerificationCommands: readonly IntegrationCommand[];
  readonly originalVerificationResults: readonly CorrectionVerificationCommandResult[];
  readonly normalizedVerificationCommands: readonly IntegrationCommand[];
}

export interface ReviewCorrectionVerificationAttempt {
  readonly attempt: number;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly result: 'passed' | 'failed';
  readonly handoffSha256: string;
  readonly worktreeHeadSha: string;
  readonly worktreeDiffFingerprint: string;
  readonly commands: readonly CorrectionVerificationCommandResult[];
}

export interface ReviewCorrectionVerificationRecovery extends ReviewCorrectionVerificationRecoveryIdentity {
  readonly id: string;
  readonly authorizedBy: 'human';
  readonly authorizedAt: string;
  /** Append-only execution evidence. A failed command may be retried explicitly. */
  readonly attempts: readonly ReviewCorrectionVerificationAttempt[];
  /** Added only after the verified tree has exactly one canonical task commit. */
  readonly correctionCommitSha?: string;
}

export function correctionVerificationRecoveryId(identity: ReviewCorrectionVerificationRecoveryIdentity): string {
  return canonicalHash(identity);
}

const REQUIRED_DATABASE_ENVIRONMENT = [
  'TEST_DB_HOST', 'TEST_DB_PORT', 'TEST_DB_USER', 'TEST_DB_PASSWORD', 'TEST_DB_NAME',
] as const;

/** Require an explicit test database target; never infer or persist its values. */
export function assertCorrectionVerificationEnvironment(environment: NodeJS.ProcessEnv): void {
  const missing = REQUIRED_DATABASE_ENVIRONMENT.filter((name) => (environment[name]?.trim() ?? '') === '');
  if (missing.length > 0) {
    throw new OrchestratorError('TASK_STATE_INVALID',
      `Review correction verification requires explicit database environment: ${missing.join(', ')}`);
  }
  if (!/^[1-9][0-9]{0,4}$/.test(environment.TEST_DB_PORT!)) {
    throw new OrchestratorError('TASK_STATE_INVALID', 'Review correction verification TEST_DB_PORT is invalid');
  }
  const port = Number(environment.TEST_DB_PORT);
  if (port > 65_535) throw new OrchestratorError('TASK_STATE_INVALID', 'Review correction verification TEST_DB_PORT is invalid');
}

function refuse(message: string): never {
  throw new OrchestratorError('STATE_CORRUPT', `Review correction verification recovery: ${message}`);
}

function object(value: unknown, keys: readonly string[], path: string): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).some((key) => !keys.includes(key))) refuse(`${path} has invalid fields`);
  return value as Record<string, unknown>;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) refuse(`${path} must be non-empty text`);
  return value;
}

function digest(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[a-f0-9]{64}$/.test(result)) refuse(`${path} must be a SHA-256 digest`);
  return result;
}

function sha(value: unknown, path: string): string {
  const result = text(value, path);
  if (!/^[a-f0-9]{40,64}$/.test(result)) refuse(`${path} must be a full commit SHA`);
  return result;
}

function integer(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) refuse(`${path} must be an integer >= ${minimum}`);
  return Number(value);
}

function timestamp(value: unknown, path: string): string {
  const result = text(value, path);
  if (!Number.isFinite(Date.parse(result))) refuse(`${path} must be a timestamp`);
  return result;
}

function command(value: unknown, path: string): IntegrationCommand {
  const item = object(value, ['command', 'required', 'timeoutMs'], path);
  if (item.required !== true) refuse(`${path}.required must be true`);
  return { command: text(item.command, `${path}.command`), required: true,
    ...(item.timeoutMs === undefined ? {} : { timeoutMs: integer(item.timeoutMs, `${path}.timeoutMs`, 1_000) }) };
}

function commandResult(value: unknown, path: string): CorrectionVerificationCommandResult {
  const item = object(value, ['command', 'required', 'timeoutMs', 'termination', 'timedOut', 'exitCode', 'signal',
    'durationMs', 'stdoutPath', 'stderrPath'], path);
  if (item.required !== true || typeof item.timedOut !== 'boolean') refuse(`${path} has invalid required/timedOut fields`);
  if (item.termination !== null && item.termination !== 'timeout' && item.termination !== 'aborted') refuse(`${path}.termination is invalid`);
  if (item.exitCode !== null && !Number.isSafeInteger(item.exitCode)) refuse(`${path}.exitCode is invalid`);
  if (item.signal !== null && typeof item.signal !== 'string') refuse(`${path}.signal is invalid`);
  return {
    command: text(item.command, `${path}.command`), required: true,
    timeoutMs: integer(item.timeoutMs, `${path}.timeoutMs`, 1_000),
    termination: item.termination as CorrectionVerificationCommandResult['termination'],
    timedOut: item.timedOut,
    exitCode: item.exitCode as number | null,
    signal: item.signal as string | null,
    durationMs: integer(item.durationMs, `${path}.durationMs`),
    stdoutPath: text(item.stdoutPath, `${path}.stdoutPath`),
    stderrPath: text(item.stderrPath, `${path}.stderrPath`),
  };
}

export function parseReviewCorrectionVerificationRecoveries(value: unknown): ReviewCorrectionVerificationRecovery[] {
  if (!Array.isArray(value)) refuse('history must be an array');
  const recoveries = value.map((raw, index): ReviewCorrectionVerificationRecovery => {
    const path = `reviewCorrectionVerificationRecoveries[${index}]`;
    const item = object(raw, ['id', 'version', 'runId', 'correctionTaskId', 'correctionAuthorizationId',
      'providerAttempt', 'handoffPath', 'handoffSha256', 'preparedHeadSha', 'worktreeHeadSha',
      'worktreeDiffFingerprint', 'originalVerificationCommands', 'normalizedVerificationCommands',
      'originalVerificationResults', 'authorizedBy', 'authorizedAt', 'attempts', 'correctionCommitSha'], path);
    if (item.version !== 1 || item.authorizedBy !== 'human') refuse(`${path} version/provenance is invalid`);
    if (!Array.isArray(item.originalVerificationCommands) || !Array.isArray(item.originalVerificationResults)
      || !Array.isArray(item.normalizedVerificationCommands) || !Array.isArray(item.attempts)) {
      refuse(`${path} command/attempt history is invalid`);
    }
    const identity: ReviewCorrectionVerificationRecoveryIdentity = {
      version: 1,
      runId: text(item.runId, `${path}.runId`),
      correctionTaskId: text(item.correctionTaskId, `${path}.correctionTaskId`),
      correctionAuthorizationId: digest(item.correctionAuthorizationId, `${path}.correctionAuthorizationId`),
      providerAttempt: integer(item.providerAttempt, `${path}.providerAttempt`, 1),
      handoffPath: text(item.handoffPath, `${path}.handoffPath`),
      handoffSha256: digest(item.handoffSha256, `${path}.handoffSha256`),
      preparedHeadSha: sha(item.preparedHeadSha, `${path}.preparedHeadSha`),
      worktreeHeadSha: sha(item.worktreeHeadSha, `${path}.worktreeHeadSha`),
      worktreeDiffFingerprint: digest(item.worktreeDiffFingerprint, `${path}.worktreeDiffFingerprint`),
      originalVerificationCommands: item.originalVerificationCommands.map((entry, commandIndex) => command(entry, `${path}.originalVerificationCommands[${commandIndex}]`)),
      originalVerificationResults: item.originalVerificationResults.map((entry, commandIndex) =>
        commandResult(entry, `${path}.originalVerificationResults[${commandIndex}]`)),
      normalizedVerificationCommands: item.normalizedVerificationCommands.map((entry, commandIndex) => command(entry, `${path}.normalizedVerificationCommands[${commandIndex}]`)),
    };
    if (identity.originalVerificationResults.length === 0
      || identity.originalVerificationResults.some((entry, commandIndex) => {
        const expected = identity.originalVerificationCommands[commandIndex];
        return expected === undefined || entry.command !== expected.command || entry.required !== expected.required
          || entry.timeoutMs !== expected.timeoutMs;
      }) || !identity.originalVerificationResults.some((entry) => entry.exitCode !== 0 || entry.termination !== null)) {
      refuse(`${path} original verification results do not prove the legacy failure`);
    }
    const id = digest(item.id, `${path}.id`);
    if (id !== correctionVerificationRecoveryId(identity)) refuse(`${path}.id does not match its identity`);
    const attempts = item.attempts.map((rawAttempt, attemptIndex): ReviewCorrectionVerificationAttempt => {
      const attemptPath = `${path}.attempts[${attemptIndex}]`;
      const attempt = object(rawAttempt, ['attempt', 'startedAt', 'finishedAt', 'result', 'handoffSha256',
        'worktreeHeadSha', 'worktreeDiffFingerprint', 'commands'], attemptPath);
      if (attempt.attempt !== attemptIndex + 1 || (attempt.result !== 'passed' && attempt.result !== 'failed')
        || !Array.isArray(attempt.commands)) refuse(`${attemptPath} sequence/result is invalid`);
      const commands = attempt.commands.map((entry, commandIndex) => commandResult(entry, `${attemptPath}.commands[${commandIndex}]`));
      if (commands.some((entry, commandIndex) => {
        const expected = identity.normalizedVerificationCommands[commandIndex];
        return expected === undefined || entry.command !== expected.command || entry.required !== expected.required
          || entry.timeoutMs !== expected.timeoutMs;
      })) refuse(`${attemptPath} command evidence is not a canonical prefix`);
      const handoffSha256 = digest(attempt.handoffSha256, `${attemptPath}.handoffSha256`);
      const worktreeHeadSha = sha(attempt.worktreeHeadSha, `${attemptPath}.worktreeHeadSha`);
      const worktreeDiffFingerprint = digest(attempt.worktreeDiffFingerprint, `${attemptPath}.worktreeDiffFingerprint`);
      const passed = commands.length === identity.normalizedVerificationCommands.length
        && commands.every((entry) => entry.exitCode === 0 && entry.termination === null)
        && handoffSha256 === identity.handoffSha256 && worktreeHeadSha === identity.worktreeHeadSha
        && worktreeDiffFingerprint === identity.worktreeDiffFingerprint;
      if ((attempt.result === 'passed') !== passed) refuse(`${attemptPath} result conflicts with command/tree evidence`);
      return {
        attempt: attemptIndex + 1, startedAt: timestamp(attempt.startedAt, `${attemptPath}.startedAt`),
        finishedAt: timestamp(attempt.finishedAt, `${attemptPath}.finishedAt`), result: attempt.result,
        handoffSha256, worktreeHeadSha, worktreeDiffFingerprint,
        commands,
      };
    });
    if (attempts.slice(0, -1).some((attempt) => attempt.result === 'passed')) refuse(`${path} has attempts after success`);
    const correctionCommitSha = item.correctionCommitSha === undefined ? undefined : sha(item.correctionCommitSha, `${path}.correctionCommitSha`);
    if (correctionCommitSha !== undefined && attempts.at(-1)?.result !== 'passed') refuse(`${path} commit lacks passing verification`);
    return { id, ...identity, authorizedBy: 'human', authorizedAt: timestamp(item.authorizedAt, `${path}.authorizedAt`),
      attempts, ...(correctionCommitSha === undefined ? {} : { correctionCommitSha }) };
  });
  if (new Set(recoveries.map((entry) => entry.correctionTaskId)).size !== recoveries.length) {
    refuse('more than one recovery exists for a correction task');
  }
  return recoveries;
}
