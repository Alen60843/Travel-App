import { mapFailureToActions } from '../action-mapping/mapper';
import { canonicalJson } from '../canonical-json';
import { OrchestratorError } from '../errors';
import type { FailureDiagnosis } from '../failure-intelligence/types';
import type { MemoryGraphEdge, MemoryNodeRef } from '../memory-graph/types';
import type { JsonValue, MemoryEntry, MemorySubject } from '../memory/types';
import type { ContextActionCandidate, ContextBuildResult, ContextBuilderInput,
  ContextBundle, ContextMemoryFact, ContextMemoryFactOf, ContextMemoryFacts, ContextRepository,
  RepositoryNavigationHint } from './types';

export const MAX_CONTEXT_BUNDLE_CANONICAL_BYTES = 256 * 1024;

function corrupt(message: string): never {
  throw new OrchestratorError('STATE_CORRUPT', `Context builder: ${message}`);
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sameSubject(left: MemorySubject, right: MemorySubject): boolean {
  return canonicalJson(left) === canonicalJson(right);
}

function diagnosisSubject(diagnosis: FailureDiagnosis): MemorySubject {
  if (diagnosis.subject.kind === 'task') {
    if (diagnosis.subject.taskId === undefined) corrupt('task diagnosis is missing taskId');
    return { kind: 'task', taskId: diagnosis.subject.taskId };
  }
  if (diagnosis.subject.kind === 'integration') return { kind: 'integration' };
  return { kind: 'run' };
}

function cloneSubject(subject: MemorySubject): MemorySubject {
  return subject.kind === 'task' ? { kind: 'task', taskId: subject.taskId } : { kind: subject.kind };
}

function cloneDiagnosis(diagnosis: FailureDiagnosis): FailureDiagnosis {
  return {
    version: diagnosis.version,
    status: diagnosis.status,
    runId: diagnosis.runId,
    subject: diagnosis.subject.kind === 'task'
      ? { kind: 'task', ...(diagnosis.subject.taskId === undefined ? {} : { taskId: diagnosis.subject.taskId }) }
      : { kind: diagnosis.subject.kind },
    ...(diagnosis.classification === undefined ? {} : { classification: diagnosis.classification }),
    ...(diagnosis.variant === undefined ? {} : { variant: diagnosis.variant }),
    ...(diagnosis.agent === undefined ? {} : { agent: diagnosis.agent }),
    evidence: diagnosis.evidence.map((entry) => ({ ...entry })),
  };
}

function cloneDiagnosisSubject(subject: FailureDiagnosis['subject']): FailureDiagnosis['subject'] {
  return subject.kind === 'task'
    ? { kind: 'task', ...(subject.taskId === undefined ? {} : { taskId: subject.taskId }) }
    : { kind: subject.kind };
}

function projectActions(diagnosis: FailureDiagnosis): readonly ContextActionCandidate[] {
  return mapFailureToActions(diagnosis).map((candidate) => ({
    version: candidate.version,
    actionId: candidate.id,
    subject: cloneDiagnosisSubject(candidate.subject),
    mutatesState: candidate.mutatesState,
    execution: candidate.execution,
    authority: { ...candidate.authority },
    basis: {
      classification: candidate.basis.classification,
      evidenceReferences: [...candidate.basis.evidenceReferences],
    },
  })).sort((left, right) => compareText(left.actionId, right.actionId)
    || compareText(canonicalJson(left), canonicalJson(right)));
}

function repositoryContext(input: ContextBuilderInput['repositoryContext']): ContextRepository {
  if (input === null) return { status: 'unavailable', authority: 'navigation_only' };
  const hints: RepositoryNavigationHint[] = input.hints.map((hint) => ({
    path: hint.path,
    score: hint.score,
    reasons: [...hint.reasons].sort(compareText),
  }));
  hints.sort((left, right) => right.score - left.score
    || compareText(left.path, right.path)
    || compareText(canonicalJson(left.reasons), canonicalJson(right.reasons)));
  return {
    status: 'available',
    authority: 'navigation_only',
    hints,
    scannedFileCount: input.scannedFileCount,
    truncated: input.truncated,
    maxHints: input.maxHints,
  };
}

function cloneJson(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map((entry) => cloneJson(entry));
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).sort(([left], [right]) => compareText(left, right))
      .map(([key, entry]) => [key, cloneJson(entry)]));
  }
  return value;
}

function projectFact(entry: Extract<MemoryEntry, { readonly kind: 'FAILURE' }>): ContextMemoryFactOf<'FAILURE'>;
function projectFact(entry: Extract<MemoryEntry, { readonly kind: 'ACTION_CANDIDATE' }>): ContextMemoryFactOf<'ACTION_CANDIDATE'>;
function projectFact(entry: Extract<MemoryEntry, { readonly kind: 'OUTCOME' }>): ContextMemoryFactOf<'OUTCOME'>;
function projectFact(entry: Extract<MemoryEntry, { readonly kind: 'DECISION' }>): ContextMemoryFactOf<'DECISION'>;
function projectFact(entry: Extract<MemoryEntry, { readonly kind: 'INVARIANT' }>): ContextMemoryFactOf<'INVARIANT'>;
function projectFact(entry: MemoryEntry): ContextMemoryFact {
  const provenance = {
    sourceKind: entry.provenance.sourceKind,
    producerVersion: entry.provenance.producerVersion,
    ...(entry.provenance.runId === undefined ? {} : { runId: entry.provenance.runId }),
    ...(entry.provenance.taskId === undefined ? {} : { taskId: entry.provenance.taskId }),
    references: [...entry.provenance.references],
  };
  const subject = cloneSubject(entry.subject);
  if (entry.kind === 'FAILURE') {
    return { version: 1, memoryId: entry.id, kind: entry.kind, subject,
      data: { diagnosisVersion: entry.data.diagnosisVersion, classification: entry.data.classification,
        ...(entry.data.variant === undefined ? {} : { variant: entry.data.variant }),
        ...(entry.data.agent === undefined ? {} : { agent: entry.data.agent }) }, provenance };
  }
  if (entry.kind === 'ACTION_CANDIDATE') {
    return { version: 1, memoryId: entry.id, kind: entry.kind, subject,
      data: { actionVersion: entry.data.actionVersion, actionId: entry.data.actionId,
        mutatesState: entry.data.mutatesState, execution: entry.data.execution,
        authority: { kind: entry.data.authority.kind, required: entry.data.authority.required },
        basisClassification: entry.data.basisClassification,
        sourceFailureMemoryId: entry.data.sourceFailureMemoryId }, provenance };
  }
  if (entry.kind === 'OUTCOME') {
    return { version: 1, memoryId: entry.id, kind: entry.kind, subject,
      data: { sourceActionMemoryId: entry.data.sourceActionMemoryId, status: entry.data.status,
        ...(entry.data.resultCode === undefined ? {} : { resultCode: entry.data.resultCode }) }, provenance };
  }
  if (entry.kind === 'DECISION') {
    return { version: 1, memoryId: entry.id, kind: entry.kind, subject,
      data: { key: entry.data.key, value: cloneJson(entry.data.value), rationale: entry.data.rationale }, provenance };
  }
  return { version: 1, memoryId: entry.id, kind: entry.kind, subject,
    data: { key: entry.data.key, rule: cloneJson(entry.data.rule),
      ...(entry.data.rationale === undefined ? {} : { rationale: entry.data.rationale }) }, provenance };
}

function emptyFacts(): {
  failures: ContextMemoryFactOf<'FAILURE'>[];
  actionCandidates: ContextMemoryFactOf<'ACTION_CANDIDATE'>[];
  outcomes: ContextMemoryFactOf<'OUTCOME'>[];
  decisions: ContextMemoryFactOf<'DECISION'>[];
  invariants: ContextMemoryFactOf<'INVARIANT'>[];
} {
  return { failures: [], actionCandidates: [], outcomes: [], decisions: [], invariants: [] };
}

type MutableFacts = ReturnType<typeof emptyFacts>;

function addFact(target: MutableFacts, entry: MemoryEntry): void {
  if (entry.kind === 'FAILURE') target.failures.push(projectFact(entry));
  else if (entry.kind === 'ACTION_CANDIDATE') target.actionCandidates.push(projectFact(entry));
  else if (entry.kind === 'OUTCOME') target.outcomes.push(projectFact(entry));
  else if (entry.kind === 'DECISION') target.decisions.push(projectFact(entry));
  else target.invariants.push(projectFact(entry));
}

function sortFacts(facts: MutableFacts): ContextMemoryFacts {
  const byId = <T extends { readonly memoryId: string }>(values: T[]): readonly T[] =>
    values.sort((left, right) => compareText(left.memoryId, right.memoryId));
  return {
    failures: byId(facts.failures),
    actionCandidates: byId(facts.actionCandidates),
    outcomes: byId(facts.outcomes),
    decisions: byId(facts.decisions),
    invariants: byId(facts.invariants),
  };
}

function allMemoryEntries(input: ContextBuilderInput['relevantMemory']): readonly MemoryEntry[] {
  return [
    ...input.failures,
    ...input.actionCandidates,
    ...input.outcomes,
    ...input.decisions,
    ...input.invariants,
  ].sort((left, right) => compareText(left.id, right.id));
}

function validateMemoryEntryScope(
  entries: readonly MemoryEntry[],
  subject: MemorySubject,
  aggregateRunId: string | undefined,
): void {
  for (const entry of entries) {
    if (!sameSubject(entry.subject, subject)) {
      corrupt(`Memory entry ${entry.id} subject does not match requested scope`);
    }
    if (aggregateRunId !== undefined && entry.provenance.runId !== aggregateRunId) {
      corrupt(`Memory entry ${entry.id} runId conflicts with relevant Memory scope`);
    }
  }
}

function cloneAndSortEdges(edges: readonly MemoryGraphEdge[]): readonly MemoryGraphEdge[] {
  const cloneNode = (node: MemoryNodeRef): MemoryNodeRef => node.kind === 'subject'
    ? { kind: 'subject', subject: cloneSubject(node.subject) }
    : { ...node };
  return edges.map((edge) => ({
    relation: edge.relation,
    source: cloneNode(edge.source),
    target: cloneNode(edge.target),
  })).sort((left, right) => compareText(canonicalJson(left), canonicalJson(right)));
}

function canonicalBytes(value: unknown): number {
  return new TextEncoder().encode(canonicalJson(value)).byteLength;
}

/** Pure composition of already-derived structured sources. Performs no loading or execution. */
export function buildContextBundle(input: ContextBuilderInput): ContextBuildResult {
  const scope = { runId: input.runId, subject: cloneSubject(input.subject) };
  if (input.diagnosis.runId !== input.runId) corrupt('diagnosis runId does not match requested scope');
  if (!sameSubject(diagnosisSubject(input.diagnosis), input.subject)) {
    corrupt('diagnosis subject does not match requested scope');
  }
  if (!sameSubject(input.relevantMemory.subject, input.subject)) {
    corrupt('relevant Memory subject does not match requested scope');
  }
  if (input.relevantMemory.runId !== undefined && input.relevantMemory.runId !== input.runId) {
    corrupt('relevant Memory runId conflicts with requested scope');
  }

  const currentRun = emptyFacts();
  const repositoryScoped = emptyFacts();
  const historical = new Map<string, MutableFacts>();
  const entries = allMemoryEntries(input.relevantMemory);
  validateMemoryEntryScope(entries, input.subject, input.relevantMemory.runId);
  for (const entry of entries) {
    const runId = entry.provenance.runId;
    if (runId === undefined) addFact(repositoryScoped, entry);
    else if (runId === input.runId) addFact(currentRun, entry);
    else {
      let group = historical.get(runId);
      if (group === undefined) {
        group = emptyFacts();
        historical.set(runId, group);
      }
      addFact(group, entry);
    }
  }

  const repository = repositoryContext(input.repositoryContext);
  const ready: ContextBundle = {
    version: 1,
    status: 'ready',
    scope,
    repository,
    current: {
      diagnosis: cloneDiagnosis(input.diagnosis),
      actionCandidates: projectActions(input.diagnosis),
    },
    memory: {
      currentRun: sortFacts(currentRun),
      historicalRuns: [...historical.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([runId, facts]) => ({ runId, facts: sortFacts(facts) })),
      repositoryScoped: sortFacts(repositoryScoped),
      edges: cloneAndSortEdges(input.relevantMemory.edges),
    },
    sourceState: {
      repositoryTruncated: repository.status === 'available' ? repository.truncated : null,
      memoryFactCount: entries.length,
      maximumCanonicalBytes: MAX_CONTEXT_BUNDLE_CANONICAL_BYTES,
    },
  };
  const actualBytes = canonicalBytes(ready);
  if (actualBytes > MAX_CONTEXT_BUNDLE_CANONICAL_BYTES) {
    return {
      version: 1,
      status: 'limit_exceeded',
      scope,
      limit: {
        kind: 'canonical_bytes',
        maximumBytes: MAX_CONTEXT_BUNDLE_CANONICAL_BYTES,
        actualBytes,
      },
    };
  }
  return ready;
}
