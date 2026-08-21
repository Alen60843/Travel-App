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
  readonly attempts: number;
  readonly durationMs: number | null;
  readonly findingsProduced: number;
  readonly confirmedFindings: number;
  readonly rejectedFindings: number;
  readonly tokensUsed: null;
  readonly costUsd: null;
}

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
      attempts: runState.agentAttempts.length,
      durationMs: taskDurationMs(runState),
      findingsProduced,
      confirmedFindings,
      rejectedFindings,
      tokensUsed: null,
      costUsd: null,
    });
  }

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
    deterministicGate: { ran: gateRan, passed: gatePassed, commands },
  };
}
