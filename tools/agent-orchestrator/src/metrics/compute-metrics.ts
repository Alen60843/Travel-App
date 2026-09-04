import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { PhaseConfig } from '../config';
import { validateHandoff, type StructuredHandoff } from '../handoff';
import { validateReview, type StructuredReview } from '../review/findings';
import type { RunState, TaskRunState } from '../state';
import { SEMANTIC_ROLE_BY_TASK_MODE, type SolverVerifierRole } from '../workflow/solver-verifier';

/**
 * §10: run metrics, computed on demand from what the orchestrator already
 * persists — no new fields were added to the execution path's write-critical
 * state for this. `run.json`/`phase.yaml`/`events.jsonl`/handoffs/reviews
 * already carry everything genuinely available; this module only reshapes
 * it into the questions §10 asks future analysis to answer:
 *
 *   verifier precision  = confirmedFindings / totalFindings
 *   escalation rate      = runs with an escalation task / total runs (across a set of RunMetrics)
 *   avg correction rounds
 *   success rate by provider / model / role / effort / task type
 *
 * tokensUsed and costUsd are ALWAYS null. Neither adapter's invocation
 * (claude -p --output-format text; codex exec) exposes structured usage
 * data through the single JSON handoff/review object this orchestrator reads
 * from stdout — there is no wrapper carrying it. Inventing a number here
 * would be worse than the honest "unknown" the brief explicitly asks for.
 */

export interface TaskMetrics {
  readonly taskId: string;
  readonly role: SolverVerifierRole;
  readonly mode: string;
  readonly agent: string | null;
  readonly model: string | null;
  readonly effort: string;
  readonly status: string;
  /**
   * True iff an agent was actually invoked for this task — i.e. status is
   * something other than the still-pending states or SKIPPED. This is the
   * field that lets analysis distinguish "ran and did nothing" (the old,
   * incorrect always-run behavior this correction pass replaced) from
   * "correctly never ran" (SKIPPED): a skipped task is never `executed`,
   * regardless of what its condition's reason says.
   */
  readonly executed: boolean;
  /** Present only when status is SKIPPED. */
  readonly skipReason: string | null;
  /**
   * §7 (real Phase 5 dogfood recovery): the AGENT PROCESS's own outcome —
   * derived from the last recorded agentAttempts entry, not from whether the
   * task's structured output later validated. Distinguishing this from
   * handoffOutcome below is the entire point: a task can have
   * implementationOutcome 'succeeded' and still end up FAILED because its
   * handoff never became valid (handoffOutcome 'invalid', even after a
   * repair attempt) — that is a protocol failure, not an implementation one.
   * Null only when the task never reached an agent attempt at all (e.g.
   * still PENDING, or SKIPPED before any invocation).
   */
  readonly implementationOutcome: 'succeeded' | 'failed' | 'timed_out' | 'aborted' | null;
  /** Whether the task's structured output was ultimately schema-valid, whether directly or only after a repair. Null if no handoff/review parse was ever attempted. */
  readonly handoffOutcome: 'valid' | 'invalid' | null;
  /** Whether a bounded handoff-repair attempt (deterministic and/or one read-only agent call) was made. */
  readonly handoffRepairAttempted: boolean;
  /** Present only when handoffRepairAttempted is true. */
  readonly handoffRepairSucceeded: boolean | null;
  readonly attempts: number;
  readonly durationMs: number | null;
  readonly findingsProduced: number;
  readonly confirmedFindings: number;
  readonly rejectedFindings: number;
  readonly tokensUsed: null;
  readonly costUsd: null;
}

const NOT_YET_EXECUTED_STATUSES = new Set(['PENDING', 'READY', 'RUNNING', 'SKIPPED']);

export interface DeterministicGateCommandMetrics {
  readonly command: string;
  readonly required: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

export interface RunMetrics {
  readonly runId: string;
  readonly phase: number | string;
  readonly runStatus: string;
  readonly tasks: readonly TaskMetrics[];
  readonly totalFindingsProduced: number;
  readonly totalConfirmedFindings: number;
  readonly totalRejectedFindings: number;
  /** null when the ratio is undefined (zero findings produced). */
  readonly verifierPrecision: number | null;
  readonly correctionRounds: number;
  readonly escalationOccurred: boolean;
  readonly escalationResolved: boolean | null;
  /**
   * §9's named convenience view over `tasks`, for the well-known generated
   * task ids only (solve/verify/fix/reverify/judge — see
   * workflow/solver-verifier.ts). `null` when a run doesn't use that
   * generated shape at all (e.g. a hand-authored generic phase file) rather
   * than defaulting to false, which would misleadingly claim "did not run"
   * for a role that was never applicable.
   */
  readonly roleExecution: {
    readonly solverExecuted: boolean | null;
    readonly verifierExecuted: boolean | null;
    readonly fixerExecuted: boolean | null;
    readonly judgeExecuted: boolean | null;
  };
  readonly deterministicGate: {
    readonly ran: boolean;
    readonly passed: boolean | null;
    readonly commands: readonly DeterministicGateCommandMetrics[];
  };
}

async function readJsonIfPresent(path: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

async function readHandoffIfPresent(path: string | undefined): Promise<StructuredHandoff | undefined> {
  if (path === undefined) return undefined;
  const raw = await readJsonIfPresent(path);
  return raw === undefined ? undefined : validateHandoff(raw);
}

async function readReviewIfPresent(path: string | undefined): Promise<StructuredReview | undefined> {
  if (path === undefined) return undefined;
  const raw = await readJsonIfPresent(path);
  return raw === undefined ? undefined : validateReview(raw);
}

function taskDurationMs(task: TaskRunState): number | null {
  const finished = task.agentAttempts.filter((attempt) => attempt.finishedAt !== undefined);
  if (finished.length === 0) return null;
  return finished.reduce((total, attempt) => {
    const start = Date.parse(attempt.startedAt);
    const end = Date.parse(attempt.finishedAt!);
    return total + Math.max(0, end - start);
  }, 0);
}

interface IntegrationCommandFinishedEvent {
  readonly command: string;
  readonly required: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  readonly durationMs: number;
}

async function readIntegrationCommandEvents(
  eventsPath: string,
): Promise<IntegrationCommandFinishedEvent[]> {
  let raw: string;
  try {
    raw = await readFile(eventsPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const events: IntegrationCommandFinishedEvent[] = [];
  for (const line of raw.split('\n')) {
    if (line.trim() === '') continue;
    const event = JSON.parse(line) as { name?: unknown; data?: Record<string, unknown> };
    if (event.name !== 'INTEGRATION_COMMAND_FINISHED' || event.data === undefined) continue;
    const data = event.data;
    events.push({
      command: String(data.command),
      required: data.required === true,
      exitCode: typeof data.exitCode === 'number' ? data.exitCode : null,
      timedOut: data.timedOut === true,
      durationMs: typeof data.durationMs === 'number' ? data.durationMs : 0,
    });
  }
  return events;
}

/**
 * Computes RunMetrics purely from artifacts already on disk under a single
 * run directory. Deliberately NOT wired into the orchestrator's execution
 * path — it can run against a completed, blocked, or still-running run
 * without any risk of perturbing that run's state.
 */
export async function computeRunMetrics(
  runDirectory: string,
  state: RunState,
  config: PhaseConfig,
): Promise<RunMetrics> {
  const taskById = new Map(config.tasks.map((task) => [task.id, task]));
  const tasks: TaskMetrics[] = [];
  let totalFindingsProduced = 0;
  let totalConfirmedFindings = 0;
  let totalRejectedFindings = 0;
  let correctionRounds = 0;
  let escalationOccurred = false;
  let escalationResolved: boolean | null = null;

  for (const [taskId, runState] of Object.entries(state.tasks)) {
    const spec = taskById.get(taskId);
    const mode = spec?.mode ?? 'unknown';
    const role: SolverVerifierRole =
      spec !== undefined && spec.mode in SEMANTIC_ROLE_BY_TASK_MODE
        ? SEMANTIC_ROLE_BY_TASK_MODE[spec.mode as keyof typeof SEMANTIC_ROLE_BY_TASK_MODE]
        : 'SOLVER';

    const handoff = await readHandoffIfPresent(runState.handoffPath);
    const review = await readReviewIfPresent(runState.reviewPaths.at(-1));

    let findingsProduced = 0;
    let confirmedFindings = 0;
    let rejectedFindings = 0;
    if (review !== undefined) {
      findingsProduced = review.findings.length;
      totalFindingsProduced += findingsProduced;
    }
    if (handoff?.findingResponses !== undefined) {
      confirmedFindings = handoff.findingResponses.filter((r) => r.decision === 'confirmed').length;
      rejectedFindings = handoff.findingResponses.filter((r) => r.decision === 'rejected').length;
      totalConfirmedFindings += confirmedFindings;
      totalRejectedFindings += rejectedFindings;
    }
    if (mode === 'correction' && runState.status === 'SUCCEEDED') {
      correctionRounds += 1;
    }
    if (mode === 'escalation') {
      escalationOccurred = runState.status === 'SUCCEEDED' || runState.status === 'BLOCKED';
      if (runState.status === 'SUCCEEDED') escalationResolved = true;
      else if (runState.status === 'BLOCKED') escalationResolved = false;
    }

    const lastAttempt = runState.agentAttempts.at(-1);
    tasks.push({
      taskId,
      role,
      mode,
      agent: lastAttempt?.agent ?? spec?.owner ?? null,
      model: spec?.model ?? null,
      effort: spec?.effort ?? 'unknown',
      status: runState.status,
      executed: !NOT_YET_EXECUTED_STATUSES.has(runState.status),
      skipReason: runState.status === 'SKIPPED' ? (runState.skipReason ?? null) : null,
      implementationOutcome: lastAttempt?.outcome ?? null,
      handoffOutcome: runState.handoffOutcome ?? null,
      handoffRepairAttempted: runState.handoffRepairAttempts.length > 0,
      handoffRepairSucceeded: runState.handoffRepairAttempts.length > 0
        ? (runState.handoffRepairAttempts.at(-1)!.succeeded)
        : null,
      attempts: runState.agentAttempts.length,
      durationMs: taskDurationMs(runState),
      findingsProduced,
      confirmedFindings,
      rejectedFindings,
      tokensUsed: null,
      costUsd: null,
    });
  }

  const executedById = new Map(tasks.map((task) => [task.taskId, task.executed]));
  const roleExecution = {
    solverExecuted: executedById.get('solve') ?? null,
    verifierExecuted: executedById.get('verify') ?? null,
    fixerExecuted: executedById.get('fix') ?? null,
    judgeExecuted: executedById.get('judge') ?? null,
  };

  const commands = (await readIntegrationCommandEvents(join(runDirectory, 'events.jsonl'))).map(
    (event): DeterministicGateCommandMetrics => ({
      command: event.command,
      required: event.required,
      exitCode: event.exitCode,
      timedOut: event.timedOut,
      durationMs: event.durationMs,
    }),
  );
  const requiredCommands = commands.filter((command) => command.required);
  const gateRan = commands.length > 0;
  const gatePassed = gateRan
    ? requiredCommands.every((command) => command.exitCode === 0 && !command.timedOut)
    : null;

  return {
    runId: state.runId,
    phase: state.phase,
    runStatus: state.status,
    tasks,
    totalFindingsProduced,
    totalConfirmedFindings,
    totalRejectedFindings,
    verifierPrecision:
      totalFindingsProduced === 0 ? null : totalConfirmedFindings / totalFindingsProduced,
    correctionRounds,
    escalationOccurred,
    escalationResolved,
    roleExecution,
    deterministicGate: { ran: gateRan, passed: gatePassed, commands },
  };
}
