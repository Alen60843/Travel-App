import type { ContextActionCandidate, ContextBuildResult, ContextBundle,
  ContextMemoryFacts, ContextScope } from '../context-builder/types';
import type { MemorySubject } from '../memory/types';
import { parseCoordinatorProposal } from './proposal';
import type { CoordinatorDecision, CoordinatorProposal, CoordinatorReasoner,
  CoordinatorReference, CoordinatorResult } from './types';

function cloneSubject(subject: MemorySubject): MemorySubject {
  return subject.kind === 'task' ? { kind: 'task', taskId: subject.taskId } : { kind: subject.kind };
}

function cloneScope(scope: ContextScope): ContextScope {
  return { runId: scope.runId, subject: cloneSubject(scope.subject) };
}

function cloneReference(reference: CoordinatorReference): CoordinatorReference {
  if (reference.kind === 'current_evidence') return { kind: reference.kind, reference: reference.reference };
  if (reference.kind === 'memory') return { kind: reference.kind, memoryId: reference.memoryId };
  return { kind: reference.kind, path: reference.path };
}

function cloneAction(action: ContextActionCandidate): ContextActionCandidate {
  return {
    version: action.version,
    actionId: action.actionId,
    subject: action.subject.kind === 'task'
      ? { kind: 'task', ...(action.subject.taskId === undefined ? {} : { taskId: action.subject.taskId }) }
      : { kind: action.subject.kind },
    mutatesState: action.mutatesState,
    execution: action.execution,
    authority: { kind: action.authority.kind, required: action.authority.required },
    basis: {
      classification: action.basis.classification,
      evidenceReferences: [...action.basis.evidenceReferences],
    },
  };
}

function sameTexts(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameAction(left: ContextActionCandidate, right: ContextActionCandidate): boolean {
  return left.version === right.version
    && left.actionId === right.actionId
    && left.subject.kind === right.subject.kind
    && left.subject.taskId === right.subject.taskId
    && left.mutatesState === right.mutatesState
    && left.execution === right.execution
    && left.authority.kind === right.authority.kind
    && left.authority.required === right.authority.required
    && left.basis.classification === right.basis.classification
    && sameTexts(left.basis.evidenceReferences, right.basis.evidenceReferences);
}

function memoryIds(facts: ContextMemoryFacts): readonly string[] {
  return [
    ...facts.failures,
    ...facts.actionCandidates,
    ...facts.outcomes,
    ...facts.decisions,
    ...facts.invariants,
  ].map((fact) => fact.memoryId);
}

function referencesExist(references: readonly CoordinatorReference[], context: ContextBundle): boolean {
  const currentEvidence = new Set([
    ...context.current.diagnosis.evidence.map((entry) => entry.reference),
    ...context.current.actionCandidates.flatMap((action) => action.basis.evidenceReferences),
  ]);
  const memory = new Set([
    ...memoryIds(context.memory.currentRun),
    ...context.memory.historicalRuns.flatMap((run) => memoryIds(run.facts)),
    ...memoryIds(context.memory.repositoryScoped),
  ]);
  const repositoryHints = new Set(context.repository.status === 'available'
    ? context.repository.hints.map((hint) => hint.path)
    : []);
  return references.every((reference) => {
    if (reference.kind === 'current_evidence') return currentEvidence.has(reference.reference);
    if (reference.kind === 'memory') return memory.has(reference.memoryId);
    return repositoryHints.has(reference.path);
  });
}

function currentAction(actionId: string, context: ContextBundle): ContextActionCandidate | undefined {
  const matches = context.current.actionCandidates.filter((candidate) => candidate.actionId === actionId);
  if (matches.length === 0) return undefined;
  const first = matches[0]!;
  if (matches.some((candidate) => !sameAction(candidate, first))) return undefined;
  return first;
}

function validateProposal(proposal: CoordinatorProposal, context: ContextBundle): CoordinatorDecision | undefined {
  if (!referencesExist(proposal.supportingReferences, context)) return undefined;
  const base = {
    version: 1 as const,
    scope: cloneScope(context.scope),
    reason: proposal.reason,
    supportingReferences: proposal.supportingReferences.map(cloneReference),
  };
  const status = context.current.diagnosis.status;
  if (status === 'no_active_failure') {
    return proposal.decision === 'no_action' ? { ...base, kind: 'NO_ACTION' } : undefined;
  }
  if (status === 'unknown') {
    return proposal.decision === 'human_required' ? { ...base, kind: 'HUMAN_REQUIRED' } : undefined;
  }
  if (proposal.decision === 'human_required') return { ...base, kind: 'HUMAN_REQUIRED' };
  if (proposal.decision !== 'select_action') return undefined;
  const selectedAction = currentAction(proposal.actionId, context);
  return selectedAction === undefined
    ? undefined
    : { ...base, kind: 'SELECT_ACTION', selectedAction: cloneAction(selectedAction) };
}

/**
 * Runs one untrusted reasoning call, then deterministically validates its bounded proposal.
 * This function performs no I/O, persistence, authorization, routing, or action execution.
 */
export async function coordinate(
  contextResult: ContextBuildResult,
  reasoner: CoordinatorReasoner,
): Promise<CoordinatorResult> {
  if (contextResult.status === 'limit_exceeded') {
    return {
      version: 1,
      status: 'context_unavailable',
      scope: cloneScope(contextResult.scope),
      reason: 'limit_exceeded',
      limit: { ...contextResult.limit },
    };
  }

  const trustedContext = structuredClone(contextResult);
  let rawProposal: unknown;
  try {
    rawProposal = await reasoner.propose(structuredClone(trustedContext));
  } catch {
    return { version: 1, status: 'reasoner_failed', scope: cloneScope(trustedContext.scope), code: 'REASONER_ERROR' };
  }

  let proposal: CoordinatorProposal;
  try {
    proposal = parseCoordinatorProposal(rawProposal);
  } catch {
    return { version: 1, status: 'reasoner_failed', scope: cloneScope(trustedContext.scope), code: 'PROPOSAL_INVALID' };
  }
  const decision = validateProposal(proposal, trustedContext);
  return decision === undefined
    ? { version: 1, status: 'reasoner_failed', scope: cloneScope(trustedContext.scope), code: 'PROPOSAL_INVALID' }
    : { version: 1, status: 'decided', decision };
}
