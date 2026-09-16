import { join } from 'node:path';

import { loadAdaptivePhaseConfig, runtimePhaseConfig } from '../adaptive';
import type { CoordinatorReasoner, CoordinatorResult } from '../coordinator-core';
import { coordinate } from '../coordinator-core';
import {
  buildContextBundle,
  type ContextBuildResult,
  type RepositoryNavigationContext,
} from '../context-builder';
import { resolveRepositoryContextHints } from '../context/repository-context';
import { OrchestratorError } from '../errors';
import { diagnoseFailure } from '../failure-intelligence/classifier';
import type { FailureDiagnosis } from '../failure-intelligence/types';
import { getRelevantMemory, type MemoryReader } from '../memory-graph';
import { MemoryStore, type MemorySubject } from '../memory';
import { applyRecoveryPolicyOverlay } from '../recovery/policy';
import { applyReplanOverlays } from '../replan/model';
import { applyReviewCorrectionOverlays } from '../review/correction-continuation';
import { matchCapabilities, type CapabilityProfile } from '../role-capabilities';
import { StateStore } from '../state';
import { loadAnyPhaseConfig } from '../workflow/solver-verifier';

export interface CapableCoordinatorReasoner extends CoordinatorReasoner {
  readonly capabilityProfile: CapabilityProfile;
}

export interface ShadowCoordinatorReport {
  readonly version: 1;
  readonly mode: 'shadow';
  readonly authoritative: false;
  readonly executed: false;
  readonly persisted: false;
  readonly result: CoordinatorResult;
}

export class ShadowCoordinatorError extends Error {
  constructor(readonly code: 'CAPABILITY_MISMATCH', message: string) {
    super(message);
    this.name = 'ShadowCoordinatorError';
  }
}

export interface BuildShadowContextOptions {
  readonly repositoryRoot: string;
  readonly runId: string;
  readonly taskId?: string;
  readonly memoryReader?: MemoryReader;
}

/** Read-only composition of persisted run truth, diagnosis, Memory, and optional Graph Context. */
export async function buildShadowContextForRun(
  options: BuildShadowContextOptions,
): Promise<ContextBuildResult> {
  const store = new StateStore(join(options.repositoryRoot, 'tools/agent-orchestrator/runs'), options.runId);
  const state = await store.load();
  const baseConfig = state.strategy === 'adaptive'
    ? runtimePhaseConfig(await loadAdaptivePhaseConfig(join(store.runDirectory, 'phase.yaml')), state.adaptive!)
    : await loadAnyPhaseConfig(join(store.runDirectory, 'phase.yaml'));
  const recoveredConfig = applyRecoveryPolicyOverlay(baseConfig, state.recoveryPolicyHistory?.at(-1)?.policy);
  const config = state.strategy === 'adaptive' ? recoveredConfig
    : applyReviewCorrectionOverlays(applyReplanOverlays(recoveredConfig, state), state);

  if (options.taskId !== undefined
    && (state.tasks[options.taskId] === undefined
      || !config.tasks.some((candidate) => candidate.id === options.taskId))) {
    throw new OrchestratorError('TASK_STATE_INVALID',
      `Shadow Coordinator cannot resolve requested task ${options.taskId} from trusted run state`);
  }

  const diagnosis = await diagnoseFailure({
    store,
    state,
    config,
    ...(options.taskId === undefined ? {} : { taskId: options.taskId }),
  });
  const subject = subjectForDiagnosis(diagnosis);
  const taskSpec = subject.kind === 'task'
    ? config.tasks.find((candidate) => candidate.id === subject.taskId)
    : undefined;
  const repositoryContext: RepositoryNavigationContext | null = taskSpec === undefined
    ? null
    : resolveRepositoryContextHints(options.repositoryRoot, { task: taskSpec });
  const memoryReader = options.memoryReader ?? new MemoryStore(options.repositoryRoot);
  const relevantMemory = await getRelevantMemory(memoryReader, { subject });
  return buildContextBundle({
    runId: options.runId,
    subject,
    diagnosis,
    relevantMemory,
    repositoryContext,
  });
}

export async function coordinateShadowContext(
  context: ContextBuildResult,
  reasoner: CapableCoordinatorReasoner,
): Promise<ShadowCoordinatorReport> {
  const compatibility = matchCapabilities('coordinator', reasoner.capabilityProfile);
  if (compatibility.status !== 'satisfied') {
    throw new ShadowCoordinatorError('CAPABILITY_MISMATCH',
      `Coordinator adapter is missing: ${compatibility.missing.join(', ')}`);
  }
  const result = await coordinate(context, reasoner);
  return Object.freeze({
    version: 1,
    mode: 'shadow',
    authoritative: false,
    executed: false,
    persisted: false,
    result,
  });
}

export async function coordinateShadowRun(
  options: BuildShadowContextOptions & { readonly reasoner: CapableCoordinatorReasoner },
): Promise<ShadowCoordinatorReport> {
  const context = await buildShadowContextForRun(options);
  return coordinateShadowContext(context, options.reasoner);
}

function subjectForDiagnosis(diagnosis: FailureDiagnosis): MemorySubject {
  if (diagnosis.subject.kind === 'task') {
    if (diagnosis.subject.taskId === undefined) {
      throw new OrchestratorError('STATE_CORRUPT', 'Task diagnosis is missing taskId');
    }
    return { kind: 'task', taskId: diagnosis.subject.taskId };
  }
  return { kind: diagnosis.subject.kind };
}
