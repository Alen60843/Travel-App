import { readFile } from 'node:fs/promises';

import { parseDocument } from 'yaml';

import {
  boundedInteger,
  invalid,
  isRecord,
  nonEmptyString,
  parseIntegration,
  parsePhaseConfig,
  repositoryRelativePath,
  type IntegrationConfig,
  type PhaseConfig,
} from '../config';
import { OrchestratorError } from '../errors';
import { FINDING_SEVERITIES, type FindingSeverity } from '../review/findings';
import {
  AGENT_NAMES,
  EFFORT_LEVELS,
  type AgentName,
  type EffortLevel,
  type TaskCondition,
} from '../tasks/task-schema';

/**
 * §2/§11: the SOLVER / VERIFIER / FIXER / JUDGE semantic-role vocabulary,
 * expressed as a small declarative phase-file shorthand rather than a second
 * execution engine.
 *
 * This module does exactly one thing: turn a `workflow: solver_verifier`
 * phase file into the SAME `PhaseConfig` shape `config.ts` already produces
 * from a raw task list, by generating that task list deterministically and
 * running it through the existing `parsePhaseConfig` validator (DAG-cycle
 * check, ownership-overlap check, everything else included, for free). The
 * generated tasks are executed by the unmodified `AgentOrchestrator` — there
 * is no second scheduler, no parallel state machine, and no bespoke
 * execution path for this mode.
 *
 * A future `solverPool: Agent[]` only needs to change what this module
 * generates (e.g. one solve-N task per pool member feeding a shared verify),
 * not how the engine runs it.
 */

export const SOLVER_VERIFIER_ROLES = [
  'SOLVER',
  'VERIFIER',
  'FIXER',
  'JUDGE',
  'INTEGRATOR',
] as const;
export type SolverVerifierRole = (typeof SOLVER_VERIFIER_ROLES)[number];

/**
 * The engine's own vocabulary (TaskMode) IS the role — this is a read-only
 * mapping for documentation, metrics, and config validation, not a second
 * classification system. INTEGRATOR has no generated task: it maps onto the
 * orchestrator's own automatic deterministic gate (state.integration /
 * IntegrationGate), which runs unconditionally once every task succeeds. A
 * phase that also wants an agent-driven Lead composition step (the generic
 * engine's `integration`-mode task) adds one by hand in a raw task list —
 * this shorthand does not generate one.
 */
export const SEMANTIC_ROLE_BY_TASK_MODE = {
  implementation: 'SOLVER',
  review: 'VERIFIER',
  correction: 'FIXER',
  final_review: 'VERIFIER',
  escalation: 'JUDGE',
  integration: 'INTEGRATOR',
  debate: 'SOLVER',
} as const;

export interface WorkflowAgentSpec {
  readonly agent: AgentName;
  readonly model?: string;
  readonly effort: EffortLevel;
}

export interface WorkflowEscalationSpec {
  readonly enabled: boolean;
  readonly agent: AgentName;
  readonly model?: string;
  readonly effort: EffortLevel;
  /**
   * §5 MVP default: 'high'. Medium/low findings alone must not invoke the
   * expensive Judge — set this lower only as a deliberate, explicit opt-in,
   * never silently.
   */
  readonly minimumSeverity: FindingSeverity;
}

export interface SolverVerifierWorkflow {
  readonly mode: 'solver_verifier';
  /** Ownership globs shared by the generated solve and fix tasks. */
  readonly files: readonly string[];
  readonly solver: WorkflowAgentSpec;
  readonly verifier: WorkflowAgentSpec;
  readonly correction: WorkflowAgentSpec;
  /**
   * §6 MVP bound: 0 (no correction round: solve -> verify -> gate; a
   * changes_requested/blocked verify simply stops the run for a human, same
   * as any other phase) or 1 (solve -> verify -> [fix -> reverify]). Anything
   * higher is rejected outright rather than silently clamped — "no endless
   * conversations" is enforced at parse time, not by convention.
   */
  readonly maxCorrectionRounds: 0 | 1;
  readonly escalation?: WorkflowEscalationSpec;
}

export interface SolverVerifierPhaseFile {
  readonly phase: number | string;
  readonly name: string;
  readonly baseBranch: string;
  readonly canonicalDesignDocument?: string;
  readonly concurrency?: number;
  readonly agentRetries?: number;
  readonly agentTimeoutMs?: number;
  readonly workflow: SolverVerifierWorkflow;
  readonly deterministicGate: IntegrationConfig;
}

const TOP_LEVEL_KEYS = new Set([
  'phase',
  'name',
  'baseBranch',
  'canonicalDesignDocument',
  'concurrency',
  'agentRetries',
  'agentTimeoutMs',
  'workflow',
  'deterministicGate',
]);
const WORKFLOW_KEYS = new Set([
  'mode',
  'files',
  'solver',
  'verifier',
  'correction',
  'maxCorrectionRounds',
  'escalation',
]);
const AGENT_SPEC_KEYS = new Set(['agent', 'model', 'effort']);
const ESCALATION_KEYS = new Set(['enabled', 'agent', 'model', 'effort', 'minimumSeverity']);

function stringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) {
    invalid(path, 'must be an array');
  }
  return value.map((entry, index) => nonEmptyString(entry, `${path}[${index}]`));
}

function parseAgentSpec(value: unknown, path: string): WorkflowAgentSpec {
  if (!isRecord(value)) {
    invalid(path, 'must be an object');
  }
  assertOnlyKnownKeys(value, AGENT_SPEC_KEYS, path);
  const agent = nonEmptyString(value.agent, `${path}.agent`);
  if (!(AGENT_NAMES as readonly string[]).includes(agent)) {
    invalid(`${path}.agent`, `must be one of ${AGENT_NAMES.join(', ')}`);
  }
  const effort = nonEmptyString(value.effort ?? 'high', `${path}.effort`);
  if (!(EFFORT_LEVELS as readonly string[]).includes(effort)) {
    invalid(`${path}.effort`, `must be one of ${EFFORT_LEVELS.join(', ')}`);
  }
  const model = value.model === undefined ? undefined : nonEmptyString(value.model, `${path}.model`);
  return {
    agent: agent as AgentName,
    effort: effort as EffortLevel,
    ...(model === undefined ? {} : { model }),
  };
}

function parseEscalation(value: unknown, path: string): WorkflowEscalationSpec | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) {
    invalid(path, 'must be an object');
  }
  assertOnlyKnownKeys(value, ESCALATION_KEYS, path);
  const enabled = value.enabled;
  if (typeof enabled !== 'boolean') {
    invalid(`${path}.enabled`, 'must be a boolean');
  }
  const base = parseAgentSpec(
    { agent: value.agent, model: value.model, effort: value.effort },
    path,
  );
  const minimumSeverity = nonEmptyString(value.minimumSeverity ?? 'high', `${path}.minimumSeverity`);
  if (!(FINDING_SEVERITIES as readonly string[]).includes(minimumSeverity)) {
    invalid(`${path}.minimumSeverity`, `must be one of ${FINDING_SEVERITIES.join(', ')}`);
  }
  return { enabled, ...base, minimumSeverity: minimumSeverity as FindingSeverity };
}

function assertOnlyKnownKeys(
  value: Record<string, unknown>,
  allowed: ReadonlySet<string>,
  path: string,
): void {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      invalid(`${path}.${key}`, 'is not a supported field');
    }
  }
}

function parseWorkflow(value: unknown): SolverVerifierWorkflow {
  const path = 'workflow';
  if (!isRecord(value)) {
    invalid(path, 'must be an object');
  }
  assertOnlyKnownKeys(value, WORKFLOW_KEYS, path);
  const mode = nonEmptyString(value.mode, `${path}.mode`);
  if (mode !== 'solver_verifier') {
    invalid(`${path}.mode`, 'must be "solver_verifier" (the only supported workflow mode)');
  }
  const files = stringArray(value.files, `${path}.files`);
  if (files.length === 0) {
    invalid(`${path}.files`, 'must declare at least one ownership glob for the solver/fixer');
  }
  const maxCorrectionRounds = boundedInteger(
    value.maxCorrectionRounds ?? 1,
    `${path}.maxCorrectionRounds`,
    0,
    1,
  );
  return {
    mode: 'solver_verifier',
    files,
    solver: parseAgentSpec(value.solver, `${path}.solver`),
    verifier: parseAgentSpec(value.verifier, `${path}.verifier`),
    correction: parseAgentSpec(value.correction, `${path}.correction`),
    maxCorrectionRounds: maxCorrectionRounds as 0 | 1,
    ...(parseEscalation(value.escalation, `${path}.escalation`) === undefined
      ? {}
      : { escalation: parseEscalation(value.escalation, `${path}.escalation`)! }),
  };
}

/** Validate a decoded YAML/JSON value shaped as a solver_verifier phase file. */
export function parseSolverVerifierPhaseFile(value: unknown): SolverVerifierPhaseFile {
  if (!isRecord(value)) {
    invalid('$', 'phase configuration must be an object');
  }
  assertOnlyKnownKeys(value, TOP_LEVEL_KEYS, '$');
  const phase = value.phase;
  if (
    !(
      (typeof phase === 'number' && Number.isSafeInteger(phase) && phase > 0) ||
      (typeof phase === 'string' && phase.trim() !== '')
    )
  ) {
    invalid('phase', 'must be a positive integer or non-empty string');
  }
  const baseBranch = nonEmptyString(value.baseBranch, 'baseBranch');
  if (baseBranch.startsWith('-') || /[ -]/.test(baseBranch)) {
    invalid('baseBranch', 'contains unsafe branch-name characters');
  }
  const canonicalDesignDocument =
    value.canonicalDesignDocument === undefined
      ? undefined
      : repositoryRelativePath(value.canonicalDesignDocument, 'canonicalDesignDocument');
  return {
    phase: typeof phase === 'string' ? phase.trim() : phase,
    name: nonEmptyString(value.name, 'name'),
    baseBranch,
    ...(canonicalDesignDocument === undefined ? {} : { canonicalDesignDocument }),
    ...(value.concurrency === undefined
      ? {}
      : { concurrency: boundedInteger(value.concurrency, 'concurrency', 1, 16) }),
    ...(value.agentRetries === undefined
      ? {}
      : { agentRetries: boundedInteger(value.agentRetries, 'agentRetries', 0, 5) }),
    ...(value.agentTimeoutMs === undefined
      ? {}
      : {
          agentTimeoutMs: boundedInteger(
            value.agentTimeoutMs,
            'agentTimeoutMs',
            1_000,
            24 * 60 * 60 * 1_000,
          ),
        }),
    workflow: parseWorkflow(value.workflow),
    deterministicGate: parseIntegration(value.deterministicGate ?? {}),
  };
}

interface GeneratedTask {
  readonly id: string;
  readonly title: string;
  readonly owner: AgentName;
  readonly model?: string;
  readonly effort: EffortLevel;
  readonly mode: string;
  readonly files: readonly string[];
  readonly dependsOn: readonly string[];
  readonly condition?: TaskCondition;
}

function agentTask(
  id: string,
  title: string,
  mode: string,
  spec: WorkflowAgentSpec,
  files: readonly string[],
  dependsOn: readonly string[],
  condition?: TaskCondition,
): GeneratedTask {
  return {
    id,
    title,
    owner: spec.agent,
    effort: spec.effort,
    mode,
    files,
    dependsOn,
    ...(spec.model === undefined ? {} : { model: spec.model }),
    ...(condition === undefined ? {} : { condition }),
  };
}

/**
 * Expand a validated solver_verifier phase file into the exact task graph
 * `parsePhaseConfig` (the generic, unmodified engine) already understands:
 *
 *   solve (implementation)
 *     -> verify (review)
 *        -> [fix (correction) -> reverify (final_review)]   graph edge iff maxCorrectionRounds === 1
 *           -> judge (escalation)                            graph edge iff escalation.enabled
 *
 * `maxReviewRounds` on the resulting PhaseConfig is derived, not configured
 * separately: one review round per generated review/final_review task, which
 * is exactly what bounds the correction loop to `maxCorrectionRounds`.
 *
 * CONDITIONAL EXECUTION: `fix`, `reverify`, and `judge` are graph edges (so
 * ownership/DAG validation and commit ordering are unconditional and simple),
 * but each carries a `condition` (task-schema.ts's TaskCondition) gating
 * whether it actually RUNS. AgentOrchestrator evaluates the condition against
 * an already-persisted, validated review artifact — before creating a
 * worktree or invoking an agent — and transitions the task straight to the
 * terminal SKIPPED state when it is not satisfied:
 *
 *   fix.condition      = skip when verify approved
 *   reverify.condition = skip when verify approved (same signal as fix — if
 *                        there was nothing to correct, there is nothing to
 *                        re-review either)
 *   judge.condition    = skip when reverify approved (regardless of why: a
 *                        skipped reverify has no review artifact to satisfy
 *                        "not approved", so a fully clean run skips judge
 *                        too, transitively)
 *
 * Whether reverify's OWN non-approved outcome is even allowed to reach
 * SUCCEEDED (rather than hard-failing as BLOCKED_FOR_HUMAN_REVIEW) is a
 * SEPARATE decision made in orchestrator.ts's finishReview, gated on
 * workflow.escalation.minimumSeverity (§5 MVP default 'high') — judge only
 * ever becomes reachable at all when that gate already passed, so its own
 * condition only needs to distinguish "reverify approved" (skip) from
 * "reverify was let through specifically for escalation" (run).
 */
export function expandSolverVerifierWorkflow(file: SolverVerifierPhaseFile): PhaseConfig {
  const { workflow } = file;
  const tasks: GeneratedTask[] = [
    agentTask('solve', 'Solver implementation', 'implementation', workflow.solver, workflow.files, []),
    agentTask('verify', 'Adversarial Verifier review', 'review', workflow.verifier, [], ['solve']),
  ];

  const skipIfVerifyApproved: TaskCondition = { reviewOf: 'verify', skipIfStatus: ['approved'] };

  let lastReviewId = 'verify';
  if (workflow.maxCorrectionRounds === 1) {
    tasks.push(
      agentTask(
        'fix',
        'Fixer correction (CONFIRMED/REJECTED per finding)',
        'correction',
        workflow.correction,
        workflow.files,
        ['verify'],
        skipIfVerifyApproved,
      ),
      agentTask(
        'reverify',
        'Verifier re-review',
        'final_review',
        workflow.verifier,
        [],
        ['fix'],
        skipIfVerifyApproved,
      ),
    );
    lastReviewId = 'reverify';
  }

  if (workflow.escalation?.enabled === true) {
    // Only reachable once maxCorrectionRounds === 1: escalation exists to
    // arbitrate a disagreement that survived one correction round, so an
    // escalation dependent on the FIRST-pass `verify` (with no fix/reverify
    // in between) is rejected below rather than silently accepted.
    if (lastReviewId !== 'reverify') {
      invalid(
        'workflow.escalation',
        'escalation requires maxCorrectionRounds: 1 (there must be a corrected re-review to arbitrate)',
      );
    }
    tasks.push(
      agentTask(
        'judge',
        'Judge arbitration (single bounded escalation attempt)',
        'escalation',
        workflow.escalation,
        [],
        [lastReviewId],
        {
          reviewOf: 'reverify',
          skipIfStatus: ['approved'],
          minimumSeverity: workflow.escalation.minimumSeverity,
        },
      ),
    );
  }

  // maxReviewRounds must accommodate every generated review/final_review task
  // (verify, plus reverify when a correction round exists) — otherwise the
  // engine's own assertReviewRoundAllowed would reject the second round this
  // workflow just generated.
  const maxReviewRounds = workflow.maxCorrectionRounds === 1 ? 2 : 1;

  return parsePhaseConfig({
    phase: file.phase,
    name: file.name,
    baseBranch: file.baseBranch,
    ...(file.canonicalDesignDocument === undefined
      ? {}
      : { canonicalDesignDocument: file.canonicalDesignDocument }),
    ...(file.concurrency === undefined ? {} : { concurrency: file.concurrency }),
    maxReviewRounds,
    ...(file.agentRetries === undefined ? {} : { agentRetries: file.agentRetries }),
    ...(file.agentTimeoutMs === undefined ? {} : { agentTimeoutMs: file.agentTimeoutMs }),
    tasks,
    integration: file.deterministicGate,
  });
}

function looksLikeSolverVerifierFile(value: unknown): boolean {
  return isRecord(value) && isRecord(value.workflow);
}

/**
 * Loads a phase file that may be EITHER the existing generic shape (a raw
 * `tasks:` list) OR the `workflow: solver_verifier` shorthand, dispatching on
 * the presence of a top-level `workflow` key. Generic phase files (including
 * every existing one, e.g. phases/phase5.example.yaml) have no such key and
 * take the exact same path as before this module existed.
 */
export async function loadAnyPhaseConfig(path: string): Promise<PhaseConfig> {
  let source: string;
  try {
    source = await readFile(path, 'utf8');
  } catch (error) {
    throw new OrchestratorError('CONFIG_INVALID', `Could not read phase file: ${path}`, {
      cause: error,
      details: { path },
    });
  }
  let document;
  try {
    document = parseDocument(source, { prettyErrors: false, strict: true, uniqueKeys: true });
  } catch (error) {
    invalid('$', 'could not parse YAML', error);
  }
  if (document.errors.length > 0) {
    invalid('$', document.errors.map((error) => error.message).join('; '));
  }
  let decoded: unknown;
  try {
    decoded = document.toJS({ maxAliasCount: 0 });
  } catch (error) {
    invalid('$', 'could not decode YAML', error);
  }
  if (looksLikeSolverVerifierFile(decoded)) {
    return expandSolverVerifierWorkflow(parseSolverVerifierPhaseFile(decoded));
  }
  return parsePhaseConfig(decoded);
}
