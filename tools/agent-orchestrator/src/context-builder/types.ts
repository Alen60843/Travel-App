import type { ActionId } from '../action-mapping/types';
import type { FailureClassification, FailureDiagnosis } from '../failure-intelligence/types';
import type { MemoryGraphEdge, RelevantMemoryResult } from '../memory-graph/types';
import type { MemoryEntry, MemorySubject } from '../memory/types';

export interface RepositoryNavigationHint {
  readonly path: string;
  readonly score: number;
  readonly reasons: readonly string[];
}

/** Structural input boundary satisfied by Graph Context without coupling to its scanner. */
export interface RepositoryNavigationContext {
  readonly hints: readonly RepositoryNavigationHint[];
  readonly scannedFileCount: number;
  readonly truncated: boolean;
  readonly maxHints: number;
}

export type ContextRepository =
  | { readonly status: 'unavailable'; readonly authority: 'navigation_only' }
  | {
    readonly status: 'available';
    readonly authority: 'navigation_only';
    readonly hints: readonly RepositoryNavigationHint[];
    readonly scannedFileCount: number;
    readonly truncated: boolean;
    readonly maxHints: number;
  };

export interface ContextActionCandidate {
  readonly version: 1;
  readonly actionId: ActionId;
  readonly subject: FailureDiagnosis['subject'];
  readonly mutatesState: boolean;
  readonly execution: 'manual';
  readonly authority: { readonly kind: 'human'; readonly required: boolean };
  readonly basis: {
    readonly classification: FailureClassification;
    readonly evidenceReferences: readonly string[];
  };
}

export type ContextMemoryFactOf<K extends MemoryEntry['kind']> = {
  readonly version: 1;
  readonly memoryId: string;
  readonly kind: K;
  readonly subject: Extract<MemoryEntry, { readonly kind: K }>['subject'];
  readonly data: Extract<MemoryEntry, { readonly kind: K }>['data'];
  readonly provenance: Extract<MemoryEntry, { readonly kind: K }>['provenance'];
};

export type ContextMemoryFact = {
  [K in MemoryEntry['kind']]: ContextMemoryFactOf<K>
}[MemoryEntry['kind']];

export interface ContextMemoryFacts {
  readonly failures: readonly ContextMemoryFactOf<'FAILURE'>[];
  readonly actionCandidates: readonly ContextMemoryFactOf<'ACTION_CANDIDATE'>[];
  readonly outcomes: readonly ContextMemoryFactOf<'OUTCOME'>[];
  readonly decisions: readonly ContextMemoryFactOf<'DECISION'>[];
  readonly invariants: readonly ContextMemoryFactOf<'INVARIANT'>[];
}

export interface HistoricalMemoryRun {
  readonly runId: string;
  readonly facts: ContextMemoryFacts;
}

export interface ContextScope {
  readonly runId: string;
  readonly subject: MemorySubject;
}

export interface ContextBuilderInput {
  readonly runId: string;
  readonly subject: MemorySubject;
  readonly repositoryContext: RepositoryNavigationContext | null;
  readonly diagnosis: FailureDiagnosis;
  readonly relevantMemory: RelevantMemoryResult;
}

export interface ContextBundle {
  readonly version: 1;
  readonly status: 'ready';
  readonly scope: ContextScope;
  readonly repository: ContextRepository;
  readonly current: {
    readonly diagnosis: FailureDiagnosis;
    readonly actionCandidates: readonly ContextActionCandidate[];
  };
  readonly memory: {
    readonly currentRun: ContextMemoryFacts;
    readonly historicalRuns: readonly HistoricalMemoryRun[];
    readonly repositoryScoped: ContextMemoryFacts;
    readonly edges: readonly MemoryGraphEdge[];
  };
  readonly sourceState: {
    readonly repositoryTruncated: boolean | null;
    readonly memoryFactCount: number;
    readonly maximumCanonicalBytes: number;
  };
}

export interface ContextLimitExceeded {
  readonly version: 1;
  readonly status: 'limit_exceeded';
  readonly scope: ContextScope;
  readonly limit: {
    readonly kind: 'canonical_bytes';
    readonly maximumBytes: number;
    readonly actualBytes: number;
  };
}

export type ContextBuildResult = ContextBundle | ContextLimitExceeded;
